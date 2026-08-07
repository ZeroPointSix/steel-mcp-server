// ABOUTME: Launches a local headless Chrome and drives it over CDP, exposing one session for a host
// ABOUTME: page and one for the sandboxed app frame inside it, so a test can read what the app painted.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

/**
 * How much of Chrome's stderr to keep for a failure message. A browser that grumbles for the whole
 * startup timeout must not grow the heap, and only the last lines say why it stopped.
 */
const STDERR_TAIL_CHARS = 4096;

/** Browsers that can run the app, in the order they are preferred. `CHROME_PATH` wins over all. */
const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
];

/** The Chrome binary this machine has, or `null` when there is none to run. */
export function findChrome(): string | null {
    const configured = process.env.CHROME_PATH;
    if (configured !== undefined && configured !== '') return existsSync(configured) ? configured : null;
    return CHROME_CANDIDATES.find(existsSync) ?? null;
}

/**
 * Writes a skip reason to stderr.
 *
 * Vitest does not print the names of skipped suites at default verbosity, so without this a machine
 * with no Chrome looks exactly like a suite nobody wrote.
 */
export function announceMissing(suite: string, missing: readonly string[]): void {
    if (missing.length === 0) return;
    if (process.env.CI === 'true') {
        throw new Error(`${suite} requires ${missing.join(' and ')} in CI; skipping browser coverage is forbidden.`);
    }
    process.stderr.write(
        `\n  SKIPPED ${suite}: this machine has no ${missing.join(' and no ')}.\n` +
            '  Install Google Chrome (or point CHROME_PATH at a Chromium build) and re-run npm run test:browser.\n\n'
    );
}

/**
 * Polls `read` until `ok` accepts what it returns, then returns that value.
 *
 * Browser-side effects land asynchronously and at times only the renderer decides, so every wait in
 * these tests is on an observable condition rather than a sleep, and reports what it last saw when
 * it gives up.
 */
export async function until<T>(
    label: string,
    read: () => Promise<T>,
    ok: (value: T) => boolean,
    timeoutMs = 10_000
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let seen = await read();
    while (!ok(seen)) {
        if (Date.now() >= deadline) {
            throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}; last saw ${JSON.stringify(seen)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        seen = await read();
    }
    return seen;
}

interface CdpEvent {
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
}

/** One CDP socket, with id-matched replies and a session id on every command that needs one. */
class CdpConnection {
    private nextId = 0;
    private readonly pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
    private readonly listeners = new Set<(event: CdpEvent) => void>();

    private constructor(private readonly socket: WebSocket) {
        socket.on('message', raw => {
            const message = JSON.parse(raw.toString()) as {
                id?: number;
                result?: unknown;
                error?: { message?: string };
            } & Partial<CdpEvent>;
            if (typeof message.id === 'number') {
                const waiter = this.pending.get(message.id);
                if (!waiter) return;
                this.pending.delete(message.id);
                if (message.error) waiter.reject(new Error(`CDP refused the command: ${message.error.message}`));
                else waiter.resolve(message.result as never);
                return;
            }
            if (typeof message.method !== 'string') return;
            const event: CdpEvent = {
                method: message.method,
                params: message.params ?? {},
                sessionId: message.sessionId,
            };
            for (const listener of this.listeners) listener(event);
        });
    }

    static async open(url: string): Promise<CdpConnection> {
        const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 << 20 });
        await new Promise<void>((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        return new CdpConnection(socket);
    }

    send<T = Record<string, unknown>>(
        method: string,
        params: Record<string, unknown> = {},
        sessionId?: string
    ): Promise<T> {
        const id = ++this.nextId;
        this.socket.send(
            JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId })
        );
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (value: never) => void, reject });
            setTimeout(() => {
                if (this.pending.delete(id)) reject(new Error(`${method} got no CDP reply within 20s`));
            }, 20_000);
        });
    }

    on(listener: (event: CdpEvent) => void): void {
        this.listeners.add(listener);
    }

    close(): void {
        this.socket.close();
    }
}

/**
 * A page holding the fake host document, plus the app frame nested inside it.
 *
 * The app runs in a `sandbox="allow-scripts"` iframe and so has an opaque origin: the host page's own
 * scripts cannot reach into it at all, which is the point. Reading the app's DOM therefore goes
 * through the app frame's own CDP session rather than through the host page.
 */
