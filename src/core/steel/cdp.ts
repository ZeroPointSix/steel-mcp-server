// ABOUTME: A minimal Chrome DevTools Protocol client over a WebSocket, plus the page-scoped session
// ABOUTME: interface every page operation is written against so tests can inject a fake.
import { WebSocket } from 'ws';
import { SteelToolError } from '../errors.js';

/** A CDP event payload. Shapes are protocol-defined; call sites narrow what they read. */
export type CdpEventParams = Record<string, unknown>;

/** A CDP connection scoped to one page target. All page operations depend on this, not on a socket. */
export interface CdpSession {
    send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
    /** Subscribes to a CDP event; the returned function unsubscribes. */
    on(event: string, listener: (params: CdpEventParams) => void): () => void;
    close(): Promise<void>;
}

interface Pending {
    resolve(value: unknown): void;
    reject(error: Error): void;
    method: string;
}

interface CdpMessage {
    id?: number;
    method?: string;
    params?: CdpEventParams;
    sessionId?: string;
    result?: unknown;
    error?: { code: number; message: string; data?: string };
}

/** How long to wait for a single CDP command before giving up. */
const COMMAND_TIMEOUT_MS = 30_000;

/** A browser-level CDP connection that can attach page-scoped sessions over the same socket. */
export class CdpConnection {
    private readonly pending = new Map<number, Pending>();
    private readonly listeners = new Map<string, Set<(params: CdpEventParams, sessionId?: string) => void>>();
    private nextId = 1;
    private closed = false;

    private constructor(private readonly socket: WebSocket) {
        socket.on('message', raw => this.receive(String(raw)));
        socket.on('close', () => this.failAll('The CDP connection closed.'));
        socket.on('error', error => this.failAll(`The CDP connection failed: ${error.message}`));
    }

    /** True once the socket is gone, so a pool can evict this connection instead of reusing it. */
    get isClosed(): boolean {
        return this.closed;
    }

    /**
     * Opens a CDP connection.
     *
     * The signal cancels the handshake only. It deliberately does not survive into the established
     * connection: the signal belongs to one tool call, while the connection is pooled for the whole
     * browser session, so honouring a later abort would brick the session handle for every
     * subsequent call while Steel kept billing for the browser.
     */
    static async connect(url: string, signal?: AbortSignal): Promise<CdpConnection> {
        const socket = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
        try {
            await new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                    reject(
                        new SteelToolError('The request was cancelled before the browser connected.', {
                            code: 'timeout',
                        })
                    );
                };
                if (signal?.aborted) {
                    onAbort();
                    return;
                }
                signal?.addEventListener('abort', onAbort, { once: true });
                socket.once('open', () => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                });
                socket.once('error', error => {
                    signal?.removeEventListener('abort', onAbort);
                    reject(
                        new SteelToolError(`Could not open a browser connection: ${error.message}`, {
                            code: 'steel_error',
                        })
                    );
                });
            });
        } catch (error) {
            socket.terminate();
            throw error;
        }

        return new CdpConnection(socket);
    }

    private receive(raw: string): void {
        let message: CdpMessage;
        try {
            message = JSON.parse(raw) as CdpMessage;
        } catch {
            return;
        }

        if (message.id !== undefined) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error) {
                pending.reject(
                    new SteelToolError(`${pending.method} failed: ${message.error.message}`, { code: 'steel_error' })
                );
            } else {
                pending.resolve(message.result);
            }
            return;
        }

        if (message.method) {
            for (const listener of this.listeners.get(message.method) ?? []) {
                listener(message.params ?? {}, message.sessionId);
            }
        }
    }

    private failAll(reason: string): void {
        this.closed = true;
        for (const pending of this.pending.values()) {
            pending.reject(new SteelToolError(reason, { code: 'steel_error' }));
        }
        this.pending.clear();
    }

    /** Sends a CDP command, optionally targeting an attached page session. */
    async send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
        if (this.closed) {
            throw new SteelToolError('The browser connection is closed. Create a new session.', {
                code: 'session_expired',
            });
        }
        const id = this.nextId++;
        const payload = JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params });

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(
                    new SteelToolError(`${method} did not answer within ${COMMAND_TIMEOUT_MS}ms.`, { code: 'timeout' })
                );
            }, COMMAND_TIMEOUT_MS);

            this.pending.set(id, {
                method,
                resolve: value => {
                    clearTimeout(timer);
                    resolve(value as T);
                },
                reject: error => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
            this.socket.send(payload);
        });
    }

    /** Subscribes to a CDP event across every session on this connection. */
    on(event: string, listener: (params: CdpEventParams, sessionId?: string) => void): () => void {
        const set = this.listeners.get(event) ?? new Set();
        set.add(listener);
        this.listeners.set(event, set);
        return () => set.delete(listener);
    }

    /**
     * Attaches to the first page target and returns a session bound to it.
     *
     * Only one page is ever attached: eagerly attaching to every target is how a long-lived
     * browser connection exhausts memory on a site that opens many tabs.
     */
    async attachToPage(): Promise<CdpSession> {
        const { targetInfos } = await this.send<{ targetInfos: Array<{ targetId: string; type: string }> }>(
            'Target.getTargets'
        );
        const page = targetInfos.find(target => target.type === 'page');
        if (!page) {
            throw new SteelToolError('The browser session has no open page to attach to.', { code: 'steel_error' });
        }
        const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', {
            targetId: page.targetId,
            flatten: true,
        });
        return new AttachedCdpSession(this, sessionId);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.socket.close();
        this.failAll('The CDP connection was closed by this server.');
    }
}

/** A page-scoped view of a browser connection: every command and event carries the target session. */
class AttachedCdpSession implements CdpSession {
    constructor(
        private readonly connection: CdpConnection,
        private readonly sessionId: string
    ) {}

    send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        return this.connection.send<T>(method, params, this.sessionId);
    }

    on(event: string, listener: (params: CdpEventParams) => void): () => void {
        return this.connection.on(event, (params, sessionId) => {
            if (sessionId === this.sessionId) listener(params);
        });
    }

    async close(): Promise<void> {
        await this.connection.close();
    }
}
