// ABOUTME: Unit tests for the Redis-backed handle registry: the same state machine as the in-memory
// ABOUTME: backend, plus the multi-replica behaviour a shared store adds — handoff and concurrent reaps.
import { describe, expect, it } from 'vitest';
import { SteelToolError } from '../../src/core/errors.js';
import { principalFromCredential, type RegistryDeps } from '../../src/core/registry.js';
import { RedisHandleRegistry } from '../../src/core/registry-redis.js';
import { FakeRedis } from '../helpers/fake-redis.js';

const ORG_A = principalFromCredential('ste-key-a');
const ORG_B = principalFromCredential('ste-key-b');

/** A movable clock in the `() => Date` shape the rest of the server injects. */
function testClock(startMs = 1_800_000_000_000) {
    let ms = startMs;
    return {
        now: () => new Date(ms),
        advance: (deltaMs: number) => {
            ms += deltaMs;
        },
        get ms() {
            return ms;
        },
    };
}

interface HarnessOptions {
    store?: FakeRedis;
    clock?: ReturnType<typeof testClock>;
    releaseSteelSession?: RegistryDeps['releaseSteelSession'];
    onReapError?: RegistryDeps['onReapError'];
}

/** Builds one replica. Pass the same store and clock twice to model two replicas of one deployment. */
function harness(options: HarnessOptions = {}) {
    const clock = options.clock ?? testClock();
    const store = options.store ?? new FakeRedis({ now: clock.now });
    const released: string[] = [];
    const registry = new RedisHandleRegistry({
        commands: store,
        now: clock.now,
        releaseSteelSession:
            options.releaseSteelSession ??
            (async (id: string) => {
                released.push(id);
            }),
        onReapError: options.onReapError,
    });
    return { registry, store, clock, released };
}

async function captureError(promise: Promise<unknown>): Promise<SteelToolError> {
    try {
        await promise;
    } catch (error) {
        return error as SteelToolError;
    }
    throw new Error('Expected the promise to reject, but it resolved.');
}

describe('RedisHandleRegistry.create', () => {
    it('mints an opaque prefixed handle with at least 128 bits of entropy', async () => {
        const { registry, clock } = harness();
        const record = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });
        expect(record.handle.startsWith('sess_')).toBe(true);
        expect(record.handle.length - 'sess_'.length).toBeGreaterThanOrEqual(22);
    });

    it('never derives the handle from the principal or the Steel id', async () => {
        const { registry, clock } = harness();
        const handles = new Set<string>();
        for (let i = 0; i < 50; i++) {
            const record = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: clock.ms + 60_000,
            });
            expect(record.handle).not.toContain(ORG_A);
            expect(record.handle).not.toContain('steel-1');
            handles.add(record.handle);
        }
        expect(handles.size).toBe(50);
    });

    it('stores the record under a key namespaced by prefix and principal', async () => {
        const clock = testClock();
        const store = new FakeRedis({ now: clock.now });
        const registry = new RedisHandleRegistry({
            commands: store,
            keyPrefix: 'tenant-x',
            now: clock.now,
            releaseSteelSession: async () => {},
        });
        const record = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        expect(store.valueKeys()).toEqual([`tenant-x:handle:${record.handle}`]);
        expect(store.setMembers()[`tenant-x:principal:${ORG_A}`]).toEqual([record.handle]);
        expect(store.setMembers()['tenant-x:live']).toEqual([`${ORG_A}:${record.handle}`]);
    });

    it('keeps the record alive well past the hard expiry, so a failed release can still be retried', async () => {
        const { registry, store, clock } = harness();
        const expiresIn = 60_000;
        await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + expiresIn,
        });

        const [key] = store.valueKeys();
        expect(store.ttlMs(key!)).toBeGreaterThan(expiresIn);
    });

    it('still gives a long-expired handle a positive expiry, which is the only kind Redis accepts', async () => {
        const { registry, store, clock } = harness();
        await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms - 30 * 86_400_000,
        });

        const [key] = store.valueKeys();
        expect(store.ttlMs(key!)).toBeGreaterThan(0);
    });
});