export class BrowserPage {
    private appSession: string | null = null;
    /** Uncaught errors the app frame reported, so a broken app cannot pass quietly. */
    readonly appExceptions: string[] = [];

    constructor(
        private readonly connection: CdpConnection,
        private readonly targetId: string,
        private readonly pageSession: string
    ) {
        connection.on(event => {
            if (event.method === 'Target.attachedToTarget' && event.sessionId === this.pageSession) {
                const info = event.params.targetInfo as { type?: string } | undefined;
                if (info?.type === 'iframe') this.appSession = event.params.sessionId as string;
                return;
            }
            if (event.method === 'Runtime.exceptionThrown' && event.sessionId === this.appSession) {
                const details = event.params.exceptionDetails as
                    | { text?: string; exception?: { description?: string } }
                    | undefined;
                this.appExceptions.push(details?.exception?.description ?? details?.text ?? 'unknown exception');
            }
        });
    }

    /** Loads `url` and waits until the app frame inside it has built its DOM. */
    async load(url: string): Promise<void> {
        await this.connection.send('Page.navigate', { url }, this.pageSession);
        await until(
            'the app frame to attach',
            async () => this.appSession,
            found => found !== null
        );
        await this.connection.send('Runtime.enable', {}, this.appSession!);
        await until(
            'the app document to build its stage',
            () => this.evalInApp<boolean>("document.getElementById('stage') !== null").catch(() => false),
            built => built
        );
    }

    /** Evaluates in the fake host page, which owns the postMessage log. */
    evalInHost<T>(expression: string): Promise<T> {
        return this.evaluate<T>(this.pageSession, expression);
    }

    /** Evaluates inside the app frame, the only way to see the DOM the app writes. */
    evalInApp<T>(expression: string): Promise<T> {
        if (this.appSession === null) throw new Error('the app frame has not attached yet');
        return this.evaluate<T>(this.appSession, expression);
    }

    /** Clicks at a point in the top-level page, in its own CSS pixels. */
    async clickAt(x: number, y: number): Promise<void> {
        for (const type of ['mousePressed', 'mouseReleased']) {
            await this.connection.send(
                'Input.dispatchMouseEvent',
                { type, x, y, button: 'left', buttons: 1, clickCount: 1 },
                this.pageSession
            );
        }
    }

    /** Navigates away, which is what makes the app frame fire `pagehide` for real. */
    async navigateAway(): Promise<void> {
        await this.connection.send('Page.navigate', { url: 'about:blank' }, this.pageSession);
    }

    async close(): Promise<void> {
        await this.connection.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
    }

    private async evaluate<T>(sessionId: string, expression: string): Promise<T> {
        const reply = await this.connection.send<{
            result: { value?: unknown };
            exceptionDetails?: { text?: string; exception?: { description?: string } };
        }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (reply.exceptionDetails) {
            const details = reply.exceptionDetails;
            throw new Error(`evaluating in the browser threw: ${details.exception?.description ?? details.text}`);
        }
        return reply.result.value as T;
    }
}

/** A headless Chrome the tests own for the whole file, one fresh page per test. */
export class HeadlessChrome {
    private jpegSession: BrowserPage | null = null;

    private constructor(
        private readonly process: ChildProcess,
        private readonly connection: CdpConnection,
        private readonly profile: string
    ) {}

