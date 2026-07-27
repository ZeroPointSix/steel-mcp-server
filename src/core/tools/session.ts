// ABOUTME: Session lifecycle tools: explicit create with both Steel timeouts set, a release that
// ABOUTME: captures context before tearing down, and the agent-trace diagnostics timeline.
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { mintSteelSessionId, type ServerDeps } from '../context.js';
import { type SelfHostCapability, selfHostUnsupportedError } from '../errors.js';
import { DEFAULT_MAX_TOKENS, paginate } from '../pagination.js';
import type { AccountDetails } from '../steel/types.js';
import { cursorSchema, guard, maxTokensSchema, sessionIdSchema, successResult } from './shared.js';

/** Session-creation options the self-hosted image cannot honour, mapped to their named errors. */
const CLOUD_ONLY_OPTIONS: Array<[keyof CreateArgs, SelfHostCapability]> = [
    ['use_proxy', 'use_proxy'],
    ['solve_captcha', 'solve_captcha'],
    ['region', 'region'],
    ['profile_id', 'profile_id'],
    ['namespace', 'credentials'],
];

interface CreateArgs {
    region?: string | undefined;
    use_proxy?: boolean | undefined;
    solve_captcha?: boolean | undefined;
    profile_id?: string | undefined;
    namespace?: string | undefined;
    block_ads?: boolean | undefined;
    viewport?: { width: number; height: number } | undefined;
    timeout_ms?: number | undefined;
}

export function registerSessionCreate(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        'steel_session_create',
        {
            title: 'Start a browser session',
            description:
                'Start a real browser you can navigate, click and type in. This is a billed resource: it is ' +
                'charged per browser-minute and occupies one of your plan concurrency slots until it is released. ' +
                'Call steel_session_release as soon as you are done. If nobody touches it for two minutes, or it ' +
                'reaches the plan time limit, Steel releases it automatically and any refs you hold stop working. ' +
                'For anything you only need to read, use steel_scrape instead — it starts no session.',
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
            inputSchema: z.object({
                region: z.string().optional().describe('Region to run the browser in, e.g. lax, iad, fra.'),
                use_proxy: z.boolean().optional().describe('Route through a Steel-managed residential proxy.'),
                solve_captcha: z.boolean().optional().describe('Let Steel solve CAPTCHA challenges automatically.'),
                profile_id: z
                    .string()
                    .optional()
                    .describe('Reuse a saved browser identity so cookies and fingerprint persist across visits.'),
                namespace: z
                    .string()
                    .optional()
                    .describe('Credential namespace to inject. Never put secrets in tool arguments.'),
                block_ads: z.boolean().optional().describe('Block advertising and tracking requests.'),
                viewport: z
                    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
                    .optional()
                    .describe('Viewport size in CSS pixels. Defaults to 1280x720.'),
                timeout_ms: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe('Hard session lifetime. Clamped to your plan maximum.'),
            }),
        },
        async (args, ctx) =>
            guard(async () => {
                if (deps.config.deployment === 'self_hosted') {
                    for (const [option, capability] of CLOUD_ONLY_OPTIONS) {
                        if (args[option] !== undefined && args[option] !== false) {
                            throw selfHostUnsupportedError(capability);
                        }
                    }
                }

                const live = await deps.registry.countLive(deps.principal);
                if (live >= deps.config.maxConcurrentSessions) {
                    throw deps.config.deployment === 'self_hosted'
                        ? selfHostUnsupportedError('concurrency')
                        : new (await import('../errors.js')).SteelToolError(
                              `You already have ${live} live browser sessions, which is this deployment's limit. ` +
                                  'Release one with steel_session_release before starting another.',
                              { code: 'rate_limited' }
                          );
                }

                const details: AccountDetails = await deps.api.getDetails(ctx.mcpReq.signal).catch(() => ({}));
                const planMax = details.maxSessionDuration ?? deps.config.sessionTimeoutMs;
                const timeout = Math.min(args.timeout_ms ?? deps.config.sessionTimeoutMs, planMax);

                const steelSessionId = mintSteelSessionId(deps);
                const session = await deps.api.createSession(
                    {
                        sessionId: steelSessionId,
                        timeout,
                        inactivityTimeout: Math.min(deps.config.inactivityTimeoutMs, timeout),
                        region: args.region,
                        useProxy: args.use_proxy,
                        solveCaptcha: args.solve_captcha,
                        profileId: args.profile_id,
                        namespace: args.namespace,
                        blockAds: args.block_ads,
                        dimensions: args.viewport,
                    },
                    ctx.mcpReq.signal
                );

                const expiresAt = new Date(deps.now().getTime() + timeout);
                const record = await deps.registry.create({
                    principal: deps.principal,
                    steelSessionId,
                    expiresAt: expiresAt.getTime(),
                    viewerUrl: session.sessionViewerUrl,
                    mitigation: {
                        profileId: args.profile_id,
                        useProxy: args.use_proxy,
                        solveCaptcha: args.solve_captcha,
                    },
                });

                return successResult(
                    {
                        result:
                            `Started a browser session. Pass session_id="${record.handle}" to the other browser tools, ` +
                            'and call steel_session_release when you are finished with it.',
                        pageState: session.sessionViewerUrl ? `Watch it live: ${session.sessionViewerUrl}` : undefined,
                        notes: [
                            `Hard limit ${Math.round(timeout / 60_000)} minutes (expires ${expiresAt.toISOString()}).`,
                            'Steel releases the session by itself after two minutes with no activity.',
                        ],
                    },
                    {
                        session_id: record.handle,
                        viewer_url: session.sessionViewerUrl,
                        expires_at: expiresAt.toISOString(),
                        plan_limits: {
                            max_session_ms: planMax,
                            max_concurrent_sessions: details.concurrencyLimit ?? deps.config.maxConcurrentSessions,
                        },
                    }
                );
            })
    );
}