describe('RedisHandleRegistry.resolve', () => {
    it('returns the record for the principal that created it', async () => {
        const { registry, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
            viewerUrl: 'https://app.steel.dev/sessions/steel-1',
            mitigation: { useProxy: true },
        });

        await expect(registry.resolve(handle, ORG_A)).resolves.toMatchObject({
            steelSessionId: 'steel-1',
            principal: ORG_A,
            viewerUrl: 'https://app.steel.dev/sessions/steel-1',
            mitigation: { useProxy: true },
        });
    });

    it('rejects a handle presented by a different principal', async () => {
        const { registry, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        const error = await captureError(registry.resolve(handle, ORG_B));
        expect(error).toBeInstanceOf(SteelToolError);
        expect(error.code).toBe('not_found');
    });

    it('does not reveal whether a rejected handle exists', async () => {
        const { registry, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        const wrongOrg = await registry.resolve(handle, ORG_B).catch(e => (e as Error).message);
        const unknown = await registry.resolve('sess_nope', ORG_B).catch(e => (e as Error).message);
        expect(wrongOrg).toBe(unknown);
    });

    it('rejects an expired handle with its own code', async () => {
        const { registry, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 1_000,
        });

        clock.advance(2_000);
        const error = await captureError(registry.resolve(handle, ORG_A));
        expect(error.code).toBe('session_expired');
    });

    it('treats an unreadable record as an unknown handle rather than throwing a parse error', async () => {
        const { registry, store, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });
        const [key] = store.valueKeys();
        await store.set(key!, 'not json', 60_000);

        const error = await captureError(registry.resolve(handle, ORG_A));
        expect(error.code).toBe('not_found');
    });
});

describe('RedisHandleRegistry.touch', () => {
    it('records the last use so the reaper can measure idleness', async () => {
        const { registry, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 600_000,
        });

        const before = (await registry.resolve(handle, ORG_A)).lastUsedAt;
        clock.advance(5_000);
        await registry.touch(handle);

        expect((await registry.resolve(handle, ORG_A)).lastUsedAt).toBe(before + 5_000);
    });

    it('ignores an unknown handle', async () => {
        const { registry } = harness();
        await expect(registry.touch('sess_nope')).resolves.toBeUndefined();
    });
});

describe('RedisHandleRegistry.release', () => {
    it('releases the Steel session and forgets the handle, indexes included', async () => {
        const { registry, store, clock, released } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        const record = await registry.release(handle, ORG_A, 'explicit');
        expect(record?.steelSessionId).toBe('steel-1');
        expect(released).toEqual(['steel-1']);
        expect(await registry.countLive(ORG_A)).toBe(0);
        expect(store.valueKeys()).toEqual([]);
        expect(store.setMembers()).toEqual({});
    });

    it('names the owning principal, so a hosted replica can pick the credential allowed to release', async () => {
        const releases: Array<[string, string]> = [];
        const clock = testClock();
        const registry = new RedisHandleRegistry({
            commands: new FakeRedis({ now: clock.now }),
            now: clock.now,
            releaseSteelSession: async (id: string, principal: string) => {
                releases.push([id, principal]);
            },
        });
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        await registry.release(handle, ORG_A, 'explicit');
        expect(releases).toEqual([['steel-1', ORG_A]]);
    });

    it('is idempotent: a second release neither throws nor re-releases', async () => {
        const { registry, clock, released } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        await registry.release(handle, ORG_A, 'explicit');
        await expect(registry.release(handle, ORG_A, 'explicit')).resolves.toBeNull();
        expect(released).toEqual(['steel-1']);
        expect(registry.releaseCounts().explicit).toBe(1);
    });

    it('refuses to release another principal handle', async () => {
        const { registry, clock, released } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        await expect(registry.release(handle, ORG_B, 'explicit')).rejects.toBeInstanceOf(SteelToolError);
        expect(released).toEqual([]);
        expect(await registry.countLive(ORG_A)).toBe(1);
    });

    it('releases the Steel session before forgetting the handle', async () => {
        // If the record went first, a transient failure would lose it: no retry, the reaper could
        // never see it, and the browser would bill on with nothing tracking it.
        let resolvableDuringRelease: boolean | undefined;
        const clock = testClock();
        const store = new FakeRedis({ now: clock.now });
        const registry: RedisHandleRegistry = new RedisHandleRegistry({
            commands: store,
            now: clock.now,
            releaseSteelSession: async () => {
                resolvableDuringRelease = await registry
                    .resolve(handle, ORG_A)
                    .then(() => true)
                    .catch(() => false);
            },
        });
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 's1',
            expiresAt: clock.ms + 60_000,
        });

        await registry.release(handle, ORG_A, 'explicit');
        expect(resolvableDuringRelease, 'the record was deleted before the release was awaited').toBe(true);
    });

    it('keeps the handle when the Steel release fails, so the reaper can retry', async () => {
        let attempts = 0;
        const { registry, clock } = harness({
            releaseSteelSession: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('steel unreachable');
            },
        });
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 's1',
            expiresAt: clock.ms + 60_000,
        });

        await expect(registry.release(handle, ORG_A, 'explicit')).rejects.toThrow(/steel unreachable/);
        expect(await registry.countLive(ORG_A), 'the handle was dropped despite the failure').toBe(1);
        expect(registry.releaseCounts().explicit, 'the leak metric counted a release that never happened').toBe(0);

        await expect(registry.release(handle, ORG_A, 'explicit')).resolves.toBeTruthy();
        expect(await registry.countLive(ORG_A)).toBe(0);
        expect(registry.releaseCounts().explicit).toBe(1);
    });
});