    static async launch(binary: string): Promise<HeadlessChrome> {
        const profile = mkdtempSync(join(tmpdir(), 'steel-viewer-chrome-'));
        const child = spawn(
            binary,
            [
                '--headless=new',
                '--remote-debugging-port=0',
                `--user-data-dir=${profile}`,
                '--no-first-run',
                '--no-default-browser-check',
                '--window-size=1000,700',
                // The fake CDP endpoint is a self-signed TLS server, because the app only ever opens
                // a `wss:` URL and its own CSP allows no other scheme.
                '--ignore-certificate-errors',
                // The app's phases are driven by a 400ms interval and two timeouts, and a renderer
                // Chrome considers hidden throttles both, which would show up as flaky phases.
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                'about:blank',
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] }
        );
        // Chrome writes its startup banner and any GPU grumbling to stderr; draining keeps the pipe
        // from filling and the test output clean. The tail is kept rather than discarded, because a
        // browser that refuses to start says why here and nowhere else.
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
        });
        // A browser that dies on startup never writes the port file, so without this the wait runs
        // its full timeout and reports a deadline instead of the exit that caused it.
        let exited: string | undefined;
        child.on('exit', (code, signal) => {
            exited = signal === null ? `exited with code ${code}` : `was killed by ${signal}`;
        });

        try {
            const url = await readDebuggerUrl(profile, 20_000, {
                exited: () => exited,
                stderr: () => stderr,
            });
            const connection = await CdpConnection.open(url);
            return new HeadlessChrome(child, connection, profile);
        } catch (error) {
            child.kill('SIGKILL');
            rmSync(profile, { recursive: true, force: true, maxRetries: 20 });
            throw error;
        }
    }

    /** Opens a fresh tab on `url` and waits for the app frame inside it. */
    async openPage(url: string): Promise<BrowserPage> {
        const { targetId } = await this.connection.send<{ targetId: string }>('Target.createTarget', {
            url: 'about:blank',
            background: false,
        });
        const { sessionId } = await this.connection.send<{ sessionId: string }>('Target.attachToTarget', {
            targetId,
            flatten: true,
        });
        await this.connection.send('Page.enable', {}, sessionId);
        // The app frame is sandboxed, so Chrome gives it its own target; auto-attach is how a
        // session for it arrives.
        await this.connection.send(
            'Target.setAutoAttach',
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
            sessionId
        );
        const page = new BrowserPage(this.connection, targetId, sessionId);
        await page.load(url);
        return page;
    }

    /**
     * Encodes a real solid-colour JPEG and returns its base64 payload.
     *
     * The fake screencast needs bytes a JPEG decoder accepts, and the honest way to get them is to
     * let the same browser that will decode them do the encoding.
     */
    async encodeJpeg(cssColor: string, width: number, height: number): Promise<string> {
        this.jpegSession ??= await this.openBlankPage();
        return this.jpegSession.evalInHost<string>(
            `(function(){` +
                `var canvas = document.createElement('canvas');` +
                `canvas.width = ${width}; canvas.height = ${height};` +
                `var context = canvas.getContext('2d');` +
                `context.fillStyle = ${JSON.stringify(cssColor)};` +
                `context.fillRect(0, 0, ${width}, ${height});` +
                `return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];` +
                `})()`
        );
    }

    async close(): Promise<void> {
        this.connection.close();
        this.process.kill('SIGKILL');
        await new Promise<void>(resolve => this.process.once('exit', () => resolve()));
        rmSync(this.profile, { recursive: true, force: true, maxRetries: 20 });
    }

    /** A tab with no app frame in it, used only as a scratch canvas for JPEG encoding. */
    private async openBlankPage(): Promise<BrowserPage> {
        const { targetId } = await this.connection.send<{ targetId: string }>('Target.createTarget', {
            url: 'about:blank',
            background: true,
        });
        const { sessionId } = await this.connection.send<{ sessionId: string }>('Target.attachToTarget', {
            targetId,
            flatten: true,
        });
        return new BrowserPage(this.connection, targetId, sessionId);
    }
}

/** What a launching Chrome has said and whether it is still alive, so a failure can name its cause. */
interface LaunchWatch {
    /** How the process ended, or `undefined` while it is still running. */
    exited: () => string | undefined;
    /** The tail of everything the process wrote to stderr. */
    stderr: () => string;
}

/**
 * Reads the debugging endpoint Chrome writes into its profile once it is listening.
 *
 * Asking for port 0 and reading the port back is what keeps two runs on one machine from fighting
 * over a hardcoded port.
 */
async function readDebuggerUrl(profile: string, timeoutMs: number, watch: LaunchWatch): Promise<string> {
    const file = join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const [port, path] = readFileSync(file, 'utf8').split('\n');
            if (port !== undefined && path !== undefined && path !== '') return `ws://127.0.0.1:${port}${path}`;
        } catch {
            // Chrome has not written the file yet.
        }
        const ending = watch.exited();
        if (ending !== undefined) {
            throw new Error(`Chrome ${ending} before it started listening.${reportStderr(watch.stderr())}`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(
        `Chrome did not start listening within ${timeoutMs}ms (no ${file}).${reportStderr(watch.stderr())}`
    );
}

/** Renders the captured stderr for an error message, saying so plainly when there was none. */
function reportStderr(stderr: string): string {
    const text = stderr.trim();
    return text === '' ? ' It wrote nothing to stderr.' : `\nChrome stderr:\n${text}`;
}
