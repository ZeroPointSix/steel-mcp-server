// ABOUTME: Session lifecycle tools: explicit create with both Steel timeouts set, a release that
// ABOUTME: captures context first, live-or-finished diagnostics, and the app-only live-view endpoint.
import { z } from 'zod';
import { SESSION_VIEWER_URI } from '../apps/session-viewer.js';
import { resolveInactivityTimeout } from '../config.js';
import { mintSteelSessionId, type ServerDeps, type ToolHost } from '../context.js';
import { type SelfHostCapability, SteelToolError, selfHostUnsupportedError } from '../errors.js';
import { DEFAULT_MAX_TOKENS, paginate } from '../pagination.js';
import type { HandleRecord } from '../registry.js';
import {
    agentTraceErrorText,
    agentTraceUrl,
    agentTraceValueSummary,
    isDiagnosticLog,
    parseSessionLogPayload,
    sessionLogErrorText,
    sessionLogUrl,
} from '../steel/diagnostics.js';
import type { AccountDetails, AgentTraceTimeline, SessionLogTimeline, SteelSession } from '../steel/types.js';
import { fenceUntrusted } from '../untrusted.js';
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
    device?: 'desktop' | 'mobile' | undefined;
    viewport?: { width: number; height: number } | undefined;
    timeout_ms?: number | undefined;
}

/** Short enough to recover from a vanished viewer, long enough to survive one missed heartbeat. */
export const HUMAN_CONTROL_LEASE_MS = 60_000;

