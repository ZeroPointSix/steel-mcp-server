// ABOUTME: A strict fake MCP-Apps host: serves the session viewer in a sandboxed iframe, speaks the
// ABOUTME: postMessage bridge, records every message in order and refuses anything out of sequence.
import { createServer, type Server } from 'node:http';
import {
    SESSION_VIEWER_HTML,
    SESSION_VIEWER_LIVE_VIEW_TOOL,
    SESSION_VIEWER_READY_MESSAGE_TYPE,
} from '../../src/core/apps/session-viewer.js';
import type { BrowserPage, HeadlessChrome } from './headless-chrome.js';

/** What the fake host makes `tools/call` for the live-view tool answer. */
export type LiveViewAnswer =
    | { kind: 'ok'; cdpUrl: string; viewport?: { width: number; height: number }; expiresAt?: string | number }
    /** A tool that ran and reported failure: `isError` with text, not a JSON-RPC error. */
    | { kind: 'tool-error'; message: string }
    /** The host itself refusing the call. */
    | { kind: 'rpc-error'; message: string }
    /** A reply with no `structuredContent` at all. */
    | { kind: 'no-details' }
    /** No answer ever, to run the app's own call timeout. */
    | { kind: 'silent' };

export interface FakeHostOptions {
    /** The `ui/initialize` protocol versions this host speaks; it declines every other one. */
    acceptedProtocolVersions?: readonly string[];
    /**
     * How long the host sits on a successful `ui/initialize` reply.
     *
     * A slow host is what makes the app's own ordering rule testable: a session pushed during the
     * delay must still not produce a `tools/call` before the initialized notification.
     */
    initializeDelayMs?: number;
    /**
     * An extra `content-security-policy` response header for the app document.
     *
     * A real MCP host narrows the app's `connect-src` to the origins the resource declared, so this
     * is how a test makes the host refuse the socket the app wants to open.
     */
    appCsp?: string;
    liveView?: LiveViewAnswer;
}

/** One JSON-RPC request or notification the app posted to its parent. */
export interface HostMessage {
    method: string;
    id?: number | string;
    params?: Record<string, unknown>;
}

/** One JSON-RPC response the app posted back for a request the host made. */
export interface HostResponse {
    id: number | string;
    result?: unknown;
    error?: unknown;
}

/** Everything the host page recorded, read out of the browser in one round trip. */
export interface HostLog {
    messages: HostMessage[];
    responses: HostResponse[];
    /** Requests the host refused because the app broke the bridge contract. */
    violations: string[];
    /** True once the app posted its plain ready echo. */
    ready: boolean;
    initialized: boolean;
}

/** What the app is showing, as a user would read it off the screen. */
export interface ViewerScreen {
    headline: string;
    note: string;
    badge: string;
    veilHidden: boolean;
    badgeHidden: boolean;
    spinHidden: boolean;
}

/** What is on the canvas: its pixel size and the colour at its centre. */
export interface ViewerCanvas {
    width: number;
    height: number;
    centre: [number, number, number, number];
}

const DEFAULT_VERSIONS = ['2026-01-26', '2025-11-25', '2025-06-18'] as const;

