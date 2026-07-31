// ABOUTME: Readers over Steel's two diagnostics endpoints, where a URL sits under a different key
// ABOUTME: per activity type, a log entry's detail arrives JSON-encoded, and most entries are noise.
import type { AgentTrace, SessionLogEntry, SessionLogPayload } from './types.js';

/** Reads a non-empty `url` off any context object, so one reader covers every place it can sit. */
function urlOf(context: unknown): string | undefined {
    if (!context || typeof context !== 'object') return undefined;
    const url = (context as { url?: unknown }).url;
    return typeof url === 'string' && url.length > 0 ? url : undefined;
}

/**
 * The URL an activity happened on.
 *
 * `page.url` is the documented page-context field and wins. A navigation activity carries only
 * `navigation.url` — live navigate activities have no `page` key at all — and a top-level `url` is
 * read last so an activity shaped in a way this server has not seen still resolves instead of
 * rendering a row with no page at all.
 */
export function agentTraceUrl(trace: AgentTrace): string | undefined {
    return urlOf(trace.page) ?? urlOf(trace.navigation) ?? urlOf(trace);
}

/**
 * The readable text of an error activity.
 *
 * Steel documents an `error` field without pinning its shape, so a bare string and an object
 * carrying `message` both resolve and anything else is dropped rather than rendered as
 * `[object Object]`.
 */
export function agentTraceErrorText(trace: AgentTrace): string | undefined {
    const error = trace.error;
    if (typeof error === 'string') return error.length > 0 ? error : undefined;
    if (error && typeof error === 'object') {
        const message = (error as { message?: unknown }).message;
        return typeof message === 'string' && message.length > 0 ? message : undefined;
    }
    return undefined;
}

/**
 * What a change activity says about the text entered.
 *
 * Steel reports this as `{inputType, valueLength}` — a count and a kind, never the characters — so
 * it is safe to render and it answers the question someone debugging a form actually has. A `value`
 * in any other shape is dropped: the metadata object is the only shape known to be content-free,
 * and page input must not reach the transcript on the strength of a guess.
 */
export function agentTraceValueSummary(trace: AgentTrace): string | undefined {
    const value = trace.value;
    if (!value || typeof value !== 'object') return undefined;
    const { inputType, valueLength } = value as { inputType?: unknown; valueLength?: unknown };
    if (typeof valueLength !== 'number' || !Number.isFinite(valueLength) || valueLength < 0) return undefined;
    const kind = typeof inputType === 'string' && inputType.length > 0 ? ` (${inputType})` : '';
    return `${valueLength} chars typed${kind}`;
}

/**
 * Log types that earn no timeline row.
 *
 * Steel emits one entry per HTTP request and one per response: of the 84 entries a single page load
 * produced, 77 were these. Spending the response budget to say a page loaded normally crowds out
 * the entries that explain a session going wrong.
 */
const NOISE_LOG_TYPES: readonly string[] = ['Request', 'Response'];

/**
 * Whether a log entry earns a timeline row.
 *
 * A denylist rather than an allowlist on purpose: the noise is exactly the per-request pair, and a
 * type this server has not seen is likelier to be signal worth showing than more of the same noise,
 * so an unrecognised type is kept.
 */
export function isDiagnosticLog(entry: SessionLogEntry): boolean {
    return !NOISE_LOG_TYPES.includes(entry.type ?? '');
}

/**
 * Parses the JSON-encoded `log` string on an entry.
 *
 * Anything that is not JSON encoding an object yields `undefined`, so a payload Steel changes or
 * truncates costs one row its detail instead of throwing partway through rendering the timeline.
 */
export function parseSessionLogPayload(entry: SessionLogEntry): SessionLogPayload | undefined {
    if (typeof entry.log !== 'string' || entry.log.length === 0) return undefined;
    try {
        const parsed: unknown = JSON.parse(entry.log);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
        return parsed as SessionLogPayload;
    } catch {
        return undefined;
    }
}

/** The URL a log entry concerns: where it navigated, or what failed to load. */
export function sessionLogUrl(payload: SessionLogPayload | undefined): string | undefined {
    if (!payload) return undefined;
    return urlOf(payload.navigation) ?? urlOf(payload.error) ?? urlOf(payload);
}

/** The failure message a log entry records, when it records one. */
export function sessionLogErrorText(payload: SessionLogPayload | undefined): string | undefined {
    const message = payload?.error?.message;
    return typeof message === 'string' && message.length > 0 ? message : undefined;
}
