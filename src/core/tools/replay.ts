// ABOUTME: Resolves a finished Steel Cloud session without creating one and returns its safe dashboard link.
// ABOUTME: Inline HLS playback is deliberately disabled until its browser asset can be shipped safely.
import { z } from 'zod';
import type { ServerDeps, ToolHost } from '../context.js';
import { SteelToolError } from '../errors.js';
import type { SteelSession } from '../steel/types.js';
import { guard, successResult } from './shared.js';

const replayInputSchema = z
    .object({
        steel_session_id: z.string().uuid().optional().describe('Finished Steel UUID; omit for latest released.'),
    })
    .strict();

type ReplaySelection = 'explicit' | 'latest_released';

interface ReplayTarget {
    session: SteelSession;
    selectedBy: ReplaySelection;
}

/** Accepts only login-safe Steel dashboard links, never a credential-bearing or lookalike URL. */
export function safeDashboardUrl(raw: string | undefined, steelSessionId: string): string | undefined {
    if (!raw) return undefined;
    try {
        const url = new URL(raw);
        if (
            url.origin !== 'https://app.steel.dev' ||
            url.username !== '' ||
            url.password !== '' ||
            url.search !== '' ||
            url.hash !== '' ||
            url.pathname !== `/sessions/${steelSessionId}`
        ) {
            return undefined;
        }
        return url.href;
    } catch {
        return undefined;
    }
}

/** Resolves only existing sessions owned by the configured Steel credential. */
async function resolveReplayTarget(
    deps: ServerDeps,
    steelSessionId: string | undefined,
    signal?: AbortSignal
): Promise<ReplayTarget> {
    if (steelSessionId) {
        try {
            return { session: await deps.api.getSession(steelSessionId, signal), selectedBy: 'explicit' };
        } catch (error) {
            // Do not let a caller distinguish a UUID owned by another credential from one that does
            // not exist. Authentication failures for the credential itself remain distinct.
            if (error instanceof SteelToolError && (error.code === 'forbidden' || error.code === 'not_found')) {
                throw new SteelToolError(
                    'No Steel session with that UUID was found for this credential. Check the UUID in the Steel ' +
                        "dashboard, or omit steel_session_id to open this credential's latest released session.",
                    { code: 'not_found' }
                );
            }
            throw error;
        }
    }

    const recent = await deps.api.listSessions({ status: 'released', limit: 1 }, signal);
    const latest = recent.sessions[0];
    if (!latest) {
        throw new SteelToolError(
            'No released Steel session was found for this credential. Pass steel_session_id with a finished ' +
                'session UUID from the Steel dashboard. This tool never starts a replacement browser.',
            { code: 'not_found' }
        );
    }
    return {
        session: await deps.api.getSession(latest.id, signal),
        selectedBy: 'latest_released',
    };
}

/** Registers the public, read-only finished-session dashboard resolver. */
export function registerSessionReplay(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'steel_session_replay',
        {
            title: 'Open a finished session',
            description:
                'Call only when the user explicitly asks to watch or replay a finished session. Returns its Steel ' +
                'dashboard link without starting a browser; use steel_session_diagnostics to inspect or explain activity.',
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
            inputSchema: replayInputSchema,
        },
        async (args, ctx) =>
            guard(deps, 'steel_session_replay', ctx.mcpReq, async () => {
                if (deps.config.deployment === 'self_hosted') {
                    throw new SteelToolError(
                        'Finished-session dashboard replay is a Steel Cloud capability. Point STEEL_BASE_URL at ' +
                            'Steel Cloud to open a finished session.',
                        { code: 'self_host_unsupported', details: { capability: 'session_replay' } }
                    );
                }

                const target = await resolveReplayTarget(deps, args.steel_session_id, ctx.mcpReq.signal);
                const status = typeof target.session.status === 'string' ? target.session.status : 'finished';
                if (status.toLowerCase() === 'live') {
                    throw new SteelToolError(
                        'That Steel session is still live. Use the live session viewer now, then release it before ' +
                            'requesting a finished-session replay.',
                        { code: 'invalid_argument' }
                    );
                }

                const dashboardUrl = safeDashboardUrl(target.session.sessionViewerUrl, target.session.id);
                if (!dashboardUrl) {
                    throw new SteelToolError(
                        'No safe Steel dashboard link is available for that finished session. Open it from the Steel ' +
                            'dashboard instead.',
                        { code: 'not_found' }
                    );
                }

                return successResult(
                    {
                        result: `Resolved finished Steel session ${target.session.id} without starting a browser.`,
                        links: `[Open finished session in Steel](${dashboardUrl})`,
                        notes: ['Inline replay is temporarily unavailable in this release.'],
                    },
                    {
                        steel_session_id: target.session.id,
                        status,
                        selected_by: target.selectedBy,
                        dashboard_url: dashboardUrl,
                    }
                );
            })
    );
}
