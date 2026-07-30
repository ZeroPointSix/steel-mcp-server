// ABOUTME: Unit tests for the CDP session pool lifecycle: one connection per Steel session, dead
// ABOUTME: connections evicted and reconnected, and concurrent callers sharing a single connect.
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { CdpSessionPool, type PooledConnection } from '../../src/core/context.js';
import type { CdpSession } from '../../src/core/steel/cdp.js';
import { tracingHarness } from '../helpers/tracing.js';

const API_KEY = 'ste-test';
const config = loadConfig({ STEEL_API_KEY: API_KEY });

function fakeSession(): CdpSession {
    return {
        async send<T>(): Promise<T> {
            return {} as T;
        },
        on: () => () => {},
        async close() {},
    };
}

interface FakeConnection extends PooledConnection {
    id: number;
    closeCount: number;
    kill(): void;
}

function connector(options: { failFirst?: boolean; connectDelayMs?: number } = {}) {
    const opened: FakeConnection[] = [];
    let next = 0;
    let attempts = 0;

    const connect = async (_url: string, signal?: AbortSignal): Promise<PooledConnection> => {
        attempts += 1;
        if (options.connectDelayMs) await new Promise(resolve => setTimeout(resolve, options.connectDelayMs));
        if (options.failFirst && attempts === 1) throw new Error('connect refused');
        signal?.throwIfAborted();

        let closed = false;
        const connection: FakeConnection = {
            id: ++next,
            closeCount: 0,
            get isClosed() {
                return closed;
            },
            async attachToPage() {
                return fakeSession();
            },
            async close() {
                connection.closeCount += 1;
                closed = true;
            },
            kill() {
                closed = true;
            },
        };
        opened.push(connection);
        return connection;
    };

    return { connect, opened, attemptCount: () => attempts };
}

describe('CdpSessionPool.page', () => {
    it('opens one connection per session and reuses the attached page', async () => {
        const { connect, attemptCount } = connector();
        const pool = new CdpSessionPool(config, 1, connect);

        const first = await pool.page('steel-1');
        const second = await pool.page('steel-1');

        expect(second).toBe(first);
        expect(attemptCount()).toBe(1);
    });

    it('keeps separate connections for separate sessions', async () => {
        const { connect, opened } = connector();
        const pool = new CdpSessionPool(config, 1, connect);

        const a = await pool.page('steel-1');
        const b = await pool.page('steel-2');

        expect(a).not.toBe(b);
        expect(opened).toHaveLength(2);
    });

    it('gives concurrent callers one connection and one page, never two', async () => {
        const { connect, opened, attemptCount } = connector({ connectDelayMs: 20 });
        const pool = new CdpSessionPool(config, 1, connect);

        const pages = await Promise.all([pool.page('steel-1'), pool.page('steel-1'), pool.page('steel-1')]);

        expect(attemptCount()).toBe(1);
        expect(opened).toHaveLength(1);
        expect(new Set(pages).size, 'ref state split across several PageState instances').toBe(1);
    });

    it('evicts a dead connection and reconnects transparently', async () => {
        const { connect, opened } = connector();
        const pool = new CdpSessionPool(config, 1, connect);

        const first = await pool.page('steel-1');
        opened[0]!.kill();

        const second = await pool.page('steel-1');
        expect(second).not.toBe(first);
        expect(opened).toHaveLength(2);
        expect(opened[1]!.isClosed).toBe(false);
    });

    it('does not leak the dead socket it evicted', async () => {
        const { connect, opened } = connector();
        const pool = new CdpSessionPool(config, 1, connect);

        await pool.page('steel-1');
        opened[0]!.kill();
        await pool.page('steel-1');

        expect(opened[0]!.isClosed).toBe(true);
    });

    it('lets a caller retry after a failed connect instead of caching the failure', async () => {
        const { connect } = connector({ failFirst: true });
        const pool = new CdpSessionPool(config, 1, connect);

        await expect(pool.page('steel-1')).rejects.toThrow(/connect refused/);
        await expect(pool.page('steel-1')).resolves.toBeDefined();
    });

    it('reuses the connection after one caller cancelled its own request', async () => {
        const { connect, opened } = connector();
        const pool = new CdpSessionPool(config, 1, connect);

        const controller = new AbortController();
        const page = await pool.page('steel-1', controller.signal);

        // The signal belongs to one tool call; the connection belongs to the whole session.
        controller.abort();
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(opened[0]!.isClosed, 'a cancelled tool call closed the pooled connection').toBe(false);
        expect(await pool.page('steel-1')).toBe(page);
        expect(opened).toHaveLength(1);
    });
});

describe('CdpSessionPool tracing', () => {
    it('records one span per connect, and none for a reused connection', async () => {
        const harness = tracingHarness();
        const { connect } = connector();
        const pool = new CdpSessionPool(config, 1, connect, harness.tracer);

        await pool.page('steel-1');
        await pool.page('steel-1');

        const span = harness.span('cdp connect');
        expect(span.kind).toBe(SpanKind.CLIENT);
        expect(span.attributes).toEqual({ 'steel.session.id': 'steel-1' });
        await harness.shutdown();
    });

    it('never records the CDP URL, which carries the API key as a query parameter', async () => {
        const harness = tracingHarness();
        const { connect } = connector();
        const pool = new CdpSessionPool(config, 1, connect, harness.tracer);

        await pool.page('steel-1');

        expect(JSON.stringify(harness.span('cdp connect').attributes)).not.toContain(API_KEY);
        await harness.shutdown();
    });

    it('marks the span failed when the browser connection cannot be opened', async () => {
        const harness = tracingHarness();
        const { connect } = connector({ failFirst: true });
        const pool = new CdpSessionPool(config, 1, connect, harness.tracer);

        await expect(pool.page('steel-1')).rejects.toThrow(/connect refused/);

        expect(harness.span('cdp connect').status.code).toBe(SpanStatusCode.ERROR);
        await harness.shutdown();
    });
});

describe('CdpSessionPool.close', () => {
    it('closes the connection and forgets the session', async () => {
        const { connect, opened } = connector();
        const pool = new CdpSessionPool(config, 1, connect);

        await pool.page('steel-1');
        await pool.close('steel-1');

        expect(opened[0]!.closeCount).toBe(1);
        await pool.page('steel-1');
        expect(opened).toHaveLength(2);
    });

    it('is a no-op for a session it never opened', async () => {
        const { connect, opened } = connector();
        const pool = new CdpSessionPool(config, 1, connect);
        await expect(pool.close('never-seen')).resolves.toBeUndefined();
        expect(opened).toHaveLength(0);
    });

    it('closes a socket that finishes connecting after close was called', async () => {
        const { connect, opened } = connector({ connectDelayMs: 30 });
        const pool = new CdpSessionPool(config, 1, connect);

        const pending = pool.page('steel-1');
        await pool.close('steel-1');
        await pending.catch(() => undefined);

        expect(opened, 'the in-flight connect was never awaited by close').toHaveLength(1);
        expect(opened[0]!.isClosed, 'a socket opened after close() leaked').toBe(true);
    });

    it('closeAll drains every session, including one still connecting', async () => {
        const { connect, opened } = connector({ connectDelayMs: 20 });
        const pool = new CdpSessionPool(config, 1, connect);

        await pool.page('steel-1');
        const pending = pool.page('steel-2');
        await pool.closeAll();
        await pending.catch(() => undefined);

        expect(opened).toHaveLength(2);
        expect(opened.every(connection => connection.isClosed)).toBe(true);
    });
});
