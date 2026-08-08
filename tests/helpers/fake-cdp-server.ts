// ABOUTME: A fake Chrome DevTools Protocol endpoint over wss, answering the four commands the session
// ABOUTME: viewer sends, emitting screencast frames, and recording every ack so a stall shows up.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type WebSocket, WebSocketServer } from 'ws';

/** The `openssl` this machine has, or `null`; the server needs it to mint its own certificate. */
export function findOpenssl(): string | null {
    const configured = process.env.OPENSSL_PATH;
    if (configured !== undefined && configured !== '') return existsSync(configured) ? configured : null;
    return ['/usr/bin/openssl', '/opt/homebrew/bin/openssl', '/usr/local/bin/openssl'].find(existsSync) ?? null;
}

/** One command the app sent, exactly as it arrived. */
export interface CdpCommand {
    id: number;
    method: string;
    params: Record<string, unknown>;
    /** The flat-mode target session, absent when the app sent the command browser-wide. */
    sessionId?: string;
}

/** A target as `Target.getTargets` reports it. */
export interface FakeTargetInfo {
    targetId: string;
    type: string;
    url: string;
    title?: string;
}

export interface FakeCdpOptions {
    /** Commands the endpoint accepts and never answers, to run the app's own command timeout. */
    stall?: readonly string[];
    /** Commands the endpoint refuses, mapped to the message it refuses them with. */
    refuse?: Readonly<Record<string, string>>;
    /**
     * What `Target.getTargets` reports.
     *
     * The default puts a DevTools page ahead of the real one, so the app's target picking has to skip
     * it rather than screencast the inspector.
     */
    targets?: readonly FakeTargetInfo[];
    /** The flat session id `Target.attachToTarget` hands back, or `null` to hand back none. */
    attachedSessionId?: string | null;
}

const DEFAULT_TARGETS: readonly FakeTargetInfo[] = [
    { targetId: 'devtools-1', type: 'page', url: 'devtools://devtools/bundled/inspector.html' },
    { targetId: 'page-1', type: 'page', url: 'https://example.com/', title: 'Example' },
];

/** The metadata a real `Page.screencastFrame` carries, with the app's defaults for a 1024x768 page. */
export interface FakeFrameMetadata {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
    timestamp: number;
}

export function frameMetadata(overrides: Partial<FakeFrameMetadata> = {}): FakeFrameMetadata {
    return {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: 1024,
        deviceHeight: 768,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        timestamp: Date.now() / 1000,
        ...overrides,
    };
}

let certificate: { key: string; cert: string } | null = null;

/**
 * Mints one throwaway TLS certificate for the whole test process.
 *
 * The app opens `wss:` and nothing else — that is enforced by `validateCdpUrl` and again by the
 * document's own CSP — so the fake endpoint has to speak TLS. The certificate is self-signed and
 * generated per run rather than checked in, and the browser is told to ignore certificate errors.
 */
function tlsCertificate(openssl: string): { key: string; cert: string } {
    if (certificate) return certificate;
    const directory = mkdtempSync(join(tmpdir(), 'steel-viewer-tls-'));
    const keyPath = join(directory, 'key.pem');
    const certPath = join(directory, 'cert.pem');
    execFileSync(
        openssl,
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            keyPath,
            '-out',
            certPath,
            '-days',
            '2',
            '-subj',
            '/CN=localhost',
        ],
        { stdio: 'ignore' }
    );
    certificate = { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
    return certificate;
}

/**
 * A CDP endpoint the app can really connect to.
 *
 * It answers the commands `attach()` sends, refuses a page-scoped command that arrives without the
 * session id it handed out, and records every ack, so "the ack is sent for every frame" becomes
 * something a test can read rather than something the source implies.
 */
export class FakeCdpServer {
    /** Every command the app sent, in arrival order. */
    readonly received: CdpCommand[] = [];
    /** The `sessionId` argument of every `Page.screencastFrameAck`, in arrival order. */
    readonly acks: unknown[] = [];
    /** Things the app did that a real Chrome would have refused. */
    readonly violations: string[] = [];
    /** The request target of each connection, so a test can check the URL was used byte for byte. */
    readonly connectedPaths: string[] = [];
    /** Set once the app closes the socket. */
    closedByApp = false;

    private socket: WebSocket | null = null;
    private nextFrameSessionId = 1;

    private constructor(
        private readonly server: Server,
        private readonly sockets: WebSocketServer,
        /** The URL the live-view tool should hand the app, credential and all. */
        readonly url: string,
        /** The credential inside `url`, which must never reach the app's DOM. */
        readonly token: string,
        private readonly options: FakeCdpOptions
    ) {}

    static async start(openssl: string, options: FakeCdpOptions = {}): Promise<FakeCdpServer> {
        const server = createServer(tlsCertificate(openssl));
        const sockets = new WebSocketServer({ server });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('the fake CDP server has no port');
        const token = `fake-drive-capable-token-${Math.random().toString(36).slice(2)}`;
        const url = `wss://127.0.0.1:${address.port}/v1/devtools/browser/abc123?token=${token}`;
        const fake = new FakeCdpServer(server, sockets, url, token, options);
        sockets.on('connection', (socket, request) => fake.accept(socket, request.url ?? ''));
        return fake;
    }

    get connectionCount(): number {
        return this.connectedPaths.length;
    }

    /** The methods the app sent, in order — what an attach sequence assertion reads. */
    get methods(): string[] {
        return this.received.map(command => command.method);
    }

    /** The Input.* commands the app forwarded, in arrival order — what a take-control test reads. */
    get inputCommands(): CdpCommand[] {
        return this.received.filter(command => command.method.startsWith('Input.'));
    }