describe('RedisHandleRegistry.reap', () => {
    it('releases handles idle past the deadline and leaves fresh ones alone', async () => {
        const { registry, clock, released } = harness();
        const stale = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-stale',
            expiresAt: clock.ms + 600_000,
        });
        clock.advance(200_000);
        const fresh = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-fresh',
            expiresAt: clock.ms + 600_000,
        });

        expect(await registry.reap({ idleMs: 120_000 })).toBe(1);
        expect(released).toEqual(['steel-stale']);
        await expect(registry.resolve(stale.handle, ORG_A)).rejects.toBeInstanceOf(SteelToolError);
        await expect(registry.resolve(fresh.handle, ORG_A)).resolves.toBeTruthy();
    });

    it('releases handles past their hard expiry regardless of recent use', async () => {
        const { registry, clock, released } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 1_000,
        });
        clock.advance(2_000);
        await registry.touch(handle);

        expect(await registry.reap({ idleMs: 120_000 })).toBe(1);
        expect(released).toEqual(['steel-1']);
    });

    it('counts releases by path so the Steel backstop can be alerted on', async () => {
        const { registry, clock } = harness();
        const a = await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: clock.ms + 60_000 });
        const b = await registry.create({ principal: ORG_A, steelSessionId: 's2', expiresAt: clock.ms + 60_000 });
        await registry.release(a.handle, ORG_A, 'explicit');
        await registry.release(b.handle, ORG_A, 'stream_close');

        expect(registry.releaseCounts()).toMatchObject({ explicit: 1, stream_close: 1, reaper: 0 });
    });

    it('keeps releasing after one release fails, and reports the failure', async () => {
        const failures: unknown[] = [];
        const { registry, clock } = harness({
            releaseSteelSession: async (id: string) => {
                if (id === 's1') throw new Error('steel unreachable');
            },
            onReapError: error => failures.push(error),
        });
        await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: clock.ms - 1 });
        await registry.create({ principal: ORG_A, steelSessionId: 's2', expiresAt: clock.ms - 1 });

        expect(await registry.reap({ idleMs: 1 })).toBe(1);
        expect(failures).toHaveLength(1);
        expect((failures[0] as Error).message).toContain('steel unreachable');
    });

    it('retries a handle whose release failed on the previous sweep', async () => {
        let attempts = 0;
        const { registry, clock } = harness({
            releaseSteelSession: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('steel unreachable');
            },
            onReapError: () => {},
        });
        await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: clock.ms - 1 });

        expect(await registry.reap({ idleMs: 1 })).toBe(0);
        expect(await registry.countLive(ORG_A), 'a failed reap dropped the handle it could not release').toBe(1);

        expect(await registry.reap({ idleMs: 1 })).toBe(1);
        expect(await registry.countLive(ORG_A)).toBe(0);
        expect(registry.releaseCounts().reaper).toBe(1);
    });

    it('sweeps a member no registry wrote, instead of carrying it through every future sweep', async () => {
        const { registry, store, released } = harness();
        await store.sadd('steel-mcp:live', 'not-a-member');

        expect(await registry.reap({ idleMs: 1 })).toBe(0);
        expect(released).toEqual([]);
        expect(store.setMembers()).toEqual({});
    });

    it('sweeps an index entry whose record is already gone', async () => {
        const { registry, store, clock, released } = harness();
        await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: clock.ms + 60_000 });
        const [key] = store.valueKeys();
        await store.del(key!);

        expect(await registry.reap({ idleMs: 1 })).toBe(0);
        expect(released, 'a record-less index entry named no Steel session to release').toEqual([]);
        expect(store.setMembers()).toEqual({});
    });
});

describe('RedisHandleRegistry.countLive', () => {
    it('counts per principal, not globally', async () => {
        const { registry, clock } = harness();
        await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: clock.ms + 60_000 });
        await registry.create({ principal: ORG_B, steelSessionId: 's2', expiresAt: clock.ms + 60_000 });

        expect(await registry.countLive(ORG_A)).toBe(1);
        expect(await registry.countLive(ORG_B)).toBe(1);
        expect(await registry.list(ORG_A)).toHaveLength(1);
    });

    it('does not count a handle whose record another replica already released', async () => {
        const { registry, store, clock } = harness();
        await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: clock.ms + 60_000 });
        const [key] = store.valueKeys();
        await store.del(key!);

        expect(await registry.countLive(ORG_A)).toBe(0);
        expect(store.setMembers(), 'the stale index entry survived a list').toEqual({});
    });
});

