// ABOUTME: Explicit, model-invocable transfer of one live browser to a person and back again.
// ABOUTME: Uses the same signed elicitation and trusted viewer paths as automatic login/CAPTCHA handoff.
import {
    type ClientCapabilities,
    inputRequired,
    inputResponse,
    type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps, ToolHost } from '../context.js';
import { SteelToolError } from '../errors.js';
import {
    HANDOFF_GRACE_MS,
    HANDOFF_KEY,
    type HandoffState,
    handoffOrigin,
    handoffViewerUrl,
    supportsElicitation,
    supportsInlineViewer,
    supportsUrlElicitation,
} from '../mrtr.js';
import { guard, sessionIdSchema, successResult } from './shared.js';

const reasons = ['sensitive_input', 'file_upload', 'review', 'manual_step'] as const;
type HandoffReason = (typeof reasons)[number];

const REASON_TEXT: Record<HandoffReason, string> = {
    sensitive_input: 'enter sensitive information',
    file_upload: 'choose a file from their device',
    review: 'review the page before anything continues',
    manual_step: 'finish this step manually',
};

async function currentOrigin(deps: ServerDeps, steelSessionId: string, signal?: AbortSignal): Promise<string> {
    try {
        const page = await deps.pool.page(steelSessionId, signal);
        const snapshot = await page.snapshot({ interactiveOnly: true });
        return handoffOrigin(snapshot.url) ?? '';
    } catch {
        return '';
    }
}

function noHandoffRoute(): SteelToolError {
    return new SteelToolError(
        'This MCP client cannot pause for human browser control: it exposes neither the inline viewer nor URL elicitation. Keep the session open and ask the user to open its viewer_url, or use a compatible MCP Apps client.',
        { code: 'client_capability_missing', details: { capability: 'human_handoff' } }
    );
}

/** Registers the ordinary human-control path; no detector or failure is required to invoke it. */
export function registerSessionHandoff(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'steel_session_handoff',
        {
            title: 'Hand the browser to a person',
            description:
                'Pause for a person to take exclusive control of this same live browser, then resume only after hand-back. Use for sensitive input, local files, review, or any manual step.',
            annotations: { destructiveHint: true, openWorldHint: true },
            inputSchema: z
                .object({
                    session_id: sessionIdSchema,
                    reason: z.enum(reasons).describe('Why a person needs control.'),
                })
                .strict(),
        },
        async (args, ctx) =>
            guard(deps, 'steel_session_handoff', ctx.mcpReq, async () => {
                const serverCtx = ctx as ServerContext;
                const prior = ctx.mcpReq.requestState<HandoffState>();

                if (prior !== undefined) {
                    if (prior.handle !== args.session_id || prior.tool !== 'steel_session_handoff') {
                        throw new SteelToolError('The handoff state belongs to a different browser operation.', {
                            code: 'invalid_argument',
                        });
                    }
                    const response = inputResponse(ctx.mcpReq.inputResponses, HANDOFF_KEY);
                    if (response.kind === 'elicit' && response.action !== 'accept') {
                        throw new SteelToolError('The person declined or cancelled browser control.', {
                            code: 'invalid_argument',
                        });
                    }
                    const record = await deps.registry.resolveForAgent(args.session_id, deps.principal);
                    await deps.registry.touch(args.session_id);
                    const origin = await currentOrigin(deps, record.steelSessionId, ctx.mcpReq.signal);
                    return successResult(
                        {
                            result: 'The person handed the browser back. Re-read the page before acting; its state may have changed.',
                            pageState: origin || undefined,
                        },
                        { session_id: args.session_id, handoff: { status: 'returned', origin } }
                    );
                }

                const record = await deps.registry.resolveForAgent(args.session_id, deps.principal);
                const origin = await currentOrigin(deps, record.steelSessionId, ctx.mcpReq.signal);
                const state: HandoffState = {
                    handle: args.session_id,
                    tool: 'steel_session_handoff',
                    block: args.reason,
                    origin,
                    round: 1,
                };
                const requestState = await deps.handoffState.mint(state, ctx);
                const until = Math.min(deps.now().getTime() + HANDOFF_GRACE_MS, record.expiresAt);
                const reason = `A person needs to ${REASON_TEXT[args.reason]}${origin ? ` on ${origin}` : ''}.`;
                const deadline = ` Finish before ${new Date(record.expiresAt).toISOString()}; handoff cannot extend it.`;
                const declaredAtConnect = () => host.server.getClientCapabilities() as ClientCapabilities;
                const inlineViewer = record.inlineViewer || supportsInlineViewer(serverCtx);

                if (inlineViewer && supportsElicitation(serverCtx)) {
                    const message =
                        `${reason} Use the existing live browser viewer and finish this step by hand. ` +
                        'When finished, choose Hand back in the viewer, then accept the pending handoff prompt so the agent can re-read the page and continue.' +
                        deadline;
                    await deps.registry.awaitInput(args.session_id, until);
                    return inputRequired({
                        requestState,
                        inputRequests: {
                            [HANDOFF_KEY]: inputRequired.elicit({
                                message,
                                requestedSchema: { type: 'object', properties: {} },
                            }),
                        },
                    });
                }

                if (supportsUrlElicitation(serverCtx, declaredAtConnect)) {
                    const url = handoffViewerUrl(record.debugUrl);
                    if (!url) throw noHandoffRoute();
                    const message =
                        `${reason} Open the linked live browser and finish this step by hand. When finished, ` +
                        'choose Hand back in the viewer, then return here and accept the pending handoff prompt so the agent can re-read the page and continue.' +
                        deadline;
                    await deps.registry.awaitInput(args.session_id, until);
                    return inputRequired({
                        requestState,
                        inputRequests: { [HANDOFF_KEY]: inputRequired.elicitUrl({ message, url }) },
                    });
                }

                if (inlineViewer) {
                    const message =
                        `${reason} Use the existing live browser viewer and finish this step by hand. ` +
                        'When finished, choose Hand back in the viewer, then tell the agent to continue.' +
                        deadline;
                    await deps.registry.awaitInput(args.session_id, until);
                    return successResult(
                        {
                            result: `${message} This client cannot formally pause the tool call, so do not act or release the session until the user confirms hand-back.`,
                        },
                        {
                            session_id: args.session_id,
                            handoff: {
                                status: 'awaiting_human',
                                mode: 'inline',
                                expires_at: new Date(until).toISOString(),
                            },
                        }
                    );
                }

                throw noHandoffRoute();
            })
    );
}
