// ABOUTME: Unit tests for the agent-trace field readers, pinned to the page context Steel documents
// ABOUTME: and to the navigation context a live navigate activity actually carries.
import { describe, expect, it } from 'vitest';
import { agentTraceErrorText, agentTraceUrl } from '../../src/core/steel/traces.js';

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
