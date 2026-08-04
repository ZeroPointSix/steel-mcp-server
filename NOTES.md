# Measured findings

Facts established by direct measurement, with enough detail to reproduce or refute them. Distinct
from [RESEARCH.md](RESEARCH.md), which sources claims from documentation, and from
[PLAN.md](PLAN.md), which records decisions. Everything here was observed; where something is
inferred or came from someone else, it says so.

Measurements taken 2026-07-30 and 2026-07-31 unless noted.

---

## 1. Claude's CSP for MCP Apps

Measured in Claude Desktop 1.24012.9 (Electron 42, Chrome 148) with a throwaway probe app that
declared `connectDomains`, attempted requests to declared *and* undeclared origins, and recovered the
policy from a `securitypolicyviolation` event. Verdict logic required both directions, so
"honoured" cannot be confused with "unenforced".

```
default-src 'self';
script-src  'self' 'unsafe-inline' 'unsafe-eval' blob: data: https://assets.claude.ai;
style-src   'self' 'unsafe-inline' https://assets.claude.ai;
img-src     'self' data: blob: https://assets.claude.ai;
connect-src 'self' <every connectDomains entry>;
font-src    'self' https://assets.claude.ai;
media-src   'self' blob: data: https://assets.claude.ai;
worker-src  'self' blob: https://assets.claude.ai;
frame-src   'self' blob: data:;
base-uri 'self'; object-src 'none'; form-action 'self';
frame-ancestors 'self' https://claude.ai https://preview.claude.ai app://localhost;
```

| Finding | Evidence |
|---|---|
| **`connectDomains` is honoured** | Declared `https://api.steel.dev` answered 401 and `wss://connect.steel.dev` closed with 1006 — both prove the request left the page. Undeclared `example.com` was blocked on `connect-src`, `disposition: enforce`, for all three checks |
| **Third-party iframes are not possible** | `frame-src 'self' blob: data:`. Corroborates Anthropic's documented `frameDomains` restriction (their feature request is closed as *not planned*). The probe declared only `connectDomains`, so this is corroboration, not an independent test |
| `blob:` is available to `media-src`, `worker-src`, `script-src`; `'unsafe-eval'` permitted | Policy above. Frame decoding in a Worker and a `MediaSource` path are therefore possible |
| App origin is `https://<32-hex>.claudemcpcontent.com` | Auto-assigned even for a **local stdio server**, contradicting the expectation that a sandbox `domain` is unavailable to stdio connectors |
| The policy arrives via the sandbox URL, not a meta tag | The app's `href` carried `?connect-src=…&resource-src=https://assets.claude.ai&dev=true`; `metaCsp` was `null` |
| The host bridge is postMessage only | `hostBridgeGlobals` enumerated just `chrome` — no injected host object |

**Bridge handshake, verified end to end from a stdio server:** `ui/initialize` (accepted at
`protocolVersion: "2026-01-26"`, host identified itself as `{name: "Claude", version: "1.0.0"}`) →
`ui/notifications/initialized` → `tools/call`. An app-only tool call was delivered and its result
written server-side, so **app-only tools are a working data channel**, not just spec text.

Not measured: whether `resourceDomains` reaches `img-src`/`media-src` the same way; what `dev=true`
does; whether Claude enforces `visibility: ['app']` list filtering.

### The tool-result push is not something a view can rely on

Measured 2026-08-04 in Claude Desktop, from `~/Library/Logs/Claude/mcp-server-steel.log`. Asking for
a session and a preview rendered the viewer, and it sat on "waiting for a browser session" for the
whole session:

```
09:59:14.268  client → tools/call        id=4   (steel_session_create)
09:59:15.268  client → resources/read    id=5   (the viewer shell — 1s in, mid-call)
09:59:15.449  server → result            id=4
```

**Claude renders the view while the creating call is still running**, and the view's own `tools/call`
never appeared in the log at all — so it never learned its session id. The spec says the host "MUST
send this notification when tool execution completes (if the View is displayed during tool
execution)", but it defines **no replay, no re-send for a view that initialised late, and no way for
a view to ask for the result**. A handshake that finishes after that single push is stuck for ever.

Whether Claude sent the push and our view missed it, or never sent it, is not distinguishable from
the log — and does not matter: either way a view whose only path to its session is that one
notification is built on something unguaranteed. `steel_session_live_view` now resolves the caller's
newest live session when the app names none.

Our own fake host had asserted the working case back at us — the same test-double pattern as §6.

## 2. MCP Apps protocol contract

