// ABOUTME: The stateful browsing tools — navigate, snapshot, find, act and wait_for — each taking a
// ABOUTME: session handle and returning a change signal rather than a bare success.
import type { ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps, ToolHost } from '../context.js';
import { SteelToolError } from '../errors.js';
import { resolveHumanHandoff } from '../mrtr.js';
import { ACTIONS, type ActRequest, type BrowserPage } from '../page.js';
import { DEFAULT_MAX_TOKENS, paginate } from '../pagination.js';
import type { HandleRecord } from '../registry.js';
import type { SnapshotNode } from '../snapshot.js';
import { renderSnapshot } from '../snapshot.js';
import { fenceUntrusted } from '../untrusted.js';
import {
    cursorSchema,
    maxTokensSchema,
    pageStateLine,
    sessionIdSchema,
    successResult,
    type ToolOutcome,
    withPage,
} from './shared.js';

/**
 * Offers the page to a person when only a person can get past it.
 *
 * Bound to one server so the handoff can read the capabilities an older connection declared at
 * initialize, which is the only capability view a request without a `_meta` envelope has.
 */
function handoffFor(host: ToolHost, deps: ServerDeps, tool: string) {
    return (ctx: ServerContext, handle: string, record: HandleRecord, page: BrowserPage) =>
        resolveHumanHandoff({
            deps,
            ctx,
            declaredAtConnect: () => host.server.getClientCapabilities(),
            handle,
            record,
            page,
            tool,
        });
}

/** Captures and renders a fenced, budgeted snapshot section for a tool that was asked for one. */
export async function snapshotSection(
    page: BrowserPage,
    deps: ServerDeps,
    options: { interactiveOnly?: boolean; maxTokens?: number | undefined; cursor?: string | undefined }
): Promise<{ pageState: string; snapshot: string; pagination: string | undefined }> {
    // A cursor refers to the text of the snapshot that produced it. Recapturing would paginate
    // fresh content, so the fingerprint check would reject every continuation on a moving page.
    const stored = options.cursor === undefined ? undefined : page.pageState.lastSnapshot;
    const snapshot = stored ?? (await page.snapshot({ interactiveOnly: options.interactiveOnly ?? true }));
    const paged = paginate(snapshot.text, {
        maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        cursor: options.cursor,
    });
    return {
        pageState: pageStateLine(snapshot),
        snapshot: fenceUntrusted(paged.text, { finalUrl: snapshot.url, fetchedAt: deps.now().toISOString() }),
        pagination: paged.truncated
            ? `The page is larger than the budget. Continue with cursor="${paged.nextCursor}", ` +
              'or use steel_find to jump straight to the element you need.'
            : snapshot.truncated
              ? 'The page has more nodes than this tool renders. Use steel_find to locate a specific element.'
              : undefined,
    };
}

export function registerNavigate(host: ToolHost, deps: ServerDeps): void {
    const handoff = handoffFor(host, deps, 'steel_navigate');
    host.registerTool(
        'steel_navigate',
        {
            title: 'Open a URL in a browser session',
            description:
                'Navigate a live session and wait for it to settle. Reports the final URL and changes; set ' +
                'include_snapshot to also read the page.',
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
            inputSchema: z.object({
                session_id: sessionIdSchema,
                url: z.url().describe('Where to go.'),
                include_snapshot: z
                    .boolean()
                    .optional()
                    .describe('Also return the accessibility snapshot. Off by default because it is expensive.'),
                max_tokens: maxTokensSchema,
            }),
        },
        async (args, ctx) =>
            withPage(deps, 'steel_navigate', ctx.mcpReq, args.session_id, async (page, record) => {
                const outcome = await page.navigate(args.url);
                const handedOff = await handoff(ctx, args.session_id, record, page);
                if (handedOff) return handedOff;

                const sections = args.include_snapshot
                    ? await snapshotSection(page, deps, { maxTokens: args.max_tokens })
                    : undefined;

                return successResult(
                    {
                        result: `Opened ${args.url}.`,
                        pageState:
                            sections?.pageState ?? `${outcome.finalUrl}${outcome.title ? ` — ${outcome.title}` : ''}`,
                        change: outcome.changeDescription,
                        snapshot: sections?.snapshot,
                        pagination: sections?.pagination,
                    },
                    {
                        final_url: outcome.finalUrl,
                        title: outcome.title,
                        navigated: outcome.change.navigated,
                        dom_changed: outcome.change.domMutated,
                    }
                );
            })
    );
}

