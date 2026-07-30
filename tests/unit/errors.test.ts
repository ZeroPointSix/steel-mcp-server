// ABOUTME: Unit tests for the error mapping layer that turns Steel and CDP failures into
// ABOUTME: actionable tool-execution errors naming the cause and the next thing to try.
import { describe, expect, it } from 'vitest';
import {
    botDetectionError,
    clickBlockedError,
    detectBotBlock,
    detectInteractiveBlock,
    interactiveBlockError,
    mapSteelHttpError,
    nextMitigationRung,
    SteelToolError,
    selfHostUnsupportedError,
    staleRefError,
    toolErrorResult,
} from '../../src/core/errors.js';

describe('mapSteelHttpError', () => {
    it('translates 402 into the verified-balance requirement for managed proxies', () => {
        const err = mapSteelHttpError(
            402,
            { message: 'Payment required', error: 'payment_required' },
            {
                operation: 'session_create',
            }
        );
        expect(err.code).toBe('payment_required');
        expect(err.message).toMatch(/\$10 verified paid balance/);
        expect(err.message).toMatch(/free credits do not count/i);
        expect(err.message).toMatch(/use_proxy/);
    });

    it('names the concurrency cap when a 429 hits session creation', () => {
        const err = mapSteelHttpError(
            429,
            { message: 'Too many requests' },
            {
                operation: 'session_create',
                retryAfterSeconds: 12,
            }
        );
        expect(err.code).toBe('rate_limited');
        expect(err.message).toMatch(/concurrent session/i);
        expect(err.message).toMatch(/Retry after 12s/);
    });

    it('names the separate Browser Tools cap when a 429 hits a stateless read', () => {
        const err = mapSteelHttpError(429, { message: 'Too many requests' }, { operation: 'browser_tool' });
        expect(err.message).toMatch(/20 requests\/min Browser Tools/);
        expect(err.message).toMatch(/60 requests\/min/);
    });

    it('prefers the concurrency explanation when Steel says so in the body', () => {
        const err = mapSteelHttpError(
            429,
            { message: 'Concurrent session limit reached' },
            {
                operation: 'browser_tool',
            }
        );
        expect(err.message).toMatch(/concurrent session/i);
    });

    it('suppresses the 401 body claim that Steel does not accept bearer tokens', () => {
        const err = mapSteelHttpError(
            401,
            { message: "Unauthorized. Steel does not use 'Authorization: Bearer'", error: 'unauthorized' },
            { operation: 'browser_tool' }
        );
        expect(err.code).toBe('unauthorized');
        expect(err.message).not.toMatch(/does not use/i);
        expect(err.message).toMatch(/STEEL_API_KEY/);
    });

    it('passes Steel linkToDocs through verbatim', () => {
        const err = mapSteelHttpError(
            400,
            { message: 'Bad region', linkToDocs: 'https://docs.steel.dev/regions' },
            {
                operation: 'session_create',
            }
        );
        expect(err.linkToDocs).toBe('https://docs.steel.dev/regions');
        expect(toolErrorResult(err).content[0]).toMatchObject({
            type: 'text',
            text: expect.stringContaining('https://docs.steel.dev/regions'),
        });
    });

    it('explains a 407 as proxy configuration', () => {
        const err = mapSteelHttpError(407, { message: 'Proxy Authentication Required' }, { operation: 'navigate' });
        expect(err.code).toBe('proxy_failure');
        expect(err.message).toMatch(/proxy/i);
    });

    it('keeps Steel prose for statuses it has no special mapping for', () => {
        const err = mapSteelHttpError(418, { message: 'I am a teapot' }, { operation: 'navigate' });
        expect(err.code).toBe('steel_error');
        expect(err.message).toContain('I am a teapot');
    });
});