From the spec and the installed SDK, confirmed against a working implementation.

- Tool `_meta.ui` has exactly two fields: `resourceUri` (must be `ui://`) and `visibility`.
- `csp` and `permissions` are **resource** metadata, not tool metadata. `csp` keys:
  `connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`.
- Resource MIME must be exactly `text/html;profile=mcp-app`.
- `_meta.ui` may sit on the `resources/list` entry and on each `resources/read` content item; the
  content item wins, and hosts must check both.
- A **per-resource `cacheHint` overrides the per-operation hint field by field**, so a static shell
  can be `public`/1h while `resources/read` stays `private`/0 for everything else.
- `permissions` is a closed set: `camera`, `microphone`, `geolocation`, `clipboardWrite`. There is
  **no `autoplay` and no `fullscreen`**.
- **`visibility: ['app']` is host-side list filtering, not authorization.** No protocol marker
  distinguishes an app-proxied `tools/call` from a model-issued one, so an app-only tool is
  reachable by anything on the connection and must authorize like any other tool.
- **`structuredContent` is not normatively hidden from the model** — that guidance is a
  best-practices bullet, not RFC-2119. Do not treat it as a security boundary.
- Results over **~150,000 characters** are written to a file by Claude and **the app never
  hydrates**. This rules out relaying video frames through the MCP bridge.
- `@modelcontextprotocol/ext-apps` 1.7.5 peer-depends on the **v1** SDK, so the server side is
  hand-rolled here. Its browser-side `App` class carries no server dependency but would have to be
  inlined, since external scripts are not loadable.

## 3. Steel CDP and the session-scoped token

| Finding | Detail |
|---|---|
| **`websocketUrl` already carries a scoped token** | `POST /v1/sessions` returns `wss://connect.steel.dev?sessionId=<id>&token=<JWT>`. **No `experimentalFeatures` flag needed** — a plain create returns it on cloud today |
| The token alone authenticates CDP | `Browser.getVersion` succeeded with no `apiKey` → `Chrome/150.0.7871.46` |
| It is enforced | A tampered token is refused with **HTTP 401** at the socket handshake |
| Claims | `scope: "session:connect"`, `sessionId`, `orgId`, `exp` |
| **`exp` tracks the session's remaining lifetime** | A 60 s session read ~14 s in minted a token with `ttl = 46 s`. Re-minted fresh on every `GET /v1/sessions/{id}` |
| **A second CDP client can screencast** alongside a first | With client A attached to the page and using it, client B attached, ran `Page.startScreencast`, and received frames. A stayed healthy; both drove the same page |
| **Screencast is repaint-driven, not a frame rate** | A static page produced exactly **one** frame across six mouse moves. ~11 KB base64 per frame on a near-blank page. A viewer must distinguish "idle" from "broken" |
| Frame metadata fields | `offsetTop`, `pageScaleFactor`, `deviceWidth`, `deviceHeight`, `scrollOffsetX`, `scrollOffsetY`, `timestamp` — everything coordinate mapping needs |
| **`Page.screencastFrame.sessionId` is an `int32`** | Chrome sends `1`. An ack carrying a string is rejected: `Failed to deserialize params.sessionId - BINDINGS: int32 value expected`. Getting this wrong stalls the stream in two independent ways |

Consequence for our own code, not yet acted on: `buildCdpUrl` appends the **org-wide**
`STEEL_API_KEY` to `connectUrl`, when a session-scoped, self-expiring token is available in
`websocketUrl`. Steel's docs still say to append `apiKey`, which predates the token — worth
confirming `websocketUrl` is now canonical, then switching.

## 4. Steel session APIs — real response shapes

Both diagnostic endpoints were **enveloped, not arrays**, and our types were wrong on both. Fixed in
`cf2308d` and `fda7b00`; recorded here because the documented shapes are incomplete.

**`GET /v1/sessions/{id}/agent-traces`** → `{events, total, hasMore}`

- Activity field is **`type`**, not `action`.
- URL location varies: `navigate` events carry `navigation: {url}` and **no `page` key at all**;
  other activities carry `page: {url}`. Resolution order that works: `page.url` → `navigation.url`
  → top-level `url`.
- Observed types include **`change`** and **`submit`**, neither of which Steel documents (docs list
  `click`, `input`, `navigate`, `scroll`, `drag`, `error`). **Never switch exhaustively on `type`.**
- `target` is richer than documented: `tagName`, `role`, `accessibleName`, `attributes`,
  `selector: {css, id, name}`, `boundingBox`.
