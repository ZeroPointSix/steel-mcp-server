// ABOUTME: Integration tests for the CDP client against a real WebSocket server speaking minimal
// ABOUTME: CDP, covering the abort contract: cancel the handshake, never close a live connection.
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { CdpConnection } from '../../src/core/steel/cdp.js';

interface Harness {
    url: string;
    close(): Promise<void>;
    /** Methods the fake browser refuses to answer, so a caller's timeout path can be exercised. */
    silent: Set<string>;
}

async function startFakeBrowser(): Promise<Harness> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const silent = new Set<string>();

    server.on('connection', socket => {
        socket.on('message', raw => {
            const message = JSON.parse(String(raw)) as { id: number; method: string; sessionId?: string };
            if (silent.has(message.method)) return;

            const reply = (result: unknown) =>
                socket.send(JSON.stringify({ id: message.id, result, sessionId: message.sessionId }));

            switch (message.method) {
                case 'Target.getTargets':
                    reply({
                        targetInfos: [
                            { targetId: 'bg', type: 'background_page' },
                            { targetId: 'page-1', type: 'page' },
                        ],
                    });
                    break;
                case 'Target.attachToTarget':
                    reply({ sessionId: 'attached-1' });
                    break;
                case 'Nonexistent.method':
                    socket.send(
                        JSON.stringify({ id: message.id, error: { code: -32601, message: 'method not found' } })
                    );
                    break;
                default:
                    reply({ ok: true });
            }
        });
    });

    await new Promise<void>(resolve => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `ws://127.0.0.1:${port}/`,
        silent,
        close: () =>
            new Promise<void>(resolve => {
                for (const client of server.clients) client.terminate();
                server.close(() => resolve());
            }),
    };
}

let harness: Harness;

beforeEach(async () => {
    harness = await startFakeBrowser();
});

afterEach(async () => {
    await harness.close();
});

describe('CdpConnection.connect', () => {
    it('connects, attaches to the page target and round-trips a command', async () => {
        const connection = await CdpConnection.connect(harness.url);
        const session = await connection.attachToPage();
        await expect(session.send('Page.enable')).resolves.toEqual({ ok: true });
        await connection.close();
    });

    it('reports a protocol error from the browser as a tool error naming the method', async () => {
        const connection = await CdpConnection.connect(harness.url);
        await expect(connection.send('Nonexistent.method')).rejects.toThrow(/Nonexistent\.method.*method not found/);
        await connection.close();
    });

    // Both abort paths reach terminate() on a socket that never opened. Vitest fails the run on an
    // uncaught exception, so these also pin that terminate() never escapes as one.
    it('rejects when the signal is already aborted before the connection starts', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(CdpConnection.connect(harness.url, controller.signal)).rejects.toThrow(/cancelled/i);
    });

    it('rejects when the signal aborts during the handshake', async () => {
        const controller = new AbortController();
        const connecting = CdpConnection.connect(harness.url, controller.signal);
        controller.abort();
        await expect(connecting).rejects.toThrow(/cancelled/i);
    });

    it('reports an unreachable browser rather than hanging', async () => {
        await expect(CdpConnection.connect('ws://127.0.0.1:1/')).rejects.toThrow(/could not open/i);
    });
});

describe('the abort contract after the handshake', () => {
    it('leaves the connection usable when the request that opened it is cancelled', async () => {
        const controller = new AbortController();
        const connection = await CdpConnection.connect(harness.url, controller.signal);

        // The signal belongs to one tool call. The connection is pooled for the whole session, so
        // cancelling that call must not brick the handle while Steel keeps billing for the browser.
        controller.abort();
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(connection.isClosed).toBe(false);
        await expect(connection.send('Page.enable')).resolves.toEqual({ ok: true });
        await connection.close();
    });

    it('reports itself closed only once it really is', async () => {
        const connection = await CdpConnection.connect(harness.url);
        expect(connection.isClosed).toBe(false);
        await connection.close();
        expect(connection.isClosed).toBe(true);
    });

    it('rejects further commands after close, naming the recovery', async () => {
        const connection = await CdpConnection.connect(harness.url);
        await connection.close();
        await expect(connection.send('Page.enable')).rejects.toThrow(/create a new session/i);
    });

    it('fails in-flight commands when the browser goes away', async () => {
        harness.silent.add('Page.enable');
        const connection = await CdpConnection.connect(harness.url);
        const pending = connection.send('Page.enable');
        await harness.close();
        await expect(pending).rejects.toThrow(/connection (closed|failed)/i);
        expect(connection.isClosed).toBe(true);
    });
});
