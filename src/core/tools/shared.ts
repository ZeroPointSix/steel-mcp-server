// ABOUTME: Shared plumbing for tool handlers: the handle-to-page resolution that re-authorises on
// ABOUTME: every call, the untrusted-content fence around page text, and uniform error handling.
import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../context.js';
import { type EnvelopeSections, successResult } from '../envelope.js';
import { toolErrorResult } from '../errors.js';
import type { BrowserPage } from '../page.js';
import { DEFAULT_MAX_TOKENS, paginate } from '../pagination.js';
import type { HandleRecord } from '../registry.js';
import type { PageSnapshot } from '../snapshot.js';
import { fenceUntrusted } from '../untrusted.js';

/** The `session_id` argument shared by every stateful tool. */
export const sessionIdSchema = z
    .string()
    .describe('A session_id returned by steel_session_create. Required for every stateful browser tool.');

export const maxTokensSchema = z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Cap on the text returned, in tokens. Defaults to ${DEFAULT_MAX_TOKENS}.`);

export const cursorSchema = z
    .string()
    .optional()
    .describe('Cursor from a previous truncated response, to continue reading where it stopped.');

/**
 * A tool outcome: an ordinary result, or the input_required result a human-in-the-loop handoff
 * returns when a person has to finish the step in the live browser.
 */
export type ToolOutcome = CallToolResult | InputRequiredResult;

/** Runs a handler and converts anything it throws into a tool-execution error result. */
export async function guard(work: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
    try {
        return await work();
    } catch (error) {
        return toolErrorResult(error);
    }
}

/**
 * Resolves a handle to its live page, re-authorising against this request's own principal.
 *
 * The check is deliberately repeated on every call and never cached from creation time: a
 * handle is an identifier, not a bearer capability, and a leaked one must not grant a stranger
 * a live, possibly logged-in browser.
 */
export async function withPage(
    deps: ServerDeps,
    sessionId: string,
    signal: AbortSignal | undefined,
    work: (page: BrowserPage, record: HandleRecord) => Promise<ToolOutcome>
): Promise<ToolOutcome> {
    return guard(async () => {
        const record = await deps.registry.resolve(sessionId, deps.principal);
        await deps.registry.touch(sessionId);
        const page = await deps.pool.page(record.steelSessionId, signal);
        return work(page, record);
    });
}

/** Wraps page-derived text in the provenance fence and applies the token budget with a cursor. */
export function fencedSection(
    body: string,
    provenance: { finalUrl: string; fetchedAt: string },
    options: { maxTokens?: number | undefined; cursor?: string | undefined }
): { text: string; pagination: string | undefined } {
    const page = paginate(body, options);
    const text = fenceUntrusted(page.text, provenance);
    return {
        text,
        pagination: page.truncated
            ? `Truncated at the token budget (about ${page.totalTokens} tokens in total). ` +
              `Call this tool again with cursor="${page.nextCursor}" to continue.`
            : undefined,
    };
}

/** Renders the fixed one-line page-state section shared by the stateful tools. */
export function pageStateLine(snapshot: Pick<PageSnapshot, 'url' | 'title' | 'snapshotId'>): string {
    return `${snapshot.url}${snapshot.title ? ` — ${snapshot.title}` : ''} (snapshot ${snapshot.snapshotId})`;
}

export type Sections = EnvelopeSections;
export { successResult };