- **`value` on a change event is already redacted by Steel**: typing the 8-character string
  `practice` yielded `{"inputType":"text","valueLength":8}`. Metadata only — the content never
  arrives, so it is safe to render and useful for debugging.
- Works on in-progress *and* finished sessions, and traces persist after release.
- `startTime`/`endTime` filter server-side. No `limit`/`offset`/`cursor` is documented, so how a
  caller pages a `hasMore: true` result is unknown; `hasMore` was never observed true.

**`GET /v1/sessions/{id}/logs`** → `{events, total, hasMore}`

- Entry is `{id, timestamp, type, log}` where **`log` is a JSON-encoded string** needing a tolerant
  parse. Nothing like the `{level, text, message}` we had assumed.
- Types observed: `Navigation`, `Request`, `RequestFailed`, `Response` (capitalised).
- **Volume: 84 entries for one page load** — 41 `Request`, 36 `Response`, 4 `RequestFailed`,
  3 `Navigation`. Almost all noise; the diagnostics tool now drops the request/response pair and
  says how many it hid.
- A parsed `RequestFailed` payload: `{pageId, error: {message, url}, createdAt}`.
- Undocumented anywhere in Steel's public docs — the shape above is purely observed.

**Live trace streaming** exists per Steel's own developer, at
`wss://<STEEL_WS_URL>/v1/sessions/<id>/agent-traces?apiKey=<KEY>`, one JSON array of events per
message, session must be live. **Not verified here.** Note the auth is the **org-wide key in a query
string**, so this is a server-side-only channel — it must never reach a browser, and must not be
logged. It reportedly shares the upstream log stream, so consumers filter semantic
`BrowserInteraction` events client-side.

## 5. Steel's live viewer and player

| Finding | Detail |
|---|---|
| **`debugUrl` is the embeddable player** | `https://api.steel.dev/v1/sessions/{id}/player` — a 66 KB self-contained WebRTC player, all CSS/JS inline. Works **unauthenticated**, and returns 200 even for an already-released session |
| **`sessionViewerUrl` is the wrong URL for embedding** | `https://app.steel.dev/sessions/{id}` is a login-walled dashboard SPA; framed without a Steel login it renders a sign-in page |
| Neither Steel origin blocks framing | No `X-Frame-Options` and no CSP on either. The blocker for inline embedding is the *host*, not Steel |
| **The player URL is an unauthenticated bearer capability that can drive the browser** | Sessions default to `debugConfig.interactive: true`, and `CreateSessionRequest` exposes no field to turn it off — so a read-only viewer is not currently expressible through this client. Anyone holding the session UUID can watch *and* control |
| Player query params | **Only** `hideOverlay` and `hideInteractionDialog`. The `interactive=true` / `showControls=true` params an earlier draft of RESEARCH.md cited **do not exist**; interactivity comes from server-side `debugConfig` |
| Player → parent postMessage events | `steel:connecting`, `steel:connected`, `steel:ready` (carries `videoWidth`/`videoHeight`), `steel:disconnected`, `steel:error`, `steel:session-ended`, `steel:autoplay-blocked`, `steel:state` |
| Parent → player commands | `steel:hide-overlay`, `steel:show-overlay`, `steel:get-state` |
| Player transport | WebRTC video; input over `wss://connect.steel.dev/v1/sessions/{id}/input?token=<JWT>`; ICE from `GET /v1/rtc/ice-servers/{id}` using an inline `rtcToken` (~24 h), Cloudflare STUN/TURN. Only external script it loads is Sentry |

## 6. Bugs found, and the pattern behind them

Twelve defects were found in code that had passing tests. The ones worth remembering:

| Bug | Why it mattered |
|---|---|
| Redis registry silently dropped `debugUrl` | Made the human-in-the-loop handoff **dead on exactly the multi-replica deployment it was built for**. The field is optional, so the compiler said nothing |
| `touch` racing `release` resurrected a released record | Record returned with a fresh TTL but outside every index, so `list`, `countLive` and every reaper were blind to it |
| `touch` overwrote a concurrent `awaitInput` from a stale read | Regressed `lastUsedAt`, so the reaper measured idleness from an older timestamp and could reclaim a slot in active use |
| Handoff detection keyed on page **text** | A hostile page with one password field and the words "Sign in" could trigger a handoff and get a drive-capable URL emitted. Also fired on any page carrying a reCAPTCHA v3 badge |
| Diagnostics output was unfenced | The one page-reading path with no provenance fence, so page-controlled strings reached the model unfenced |
| **`readScreencastFrame` required a string `sessionId`** | Chrome sends an `int32`, so **every frame was rejected and nothing would ever have painted** — while 72 unit tests passed |
| **CSP-blocked WebSocket hung the viewer for ever** | Chrome fires only `error`, never `close`, when CSP blocks a socket. With no `onerror` the app sat on its spinner. This is the likeliest live misconfiguration (a host whose `connectDomains` omit the CDP host) |