export function registerSessionRelease(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        'steel_session_release',
        {
            title: 'Release a browser session',
            description:
                'Shut down a browser session and stop the meter. Safe to call twice. Anything the page held — ' +
                'logins, cookies, the current URL — is gone afterwards, so read what you need first. This tool ' +
                'reports the final URL and page title before releasing.',
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
            inputSchema: z.object({ session_id: sessionIdSchema }),
        },
        async args =>
            guard(async () => {
                const record = await deps.registry.resolve(args.session_id, deps.principal).catch(() => null);

                if (!record) {
                    return successResult(
                        {
                            result:
                                'That session is already released, or was never live for this credential. ' +
                                'Nothing to do.',
                        },
                        { session_id: args.session_id, released: false }
                    );
                }

                // Context has to be captured before the release, not after: once the browser is gone
                // there is nothing left to read, and that ordering trap is easy to fall into.
                let finalUrl = '';
                let title = '';
                try {
                    const page = await deps.pool.page(record.steelSessionId);
                    const snapshot = await page.snapshot({});
                    finalUrl = snapshot.url;
                    title = snapshot.title;
                } catch {
                    // A session whose browser already went away still needs releasing at the API.
                }

                await deps.registry.release(args.session_id, deps.principal, 'explicit');

                return successResult(
                    {
                        result: 'Released the browser session and stopped the meter.',
                        pageState: finalUrl ? `${finalUrl}${title ? ` — ${title}` : ''}` : undefined,
                        notes: record.viewerUrl ? [`Recording and replay: ${record.viewerUrl}`] : undefined,
                    },
                    { session_id: args.session_id, released: true, final_url: finalUrl, title }
                );
            })
    );
}

export function registerSessionDiagnostics(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        'steel_session_diagnostics',
        {
            title: 'Explain what a browser session did',
            description:
                'Show a timeline of what actually happened in a session — every click, input and navigation with ' +
                'timestamps, plus browser errors. Use this when an action seemed to work but the page did not ' +
                'change, or when a site behaves differently than expected, instead of guessing.',
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
            inputSchema: z.object({
                session_id: sessionIdSchema,
                since: z.string().optional().describe('ISO-8601 timestamp; only show events at or after this time.'),
                max_tokens: maxTokensSchema,
                cursor: cursorSchema,
            }),
        },
        async (args, ctx) =>
            guard(async () => {
                const record = await deps.registry.resolve(args.session_id, deps.principal);
                const [traces, logs] = await Promise.all([
                    deps.api.getAgentTraces(record.steelSessionId, ctx.mcpReq.signal).catch(() => []),
                    deps.api.getSessionLogs(record.steelSessionId, ctx.mcpReq.signal).catch(() => []),
                ]);

                const since = args.since ? Date.parse(args.since) : Number.NEGATIVE_INFINITY;
                const atOrAfter = (timestamp: string | undefined) =>
                    !timestamp || Number.isNaN(since) || Date.parse(timestamp) >= since;

                const events = [
                    ...traces
                        .filter(trace => atOrAfter(trace.timestamp))
                        .map(trace => ({
                            timestamp: trace.timestamp ?? '',
                            line: [
                                trace.action ?? 'event',
                                trace.target?.accessibleName ? `"${trace.target.accessibleName}"` : '',
                                trace.target?.role ? `(${trace.target.role})` : '',
                                trace.target?.selector?.css ?? '',
                                trace.url ?? '',
                                trace.error ? `ERROR ${trace.error}` : '',
                            ]
                                .filter(Boolean)
                                .join(' '),
                        })),
                    ...logs
                        .filter(entry => atOrAfter(entry.timestamp))
                        .map(entry => ({
                            timestamp: entry.timestamp ?? '',
                            line: `log ${entry.level ?? 'info'} ${entry.text ?? entry.message ?? ''}`.trim(),
                        })),
                ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

                const body = events.length
                    ? events.map(event => `${event.timestamp} ${event.line}`).join('\n')
                    : 'No traces or logs recorded for this session yet.';
                const page = paginate(body, { maxTokens: args.max_tokens ?? DEFAULT_MAX_TOKENS, cursor: args.cursor });

                return successResult(
                    {
                        result: `${events.length} events in this session.`,
                        snapshot: page.text,
                        pagination: page.truncated ? `Continue with cursor="${page.nextCursor}".` : undefined,
                    },
                    { session_id: args.session_id, event_count: events.length }
                );
            })
    );
}