export function registerSessionCreate(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'steel_session_create',
        {
            title: 'Start a browser session',
            description:
                'Start a billed browser for interaction. It occupies a concurrency slot until ' +
                'steel_session_release; call that as soon as you finish. It also ends at its configured inactivity ' +
                'window or immutable expiry. Prefer steel_scrape for reads.',
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
                device: z
                    .enum(['desktop', 'mobile'])
                    .optional()
                    .describe(
                        'Browser device mode. Use mobile for a mobile fingerprint, user agent, viewport and touch support.'
                    ),
                viewport: z
                    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
                    .optional()
                    .describe(
                        'Desktop viewport size in CSS pixels; desktop defaults to 1280x720. For a genuine mobile ' +
                            'fingerprint, user agent and touch environment, use device=mobile instead of only resizing.'
                    ),
                timeout_ms: z
                    .number()
                    .int()
                    .positive()
                    .max(86_400_000)
                    .optional()
                    .describe('Immutable hard lifetime, up to 24 hours and your plan maximum.'),
            }),
            // A host that supports MCP Apps renders the live viewer beside this result. A host that
            // does not ignores the key and shows the text below, which is unchanged either way.
            _meta: { ui: { resourceUri: SESSION_VIEWER_URI } },
        },
        async (args, ctx) =>
            guard(deps, 'steel_session_create', ctx.mcpReq, async () => {
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
                const requestedTimeout = args.timeout_ms ?? deps.config.sessionTimeoutMs;
                // A missing plan maximum means unknown, not "the configured default is the maximum".
                // Steel remains authoritative and rejects a lifetime the account cannot use.
                const planMax = details.maxSessionDuration;
                const timeout = planMax === undefined ? requestedTimeout : Math.min(requestedTimeout, planMax);
                const inactivityTimeout = resolveInactivityTimeout(deps.config.inactivityTimeoutMs, timeout);

                const steelSessionId = mintSteelSessionId(deps);
                let session: SteelSession;
                try {
                    session = await deps.api.createSession(
                        {
                            sessionId: steelSessionId,
                            timeout,
                            inactivityTimeout,
                            region: args.region,
                            useProxy: args.use_proxy,
                            solveCaptcha: args.solve_captcha,
                            profileId: args.profile_id,
                            namespace: args.namespace,
                            blockAds: args.block_ads,
                            deviceConfig: args.device ? { device: args.device } : undefined,
                            dimensions: args.viewport,
                        },
                        ctx.mcpReq.signal
                    );
                } catch (error) {
                    // The id was minted before the request, so even a response lost after Steel
                    // accepted the create can be reclaimed instead of becoming an unknown session.
                    await deps.pool.close(steelSessionId).catch(() => undefined);
                    await deps.api.releaseSession(steelSessionId).catch(() => undefined);
                    throw error;
                }

                const expiresAt = new Date(deps.now().getTime() + timeout);
                let record: HandleRecord;
                try {
                    record = await deps.registry.create({
                        principal: deps.principal,
                        steelSessionId,
                        expiresAt: expiresAt.getTime(),
                        viewerUrl: session.sessionViewerUrl,
                        // Kept for the human-in-the-loop handoff, which needs the self-contained
                        // player rather than the dashboard: a person with no Steel login can open
                        // the player, and the dashboard would show them a sign-in page instead.
                        debugUrl: session.debugUrl,
                        mitigation: {
                            profileId: args.profile_id,
                            useProxy: args.use_proxy,
                            solveCaptcha: args.solve_captcha,
                        },
                    });
                } catch (error) {
                    await deps.pool.close(steelSessionId).catch(() => undefined);
                    await deps.api.releaseSession(steelSessionId).catch(() => undefined);
                    throw error;
                }

                const signal = ctx.mcpReq.signal;
                let abortRelease: Promise<unknown> | undefined;
                let releaseOnAbort: (() => Promise<unknown>) | undefined;
                if (signal) {
                    releaseOnAbort = () => {
                        abortRelease ??= deps.registry
                            .release(record.handle, deps.principal, 'stream_close')
                            .catch(() => undefined);
                        return abortRelease;
                    };
                    signal.addEventListener('abort', releaseOnAbort, { once: true });
                    if (signal.aborted) {
                        await releaseOnAbort();
                        throw new SteelToolError('The session-creation request was cancelled by the caller.', {
                            code: 'timeout',
                        });
                    }
                }

                const result = successResult(
                    {
                        result:
                            `Started a browser session. Pass session_id="${record.handle}" to the other browser tools, ` +
                            'and call steel_session_release when you are finished with it.',
                        pageState: session.sessionViewerUrl
                            ? `Watch or take control in the live browser: ${session.sessionViewerUrl}`
                            : undefined,
                        notes: [
                            `This session expires at ${expiresAt.toISOString()}; its lifetime cannot be extended after creation.`,
                            inactivityTimeout === undefined
                                ? 'No separate inactivity timeout fits inside this short session lifetime.'
                                : `Steel releases it after ${Math.round(inactivityTimeout / 1_000)} seconds without browser activity; active human input resets that clock.`,
                        ],
                    },
                    {
                        session_id: record.handle,
                        viewer_url: session.sessionViewerUrl,
                        expires_at: expiresAt.toISOString(),
                        remaining_ms: timeout,
                        inactivity_timeout_ms: inactivityTimeout,
                        hard_timeout_mutable: false,
                        takeover: {
                            inline_viewer: true,
                            external_player: Boolean(session.debugUrl),
                            exclusive_control: true,
                        },
                        files: { local_upload: 'inline_viewer', model_can_read_bytes: false },
                        plan_limits: {
                            max_session_ms: planMax,
                            max_concurrent_sessions: details.concurrencyLimit ?? deps.config.maxConcurrentSessions,
                        },
                    }
                );
                if (signal && releaseOnAbort) {
                    // McpServer closes its per-request signal after a normal result. Remove the
                    // listener before that lifecycle cleanup so success does not look like a
                    // disconnected client and destroy the session it just returned.
                    signal.removeEventListener('abort', releaseOnAbort);
                    if (signal.aborted) {
                        await releaseOnAbort();
                        throw new SteelToolError('The session-creation request was cancelled by the caller.', {
                            code: 'timeout',
                        });
                    }
                }
                return result;
            })
    );
}

export function registerSessionRelease(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
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
        async (args, ctx) =>
            guard(deps, 'steel_session_release', ctx.mcpReq, async () => {
                const record = await deps.registry.resolveForAgent(args.session_id, deps.principal).catch(error => {
                    if (error instanceof SteelToolError && error.code === 'human_control_active') throw error;
                    return null;
                });

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
                        notes: record.viewerUrl ? [`Steel dashboard: ${record.viewerUrl}`] : undefined,
                    },
                    { session_id: args.session_id, released: true, final_url: finalUrl, title }
                );
            })
    );
}