describe('detectBotBlock', () => {
    it('recognises a Cloudflare challenge from the interstitial body', () => {
        expect(detectBotBlock({ status: 403, body: '<title>Just a moment...</title>' })?.vendor).toBe('Cloudflare');
    });

    it('recognises Cloudflare from the __cf_bm cookie header', () => {
        expect(detectBotBlock({ status: 200, headers: { 'set-cookie': '__cf_bm=abc; Path=/' } })?.vendor).toBe(
            'Cloudflare'
        );
    });

    it('recognises DataDome, PerimeterX and Akamai markers', () => {
        expect(detectBotBlock({ status: 403, headers: { 'x-datadome': 'protected' } })?.vendor).toBe('DataDome');
        expect(detectBotBlock({ status: 403, body: 'window._pxAppId = "PX123"' })?.vendor).toBe('PerimeterX');
        expect(detectBotBlock({ status: 403, headers: { 'set-cookie': 'ak_bmsc=x' } })?.vendor).toBe('Akamai');
    });

    it("recognises Google's /sorry/ interstitial from the final URL", () => {
        expect(detectBotBlock({ status: 200, finalUrl: 'https://www.google.com/sorry/index?continue=x' })?.vendor).toBe(
            'Google'
        );
    });

    it('returns null for an ordinary page', () => {
        expect(detectBotBlock({ status: 200, body: '<h1>Welcome</h1>', finalUrl: 'https://example.com/' })).toBeNull();
    });
});

describe('detectInteractiveBlock', () => {
    it('reuses the vendor taxonomy so an interstitial is classified as a challenge, not a login', () => {
        const block = detectInteractiveBlock({
            finalUrl: 'https://shop.test/cart',
            title: 'Just a moment...',
            text: 'RootWebArea Just a moment...',
        });
        expect(block).toMatchObject({ kind: 'captcha', vendor: 'Cloudflare', marker: 'cf-chl' });
    });

    it('recognises the CAPTCHA widgets a person can clear in a live browser', () => {
        for (const [text, vendor] of [
            ["checkbox I'm not a robot", 'reCAPTCHA'],
            ['iframe hCaptcha challenge', 'hCaptcha'],
            ['Verify you are human', 'human-verification'],
        ] as const) {
            expect(detectInteractiveBlock({ finalUrl: 'https://x.test/', text })).toMatchObject({
                kind: 'captcha',
                vendor,
            });
        }
    });

    it('calls a page with a password field a login wall', () => {
        const block = detectInteractiveBlock({
            finalUrl: 'https://app.test/login',
            title: 'Sign in',
            text: 'textbox Email\ntextbox Password\nbutton Sign in',
            hasPasswordField: true,
        });
        expect(block).toMatchObject({ kind: 'login_wall', marker: 'password_field' });
    });

    it('does not call every page with a Sign in link a login wall', () => {
        // Nearly every page on the web has a "Sign in" link in its header. Without the password
        // field the detector would hand a human control of the browser on ordinary navigations.
        expect(
            detectInteractiveBlock({
                finalUrl: 'https://shop.test/products',
                title: 'Products',
                text: 'link Sign in\nheading Products\nbutton Add to basket',
            })
        ).toBeNull();
    });

    it('returns null for an ordinary page', () => {
        expect(
            detectInteractiveBlock({ finalUrl: 'https://example.com/', title: 'Example', text: 'heading Welcome' })
        ).toBeNull();
    });
});

describe('interactiveBlockError', () => {
    it('routes a challenge to the bot-detection error, keeping the one-rung ladder', () => {
        const err = interactiveBlockError(
            { kind: 'captcha', vendor: 'DataDome', marker: 'datadome' },
            'https://shop.test/cart',
            {}
        );
        expect(err.code).toBe('bot_detection');
        expect(err.message).toBe(
            botDetectionError({ vendor: 'DataDome', marker: 'datadome' }, 'https://shop.test/cart', {}).message
        );
    });

    it('tells a login wall apart and points at the identity options, never at typing a password', () => {
        const err = interactiveBlockError(
            { kind: 'login_wall', vendor: 'credentials', marker: 'password_field' },
            'https://app.test/login',
            {}
        );
        expect(err.code).toBe('login_required');
        expect(err.message).toContain('https://app.test/login');
        expect(err.message).toMatch(/profile_id/);
        expect(err.message).toMatch(/namespace/);
        expect(err.message).toMatch(/never put a password in a tool argument/i);
    });

    it('says the saved identity is not signed in when the session already reuses a profile', () => {
        const err = interactiveBlockError(
            { kind: 'login_wall', vendor: 'credentials', marker: 'password_field' },
            'https://app.test/login',
            { profileId: 'p1' }
        );
        expect(err.message).toMatch(/already reuses a browser profile/i);
    });
});