function hostDocument(options: FakeHostOptions): string {
    const config = {
        liveViewTool: SESSION_VIEWER_LIVE_VIEW_TOOL,
        readyMessage: SESSION_VIEWER_READY_MESSAGE_TYPE,
        acceptedProtocolVersions: options.acceptedProtocolVersions ?? DEFAULT_VERSIONS,
        initializeDelayMs: options.initializeDelayMs ?? 0,
        liveView: options.liveView ?? { kind: 'silent' },
    };
    // Kept to plain ES5 and one listener so the sequence it enforces is readable at a glance.
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fake MCP Apps host</title>
<style>html,body{margin:0;height:100%}iframe{display:block;width:800px;height:500px;border:0}</style></head>
<body>
<iframe id="app" src="/app" sandbox="allow-scripts"></iframe>
<script>
'use strict';
var CONFIG = ${JSON.stringify(config)};
var log = { messages: [], responses: [], violations: [], ready: false, initialized: false };
window.__host = log;

function app(){ return document.getElementById('app').contentWindow; }
function post(message){ app().postMessage(message, '*'); }
function reply(id, result){ post({ jsonrpc: '2.0', id: id, result: result }); }
/** A legitimate refusal: the app asked for something this host does not offer. */
function decline(id, message){ post({ jsonrpc: '2.0', id: id, error: { code: -32601, message: message } }); }
/** The app broke the bridge contract. Recorded, so a test never has to infer it from ordering. */
function refuse(id, message){ log.violations.push(message); post({ jsonrpc: '2.0', id: id, error: { code: -32600, message: message } }); }

function answerLiveView(id){
  var answer = CONFIG.liveView;
  if (answer.kind === 'silent') return;
  if (answer.kind === 'rpc-error') { decline(id, answer.message); return; }
  if (answer.kind === 'tool-error') { reply(id, { isError: true, content: [{ type: 'text', text: answer.message }] }); return; }
  if (answer.kind === 'no-details') { reply(id, { content: [{ type: 'text', text: 'the live view is not available' }] }); return; }
  var structured = { cdp_url: answer.cdpUrl };
  if (answer.viewport) structured.viewport = answer.viewport;
  if (answer.expiresAt !== undefined) structured.expires_at = answer.expiresAt;
  reply(id, { content: [{ type: 'text', text: 'live view ready' }], structuredContent: structured });
}

window.addEventListener('message', function (event) {
  var message = event.data;
  if (message && message.type === CONFIG.readyMessage) { log.ready = true; return; }
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.method === undefined) {
    log.responses.push({ id: message.id, result: message.result, error: message.error });
    return;
  }
  log.messages.push({ method: message.method, id: message.id, params: message.params });

  if (message.method === 'ui/initialize') {
    if (log.initialized) { refuse(message.id, 'ui/initialize after the app already said it was initialized'); return; }
    var params = message.params || {};
    if (typeof params.protocolVersion !== 'string' || !params.appCapabilities) {
      refuse(message.id, 'ui/initialize without both a protocolVersion and appCapabilities');
      return;
    }
    if (CONFIG.acceptedProtocolVersions.indexOf(params.protocolVersion) === -1) {
      decline(message.id, 'this host does not speak ' + params.protocolVersion);
      return;
    }
    var accepted = {
      protocolVersion: params.protocolVersion,
      hostCapabilities: { serverTools: {} },
      hostInfo: { name: 'fake-mcp-app-host', version: '1.0.0' },
      hostContext: { theme: 'dark', displayMode: 'inline' }
    };
    var id = message.id;
    if (CONFIG.initializeDelayMs > 0) setTimeout(function(){ reply(id, accepted); }, CONFIG.initializeDelayMs);
    else reply(id, accepted);
    return;
  }

  if (message.method === 'ui/notifications/initialized') {
    if (log.initialized) log.violations.push('a second ui/notifications/initialized');
    log.initialized = true;
    return;
  }

  if (message.method === 'tools/call') {
    if (!log.initialized) { refuse(message.id, 'tools/call before ui/notifications/initialized'); return; }
    var name = message.params && message.params.name;
    if (name !== CONFIG.liveViewTool) { refuse(message.id, 'tools/call for an unexpected tool: ' + name); return; }
    answerLiveView(message.id);
    return;
  }

  if (message.id !== undefined) refuse(message.id, 'an unexpected request: ' + message.method);
});

/** The push a host makes when a tool the conversation ran produced a result the app may use. */
window.__pushToolResult = function (structuredContent) {
  post({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {
    content: [{ type: 'text', text: 'a session is open' }],
    structuredContent: structuredContent
  } });
};

