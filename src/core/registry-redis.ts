// ABOUTME: Redis-backed handle registry: interchangeable replicas share one set of session handles,
// ABOUTME: behind a narrow command interface and with the same semantics as the in-memory backend.
import {
    type CreateHandleInput,
    type HandleRecord,
    type HandleRegistry,
    handleExpiredError,
    handleNotFoundError,
    mintHandle,
    type ReapOptions,
    type RegistryDeps,
    type ReleasePath,
} from './registry.js';

/**
 * The Redis commands this registry issues, and nothing more.
 *
 * Keeping the surface this small is what lets the whole state machine be tested against an
 * in-memory store: no server, no client library, no network in the unit suite.
 */
export interface RedisCommands {
    get(key: string): Promise<string | null>;
    /**
     * Writes a value with a millisecond time-to-live.
     *
     * The TTL is a garbage-collection net for records no replica ever sweeps, never a release
     * path: it is always set far beyond the handle's own hard expiry.
     */
    set(key: string, value: string, ttlMs: number): Promise<void>;
    /** Returns how many keys were removed, which is how one of two concurrent sweepers wins. */
    del(key: string): Promise<number>;
    sadd(key: string, member: string): Promise<void>;
    srem(key: string, member: string): Promise<void>;
    smembers(key: string): Promise<string[]>;
}

export interface RedisRegistryDeps extends RegistryDeps {
    commands: RedisCommands;
    /** Key namespace, so one Redis can serve more than one deployment. */
    keyPrefix?: string | undefined;
    now?: (() => Date) | undefined;
}

const DEFAULT_KEY_PREFIX = 'steel-mcp';

/**
 * How long a record outlives its own hard expiry before Redis drops it.
 *
 * Long enough that a reaper sweep — including one that has to retry a failed Steel release for a
 * while — always finds the record it needs. Steel's own `inactivityTimeout` is what actually
 * guarantees the browser is gone by then; this only stops abandoned keys accumulating forever.
 */
const RECORD_GRACE_MS = 86_400_000;

/** Handle registry over a shared Redis, so any replica can serve a handle any other replica minted. */
export class RedisHandleRegistry implements HandleRegistry {
    private readonly commands: RedisCommands;
    private readonly prefix: string;
    private readonly now: () => Date;
    private readonly counts: Record<ReleasePath, number> = { explicit: 0, stream_close: 0, reaper: 0 };

    constructor(private readonly deps: RedisRegistryDeps) {
        this.commands = deps.commands;
        this.prefix = deps.keyPrefix ?? DEFAULT_KEY_PREFIX;
        this.now = deps.now ?? (() => new Date());
    }

    private recordKey(handle: string): string {
        return `${this.prefix}:handle:${handle}`;
    }

    /** Index of one principal's handles, so a count or a list never scans another tenant's records. */
    private principalKey(principal: string): string {
        return `${this.prefix}:principal:${principal}`;
    }

    /** Index every reaper sweeps, holding `<principal>:<handle>` members. */
    private get liveKey(): string {
        return `${this.prefix}:live`;
    }

    private async read(handle: string): Promise<HandleRecord | null> {
        const raw = await this.commands.get(this.recordKey(handle));
        if (raw === null) return null;
        try {
            return JSON.parse(raw) as HandleRecord;
        } catch {
            // A record we cannot read is a record we cannot authorise, so it is answered exactly
            // like an unknown handle. The next sweep clears the key out.
            return null;
        }
    }

    private async write(record: HandleRecord): Promise<void> {
        // Never below the grace period: a handle that is already long expired still needs a record
        // to release, and Redis rejects a non-positive expiry outright.
        const ttlMs = Math.max(record.expiresAt - this.now().getTime() + RECORD_GRACE_MS, RECORD_GRACE_MS);
        await this.commands.set(this.recordKey(record.handle), JSON.stringify(record), ttlMs);
    }

    /**
     * Removes a record and both of its index entries.
     *
     * Returns whether this caller was the one that removed the record. Two replicas sweeping at
     * once both see the handle, so `del` deciding the winner is what keeps the release counters
     * honest without a distributed lock.
     */
    private async forget(principal: string, handle: string): Promise<boolean> {
        const removed = await this.commands.del(this.recordKey(handle));
        await this.commands.srem(this.principalKey(principal), handle);
        await this.commands.srem(this.liveKey, `${principal}:${handle}`);
        return removed > 0;
    }

