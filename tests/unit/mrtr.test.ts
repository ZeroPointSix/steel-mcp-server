// ABOUTME: Unit tests for the human-in-the-loop handoff: the signed requestState it round-trips,
// ABOUTME: the client-capability gate that decides whether it may be offered, and the viewer URL.
import type { ServerContext } from '@modelcontextprotocol/server';
import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
    createHandoffCodec,
    type HandoffState,
    handoffViewerUrl,
    supportsUrlElicitation,
} from '../../src/core/mrtr.js';

const SECRET = 'k'.repeat(48);

/** The smallest slice of the server context the handoff reads, shaped as the SDK hands it over. */
function context(options: { capabilities?: Record<string, unknown>; method?: string; clientId?: string } = {}) {
    return {
        mcpReq: {
            method: options.method ?? 'tools/call',
            ...(options.capabilities === undefined
                ? {}
                : { envelope: { [CLIENT_CAPABILITIES_META_KEY]: options.capabilities } }),
        },
        ...(options.clientId === undefined ? {} : { http: { authInfo: { clientId: options.clientId } } }),
    } as unknown as ServerContext;
}

const STATE: HandoffState = {
    handle: 'sess_abc',
    tool: 'steel_navigate',
    block: 'login_wall',
    url: 'https://app.test/login',
    round: 1,
};

describe('createHandoffCodec', () => {
    it('round-trips the state a retry needs and nothing a client could not already see', async () => {
        const codec = createHandoffCodec(SECRET);
        const ctx = context({ clientId: 'principal-a' });
        expect(await codec.verify(await codec.mint(STATE, ctx), ctx)).toEqual(STATE);
    });

    it('rejects state whose body was edited, so a client cannot promote its own round count', async () => {
        const codec = createHandoffCodec(SECRET);
        const ctx = context({ clientId: 'principal-a' });
        const sealed = await codec.mint(STATE, ctx);
        const [version, body, mac] = sealed.split('.');
        const edited = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8'));
        edited.p.handle = 'sess_someoneelse';
        const forged = [version, Buffer.from(JSON.stringify(edited)).toString('base64url'), mac].join('.');

        await expect(codec.verify(forged, ctx)).rejects.toThrow(/mac/);
    });

    it('rejects state echoed by a different principal', async () => {
        const codec = createHandoffCodec(SECRET);
        const sealed = await codec.mint(STATE, context({ clientId: 'principal-a' }));
        await expect(codec.verify(sealed, context({ clientId: 'principal-b' }))).rejects.toThrow(/bind/);
    });

    it('rejects state echoed on a different method', async () => {
        const codec = createHandoffCodec(SECRET);
        const sealed = await codec.mint(STATE, context({ method: 'tools/call' }));
        await expect(codec.verify(sealed, context({ method: 'resources/read' }))).rejects.toThrow(/bind/);
    });

    it('rejects state minted under a different secret', async () => {
        const sealed = await createHandoffCodec(SECRET).mint(STATE, context());
        await expect(createHandoffCodec('j'.repeat(48)).verify(sealed, context())).rejects.toThrow(/mac/);
    });

    it('never embeds the principal in the wire value the client holds', async () => {
        const codec = createHandoffCodec(SECRET);
        const sealed = await codec.mint(STATE, context({ clientId: 'principal-a' }));
        expect(sealed).not.toContain('principal-a');
    });
});

describe('supportsUrlElicitation', () => {
    it('is true only when the request declares the url elicitation mode', () => {
        expect(supportsUrlElicitation(context({ capabilities: { elicitation: { url: {} } } }))).toBe(true);
    });

    it('is false for a client that declared form elicitation only', () => {
        expect(supportsUrlElicitation(context({ capabilities: { elicitation: { form: {} } } }))).toBe(false);
    });

    it('is false for a bare elicitation declaration, which means form on the 2025 reading', () => {
        expect(supportsUrlElicitation(context({ capabilities: { elicitation: {} } }))).toBe(false);
    });

    it('is false when the request declared no capabilities at all', () => {
        expect(supportsUrlElicitation(context({ capabilities: {} }))).toBe(false);
        expect(supportsUrlElicitation(context())).toBe(false);
    });

    it('falls back to the capabilities an older connection declared at initialize', () => {
        const declared = { elicitation: { url: {} } };
        expect(supportsUrlElicitation(context(), () => declared)).toBe(true);
        expect(supportsUrlElicitation(context(), () => undefined)).toBe(false);
    });
});

describe('handoffViewerUrl', () => {
    it('passes a plain player URL through', () => {
        expect(handoffViewerUrl('https://api.steel.dev/v1/sessions/abc/player')).toBe(
            'https://api.steel.dev/v1/sessions/abc/player'
        );
    });

    it('strips any credential a deployment put in the query before the URL leaves the server', () => {
        const url = handoffViewerUrl(
            'https://api.steel.dev/v1/sessions/abc/player?apiKey=ste-secret&token=t&access_token=a&hideOverlay=true'
        );
        expect(url).not.toContain('ste-secret');
        expect(url).not.toContain('token');
        expect(url).toContain('hideOverlay=true');
    });

    it('refuses a non-http URL rather than handing a person something unopenable', () => {
        expect(handoffViewerUrl('javascript:alert(1)')).toBeUndefined();
        expect(handoffViewerUrl('not a url')).toBeUndefined();
        expect(handoffViewerUrl(undefined)).toBeUndefined();
    });
});
