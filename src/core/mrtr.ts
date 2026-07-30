// ABOUTME: The human-in-the-loop handoff: a login wall or CAPTCHA becomes a URL-mode elicitation
// ABOUTME: pointing at the session's live player, and the retried call re-checks the page itself.
import {
    CLIENT_CAPABILITIES_META_KEY,
    type ClientCapabilities,
    createRequestStateCodec,
    type InputRequiredResult,
    inputRequired,
    inputResponse,
    type RequestStateCodec,
    type ServerContext,
} from '@modelcontextprotocol/server';
import type { ServerDeps } from './context.js';
import {
    detectInteractiveBlock,
    type InteractiveBlock,
    type InteractiveBlockKind,
    interactiveBlockError,
    type PageBlockEvidence,
} from './errors.js';
import type { BrowserPage } from './page.js';
import type { HandleRecord } from './registry.js';

/** The key the elicitation is filed under, and the key the retry's response comes back on. */
export const HANDOFF_KEY = 'steel_human_handoff';

/**
 * How many handoffs one flow may ask for before it gives up and returns the actionable error.
 *
 * The spec permits asking indefinitely. A bound is better: after three attempts the person is not
 * getting through, and a caller stuck in a loop learns nothing from a fourth identical prompt.
 */
export const MAX_HANDOFF_ROUNDS = 3;

/**
 * How long idle reclamation is suspended for while a person works.
 *
 * Matches the SDK's human-paced per-leg timeout, and the registry clamps it to the handle's own
 * hard expiry, so this can never keep a slot past the session's Steel-enforced lifetime.
 */
export const HANDOFF_GRACE_MS = 600_000;

/**
 * The state a retried call carries.
 *
 * Signed, not encrypted: the client can read every field, so nothing secret goes in. Each field is
 * here to be checked on the way back in — the handle and tool so state minted for one session and
 * verb cannot be replayed onto another, the round so the loop is bounded, the URL for the message.
 */
export interface HandoffState {
    handle: string;
    tool: string;
    block: InteractiveBlockKind;
    url: string;
    round: number;
}

/**
 * Builds the HMAC codec for the handoff state.
 *
 * The binding is the spec's user-binding MUST: state minted for one principal on one method is
 * refused when echoed under another. The binding value is stored as a keyed tag, never raw, so the
 * principal does not travel in the value the client holds.
 */
export function createHandoffCodec(secret: string): RequestStateCodec<HandoffState> {
    return createRequestStateCodec<HandoffState>({
        key: secret,
        bind: ctx => `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? ''}`,
    });
}

/** Query parameters that would turn the handed-out player URL into a leaked credential. */
const CREDENTIAL_PARAMS = ['apiKey', 'api_key', 'token', 'access_token', 'authorization', 'key'];

/**
 * Prepares the live-player URL for the one place it is allowed to go: the elicitation payload.
 *
 * The player URL is already an unauthenticated bearer capability — whoever holds it can watch and
 * drive the browser — so it must not also carry the Steel API key. Any credential-shaped parameter
 * is dropped, and a URL that is not http(s) is refused rather than handed to a person to open.
 */
export function handoffViewerUrl(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return undefined;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    for (const param of CREDENTIAL_PARAMS) url.searchParams.delete(param);
    return url.toString();
}

/**
 * Whether this request may be answered with a URL-mode elicitation.
 *
 * The per-request `_meta` envelope is the 2026-07-28 capability view; `declaredAtConnect` supplies
 * the initialize-declared capabilities an older connection has instead. A bare `elicitation: {}`
 * means form mode on the 2025 reading, so the url sub-capability must be spelled out — the same
 * rule the SDK applies before it will put the request on the wire.
 */
export function supportsUrlElicitation(
    ctx: ServerContext,
    declaredAtConnect?: () => ClientCapabilities | undefined
): boolean {
    // The SDK publishes the envelope as an opaque record, so its reserved keys are read by name.
    const envelope = ctx.mcpReq.envelope as Record<string, ClientCapabilities | undefined> | undefined;
    const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? declaredAtConnect?.();
    return declared?.elicitation?.url !== undefined;
}

