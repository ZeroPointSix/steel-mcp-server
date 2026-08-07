// ABOUTME: Token budgeting and cursor pagination for every text-returning tool, so a large page
// ABOUTME: is truncated visibly at a line boundary and can be walked rather than silently clipped.
import { createHash } from 'node:crypto';
import { SteelToolError } from './errors.js';

/** Claude Code's default cap on a single tool response. Every budget must stay well under it. */
export const HOST_RESPONSE_TOKEN_CAP = 25_000;

/** Default per-tool budget, leaving room for the envelope and the host's own overhead. */
export const DEFAULT_MAX_TOKENS = 8_000;

/** Rough token count. Deliberately cheap: exactness costs a tokenizer dependency and buys nothing. */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export interface PaginateOptions {
    maxTokens?: number | undefined;
    cursor?: string | undefined;
}

export interface Page {
    text: string;
    /** Present only when there is more to read. */
    nextCursor: string | undefined;
    truncated: boolean;
    /** Token estimate of the whole document, so the caller can say how much is left. */
    totalTokens: number;
}

interface CursorPayload {
    offset: number;
    fingerprint: string;
}

function fingerprint(text: string): string {
    return createHash('sha256').update(text).digest('base64url').slice(0, 12);
}

function encodeCursor(payload: CursorPayload): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, text: string): number {
    let payload: CursorPayload;
    try {
        payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
    } catch {
        throw new SteelToolError(
            'That cursor is not readable. Drop the cursor argument to start again from the beginning.',
            { code: 'invalid_argument' }
        );
    }
    if (typeof payload.offset !== 'number' || payload.fingerprint !== fingerprint(text)) {
        throw new SteelToolError(
            'That cursor was issued for different content — the page has changed since it was minted. ' +
                'Drop the cursor argument to read the current content from the beginning.',
            { code: 'invalid_argument' }
        );
    }
    return payload.offset;
}

/**
 * Returns one budgeted page of `text`, starting at `cursor`.
 *
 * Cuts at a line boundary so a snapshot line or a markdown row is never split mid-token, but
 * always makes progress: a single line longer than the whole budget is emitted on its own.
 */
export function paginate(text: string, options: PaginateOptions = {}): Page {
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const maxChars = Math.max(1, maxTokens * 4);
    const start = options.cursor === undefined ? 0 : decodeCursor(options.cursor, text);
    const remaining = text.slice(start);

    if (remaining.length <= maxChars) {
        return { text: remaining, nextCursor: undefined, truncated: false, totalTokens: estimateTokens(text) };
    }

    const window = remaining.slice(0, maxChars);
    const lastBreak = window.lastIndexOf('\n');
    const cut = lastBreak > 0 ? lastBreak : window.length;
    const next = start + cut + (lastBreak > 0 ? 1 : 0);

    return {
        text: remaining.slice(0, cut),
        nextCursor: encodeCursor({ offset: next, fingerprint: fingerprint(text) }),
        truncated: true,
        totalTokens: estimateTokens(text),
    };
}
