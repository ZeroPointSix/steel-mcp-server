// ABOUTME: Unit tests for the hosted dependency runtime: clients are reused within one principal,
// ABOUTME: isolated across credentials, and session releases route back through the owning client.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import type { SessionPool } from '../../src/core/context.js';
import type { BrowserPage } from '../../src/core/page.js';
import { principalFromCredential } from '../../src/core/registry.js';
import { HostedRuntime } from '../../src/hosted-runtime.js';
import { FakeSteelApi } from '../helpers/fakes.js';

class RecordingPool implements SessionPool {
    readonly closed: string[] = [];

    async page(): Promise<BrowserPage> {
        throw new Error('This runtime test does not open a browser page.');
    }

    async close(steelSessionId: string): Promise<void> {
        this.closed.push(steelSessionId);
    }

    async closeAll(): Promise<void> {}
}

function input(credential: string) {
    return {
        credential,
        principal: principalFromCredential(credential),
        request: new Request('https://mcp.steel.dev/mcp', { method: 'POST' }),
    };
}

function harness() {
    const apis = new Map<string, FakeSteelApi>();
    const pools = new Map<string, RecordingPool>();
    const runtime = new HostedRuntime({
        configForCredential: credential => loadConfig({ STEEL_API_KEY: credential }),
        createApi: config => {
            const api = new FakeSteelApi();
            apis.set(config.apiKey!, api);
            return api;
        },
        createPool: config => {
            const pool = new RecordingPool();
            pools.set(config.apiKey!, pool);
            return pool;
        },
    });
    return { runtime, apis, pools };
}

describe('HostedRuntime dependency isolation', () => {
    it('reuses clients for one credential but never across credentials', async () => {
        const { runtime, apis, pools } = harness();
        const first = runtime.depsForRequest(input('ste-a'));
        const second = runtime.depsForRequest(input('ste-a'));
        const other = runtime.depsForRequest(input('ste-b'));

        expect(second.api).toBe(first.api);
        expect(second.pool).toBe(first.pool);
        expect(second.registry).toBe(first.registry);
        expect(other.registry).toBe(first.registry);
        expect(other.api).not.toBe(first.api);
        expect(other.pool).not.toBe(first.pool);
        expect(apis.size).toBe(2);
        expect(pools.size).toBe(2);

        await runtime.close();
    });

    it('routes a registry release through the REST client and CDP pool that own the session', async () => {
        const { runtime, apis, pools } = harness();
        const depsA = runtime.depsForRequest(input('ste-a'));
        runtime.depsForRequest(input('ste-b'));

        await depsA.api.createSession({ sessionId: 'steel-a', timeout: 60_000 });
        const record = await depsA.registry.create({
            principal: depsA.principal,
            steelSessionId: 'steel-a',
            expiresAt: Date.now() + 60_000,
        });
        await depsA.registry.release(record.handle, depsA.principal, 'explicit');

        expect(apis.get('ste-a')?.released).toEqual(['steel-a']);
        expect(pools.get('ste-a')?.closed).toEqual(['steel-a']);
        expect(apis.get('ste-b')?.released).toEqual([]);
        expect(pools.get('ste-b')?.closed).toEqual([]);

        await runtime.close();
    });

    it('keeps a handle usable across requests by its owner and opaque to another principal', async () => {
        const { runtime } = harness();
        const owner = runtime.depsForRequest(input('ste-owner'));
        const stranger = runtime.depsForRequest(input('ste-stranger'));
        const record = await owner.registry.create({
            principal: owner.principal,
            steelSessionId: 'steel-owned',
            expiresAt: Date.now() + 60_000,
        });

        await expect(owner.registry.resolve(record.handle, owner.principal)).resolves.toMatchObject({
            steelSessionId: 'steel-owned',
        });
        await expect(stranger.registry.resolve(record.handle, stranger.principal)).rejects.toThrow(
            /No live browser session/
        );

        await runtime.close();
    });
});
