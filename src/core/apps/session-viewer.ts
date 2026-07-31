// ABOUTME: Identity and markup of the inline session-viewer MCP app: its ui:// URI, its profiled
// ABOUTME: MIME type, and the self-contained HTML shell the host renders in its sandboxed iframe.

/** The `ui://` URI the host reads the shell from. Fixed: the shell and the server both name it. */
export const SESSION_VIEWER_URI = 'ui://steel/session-viewer';

/**
 * The MIME type that marks this HTML as an MCP app rather than a document to display.
 *
 * The `profile` parameter is what a host keys its app renderer off, so the spelling — no space
 * before `profile` — is part of the contract and not a formatting choice.
 */
export const SESSION_VIEWER_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * The shell, in full.
 *
 * Self-contained by necessity rather than by preference: the host serves it from an opaque origin
 * under a CSP whose `default-src` is `'self'`, so a stylesheet, font, image or script fetched from
 * anywhere else is blocked outright. Nothing session-specific is baked in — the shell asks for the
 * connection details over the app bridge once the host has rendered it, which is also why the
 * resource can be cached publicly for an hour.
 */
export const SESSION_VIEWER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Steel live session</title>
<style>
  html,body{margin:0;height:100%;background:#111;color:#eee;font:14px system-ui,sans-serif}
  main{display:flex;align-items:center;justify-content:center;height:100%}
</style>
</head>
<body><main id="status">Connecting to the live browser session…</main></body>
</html>
`;
