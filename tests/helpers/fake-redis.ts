// ABOUTME: In-memory stand-ins for Redis: a store the handle registry can be driven against, and a
// ABOUTME: recording client for asserting the exact commands the ioredis adapter issues.
import type { RedisClient } from '../../src/core/redis.js';
import type { RedisCommands } from '../../src/core/registry-redis.js';

export interface FakeRedisOptions {
    /** The clock TTLs are measured against, so a test can expire a key by moving time. */
    now?: (() => Date) | undefined;
}

/**
 * One instance stands for one Redis server.
 *
 * Two registries constructed over the same instance are two replicas sharing a store, which is
 * what the multi-replica behaviour needs to be tested against.
 */
export class FakeRedis implements RedisCommands {
    private readonly values = new Map<string, { value: string; expiresAtMs: number }>();
    private readonly sets = new Map<string, Set<string>>();

    constructor(private readonly options: FakeRedisOptions = {}) {}

    private nowMs(): number {
        return (this.options.now ?? (() => new Date()))().getTime();
    }

    async get(key: string): Promise<string | null> {
        const entry = this.values.get(key);
        if (!entry) return null;
        if (entry.expiresAtMs <= this.nowMs()) {
            this.values.delete(key);
            return null;
        }
        return entry.value;
    }

    async set(key: string, value: string, ttlMs: number): Promise<void> {
        this.values.set(key, { value, expiresAtMs: this.nowMs() + ttlMs });
    }

    async del(key: string): Promise<number> {
        return this.values.delete(key) ? 1 : 0;
    }

    async sadd(key: string, member: string): Promise<void> {
        const members = this.sets.get(key) ?? new Set<string>();
        members.add(member);
        this.sets.set(key, members);
    }

    async srem(key: string, member: string): Promise<void> {
        this.sets.get(key)?.delete(member);
    }

    async smembers(key: string): Promise<string[]> {
        return [...(this.sets.get(key) ?? [])];
    }

    /** Remaining TTL on a key, for asserting that a record outlives the session it points at. */
    ttlMs(key: string): number | undefined {
        const entry = this.values.get(key);
        return entry ? entry.expiresAtMs - this.nowMs() : undefined;
    }

    /** Every value key held, so a test can assert that a release left nothing behind. */
    valueKeys(): string[] {
        return [...this.values.keys()];
    }

    /** Every non-empty set and its members, for asserting that the indexes are swept too. */
    setMembers(): Record<string, string[]> {
        const entries = [...this.sets.entries()].filter(([, members]) => members.size > 0);
        return Object.fromEntries(entries.map(([key, members]) => [key, [...members]]));
    }
}

export interface RecordingRedisClientReplies {
    get?: string | null;
    del?: number;
    smembers?: string[];
}

/** Records the calls the ioredis adapter makes, so argument shapes can be asserted without a server. */
export class RecordingRedisClient implements RedisClient {
    readonly calls: Array<{ command: string; args: unknown[] }> = [];
    private readonly errorListeners: Array<(error: Error) => void> = [];

    constructor(private readonly replies: RecordingRedisClientReplies = {}) {}

    private record(command: string, args: unknown[]): void {
        this.calls.push({ command, args });
    }

    async get(key: string): Promise<string | null> {
        this.record('get', [key]);
        return this.replies.get ?? null;
    }

    async set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown> {
        this.record('set', [key, value, mode, ttlMs]);
        return 'OK';
    }

    async del(key: string): Promise<number> {
        this.record('del', [key]);
        return this.replies.del ?? 0;
    }

    async sadd(key: string, member: string): Promise<number> {
        this.record('sadd', [key, member]);
        return 1;
    }

    async srem(key: string, member: string): Promise<number> {
        this.record('srem', [key, member]);
        return 1;
    }

    async smembers(key: string): Promise<string[]> {
        this.record('smembers', [key]);
        return this.replies.smembers ?? [];
    }

    async quit(): Promise<unknown> {
        this.record('quit', []);
        return 'OK';
    }

    on(event: 'error', listener: (error: Error) => void): this {
        if (event === 'error') this.errorListeners.push(listener);
        return this;
    }

    /** Stands in for the reconnect failures a real client emits at any time. */
    emitError(error: Error): void {
        for (const listener of this.errorListeners) listener(error);
    }
}