/** Reads Steel's reported viewport, or nothing when it did not report a usable one. */
function readViewport(dimensions: SteelSession['dimensions']): { width: number; height: number } | undefined {
    const width = dimensions?.width;
    const height = dimensions?.height;
    if (typeof width !== 'number' || typeof height !== 'number') return undefined;
    return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * The app-only tool the inline session viewer calls to learn where to connect.
 *
 * `visibility: ['app']` keeps this out of the list a host shows the model. It is presentation, not
 * protection: nothing on the wire distinguishes an app-proxied call from a model-issued one, so the
 * handle is re-authorised against this request's own principal exactly as it is for every other
 * stateful tool, and a leaked handle is worth no more here than anywhere else.
 */
/**
 * The newest live session this credential owns.
 *
 * Only ever called for a caller who named no session, and only over that caller's own handles — the
 * registry is asked for one principal's records, so this can no more reach another tenant's browser
 * than `resolve` can. Newest wins because the viewer is rendered by the call that just created one.
 */
async function newestLiveSession(deps: ServerDeps): Promise<HandleRecord> {
    const now = deps.now().getTime();
    const live = (await deps.registry.list(deps.principal))
        .filter(record => record.expiresAt > now)
        .sort((left, right) => right.createdAt - left.createdAt);
    const newest = live[0];
    if (!newest) {
        throw new SteelToolError('There is no live browser session to show. Call steel_session_create to start one.', {
            code: 'session_expired',
        });
    }
    return newest;
}

export function registerSessionLiveView(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'steel_session_live_view',
        {
            title: 'Live view connection',
            description: 'App-only live-view connection and exclusive human-control lease. Returns no page content.',
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
            inputSchema: z.object({
                session_id: sessionIdSchema
                    .optional()
                    .describe(
                        'Omit to stream the newest live session this credential owns, which is what a ' +
                            'viewer that never received the session does.'
                    ),
                action: z.enum(['connect', 'acquire', 'renew', 'release']).optional(),
                control_token: z.string().optional(),
            }),
            _meta: { ui: { visibility: ['app'] } },
        },
        async (args, ctx) =>
            guard(deps, 'steel_session_live_view', ctx.mcpReq, async () => {
                const action = args.action ?? 'connect';
                if (action !== 'connect') {
                    if (!args.session_id) {
                        throw new SteelToolError('session_id is required for a human-control lease.', {
                            code: 'invalid_argument',
                        });
                    }
                    if ((action === 'renew' || action === 'release') && !args.control_token) {
                        throw new SteelToolError(`control_token is required to ${action} human control.`, {
                            code: 'invalid_argument',
                        });
                    }

                    if (action === 'release') {
                        await deps.registry.releaseHumanControl(
                            args.session_id,
                            deps.principal,
                            args.control_token as string
                        );
                        return successResult(
                            { result: 'Human control returned to the agent.' },
                            { session_id: args.session_id, control: { state: 'agent' } }
                        );
                    }

                    const lease =
                        action === 'acquire'
                            ? await deps.registry.acquireHumanControl(
                                  args.session_id,
                                  deps.principal,
                                  HUMAN_CONTROL_LEASE_MS
                              )
                            : await deps.registry.renewHumanControl(
                                  args.session_id,
                                  deps.principal,
                                  args.control_token as string,
                                  HUMAN_CONTROL_LEASE_MS
                              );
                    return successResult(
                        { result: action === 'acquire' ? 'Human control acquired.' : 'Human control renewed.' },
                        {
                            session_id: args.session_id,
                            control: {
                                state: 'human',
                                token: lease.token,
                                lease_expires_at: new Date(lease.leaseUntil).toISOString(),
                            },
                        }
                    );
                }

                // The host pushes the tool result to a rendered app exactly once, when the call
                // completes, and the MCP Apps spec has neither a replay nor a way to ask for it
                // again. A viewer rendered while the create call is still running can therefore
                // finish its handshake after that instant and never learn which session it shows.
                // Resolving from the caller's own handles is what makes the viewer recoverable; it
                // is the same principal, so it widens nothing.
                const record = args.session_id
                    ? await deps.registry.resolve(args.session_id, deps.principal)
                    : await newestLiveSession(deps);
                let session: SteelSession;
                try {
                    // Read fresh every time: Steel re-mints the token on each read, and an expiring
                    // credential stored on the handle record would be a liability with no upside.
                    session = await deps.api.getSession(record.steelSessionId, ctx.mcpReq.signal);
                } catch (error) {
                    // Steel's own prose is relayed everywhere else in this server. Not here: a
                    // failure reading a session can quote the URL it was reading, and that URL
                    // drives the browser. Only the classification survives.
                    throw new SteelToolError(
                        'Could not read the live-view connection details for this session from Steel. ' +
                            'The session may have just been released; take a snapshot to check it is still live.',
                        { code: error instanceof SteelToolError ? error.code : 'steel_error' }
                    );
                }

                const cdpUrl = session.websocketUrl;
                if (!cdpUrl) {
                    // Never fall back to the configured connect URL: that one carries STEEL_API_KEY,
                    // which is an org-wide credential and must not leave this process.
                    throw new SteelToolError(
                        'Steel returned no live-view connection for this session, so it cannot be streamed ' +
                            'inline. Open the session viewer link from steel_session_create instead.',
                        { code: 'steel_error' }
                    );
                }

                const viewport = readViewport(session.dimensions);
                return successResult(
                    // Deliberately says nothing else. The URL below is a drive-capable credential and
                    // belongs only in structured data, which the app reads and the model does not.
                    { result: 'Live view connection details for this session.' },
                    {
                        // Named so a viewer that resolved its own session knows which one it got,
                        // and can say so rather than stream an unidentified browser.
                        session_id: record.handle,
                        cdp_url: cdpUrl,
                        ...(viewport ? { viewport } : {}),
                        expires_at: new Date(record.expiresAt).toISOString(),
                    }
                );
            })
    );
}