/** What a host sends just before it removes the app from the conversation. */
window.__requestTeardown = function (id) {
  post({ jsonrpc: '2.0', id: id, method: 'ui/resource-teardown', params: {} });
};
</script>
</body>
</html>`;
}

/**
 * The fake host, serving its own page and the app over loopback HTTP.
 *
 * `127.0.0.1` is a secure context, so plain HTTP is enough for the documents; only the CDP endpoint
 * has to be TLS, because `wss:` is the only scheme the app will open.
 */
export class FakeMcpAppHost {
    private constructor(
        private readonly server: Server,
        /** The host page to load; the app frame inside it comes up on its own. */
        readonly url: string
    ) {}

    static async start(options: FakeHostOptions = {}): Promise<FakeMcpAppHost> {
        const document = hostDocument(options);
        const server = createServer((request, response) => {
            if (request.url === '/host') {
                response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                response.end(document);
                return;
            }
            if (request.url === '/app') {
                const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
                if (options.appCsp !== undefined) headers['content-security-policy'] = options.appCsp;
                response.writeHead(200, headers);
                response.end(SESSION_VIEWER_HTML);
                return;
            }
            response.writeHead(404).end();
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('the fake host has no port');
        return new FakeMcpAppHost(server, `http://127.0.0.1:${address.port}/host`);
    }

    /** Loads the host page in a fresh tab and returns a handle on the app running inside it. */
    async open(chrome: HeadlessChrome): Promise<HostedViewer> {
        return new HostedViewer(await chrome.openPage(this.url));
    }

    async stop(): Promise<void> {
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }
}

/** A running session viewer: what the host saw, what the app shows, and how to nudge either. */
export class HostedViewer {
    constructor(readonly page: BrowserPage) {}

    /** Everything the host page recorded so far. */
    log(): Promise<HostLog> {
        return this.page.evalInHost<HostLog>('JSON.parse(JSON.stringify(window.__host))');
    }

    /** The bridge methods the app sent, in order. */
    async bridgeMethods(): Promise<string[]> {
        return (await this.log()).messages.map(message => message.method);
    }

    /** Pushes a tool result the way a host does when the conversation ran a tool. */
    async pushToolResult(structuredContent: Record<string, unknown>): Promise<void> {
        await this.page.evalInHost(`window.__pushToolResult(${JSON.stringify(structuredContent)})`);
    }

    /** Asks the app to tear down, as a host does before it removes the view. */
    async requestTeardown(id = 900): Promise<void> {
        await this.page.evalInHost(`window.__requestTeardown(${JSON.stringify(id)})`);
    }

    /** What the app is showing right now. */
    screen(): Promise<ViewerScreen> {
        return this.page.evalInApp<ViewerScreen>(
            `(function(){` +
                `var veil = document.getElementById('veil');` +
                `var badge = document.getElementById('badge');` +
                `return {` +
                `headline: document.getElementById('head').textContent,` +
                `note: document.getElementById('note').textContent,` +
                `badge: badge.textContent,` +
                `veilHidden: veil.hidden, badgeHidden: badge.hidden,` +
                `spinHidden: document.getElementById('spin').hidden` +
                `};})()`
        );
    }

    /** The canvas size and the colour at its centre, which is blank until a frame is drawn. */
    canvas(): Promise<ViewerCanvas> {
        return this.page.evalInApp<ViewerCanvas>(
            `(function(){` +
                `var canvas = document.getElementById('screen');` +
                `var pixel = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;` +
                `return { width: canvas.width, height: canvas.height, centre: [pixel[0], pixel[1], pixel[2], pixel[3]] };` +
                `})()`
        );
    }

    /** The aspect ratio the app is holding the stage at. */
    aspectRatio(): Promise<string> {
        return this.page.evalInApp<string>(`document.getElementById('stage').style.getPropertyValue('--ar')`);
    }

    /** The app's whole rendered document, for checking what did *not* end up in it. */
    documentHtml(): Promise<string> {
        return this.page.evalInApp<string>('document.documentElement.outerHTML');
    }

    /** Runs the app's own canvas-to-page mapping against a point in the app frame. */
    mapPoint(clientX: number, clientY: number): Promise<unknown> {
        return this.page.evalInApp<unknown>(
            `window.steelSessionViewer.pointFromCanvasEvent({ clientX: ${clientX}, clientY: ${clientY} })`
        );
    }