export function registerSnapshot(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'steel_snapshot',
        {
            title: 'Read the page structure',
            description:
                'Return the page as a compact accessibility tree with a @eN reference on every element you can ' +
                'click or type into. This is the read to use before acting. Elements with no reference cannot be ' +
                'targeted. If you already know what you are looking for, steel_find is much cheaper.',
            annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
            inputSchema: z.object({
                session_id: sessionIdSchema,
                interactive_only: z
                    .boolean()
                    .optional()
                    .describe('Skip purely structural containers. On by default; turn off for the full tree.'),
                max_tokens: maxTokensSchema,
                cursor: cursorSchema,
            }),
        },
        async (args, ctx) =>
            withPage(deps, 'steel_snapshot', ctx.mcpReq, args.session_id, async page => {
                const sections = await snapshotSection(page, deps, {
                    interactiveOnly: args.interactive_only ?? true,
                    maxTokens: args.max_tokens,
                    cursor: args.cursor,
                });
                const snapshot = page.pageState.lastSnapshot;
                return successResult(
                    {
                        result: `Read the page structure: ${snapshot?.nodes.filter(node => node.ref).length ?? 0} targetable elements.`,
                        pageState: sections.pageState,
                        snapshot: sections.snapshot,
                        pagination: sections.pagination,
                    },
                    { snapshot_id: snapshot?.snapshotId, url: snapshot?.url }
                );
            })
    );
}

function renderMatches(nodes: SnapshotNode[]): string {
    return renderSnapshot(nodes.map(node => ({ ...node, depth: 0 })));
}

export function registerFind(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'steel_find',
        {
            title: 'Find an element on the page',
            description:
                'Search the current page for elements whose label matches a word, phrase or pattern, and return ' +
                'just those with their @eN references. Much cheaper than reading the whole page when you only ' +
                'need one button, link or field.',
            annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
            inputSchema: z.object({
                session_id: sessionIdSchema,
                text: z.string().optional().describe('Case-insensitive substring of the element label.'),
                regex: z.string().optional().describe('Regular expression matched against the element label.'),
                role: z.string().optional().describe('Only return elements with this role, e.g. button or link.'),
                interactive_only: z
                    .boolean()
                    .optional()
                    .describe('Only return elements that can actually be clicked or typed into.'),
                max_results: z.number().int().positive().max(200).optional().describe('Cap on matches returned.'),
            }),
        },
        async (args, ctx) =>
            withPage(deps, 'steel_find', ctx.mcpReq, args.session_id, async page => {
                await page.snapshot({});
                const matches = await page.find({
                    text: args.text,
                    regex: args.regex,
                    role: args.role,
                    interactiveOnly: args.interactive_only,
                });
                const limited = matches.slice(0, args.max_results ?? 50);
                const snapshot = page.pageState.lastSnapshot;

                if (limited.length === 0) {
                    return successResult(
                        {
                            result:
                                'No element on this page matches that. Call steel_snapshot to see what is actually ' +
                                'there, or steel_wait_for if you expect it to appear shortly.',
                            pageState: snapshot ? pageStateLine(snapshot) : undefined,
                        },
                        { match_count: 0 }
                    );
                }

                return successResult(
                    {
                        result: `${matches.length} match${matches.length === 1 ? '' : 'es'}${
                            matches.length > limited.length ? `, showing the first ${limited.length}` : ''
                        }.`,
                        pageState: snapshot ? pageStateLine(snapshot) : undefined,
                        snapshot: fenceUntrusted(renderMatches(limited), {
                            finalUrl: snapshot?.url ?? '',
                            fetchedAt: deps.now().toISOString(),
                        }),
                    },
                    {
                        match_count: matches.length,
                        matches: limited.map(node => ({ ref: node.ref, role: node.role, name: node.name })),
                    }
                );
            })
    );
}