**The pattern, three separate times: a test double encoded our wrong belief and asserted it back to
us.** The traces fake returned a bare array, the logs fake returned `{level, text}`, and a viewer
unit test asserted that a *numeric* `sessionId` must be rejected. Each made a broken path look
tested. Two defences now exist: a registry conformance suite that runs identical cases against both
backends, and a browser suite that executes the app's runtime instead of asserting its source order.

## 7. The MCPB desktop bundle

Measured 2026-08-04 against `@anthropic-ai/mcpb@2.1.2`, manifest schema **v0.4**.

- **The bundle is 2.0MB packed, 8.0MB unpacked, 938 files.** It carries four dependency trees —
  `@modelcontextprotocol/server` (with `core` beneath it), `@opentelemetry/api`, `ws`, `zod` — and
  nothing else. `npm install` in the staging tree resolves **5 packages**.
- **Narrowing the staged `package.json` beats deleting installed directories.** Deleting
  `node_modules/ioredis` left its six dependencies behind (`redis-parser`, `redis-errors`, `denque`,
  `cluster-key-slot`, `standard-as-callback`, `debug`), and `@modelcontextprotocol/node` dragged in
  `hono` and `@hono/*` for a hosted path the desktop bundle can never take. Dropping both from the
  manifest's `dependencies` before installing took the bundle from 17 packages and 1411 files to 5
  and 938.
- **`assets/` must not be staged wholesale.** It holds two demo recordings; copying the directory
  produced a **77.3MB** bundle, 75MB of it video. The pack script now reads `manifest.json`'s `icon`
  and copies only that file.
- **A blank env var is a real MCPB failure mode.** `manifest.json` maps `STEEL_PROFILE` to an
  optional `user_config` value, and a host substitutes the empty string for one the user left alone.
  `env.STEEL_PROFILE ?? 'browse'` accepted it and then refused it — `Unknown STEEL_PROFILE ""`,
  naming a variable the user never set. Now `?.trim() || 'browse'`. `STEEL_API_KEY` already handled
  blank correctly.
- **Omitting the OpenTelemetry SDK from the bundle is safe, and by design.** `startTracing` reaches
  it through a dynamic `import()` inside a `try`/`catch` that warns and carries on, so the pruned
  bundle serves normally; a static import would have made the same pruning a startup crash. A test
  now walks the import graph from `stdio.ts` and distinguishes static from dynamic edges, because
  only the static ones have to ship.
- **The staged server is verified before packing, and the check is not vacuous.** Removing `ws` from
  a staged tree makes `scripts/verify-mcpb-stage.mjs` exit 1 with `MODULE_NOT_FOUND` rather than
  producing a bundle that fails on a user's machine.
- **`mcpb validate` passes and the icon is accepted at 512×512.** The CLI reports "Icon validation
  passed" as a *warning* line, which reads like a problem and is not one.

## 8. Process notes

- **Never judge a check by piping it to `tail`/`head`.** A pipeline's exit status is the pager's, so
  `npm run lint | tail -2` reports success on a failure — and `&&` gives no protection for the same
  reason. This let an unformatted file reach the branch and be reported as clean. Run bare, or
  `npm run lint > /dev/null 2>&1; echo $?`.
- **`tests/integration/stdio.test.ts` drives the built binary**, so `npm test` can mislead when
  `dist/` is stale. `npm run build` first when tool registration changes.
- **A git worktree inside the repo aborts Biome** — its own `biome.json` triggers "found a nested
  root configuration" and `biome check .` fails before reading a file. `.claude/worktrees/` is now
  gitignored; removing a worktree while keeping its branch restores the check.
- **This repo has no git hooks** (no `.husky`, no `core.hooksPath`, nothing in `.git/hooks`), so the
  npm scripts are the only gate. That is how an unformatted merge landed.
- **No lockfile is committed** (`package-lock.json` is gitignored), and it has already caused
  observable drift: `biome.json` pins schema 2.5.5 while `^2.5.5` installs 2.5.6.
