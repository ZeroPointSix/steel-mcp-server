// ABOUTME: Unit tests for the readers over Steel's two diagnostics endpoints, pinned to bodies
// ABOUTME: captured from a live session rather than to the shapes the docs imply.
import { describe, expect, it } from 'vitest';
import {
    agentTraceErrorText,
    agentTraceUrl,
    agentTraceValueSummary,
    isDiagnosticLog,
    parseSessionLogPayload,
    sessionLogErrorText,
    sessionLogUrl,
} from '../../src/core/steel/diagnostics.js';

describe('agentTraceUrl', () => {
    it('prefers the documented page context', () => {
        expect(agentTraceUrl({ type: 'click', page: { url: 'https://example.com/login' } })).toBe(
            'https://example.com/login'
        );
    });

    it('falls back to the navigation context a navigate activity carries', () => {
        expect(agentTraceUrl({ type: 'navigate', navigation: { url: 'about:blank' } })).toBe('about:blank');
    });

    it('prefers the page context when an activity carries both', () => {
        expect(
            agentTraceUrl({
                type: 'navigate',
                page: { url: 'https://from.test/' },
                navigation: { url: 'https://to.test/' },
            })
        ).toBe('https://from.test/');
    });

    it('accepts a top-level url last', () => {
        expect(agentTraceUrl({ type: 'navigate', url: 'https://legacy.test/' })).toBe('https://legacy.test/');
    });

    it('is undefined when nothing carries a usable url', () => {
        expect(agentTraceUrl({ type: 'scroll' })).toBeUndefined();
        expect(agentTraceUrl({ type: 'scroll', page: {} })).toBeUndefined();
        expect(agentTraceUrl({ type: 'scroll', page: { url: '' } })).toBeUndefined();
        expect(agentTraceUrl({ type: 'scroll', url: 42 })).toBeUndefined();
    });
});

describe('agentTraceErrorText', () => {
    it('reads a bare string error', () => {
        expect(agentTraceErrorText({ type: 'error', error: 'net::ERR_ABORTED' })).toBe('net::ERR_ABORTED');
    });

    it('reads the message of an object error', () => {
        expect(agentTraceErrorText({ type: 'error', error: { message: 'Navigation timed out' } })).toBe(
            'Navigation timed out'
        );
    });

    it('is undefined for an error shape it cannot read, rather than rendering an object', () => {
        expect(agentTraceErrorText({ type: 'error', error: {} })).toBeUndefined();
        expect(agentTraceErrorText({ type: 'error', error: { code: 7 } })).toBeUndefined();
        expect(agentTraceErrorText({ type: 'error', error: '' })).toBeUndefined();
        expect(agentTraceErrorText({ type: 'click' })).toBeUndefined();
    });
});

describe('agentTraceValueSummary', () => {
    it('reports the metadata Steel records for entered text', () => {
        // Verbatim from typing the 8-character string "practice" into a live form.
        expect(agentTraceValueSummary({ type: 'change', value: { inputType: 'text', valueLength: 8 } })).toBe(
            '8 chars typed (text)'
        );
    });

    it('reports the length alone when no input type came with it', () => {
        expect(agentTraceValueSummary({ type: 'change', value: { valueLength: 3 } })).toBe('3 chars typed');
    });

    it('reports a cleared field rather than dropping it', () => {
        expect(agentTraceValueSummary({ type: 'change', value: { inputType: 'text', valueLength: 0 } })).toBe(
            '0 chars typed (text)'
        );
    });

    it('drops a value that is not the metadata object, so page text cannot ride in on a guess', () => {
        expect(agentTraceValueSummary({ type: 'change', value: 'hunter2' })).toBeUndefined();
        expect(agentTraceValueSummary({ type: 'change', value: { valueLength: 'lots' } })).toBeUndefined();
        expect(agentTraceValueSummary({ type: 'change', value: { text: 'hunter2' } })).toBeUndefined();
        expect(agentTraceValueSummary({ type: 'change', value: {} })).toBeUndefined();
        expect(agentTraceValueSummary({ type: 'click' })).toBeUndefined();
    });

    it('never lets the input type carry the text, since only the length is a count', () => {
        expect(agentTraceValueSummary({ type: 'change', value: { inputType: 'text' } })).toBeUndefined();
    });
});

