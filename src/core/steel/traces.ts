// ABOUTME: Readers for the fields of one agent-trace activity, whose URL sits under a different key
// ABOUTME: depending on the activity type and whose error is documented without a pinned shape.
import type { AgentTrace } from './types.js';

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
 * `navigation.url`, and a top-level `url` is read last so an activity shaped in a way this server
 * has not seen still resolves instead of rendering a row with no page at all.
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