/** Fixed prose per block kind. Page text is never quoted here — it would be an injection channel. */
function describeBlock(block: InteractiveBlock): string {
    return block.kind === 'login_wall'
        ? 'This page is asking someone to sign in'
        : `This page is showing a ${block.vendor} challenge`;
}

export interface HandoffRequest {
    deps: ServerDeps;
    ctx: ServerContext;
    /** The initialize-declared capabilities, for a connection with no per-request envelope. */
    declaredAtConnect?: (() => ClientCapabilities | undefined) | undefined;
    /** The public handle the caller passed, sealed into the state so it cannot be replayed. */
    handle: string;
    record: HandleRecord;
    page: BrowserPage;
    /** The tool being served, sealed into the state and checked on the way back in. */
    tool: string;
}

/** Reads the live page into the evidence the one detector in `errors.ts` classifies. */
async function pageEvidence(page: BrowserPage): Promise<PageBlockEvidence> {
    // Captured for detection only and never returned, so it costs CDP round trips and no tokens.
    const snapshot = await page.snapshot({});
    return {
        finalUrl: snapshot.url,
        title: snapshot.title,
        text: snapshot.nodes.map(node => `${node.role} ${node.name}`).join('\n'),
        hasPasswordField: snapshot.nodes.some(node => node.sensitive),
    };
}

/**
 * Decides what a tool should do about a page only a person can get past.
 *
 * Returns `undefined` when the page is clear, which is also the verification result on a retry:
 * the live page is read again on every round, so the client's report that a person finished is
 * never what unblocks the call. Throws the actionable tool-execution error when a handoff cannot
 * or should not be offered — an unchanged fallback for every client that cannot elicit.
 */
export async function resolveHumanHandoff(request: HandoffRequest): Promise<InputRequiredResult | undefined> {
    const { deps, ctx, handle, record, tool } = request;
    const evidence = await pageEvidence(request.page);
    const block = detectInteractiveBlock(evidence);
    const prior = ctx.mcpReq.requestState<HandoffState>();

    if (!block) return undefined;

    // Annotated on the binding, not only the arrow, so control-flow analysis knows a call ends here.
    const fail: () => never = () => {
        throw interactiveBlockError(block, evidence.finalUrl, record.mitigation);
    };

    if (prior !== undefined) {
        // The state was minted by this server for this session and this verb, or it is not ours to
        // act on. Integrity, expiry and principal are already proven by the codec at the seam.
        if (prior.handle !== handle || prior.tool !== tool) fail();
        // A person who declined or cancelled is not asked twice.
        const response = inputResponse(ctx.mcpReq.inputResponses, HANDOFF_KEY);
        if (response.kind === 'elicit' && response.action !== 'accept') fail();
        if (prior.round >= MAX_HANDOFF_ROUNDS) fail();
    }

    if (!supportsUrlElicitation(ctx, request.declaredAtConnect)) fail();

    const url = handoffViewerUrl(record.debugUrl);
    if (url === undefined) fail();

    const round = (prior?.round ?? 0) + 1;
    const state: HandoffState = { handle, tool, block: block.kind, url: evidence.finalUrl, round };
    const requestState = await deps.handoffState.mint(state, ctx);

    // Set only once the elicitation is certain to be returned, so a call that degrades to the
    // error does not leave a slot pinned by a handoff nobody was ever asked to complete.
    await deps.registry.awaitInput(handle, Math.min(deps.now().getTime() + HANDOFF_GRACE_MS, record.expiresAt));

    return inputRequired({
        requestState,
        inputRequests: {
            [HANDOFF_KEY]: inputRequired.elicitUrl({
                message:
                    `${describeBlock(block)} on ${evidence.finalUrl}. Open the live browser and finish this step ` +
                    'by hand, then let the tool run again — it re-reads the page and carries on only if the way ' +
                    'is actually clear.',
                url,
            }),
        },
    });
}