    /** Waits until the app has opened a socket. */
    async waitForConnection(timeoutMs = 10_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (this.socket === null) {
            if (Date.now() >= deadline) throw new Error(`the app never connected within ${timeoutMs}ms`);
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }

    /** Waits until the app has sent `method` at least `count` times, then returns those commands. */
    async waitFor(method: string, count = 1, timeoutMs = 10_000): Promise<CdpCommand[]> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const matching = this.received.filter(command => command.method === method);
            if (matching.length >= count) return matching;
            if (Date.now() >= deadline) {
                throw new Error(
                    `the app sent ${method} ${matching.length} times in ${timeoutMs}ms, expected ${count}; ` +
                        `it sent ${JSON.stringify(this.methods)}`
                );
            }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }

    /**
     * Emits one `Page.screencastFrame` and returns the frame session id it used.
     *
     * That id is an integer, as Chrome types it, and `Page.screencastFrameAck` has to echo it back
     * unchanged or a real browser sends nothing further.
     */
    sendFrame(base64Jpeg: string, metadata: FakeFrameMetadata = frameMetadata()): number {
        if (this.socket === null) throw new Error('no app is connected, so no frame can be sent');
        const sessionId = this.nextFrameSessionId++;
        this.socket.send(
            JSON.stringify({
                method: 'Page.screencastFrame',
                sessionId: this.attachedSessionId,
                params: { data: base64Jpeg, sessionId, metadata },
            })
        );
        return sessionId;
    }

    /** Tells the controlling viewer that the remote page opened an input[type=file]. */
    sendFileChooser(backendNodeId = 42): void {
        if (this.socket === null) throw new Error('no app is connected, so no file chooser can be sent');
        this.socket.send(
            JSON.stringify({
                method: 'Page.fileChooserOpened',
                sessionId: this.attachedSessionId,
                params: { mode: 'selectSingle', backendNodeId },
            })
        );
    }

    /**
     * Sends a payload straight down the socket, bypassing the CDP shape entirely.
     *
     * Everything CDP sends the app is JSON text, so this is how a test checks the app's guard against
     * a binary frame or a payload that does not parse.
     */
    sendRaw(payload: string | Buffer): void {
        if (this.socket === null) throw new Error('no app is connected, so nothing can be sent');
        this.socket.send(payload);
    }

    /** Drops the connection the way a browser that has gone away does. */
    dropConnection(): void {
        this.socket?.terminate();
    }

    async stop(): Promise<void> {
        this.socket?.terminate();
        await new Promise<void>(resolve => this.sockets.close(() => resolve()));
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }

    private get attachedSessionId(): string | null {
        return this.options.attachedSessionId === undefined ? 'page-session-1' : this.options.attachedSessionId;
    }

    private accept(socket: WebSocket, path: string): void {
        this.connectedPaths.push(path);
        this.socket = socket;
        socket.on('close', () => {
            this.closedByApp = true;
        });
        socket.on('message', raw => this.handle(socket, raw.toString()));
    }

    private handle(socket: WebSocket, raw: string): void {
        const command = JSON.parse(raw) as CdpCommand;
        this.received.push(command);
        if (command.method === 'Page.screencastFrameAck') this.acks.push(command.params.sessionId);

        // Everything after the attach is page-scoped, and a real Chrome answers "session not found"
        // when a command that needs one arrives without it.
        const scoped = command.method !== 'Target.getTargets' && command.method !== 'Target.attachToTarget';
        if (scoped && this.attachedSessionId !== null && command.sessionId !== this.attachedSessionId) {
            this.violations.push(`${command.method} arrived with sessionId ${JSON.stringify(command.sessionId)}`);
            this.fail(socket, command, 'Session with given id not found.');
            return;
        }
        if (this.options.stall?.includes(command.method)) return;
        const refusal = this.options.refuse?.[command.method];
        if (refusal !== undefined) {
            this.fail(socket, command, refusal);
            return;
        }

        if (command.method === 'Target.getTargets') {
            this.reply(socket, command, { targetInfos: this.options.targets ?? DEFAULT_TARGETS });
            return;
        }
        if (command.method === 'Target.attachToTarget') {
            if (command.params.flatten !== true) this.violations.push('Target.attachToTarget without flatten: true');
            this.reply(socket, command, this.attachedSessionId === null ? {} : { sessionId: this.attachedSessionId });
            return;
        }
        if (command.method === 'DOM.resolveNode') {
            this.reply(socket, command, { object: { type: 'object', objectId: 'remote-file-input-1' } });
            return;
        }
        if (command.method === 'Runtime.evaluate') {
            this.reply(socket, command, { result: { type: 'string', value: 'https://example.com' } });
            return;
        }
        if (command.method === 'Runtime.callFunctionOn') {
            this.reply(socket, command, { result: { type: 'boolean', value: true } });
            return;
        }
        if (command.method === 'Page.screencastFrameAck' && !Number.isInteger(command.params.sessionId)) {
            // Chrome types this argument as int32 and rejects anything else, which stalls the stream.
            this.violations.push('Page.screencastFrameAck with a non-integer sessionId');
            this.fail(socket, command, 'Failed to deserialize params.sessionId - BINDINGS: int32 value expected');
            return;
        }
        this.reply(socket, command, {});
    }

    private reply(socket: WebSocket, command: CdpCommand, result: unknown): void {
        socket.send(JSON.stringify({ id: command.id, sessionId: command.sessionId, result }));
    }

    private fail(socket: WebSocket, command: CdpCommand, message: string): void {
        socket.send(JSON.stringify({ id: command.id, sessionId: command.sessionId, error: { code: -32602, message } }));
    }
}