export function registerAct(host: ToolHost, deps: ServerDeps): void {
    const handoff = handoffFor(host, deps, 'steel_act');
    host.registerTool(
        'steel_act',
        {
            title: 'Interact with the page',
            description:
                'Click, type, fill a form, select an option, hover, scroll, press a key, go back, or dismiss a ' +
                'cookie or consent overlay. Target elements by the @eN reference from steel_snapshot or ' +
                'steel_find, or by a CSS selector. Always reports what actually changed, and says so plainly when ' +
                'nothing did.',
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
            inputSchema: z.object({
                session_id: sessionIdSchema,
                action: z.enum(ACTIONS).describe('What to do.'),
                target: z
                    .string()
                    .optional()
                    .describe('A @eN reference or a CSS selector. Not needed for scroll, press, go_back.'),
                value: z
                    .string()
                    .optional()
                    .describe('Text to type, option to select, key name to press, or scroll distance in pixels.'),
                fields: z
                    .array(z.object({ target: z.string(), value: z.string() }))
                    .optional()
                    .describe('For fill_form: the fields to fill, in order, in one round trip.'),
                include_snapshot: z
                    .boolean()
                    .optional()
                    .describe('Also return the page structure afterwards. Off by default.'),
                max_tokens: maxTokensSchema,
            }),
        },
        async (args, ctx) =>
            withPage(deps, 'steel_act', ctx.mcpReq, args.session_id, async (page, record) => {
                const request: ActRequest = {
                    action: args.action,
                    target: args.target,
                    value: args.value,
                    fields: args.fields,
                };
                const outcome = await page.act(request);
                const handedOff = await handoff(ctx, args.session_id, record, page);
                if (handedOff) return handedOff;

                const sections = args.include_snapshot
                    ? await snapshotSection(page, deps, { maxTokens: args.max_tokens })
                    : undefined;

                return successResult(
                    {
                        result: outcome.summary,
                        pageState: sections?.pageState,
                        change: outcome.changeDescription,
                        snapshot: sections?.snapshot,
                        pagination: sections?.pagination,
                    },
                    {
                        navigated: outcome.change.navigated,
                        dom_changed: outcome.change.domMutated,
                        focus_changed: outcome.change.focusChanged ?? false,
                    }
                );
            })
    );
}

export function registerWaitFor(host: ToolHost, deps: ServerDeps): void {
    const handoff = handoffFor(host, deps, 'steel_wait_for');
    host.registerTool(
        'steel_wait_for',
        {
            title: 'Wait for something on the page',
            description:
                'Wait until a piece of text appears, an element matches a CSS selector, or the URL contains a ' +
                'string. Name what you are waiting for — there is no wait-until-quiet option, because that hides ' +
                'why the page was slow. Most actions settle by themselves, so reach for this only when something ' +
                'genuinely arrives later.',
            annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
            inputSchema: z.object({
                session_id: sessionIdSchema,
                text: z.string().optional().describe('Wait for this text to appear on the page.'),
                selector: z.string().optional().describe('Wait for an element matching this CSS selector.'),
                url: z.string().optional().describe('Wait for the URL to contain this string.'),
                timeout_ms: z.number().int().positive().max(120_000).optional().describe('Give up after this long.'),
            }),
        },
        async (args, ctx) =>
            withPage(
                deps,
                'steel_wait_for',
                ctx.mcpReq,
                args.session_id,
                async (page, record): Promise<ToolOutcome> => {
                    let outcome: Awaited<ReturnType<BrowserPage['waitFor']>>;
                    try {
                        outcome = await page.waitFor({
                            text: args.text,
                            selector: args.selector,
                            url: args.url,
                            timeoutMs: args.timeout_ms,
                        });
                    } catch (error) {
                        // A wait that ran out is where a sign-in page or a challenge shows up: whatever
                        // was expected never arrived because something is standing in front of it. Any
                        // other failure is not about the page's contents and is reported unchanged.
                        if (!(error instanceof SteelToolError) || error.code !== 'timeout') throw error;
                        const handedOff = await handoff(ctx, args.session_id, record, page);
                        if (handedOff) return handedOff;
                        throw error;
                    }
                    return successResult(
                        {
                            result: `Waited ${outcome.waitedMs}ms for ${outcome.condition}, and it happened.`,
                            change: 'The condition you named is now true on the page.',
                        },
                        { satisfied: true, waited_ms: outcome.waitedMs }
                    );
                }
            )
    );
}