describe('parseSessionLogPayload', () => {
    it('parses the JSON-encoded log string a live entry carries', () => {
        const payload = parseSessionLogPayload({
            type: 'Navigation',
            log: '{"pageId":"ED45","navigation":{"url":"about:blank"},"createdAt":1785428340864}',
        });
        expect(payload).toEqual({ pageId: 'ED45', navigation: { url: 'about:blank' }, createdAt: 1785428340864 });
    });

    it('is undefined for a payload it cannot read, rather than throwing into the renderer', () => {
        expect(parseSessionLogPayload({ type: 'Request', log: 'not json at all' })).toBeUndefined();
        expect(parseSessionLogPayload({ type: 'Request', log: '' })).toBeUndefined();
        expect(parseSessionLogPayload({ type: 'Request', log: '{"unterminated":' })).toBeUndefined();
        expect(parseSessionLogPayload({ type: 'Request' })).toBeUndefined();
        // A bare JSON scalar parses but is not a record, so there is nothing to read fields off.
        expect(parseSessionLogPayload({ type: 'Request', log: '42' })).toBeUndefined();
        expect(parseSessionLogPayload({ type: 'Request', log: 'null' })).toBeUndefined();
    });
});

describe('sessionLogUrl and sessionLogErrorText', () => {
    /** Verbatim from a live RequestFailed entry, ad script and all. */
    const requestFailed = {
        type: 'RequestFailed',
        timestamp: '2026-07-31T11:11:59.330Z',
        id: 'session-0-12',
        log: JSON.stringify({
            pageId: '15F9',
            error: { message: 'net::ERR_FAILED', url: 'https://pagead2.googlesyndication.com/adsbygoogle.js' },
            createdAt: 1785496290115,
        }),
    };

    it('reads the failing URL and message out of a RequestFailed payload', () => {
        const payload = parseSessionLogPayload(requestFailed);
        expect(sessionLogUrl(payload)).toBe('https://pagead2.googlesyndication.com/adsbygoogle.js');
        expect(sessionLogErrorText(payload)).toBe('net::ERR_FAILED');
    });

    it('reads the destination of a Navigation payload', () => {
        const payload = parseSessionLogPayload({
            type: 'Navigation',
            log: '{"navigation":{"url":"https://practice.expandtesting.com/login"}}',
        });
        expect(sessionLogUrl(payload)).toBe('https://practice.expandtesting.com/login');
        expect(sessionLogErrorText(payload)).toBeUndefined();
    });

    it('is undefined when there is no payload to read', () => {
        expect(sessionLogUrl(undefined)).toBeUndefined();
        expect(sessionLogErrorText(undefined)).toBeUndefined();
        expect(sessionLogUrl({})).toBeUndefined();
    });
});

describe('isDiagnosticLog', () => {
    it('keeps the two types that explain a session going wrong', () => {
        expect(isDiagnosticLog({ type: 'RequestFailed' })).toBe(true);
        expect(isDiagnosticLog({ type: 'Navigation' })).toBe(true);
    });

    it('drops the per-request noise, which was 77 of the 84 entries one page load produced', () => {
        expect(isDiagnosticLog({ type: 'Request' })).toBe(false);
        expect(isDiagnosticLog({ type: 'Response' })).toBe(false);
    });

    it('keeps a type it has never seen, because a new type is likelier signal than noise', () => {
        expect(isDiagnosticLog({ type: 'ConsoleError' })).toBe(true);
        expect(isDiagnosticLog({ type: 'SomethingSteelAddsLater' })).toBe(true);
        expect(isDiagnosticLog({})).toBe(true);
    });
});
