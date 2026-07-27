// ABOUTME: The handle registry: mints opaque session handles, re-authorises them against the
// ABOUTME: caller's own principal on every call, releases idempotently and reaps orphans.
import { createHash, randomBytes } from 'node:crypto';
import type { MitigationState } from './errors.js';
import { SteelToolError } from './errors.js';

/** How a session came to be released. The Steel-backstop count is the leak metric. */
export type ReleasePath = 'explicit' | 'stream_close' | 'reaper';

export interface HandleRecord {
    /** Opaque, CSPRNG-derived, never a capability on its own. */
    handle: string;
    /** The Steel session this handle points at. */
    steelSessionId: string;
    /** The principal allowed to use this handle. Re-checked on every call. */
    principal: string;
    createdAt: number;
    lastUsedAt: number;
    /** Hard deadline; past this the handle is refused even if Steel has not reclaimed it yet. */
    expiresAt: number;
    viewerUrl?: string | undefined;
    /** Session capabilities already in play, so bot-detection errors name the right next rung. */
    mitigation: MitigationState;
}

export interface CreateHandleInput {
    principal: string;
    steelSessionId: string;
    expiresAt: number;
    viewerUrl?: string | undefined;
    mitigation?: MitigationState | undefined;
}

export interface ReapOptions {
    /** Release a handle that has not been used for this long. */
    idleMs: number;
}

/** The storage-shaped contract; the in-memory backend is the stdio and self-host implementation. */
export interface HandleRegistry {
    create(input: CreateHandleInput): Promise<HandleRecord>;
    resolve(handle: string, principal: string): Promise<HandleRecord>;
    touch(handle: string): Promise<void>;
    release(handle: string, principal: string, path: ReleasePath): Promise<HandleRecord | null>;
    list(principal: string): Promise<HandleRecord[]>;
    countLive(principal: string): Promise<number>;
    reap(options: ReapOptions): Promise<number>;
    releaseCounts(): Record<ReleasePath, number>;
}

export interface RegistryDeps {
    /** Called exactly once per handle, on whichever release path fires first. */
    releaseSteelSession(steelSessionId: string): Promise<void>;
    /** Reaper failures are reported here rather than thrown, so one bad session cannot stall a sweep. */
    onReapError?: ((error: unknown) => void) | undefined;
}

/**
 * Derives a stable principal id from a credential.
 *
 * The credential itself never enters a handle, a log line or an error message; only this
 * one-way digest does, so a leaked registry dump does not leak API keys.
 */
export function principalFromCredential(credential: string): string {
    return createHash('sha256').update(credential).digest('hex').slice(0, 32);
}

/** The message used for both an unknown handle and a handle belonging to someone else. */
const NOT_FOUND_MESSAGE =
    'No live browser session for that session_id. It may have been released, may have expired, ' +
    'or may belong to a different credential. Call steel_session_create to start a new one.';

function mintHandle(): string {
    return `sess_${randomBytes(16).toString('base64url')}`;
}

/** In-memory handle registry. One process, one replica; the hosted deployment swaps the backend. */
export class InMemoryHandleRegistry implements HandleRegistry {
    private readonly records = new Map<string, HandleRecord>();
    private readonly counts: Record<ReleasePath, number> = { explicit: 0, stream_close: 0, reaper: 0 };

    constructor(private readonly deps: RegistryDeps) {}

    async create(input: CreateHandleInput): Promise<HandleRecord> {
        const now = Date.now();
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
        this.records.set(record.handle, record);
        return record;
    }

    async resolve(handle: string, principal: string): Promise<HandleRecord> {
        const record = this.records.get(handle);
        // A handle belonging to another principal is answered exactly like an unknown handle,
        // so the error cannot be used to probe for the existence of other people's sessions.
        if (!record || record.principal !== principal) {
            throw new SteelToolError(NOT_FOUND_MESSAGE, { code: 'not_found' });
        }
        if (record.expiresAt <= Date.now()) {
            throw new SteelToolError(
                'That browser session reached its hard timeout and has been released by Steel. ' +
                    'Call steel_session_create to start a new one.',
                { code: 'session_expired', details: { handle } }
            );
        }
        return record;
    }

    async touch(handle: string): Promise<void> {
        const record = this.records.get(handle);
        if (record) record.lastUsedAt = Date.now();
    }

    async release(handle: string, principal: string, path: ReleasePath): Promise<HandleRecord | null> {
        const record = this.records.get(handle);
        if (!record) return null;
        if (record.principal !== principal) {
            throw new SteelToolError(NOT_FOUND_MESSAGE, { code: 'not_found' });
        }
        this.records.delete(handle);
        await this.deps.releaseSteelSession(record.steelSessionId);
        this.counts[path] += 1;
        return record;
    }

    async list(principal: string): Promise<HandleRecord[]> {
        return [...this.records.values()].filter(record => record.principal === principal);
    }

    async countLive(principal: string): Promise<number> {
        return (await this.list(principal)).length;
    }

    async reap(options: ReapOptions): Promise<number> {
        const now = Date.now();
        let reaped = 0;
        for (const record of [...this.records.values()]) {
            const idle = now - record.lastUsedAt >= options.idleMs;
            const expired = record.expiresAt <= now;
            if (!idle && !expired) continue;

            this.records.delete(record.handle);
            try {
                await this.deps.releaseSteelSession(record.steelSessionId);
                this.counts.reaper += 1;
                reaped += 1;
            } catch (error) {
                this.deps.onReapError?.(error);
            }
        }
        return reaped;
    }

    releaseCounts(): Record<ReleasePath, number> {
        return { ...this.counts };
    }
}