describe('RedisHandleRegistry across replicas', () => {
    /** Two registries over one store: exactly the hosted shape, where no request is routed stickily. */
    function twoReplicas(options: HarnessOptions = {}) {
        const clock = options.clock ?? testClock();
        const store = options.store ?? new FakeRedis({ now: clock.now });
        const first = harness({ ...options, store, clock });
        const second = harness({ ...options, store, clock });
        return { first, second, store, clock };
    }

    it('resolves on a second replica a handle the first one created', async () => {
        const { first, second, clock } = twoReplicas();
        const { handle } = await first.registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        await expect(second.registry.resolve(handle, ORG_A)).resolves.toMatchObject({ steelSessionId: 'steel-1' });
        expect(await second.registry.countLive(ORG_A)).toBe(1);
    });

    it('keeps a handle opaque to another principal on every replica', async () => {
        const { first, second, clock } = twoReplicas();
        const { handle } = await first.registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        const error = await captureError(second.registry.resolve(handle, ORG_B));
        expect(error.code).toBe('not_found');
        expect(await second.registry.countLive(ORG_B)).toBe(0);
    });

    it('carries a touch on one replica over to the other replica idle math', async () => {
        const { first, second, clock } = twoReplicas();
        const { handle } = await first.registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 600_000,
        });

        clock.advance(100_000);
        await second.registry.touch(handle);
        clock.advance(60_000);

        expect(await first.registry.reap({ idleMs: 120_000 }), 'a touch on another replica was not seen').toBe(0);
    });

    it('is idempotent across replicas: releasing on one leaves nothing for the other', async () => {
        const { first, second, clock } = twoReplicas();
        const { handle } = await first.registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        await first.registry.release(handle, ORG_A, 'explicit');
        await expect(second.registry.release(handle, ORG_A, 'explicit')).resolves.toBeNull();
        expect(first.released).toEqual(['steel-1']);
        expect(second.released, 'the second replica released a session the first had already released').toEqual([]);
    });

    it('counts one release when two replicas sweep the same handle at once', async () => {
        // No distributed lock: whichever replica deletes the record wins, and the loser must not
        // count a release it did not perform.
        const { first, second, store, clock } = twoReplicas();
        await first.registry.create({ principal: ORG_A, steelSessionId: 'steel-1', expiresAt: clock.ms + 600_000 });
        clock.advance(200_000);

        const [reapedByFirst, reapedBySecond] = await Promise.all([
            first.registry.reap({ idleMs: 120_000 }),
            second.registry.reap({ idleMs: 120_000 }),
        ]);

        expect(
            [...first.released, ...second.released],
            'the two sweeps did not overlap, so the race was never exercised'
        ).toEqual(['steel-1', 'steel-1']);
        expect(reapedByFirst + reapedBySecond, 'the same handle was reaped twice').toBe(1);
        const counts = first.registry.releaseCounts().reaper + second.registry.releaseCounts().reaper;
        expect(counts, 'two replicas both counted the one release').toBe(1);
        expect(store.valueKeys()).toEqual([]);
        expect(store.setMembers()).toEqual({});
        expect(await first.registry.countLive(ORG_A)).toBe(0);
    });

    it('leaves nothing behind when every replica sweeps a whole store', async () => {
        const { first, second, store, clock } = twoReplicas();
        for (const id of ['s1', 's2', 's3']) {
            await first.registry.create({ principal: ORG_A, steelSessionId: id, expiresAt: clock.ms + 600_000 });
        }
        await second.registry.create({ principal: ORG_B, steelSessionId: 's4', expiresAt: clock.ms + 600_000 });
        clock.advance(200_000);

        const swept = await Promise.all([
            first.registry.reap({ idleMs: 120_000 }),
            second.registry.reap({ idleMs: 120_000 }),
        ]);

        // Every session is released, each counted exactly once across the fleet. A replica may ask
        // Steel to release a session another replica had already released; that call is idempotent,
        // which is why concurrent sweeps need no coordination.
        expect(swept[0] + swept[1]).toBe(4);
        expect([...new Set([...first.released, ...second.released])].sort()).toEqual(['s1', 's2', 's3', 's4']);
        expect(first.registry.releaseCounts().reaper + second.registry.releaseCounts().reaper).toBe(4);
        expect(store.valueKeys()).toEqual([]);
        expect(store.setMembers()).toEqual({});
    });
});
