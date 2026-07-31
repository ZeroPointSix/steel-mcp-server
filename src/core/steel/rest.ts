// ABOUTME: Thin typed REST client for the Steel /v1 surface, with the fetch implementation injected
// ABOUTME: so tests exercise the wire shape without a network, and every failure mapped to prose.
import { type Tracer, trace } from '@opentelemetry/api';
import type { SteelConfig } from '../config.js';
import { mapSteelHttpError, type SteelErrorBody, type SteelOperation, SteelToolError } from '../errors.js';
import { activeTraceparent, resolveTracer, withSteelCallSpan } from '../telemetry.js';
import type {
    AccountDetails,
    AgentTraceTimeline,
    ArtifactRequest,
    ArtifactResponse,
    CreateSessionRequest,
    ScrapeRequest,
    ScrapeResponse,
    SessionLogTimeline,
    SteelApi,
    SteelSession,
} from './types.js';

/** The subset of `fetch` this client uses, so a test can supply a plain function. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface RequestSpec {
    method: 'GET' | 'POST';
    path: string;
    body?: Record<string, unknown> | undefined;
    operation: SteelOperation;
    signal?: AbortSignal | undefined;
    /** Statuses answered with `undefined` instead of an error, for idempotent operations. */
    tolerate?: number[] | undefined;
}