const diagnosticsInputSchema = z
    .object({
        session_id: sessionIdSchema.optional().describe('Live id from steel_session_create.'),
        steel_session_id: z.string().uuid().optional().describe('Finished Steel dashboard UUID.'),
        since: z.string().optional().describe('Only events at or after this ISO-8601 time.'),
        max_tokens: maxTokensSchema,
        cursor: cursorSchema,
    })
    .refine(args => !(args.session_id && args.steel_session_id), {
        message: 'Pass session_id or steel_session_id, not both.',
        path: ['steel_session_id'],
    });

interface DiagnosticsTarget {
    /** The id safe to echo back: an opaque live handle, or an already-supplied finished-session id. */
    reference: string;
    /** The authenticated Steel REST target. Never returned for a live opaque handle. */
    steelSessionId: string;
    kind: 'live_handle' | 'historical_id' | 'latest_released';
    selectionNote?: string | undefined;
}

/** Resolves a live handle, a dashboard UUID, or the caller's newest released Steel session. */
async function resolveDiagnosticsTarget(
    deps: ServerDeps,
    args: { session_id?: string | undefined; steel_session_id?: string | undefined },
    signal?: AbortSignal
): Promise<DiagnosticsTarget> {
    if (args.steel_session_id) {
        // Steel authorizes this UUID against the API credential on both diagnostics endpoints. A
        // raw id is never resolved through our live-handle registry because finished records are
        // deliberately absent there.
        return {
            reference: args.steel_session_id,
            steelSessionId: args.steel_session_id,
            kind: 'historical_id',
        };
    }

    if (args.session_id) {
        try {
            const record = await deps.registry.resolve(args.session_id, deps.principal);
            return { reference: args.session_id, steelSessionId: record.steelSessionId, kind: 'live_handle' };
        } catch (error) {
            if (error instanceof SteelToolError && (error.code === 'not_found' || error.code === 'session_expired')) {
                throw new SteelToolError(
                    'That MCP session handle is no longer live. Pass steel_session_id with the session UUID ' +
                        'shown in the Steel dashboard, or omit both ids to inspect the most recent released session. ' +
                        'A replacement browser cannot recover these logs.',
                    { code: error.code }
                );
            }
            throw error;
        }
    }

    const recent = await deps.api.listSessions({ status: 'released', limit: 1 }, signal);
    const latest = recent.sessions[0];
    if (!latest) {
        throw new SteelToolError(
            'No released Steel session was found for this credential. Pass steel_session_id if you meant a ' +
                'specific finished or failed session. A replacement browser would not recover historical logs.',
            { code: 'not_found' }
        );
    }
    return {
        reference: latest.id,
        steelSessionId: latest.id,
        kind: 'latest_released',
        selectionNote: `Reading the most recent released Steel session: ${latest.id}${
            latest.createdAt ? ` (created ${latest.createdAt})` : ''
        }.`,
    };
}

