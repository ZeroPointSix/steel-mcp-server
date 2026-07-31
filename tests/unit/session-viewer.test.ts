// ABOUTME: Unit tests for the session-viewer app module: the URI and MIME type the server and the
// ABOUTME: shell agree on, and that the shell references nothing the host's CSP would block.
import { describe, expect, it } from 'vitest';
import {
    SESSION_VIEWER_HTML,
    SESSION_VIEWER_MIME_TYPE,
    SESSION_VIEWER_URI,
} from '../../src/core/apps/session-viewer.js';

describe('the session-viewer app identity', () => {
    it('is published under the ui:// URI the tool result points at', () => {
        expect(SESSION_VIEWER_URI).toBe('ui://steel/session-viewer');
    });

    it('declares the profiled MIME type a host keys its app renderer off', () => {
        expect(SESSION_VIEWER_MIME_TYPE).toBe('text/html;profile=mcp-app');
    });
});

describe('the session-viewer shell', () => {
    it('is a complete HTML document', () => {
        expect(SESSION_VIEWER_HTML).toMatch(/^<!doctype html>/i);
        expect(SESSION_VIEWER_HTML).toContain('</html>');
    });

    it('loads no subresource from another origin, which the host CSP blocks outright', () => {
        expect(SESSION_VIEWER_HTML).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
    });

    it('bakes in nothing session-specific, so it stays publicly cacheable', () => {
        // The connection details arrive over the app bridge; a handle or a token in the shell would
        // make one org's session viewable from a cache entry served to another.
        expect(SESSION_VIEWER_HTML).not.toMatch(/sess_|token=|sessionId=/);
    });
});