function dropUndefined(body: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

async function readErrorBody(response: Response): Promise<SteelErrorBody> {
    try {
        const parsed: unknown = await response.json();
        if (parsed && typeof parsed === 'object') return parsed as SteelErrorBody;
    } catch {
        // A gateway in front of Steel can answer with HTML; fall through to the status-only message.
    }
    return { message: `Steel returned HTTP ${response.status} ${response.statusText}`.trim() };
}

function parseRetryAfter(response: Response): number | undefined {
    const header = response.headers.get('retry-after');
    if (!header) return undefined;
    const seconds = Number.parseInt(header, 10);
    return Number.isFinite(seconds) ? seconds : undefined;
}

/** Typed access to the Steel REST endpoints this server needs. */
export class SteelRestClient implements SteelApi {
    constructor(
        private readonly config: SteelConfig,
        private readonly fetchImpl: FetchLike = globalThis.fetch,
        private readonly tracer: Tracer = resolveTracer()
    ) {}

    /** Wraps every call in a client span, which is also what the outbound traceparent names. */
    private async request<T>(spec: RequestSpec): Promise<T | undefined> {
        return withSteelCallSpan(
            this.tracer,
            {
                method: spec.method,
                path: `/v1${spec.path}`,
                host: new URL(this.config.baseUrl).host,
                operation: spec.operation,
            },
            () => this.send<T>(spec)
        );
    }

    private async send<T>(spec: RequestSpec): Promise<T | undefined> {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
        if (spec.body) headers['content-type'] = 'application/json';
        // Only set when something is actually tracing, so an untraced deployment sends what it always did.
        const traceparent = activeTraceparent();
        if (traceparent) headers.traceparent = traceparent;

        const init: RequestInit = { method: spec.method, headers };
        if (spec.body) init.body = JSON.stringify(dropUndefined(spec.body));
        if (spec.signal) init.signal = spec.signal;

        let response: Response;
        try {
            response = await this.fetchImpl(`${this.config.baseUrl}/v1${spec.path}`, init);
        } catch (cause) {
            if (spec.signal?.aborted) {
                throw new SteelToolError('The request was cancelled by the caller.', { code: 'timeout' });
            }
            throw new SteelToolError(
                `Could not reach Steel at ${this.config.baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
                { code: 'steel_error' }
            );
        }

        trace.getActiveSpan()?.setAttribute('http.response.status_code', response.status);

        if (spec.tolerate?.includes(response.status)) return undefined;

        if (!response.ok) {
            throw mapSteelHttpError(response.status, await readErrorBody(response), {
                operation: spec.operation,
                retryAfterSeconds: parseRetryAfter(response),
            });
        }

        if (response.status === 204) return undefined;
        return (await response.json()) as T;
    }

    private async requireJson<T>(spec: RequestSpec): Promise<T> {
        const result = await this.request<T>(spec);
        if (result === undefined) {
            throw new SteelToolError(`Steel returned an empty body for ${spec.path}.`, { code: 'steel_error' });
        }
        return result;
    }

    async scrape(request: ScrapeRequest, signal?: AbortSignal): Promise<ScrapeResponse> {
        return this.requireJson<ScrapeResponse>({
            method: 'POST',
            path: '/scrape',
            operation: 'browser_tool',
            signal,
            body: {
                url: request.url,
                format: request.format,
                delay: request.delay,
                useProxy: request.useProxy,
                screenshot: request.screenshot,
                pdf: request.pdf,
            },
        });
    }

    async screenshot(request: ArtifactRequest, signal?: AbortSignal): Promise<ArtifactResponse> {
        return this.requireJson<ArtifactResponse>({
            method: 'POST',
            path: '/screenshot',
            operation: 'browser_tool',
            signal,
            body: {
                url: request.url,
                fullPage: request.fullPage,
                delay: request.delay,
                useProxy: request.useProxy,
            },
        });
    }

    async pdf(request: ArtifactRequest, signal?: AbortSignal): Promise<ArtifactResponse> {
        return this.requireJson<ArtifactResponse>({
            method: 'POST',
            path: '/pdf',
            operation: 'browser_tool',
            signal,
            body: { url: request.url, delay: request.delay, useProxy: request.useProxy },
        });
    }

    async createSession(request: CreateSessionRequest, signal?: AbortSignal): Promise<SteelSession> {
        return this.requireJson<SteelSession>({
            method: 'POST',
            path: '/sessions',
            operation: 'session_create',
            signal,
            body: { ...request },
        });
    }

    async releaseSession(sessionId: string, signal?: AbortSignal): Promise<void> {
        await this.request({
            method: 'POST',
            path: `/sessions/${encodeURIComponent(sessionId)}/release`,
            operation: 'session_release',
            signal,
            // Releasing an already-released or unknown session is a no-op, not a failure.
            tolerate: [404],
        });
    }

    async getSession(sessionId: string, signal?: AbortSignal): Promise<SteelSession> {
        return this.requireJson<SteelSession>({
            method: 'GET',
            path: `/sessions/${encodeURIComponent(sessionId)}`,
            operation: 'account',
            signal,
        });
    }

    async getDetails(signal?: AbortSignal): Promise<AccountDetails> {
        return this.requireJson<AccountDetails>({
            method: 'GET',
            path: '/details',
            operation: 'account',
            signal,
        });
    }

    /**
     * Reads the trace timeline, which arrives as an `{events,total,hasMore}` envelope rather than a
     * bare array. The envelope is passed through so a caller can see that Steel holds more activity
     * than it sent; only a missing `events` is normalised, so a shape surprise cannot become a
     * TypeError in a renderer.
     */
    async getAgentTraces(sessionId: string, signal?: AbortSignal): Promise<AgentTraceTimeline> {
        const timeline = await this.requireJson<AgentTraceTimeline>({
            method: 'GET',
            path: `/sessions/${encodeURIComponent(sessionId)}/agent-traces`,
            operation: 'account',
            signal,
        });
        return { ...timeline, events: Array.isArray(timeline.events) ? timeline.events : [] };
    }

    /** Reads the session log, which uses the same envelope as `agent-traces` and is normalised alike. */
    async getSessionLogs(sessionId: string, signal?: AbortSignal): Promise<SessionLogTimeline> {
        const timeline = await this.requireJson<SessionLogTimeline>({
            method: 'GET',
            path: `/sessions/${encodeURIComponent(sessionId)}/logs`,
            operation: 'account',
            signal,
        });
        return { ...timeline, events: Array.isArray(timeline.events) ? timeline.events : [] };
    }
}