    async create(input: CreateHandleInput): Promise<HandleRecord> {
        const now = this.now().getTime();
        const record: HandleRecord = {
            handle: mintHandle(),
            steelSessionId: input.steelSessionId,
            principal: input.principal,
            createdAt: now,
            lastUsedAt: now,
            expiresAt: input.expiresAt,
            viewerUrl: input.viewerUrl,
            mitigation: input.mitigation ?? {},
        };
        // The record is written before it is indexed, so an index entry never names a handle that
        // cannot be read back and released.
        await this.write(record);
        await this.commands.sadd(this.principalKey(record.principal), record.handle);
        await this.commands.sadd(this.liveKey, `${record.principal}:${record.handle}`);
        return record;
    }

    async resolve(handle: string, principal: string): Promise<HandleRecord> {
        const record = await this.read(handle);
        // A handle belonging to another principal is answered exactly like an unknown handle,
        // so the error cannot be used to probe for the existence of other people's sessions.
        if (!record || record.principal !== principal) {
            throw handleNotFoundError();
        }
        if (record.expiresAt <= this.now().getTime()) {
            throw handleExpiredError(handle);
        }
        return record;
    }

    async touch(handle: string): Promise<void> {
        const record = await this.read(handle);
        if (!record) return;
        await this.write({ ...record, lastUsedAt: this.now().getTime() });
    }

    /**
     * Releases the Steel session, then forgets the handle.
     *
     * The order matters: deleting the record first would lose it on a transient failure, leaving
     * nothing to retry, nothing for any replica's reaper to find, and a browser billing on — while
     * the release counter still claimed a release that never happened.
     */
    async release(handle: string, principal: string, path: ReleasePath): Promise<HandleRecord | null> {
        const record = await this.read(handle);
        if (!record) return null;
        if (record.principal !== principal) {
            throw handleNotFoundError();
        }
        await this.deps.releaseSteelSession(record.steelSessionId, record.principal);
        if (await this.forget(principal, handle)) this.counts[path] += 1;
        return record;
    }

    async list(principal: string): Promise<HandleRecord[]> {
        const handles = await this.commands.smembers(this.principalKey(principal));
        const records: HandleRecord[] = [];
        for (const handle of handles) {
            const record = await this.read(handle);
            if (record?.principal === principal) records.push(record);
            // An index entry with no readable record is stale: another replica released it, or the
            // key aged out. Dropping it here keeps the index from growing without bound.
            else await this.forget(principal, handle);
        }
        return records;
    }

    async countLive(principal: string): Promise<number> {
        return (await this.list(principal)).length;
    }

    /**
     * Sweeps every principal's handles, releasing the idle and the expired.
     *
     * Replicas sweep concurrently and are deliberately not coordinated: releasing a session is
     * idempotent on both sides — Steel tolerates a repeat release, and only the replica whose
     * `del` removed the record counts one — so a lock would buy nothing but a new failure mode.
     */
    async reap(options: ReapOptions): Promise<number> {
        const now = this.now().getTime();
        let reaped = 0;
        for (const member of await this.commands.smembers(this.liveKey)) {
            const separator = member.indexOf(':');
            if (separator < 0) {
                // Not a member this registry wrote. Dropping it keeps a foreign key in the same
                // namespace out of every future sweep.
                await this.commands.srem(this.liveKey, member);
                continue;
            }
            const principal = member.slice(0, separator);
            const handle = member.slice(separator + 1);

            const record = await this.read(handle);
            if (!record) {
                await this.forget(principal, handle);
                continue;
            }

            const idle = now - record.lastUsedAt >= options.idleMs;
            const expired = record.expiresAt <= now;
            if (!idle && !expired) continue;

            try {
                await this.deps.releaseSteelSession(record.steelSessionId, record.principal);
                if (await this.forget(record.principal, handle)) {
                    this.counts.reaper += 1;
                    reaped += 1;
                }
            } catch (error) {
                // The record stays so the next sweep — on this replica or any other — tries again.
                // Dropping it here would leave the browser running with nothing tracking it.
                this.deps.onReapError?.(error);
            }
        }
        return reaped;
    }

    /** This replica's own counts. The leak metric is their sum across the fleet. */
    releaseCounts(): Record<ReleasePath, number> {
        return { ...this.counts };
    }
}