export function registerSessionDiagnostics(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'steel_session_diagnostics',
        {
            title: 'Explain what a browser session did',
            description:
                'Read live or finished session activity; never starts a browser. Use session_id for live, ' +
                'steel_session_id for a dashboard UUID, or neither for latest released.',
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
            inputSchema: diagnosticsInputSchema,
        },
        async (args, ctx) =>
            guard(deps, 'steel_session_diagnostics', ctx.mcpReq, async () => {
                const target = await resolveDiagnosticsTarget(deps, args, ctx.mcpReq.signal);
                const [timelineRead, logsRead] = await Promise.allSettled([
                    deps.api.getAgentTraces(target.steelSessionId, ctx.mcpReq.signal),
                    deps.api.getSessionLogs(target.steelSessionId, ctx.mcpReq.signal),
                ]);
                // A 403/404 on both endpoints means the historical target is inaccessible, not that
                // it has an empty timeline. Keep the log error because logs are the narrower promise
                // this tool makes; the trace endpoint may be unsupported on older deployments.
                if (timelineRead.status === 'rejected' && logsRead.status === 'rejected') throw logsRead.reason;
                const timeline: AgentTraceTimeline =
                    timelineRead.status === 'fulfilled' ? timelineRead.value : { events: [] };
                const logs: SessionLogTimeline = logsRead.status === 'fulfilled' ? logsRead.value : { events: [] };

                const since = args.since ? Date.parse(args.since) : Number.NEGATIVE_INFINITY;
                const atOrAfter = (timestamp: string | undefined) =>
                    !timestamp || Number.isNaN(since) || Date.parse(timestamp) >= since;

                const shownLogs = logs.events.filter(entry => atOrAfter(entry.timestamp) && isDiagnosticLog(entry));
                const hiddenLogCount = logs.events.filter(
                    entry => atOrAfter(entry.timestamp) && !isDiagnosticLog(entry)
                ).length;

                const events = [
                    // Every string below other than the activity type is page-derived, which is why
                    // the whole timeline is fenced before it goes out. Activity-specific extras stay
                    // out except `value`, and that one only through the reader that refuses
                    // anything but Steel's `{inputType, valueLength}` metadata.
                    ...timeline.events
                        .filter(trace => atOrAfter(trace.timestamp))
                        .map(trace => {
                            const error = agentTraceErrorText(trace);
                            return {
                                timestamp: trace.timestamp ?? '',
                                line: [
                                    trace.type ?? 'event',
                                    trace.target?.accessibleName ? `"${trace.target.accessibleName}"` : '',
                                    trace.target?.role ? `(${trace.target.role})` : '',
                                    trace.target?.selector?.css ?? '',
                                    agentTraceUrl(trace) ?? '',
                                    agentTraceValueSummary(trace) ?? '',
                                    error ? `ERROR ${error}` : '',
                                ]
                                    .filter(Boolean)
                                    .join(' '),
                            };
                        }),
                    ...shownLogs.map(entry => {
                        const payload = parseSessionLogPayload(entry);
                        const error = sessionLogErrorText(payload);
                        return {
                            timestamp: entry.timestamp ?? '',
                            line: [
                                `log ${entry.type ?? 'entry'}`,
                                sessionLogUrl(payload) ?? '',
                                error ? `ERROR ${error}` : '',
                            ]
                                .filter(Boolean)
                                .join(' '),
                        };
                    }),
                ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

                const notes: string[] = target.selectionNote ? [target.selectionNote] : [];
                notes.push(
                    'Takeover clicks, scrolling and typing performed through the live viewer may be absent: those ' +
                        'direct CDP interactions do not necessarily enter Steel agent traces.'
                );
                if (timelineRead.status === 'rejected') {
                    notes.push('Steel could not return agent traces for this session; browser logs are shown below.');
                }
                if (logsRead.status === 'rejected') {
                    notes.push('Steel could not return browser logs for this session; agent traces are shown below.');
                }
                if (timeline.hasMore || logs.hasMore) {
                    // Distinct from the cursor below: this is Steel holding activity back, not this
                    // response running out of token budget.
                    notes.push(
                        'Steel holds more activity for this session than it returned. Narrow the window with ' +
                            'since to see the rest.'
                    );
                }
                if (hiddenLogCount > 0) {
                    notes.push(
                        `Hid ${hiddenLogCount} routine browser network Request/Response log entries. Failures and ` +
                            'navigations are kept.'
                    );
                }

                const page = paginate(
                    events.length
                        ? events.map(event => `${event.timestamp} ${event.line}`).join('\n')
                        : 'No traces or logs recorded for this session yet.',
                    { maxTokens: args.max_tokens ?? DEFAULT_MAX_TOKENS, cursor: args.cursor }
                );

                return successResult(
                    {
                        result: `${events.length} events in this session.`,
                        // Rows carry accessible names, selectors and URLs the page controls, so the
                        // timeline is fenced like any other page-derived text. No single page
                        // produced it, so the provenance names the session rather than a URL that
                        // would only be true of some rows. The empty-timeline sentence is this
                        // server's own prose and is left outside the fence.
                        snapshot: events.length
                            ? fenceUntrusted(page.text, {
                                  source: `steel-session:${target.reference}`,
                                  fetchedAt: deps.now().toISOString(),
                              })
                            : page.text,
                        notes: notes.length ? notes : undefined,
                        pagination: page.truncated ? `Continue with cursor="${page.nextCursor}".` : undefined,
                    },
                    {
                        ...(target.kind === 'live_handle'
                            ? { session_id: target.reference }
                            : { steel_session_id: target.steelSessionId }),
                        event_count: events.length,
                        has_more: (timeline.hasMore ?? false) || (logs.hasMore ?? false),
                        hidden_log_count: hiddenLogCount,
                    }
                );
            })
    );
}