describe('nextMitigationRung', () => {
    it('starts at identity, never all rungs at once', () => {
        expect(nextMitigationRung({})).toMatchObject({ rung: 'identity' });
    });

    it('advances to pacing, then proxies, then captcha, then stealth', () => {
        expect(nextMitigationRung({ profileId: 'p1' }).rung).toBe('pacing');
        expect(nextMitigationRung({ profileId: 'p1', paced: true }).rung).toBe('proxies');
        expect(nextMitigationRung({ profileId: 'p1', paced: true, useProxy: true }).rung).toBe('captcha');
        expect(nextMitigationRung({ profileId: 'p1', paced: true, useProxy: true, solveCaptcha: true }).rung).toBe(
            'stealth'
        );
    });
});

describe('botDetectionError', () => {
    it('says this is bot detection rather than a bug, and names exactly one next step', () => {
        const err = botDetectionError({ vendor: 'Cloudflare', marker: 'cf-chl' }, 'https://shop.test/cart', {});
        expect(err.code).toBe('bot_detection');
        expect(err.message).toMatch(/bot detection, not a bug/i);
        expect(err.message).toMatch(/Cloudflare/);
        expect(err.message).toMatch(/one thing at a time/i);
    });
});

describe('staleRefError', () => {
    it('names the ref, the snapshot it belongs to, the current snapshot and the recovery action', () => {
        const err = staleRefError('@e12', { refSnapshotId: 's3', currentSnapshotId: 's5', reason: 'page_navigated' });
        expect(err.code).toBe('stale_ref');
        expect(err.message).toContain('@e12');
        expect(err.message).toContain('s3');
        expect(err.message).toContain('s5');
        expect(err.message).toMatch(/page navigated/i);
        expect(err.message).toMatch(/steel_find|steel_snapshot/);
    });
});

describe('clickBlockedError', () => {
    it('names the covering element so the agent can dismiss it', () => {
        const err = clickBlockedError('@e7', 'div#consent-banner');
        expect(err.code).toBe('click_blocked');
        expect(err.message).toContain('div#consent-banner');
        expect(err.message).toMatch(/dismiss_overlays/);
    });
});

describe('selfHostUnsupportedError', () => {
    it('gives the concurrency-1 rule its own named error', () => {
        const err = selfHostUnsupportedError('concurrency');
        expect(err.code).toBe('self_host_unsupported');
        expect(err.message).toMatch(/one browser session at a time/i);
        expect(err.message).toMatch(/steel_session_release/);
    });

    it('names each missing cloud capability instead of failing opaquely', () => {
        expect(selfHostUnsupportedError('use_proxy').message).toMatch(/Steel-managed prox/i);
        expect(selfHostUnsupportedError('solve_captcha').message).toMatch(/CAPTCHA solving/i);
        expect(selfHostUnsupportedError('region').message).toMatch(/region/i);
        expect(selfHostUnsupportedError('profile_id').message).toMatch(/profile/i);
    });
});

describe('toolErrorResult', () => {
    it('produces an isError tool result with the message under an Error heading', () => {
        const result = toolErrorResult(new SteelToolError('boom', { code: 'steel_error' }));
        expect(result.isError).toBe(true);
        expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('### Error') });
        expect(result.structuredContent).toMatchObject({ error: { code: 'steel_error', message: 'boom' } });
    });

    it('wraps an unknown throwable without leaking a stack trace', () => {
        const result = toolErrorResult(new TypeError('undefined is not a function'));
        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('undefined is not a function');
        expect(text).not.toContain('at Object.');
    });
});