    /** Turns take-control on by clicking the real toggle, the path a human takes. */
    takeControl(): Promise<void> {
        return this.page.evalInApp(
            "var b=document.getElementById('control'); if(b.getAttribute('aria-pressed')!=='true') b.click();"
        );
    }

    /** Turns take-control off by clicking the real toggle again. */
    handBack(): Promise<void> {
        return this.page.evalInApp(
            "var b=document.getElementById('control'); if(b.getAttribute('aria-pressed')==='true') b.click();"
        );
    }

    /** Whether the app is currently forwarding input, read off the toggle's pressed state. */
    driving(): Promise<boolean> {
        return this.page.evalInApp<boolean>("document.getElementById('control').getAttribute('aria-pressed')==='true'");
    }

    /** The visible mode label ("Watching (read-only)" / "You are driving this browser"). */
    modeLabel(): Promise<string> {
        return this.page.evalInApp<string>("document.getElementById('mode').textContent");
    }

    /** Dispatches a synthetic key event on the canvas the way a focused canvas would receive it. */
    driveKey(
        type: 'keydown' | 'keyup',
        key: string,
        code: string,
        mods: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } = {}
    ): Promise<void> {
        const init = JSON.stringify({
            bubbles: true,
            cancelable: true,
            key,
            code,
            shiftKey: !!mods.shift,
            ctrlKey: !!mods.ctrl,
            altKey: !!mods.alt,
            metaKey: !!mods.meta,
        });
        return this.page.evalInApp(
            `document.getElementById('screen').dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, ${init}))`
        );
    }

    /** Dispatches a synthetic wheel event at a fractional position inside the canvas. */
    driveWheel(fracX: number, fracY: number, deltaX: number, deltaY: number): Promise<void> {
        return this.page.evalInApp(
            `(function(){var r=document.getElementById('screen').getBoundingClientRect();` +
                `document.getElementById('screen').dispatchEvent(new WheelEvent('wheel',` +
                `{bubbles:true,cancelable:true,deltaX:${deltaX},deltaY:${deltaY},` +
                `clientX:r.left+r.width*${fracX},clientY:r.top+r.height*${fracY}}));})()`
        );
    }

    /**
     * Dispatches a mousedown/mouseup pair on the canvas at a fractional position, and returns the
     * viewport point the app mapped that click to (or null when the mapping rejected it).
     */
    driveClick(fracX: number, fracY: number, detail = 1): Promise<{ viewportX: number; viewportY: number } | null> {
        return this.page.evalInApp(
            `(function(){var c=document.getElementById('screen');var r=c.getBoundingClientRect();` +
                // Integer client coords: Chrome snaps a MouseEvent's clientX/Y to a long, so rounding
                // here makes the probe the handler reads agree with the point the dispatch carries.
                `var x=Math.round(r.left+r.width*${fracX});var y=Math.round(r.top+r.height*${fracY});` +
                `var probe=window.steelSessionViewer.pointFromCanvasEvent({clientX:x,clientY:y});` +
                `c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,` +
                `button:0,buttons:1,detail:${detail},clientX:x,clientY:y}));` +
                `c.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,` +
                `button:0,buttons:0,detail:${detail},clientX:x,clientY:y}));return probe;})()`
        );
    }

    /**
     * Dispatches a mousedown on the canvas at a point its own mapping rejects, and returns that point.
     *
     * The point sits just outside the canvas element, so a real letterbox or out-of-bounds click is
     * reproduced: the listener runs (the event is dispatched on the canvas) but no command is built.
     */
    driveLetterboxMouseDown(): Promise<unknown> {
        return this.page.evalInApp<unknown>(
            `(function(){var c=document.getElementById('screen');var r=c.getBoundingClientRect();` +
                `var x=r.left-5;var y=r.top+r.height/2;` +
                `var probe=window.steelSessionViewer.pointFromCanvasEvent({clientX:x,clientY:y});` +
                `c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,` +
                `button:0,buttons:1,detail:1,clientX:x,clientY:y}));return probe;})()`
        );
    }
}
