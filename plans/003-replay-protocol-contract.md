# Plan 003: Make the replay payload and protocol Claude-compatible

> **Executor instructions**: This plan has a mandatory asset-readiness decision. Follow either the
> preferred external-asset path or the dashboard-only fallback; never ship the current 375 KB app
> resource. Use TDD and run every verification gate. Update `plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 6b1473a..HEAD -- src/core/server.ts src/core/apps/session-replay.ts src/core/tools/replay.ts src/core/instructions.ts src/core/steel/types.ts src/core/steel/rest.ts package.json package-lock.json Dockerfile scripts/stage-hls-player.mjs scripts/pack-mcpb.sh scripts/verify-mcpb-stage.mjs tests/helpers/fakes.ts tests/integration/apps.test.ts tests/integration/http.test.ts tests/integration/replay.test.ts tests/unit/packaging.test.ts tests/unit/session-replay.test.ts tests/unit/steel-rest.test.ts tests/browser/session-replay.browser.test.ts tests/helpers/headless-chrome.ts README.md RELEASING.md SUBMISSION.md manifest.json PLAN.md`
> and the same command for the dirty worktree. Stop if Hls.js is no longer read and embedded by
> `src/core/server.ts`, or if `appReady`, `inputSeen`, and `flushPushedReplay` no longer match the
> current-state description below.

## Status

- **Execution status**: DONE on 2026-08-07 using Step F, the dashboard-only fallback
- **Priority**: P1
- **Effort**: L
- **Risk**: MED–HIGH — changes how Claude Desktop acquires replay code and how the app negotiates
  host capabilities
- **Depends on**: `plans/001-reproducible-npm-installs.md`
- **Category**: correctness / compatibility / performance
- **Planned at**: commit `6b1473a`, 2026-08-07

## Why this matters

The replay resource currently embeds the complete `hls.light.min.js` distribution. The pinned file
is 354,471 bytes and the assembled app is about 375,844 bytes; the shell without that bundle is about
21 KB. That oversized `resources/read` payload is the strongest explanation for Claude Desktop not
displaying the app. MCP Apps explicitly permits external scripts declared in
`_meta.ui.csp.resourceDomains`, so the preferred design is an immutable Steel-owned script URL with
Subresource Integrity. If Steel cannot operate that asset yet, a dashboard-only replay tool is safer
than shipping an app known to exceed the target host's practical limit.

The app also declares empty `appCapabilities` while requesting fullscreen, tool calls, and open-link
actions without checking the host's advertised support. Strict hosts may reject those requests even
after the payload problem is removed.

## Evidence and reference contract

- `node_modules/hls.js/dist/hls.light.min.js` is 354,471 bytes.
- The current pinned bytes have SHA-384 SRI value
  `sha384-E9DBR7P0MHIlBoTMFzDnu6C09gmWTl3HKkBLYypAs89FbCLyJpP0w0aKBzpe5UYq`.
- `tests/integration/apps.test.ts` currently asserts the replay HTML is greater than 300,000 bytes,
  encoding the failure as expected behavior.
- `src/core/server.ts` reads the staged/npm Hls.js file at module load and passes its text to
  `buildSessionReplayHtml`.
- Official overview: `https://modelcontextprotocol.io/extensions/apps/overview` states that apps may
  load external scripts/resources from origins declared in `_meta.ui.csp`.
- Official resource API example:
  `https://apps.extensions.modelcontextprotocol.io/api/functions/server-helpers.registerAppResource.html`
  declares script/style/image origins in `resourceDomains`.
- Stable protocol specification:
  `https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx`.

## Current state

- `src/core/server.ts:19-24` resolves and reads `hls.light.min.js`, then exports one giant
  `SESSION_REPLAY_APP_HTML` string.
- `package.json` runs `scripts/stage-hls-player.mjs` on every build and carries pinned `hls.js` as a
  development dependency.
- The generated document uses an inline Hls.js `<script>` followed by the app script.
- Resource CSP currently contains only the Tigris recording origin.
- `src/core/apps/session-replay.ts` sends `appCapabilities: {}`.
- Initialize results are not retained for `serverTools`, `openLinks`, or host display modes.
- Recovery now correctly waits for complete tool input and rejects a mismatched pushed result. Keep
  that behavior.
- `appReady` is set immediately before `ui/notifications/initialized`, and `askForRoom` lacks a
  readiness check, leaving a narrow ordering race.

## Asset contract for the preferred path

The asset must satisfy all of these before its URL is committed:

- HTTPS on a dedicated Steel-owned asset origin with a content-hashed, versioned path such as
  `/mcp-apps/hls.js/1.6.17/hls.light.min.<content-hash>.js`; a version-only filename is not sufficient.
  Do not use an unversioned `latest` URL or mutable query parameter. Because MCP Apps allowlists the
  whole origin rather than one path, do not share this origin with user-controlled assets.
- Bytes exactly match the pinned npm distribution and the committed SHA-384 integrity value.
- Final response has no cross-origin redirect.
- `Content-Type: application/javascript` (or `text/javascript`).
- `Access-Control-Allow-Origin: *`, required for cross-origin SRI with
  `crossorigin="anonymous"`.
- `Cache-Control: public, max-age=31536000, immutable`.
- Asset ownership, deployment, and rollback are documented outside the MCP process; this repository
  must not upload the file as a side effect of build or test.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Measure local bundle | `wc -c node_modules/hls.js/dist/hls.light.min.js` | `354471` for version 1.6.17 |
| Verify local SRI | `openssl dgst -sha384 -binary node_modules/hls.js/dist/hls.light.min.js \| openssl base64 -A` | expected base64 digest |
| Preferred unit replay tests | `npm run test:unit -- tests/unit/session-replay.test.ts` | all pass |
| Both-branch integration tests | `npm run test:integration -- tests/integration/apps.test.ts tests/integration/http.test.ts tests/integration/replay.test.ts` | all pass |
| Preferred browser replay test | `npm run test:browser -- tests/browser/session-replay.browser.test.ts` | pass, not skipped |
| Fallback packaging tests | `npm run test:unit -- tests/unit/packaging.test.ts` | all pass after replay app removal |
| Fallback surviving browser test | `npm run test:browser -- tests/browser/session-viewer.browser.test.ts` | pass, not skipped |
| Typecheck/lint/build | `npm run typecheck && npm run lint && npm run build` | all exit 0 |
| Bundle | `npm run pack:mcpb` | exits 0; no staged Hls.js copy in preferred external path |

## Scope

**In scope**:

- `src/core/server.ts`
- `src/core/apps/session-replay.ts`
- `src/core/tools/replay.ts` for the dashboard-only fallback branch only
- `src/core/instructions.ts` for fallback and explicit-user-intent wording
- `src/core/steel/types.ts`, `src/core/steel/rest.ts`, and `tests/unit/steel-rest.test.ts` only to make
  an explicit keep/remove decision for the HLS client API in the fallback branch
- `package.json`
- `package-lock.json`
- `Dockerfile`
- `scripts/stage-hls-player.mjs`
- a new cross-platform `scripts/clean-dist.mjs` if build output is not already cleaned
- `scripts/pack-mcpb.sh`
- `scripts/verify-mcpb-stage.mjs`
- `scripts/verify-hls-asset.mjs` if a deterministic verifier is added
- `tests/helpers/fakes.ts`
- `tests/integration/apps.test.ts`
- `tests/integration/http.test.ts`
- `tests/integration/replay.test.ts`
- `tests/unit/packaging.test.ts`
- `tests/unit/session-replay.test.ts`
- `tests/browser/session-replay.browser.test.ts`
- `tests/helpers/headless-chrome.ts` if CDP request fulfillment is needed
- `RELEASING.md`
- `README.md`, `manifest.json`, `SUBMISSION.md`, and `PLAN.md` only for fallback/user-visible behavior

**Out of scope**:

- Provisioning DNS, buckets, CDN rules, or uploading to production from this repository.
- Using a third-party CDN or unowned asset origin.
- Relaxing HLS media URL validation.
- Reintroducing an inline minified player under another encoding.
- Adding viewer-interaction telemetry; that is a separate product decision.

## Git workflow

- Suggested branch: `fix/replay-app-payload`.
- Preferred commits: `fix(apps): load replay runtime from immutable asset`, then
  `fix(apps): negotiate replay host capabilities`.
- Fallback commit: `fix(replay): fall back to dashboard-only playback`.
- Do not upload assets, push, or publish without explicit operator instruction.

## Steps

### Step 1: Make the asset-readiness decision

Ask the Steel asset owner for the final immutable URL and deployment evidence. Perform a read-only
probe of the exact URL and record status, final URL, content length, content type, CORS, cache headers,
and SHA-384 digest. Never print signed credentials; this asset must be public and credential-free.

Choose exactly one branch:

- **Preferred external asset:** continue to Steps 2–8 only if every asset-contract requirement is
  satisfied.
- **Dashboard-only fallback:** if the URL, ownership, headers, or immutable deployment is missing,
  execute Step F and stop. Mark Plan 004 Steps 1–3 and 6 BLOCKED until the external asset path is
  available; its RC browser-gate Steps 4–5 still proceed.

**Verify**: preferred path has a recorded, reproducible header/hash result; otherwise fallback is
selected. Do not invent an asset hostname.

### Step 2: Add failing payload, script, and CSP tests

Replace the `> 300_000` assertion with a strict decimal-byte UTF-8 budget:
`Buffer.byteLength(SESSION_REPLAY_APP_HTML, 'utf8') < 100_000`.

Add assertions that production HTML contains one external blocking script with:

- the exact immutable URL;
- the exact `sha384-...` integrity attribute;
- `crossorigin="anonymous"`;
- no inline Hls.js distribution text.

Assert the Steel asset origin is present in standard MCP Apps `_meta.ui.csp.resourceDomains`, OpenAI
`widgetCSP.resource_domains`, and the document's own `script-src`, while the Tigris media origin
remains in connect/resource domains. Add negative tests for mutable, version-only, non-HTTPS,
credentialed, shared/user-content, and malformed script descriptors.

**Verify**: focused integration/unit tests fail against the current embedded implementation.

### Step 3: Externalize the production player

Replace `buildSessionReplayHtml(hlsSource)` with an asset descriptor containing the immutable script
URL and SRI hash. Render:

```html
<script src="..." integrity="sha384-..." crossorigin="anonymous"></script>
```

before the existing inline app script so `window.Hls` remains available synchronously. Keep the app's
own code inline; its small size is not the issue. Validate the descriptor before interpolating it so
no environment/user input can alter HTML or CSP.

Remove `existsSync`, `readFileSync`, and `createRequire` player-loading code from `server.ts`.

**Verify**: the resource HTML is below 100,000 UTF-8 bytes and no 300+ KiB script text appears.

### Step 4: Declare both script and media origins correctly

Add the Steel asset origin to `_meta.ui.csp.resourceDomains` and OpenAI
`widgetCSP.resource_domains`. Keep the Tigris origin in both `connectDomains` and `resourceDomains`
because Hls.js fetches media and attaches it to a video element. Replace the document's current
`script-src 'unsafe-inline'` with a directive that permits both the app's reviewed inline code and the
exact external asset origin; keep media/connect directives aligned. The host CSP, OpenAI compatibility
metadata, and document CSP must not contradict each other.

Do not add the script origin to `connectDomains` unless the app itself fetches it. Do not add Tigris
to `script-src` through a broad shared list in the document; build directive-specific lists.

**Verify**: integration tests assert exact domain sets and no wildcard/unrelated origins.

### Step 5: Remove build-time staging while retaining integrity verification

Remove `scripts/stage-hls-player.mjs` from the build command and from `Dockerfile`, then delete the
script after confirming no other importer uses it. Update the packaging tests that currently require
that staging path. Keep `hls.js@1.6.17` as a dev dependency so CI can recompute the committed SRI from
the canonical pinned bytes; keep the tracked lockfile in sync.

Make `npm run build` clean `dist` through a small cross-platform script before `tsc`. This is required:
TypeScript does not delete old outputs and `pack-mcpb.sh` copies all of `dist`, so an old
`dist/core/apps/hls.light.min.js` or license file could otherwise survive and ship after staging is
removed.

Add a small verifier that compares the local pinned file hash with the committed integrity constant.
Do not probe the remote asset in offline unit tests, but make the same exact URL/header/no-redirect/
SHA-384 probe mandatory in the release gate immediately before host smoke and tagging. Document the
asset publication and hash-bump sequence in `RELEASING.md`.

**Verify**:

- `rg -n "stage-hls-player|hls.light.min.js" package.json scripts src RELEASING.md` → no staging path;
  only documented verifier/runtime URL references remain.
- Seed the two old staged filenames, run `npm run build`, and assert neither remains in `dist`.
- `npm run pack:mcpb` → the staged bundle does not contain the Hls.js file.
- `docker build -t steel-mcp:replay-asset-plan .` → succeeds without copying the deleted staging
  script.

### Step 6: Make browser tests load an external script

Do not keep a test-only production code path that embeds Hls.js. Let the HTML builder accept a strict
test asset descriptor, and use CDP request interception or an HTTPS test asset server to return the
small fake Hls implementation with a matching test SRI hash. Assert the external script request
occurred and that app code ran only after it loaded.

Add failure cases for script 404 and SRI mismatch: both must render a safe dashboard/unavailable state
without uncaught exceptions or leaking the manifest.

**Verify**: focused replay browser tests pass with an observed external script request.

### Step 7: Make the fake host enforce MCP Apps capability negotiation

Update the browser host to advertise and enforce `serverTools`, `openLinks`, and
`hostContext.availableDisplayModes`. Assert the app initialization request declares
`appCapabilities.availableDisplayModes: ['inline', 'fullscreen']`.

Add strict cases for no server tools, no open links, and inline-only display. A capability-dependent
request without support must be a test failure.

**Verify**: new strict-host cases fail before production capability changes.

### Step 8: Retain and enforce negotiated capabilities

Parse initialize results into state for server tool calls, external links, current display mode, and
available display modes. Gate each request:

- recover/poll through `tools/call` only with `serverTools`;
- show/call dashboard open only with `openLinks`;
- show/request fullscreen only when the host includes fullscreen.

Send `ui/notifications/initialized` before marking outbound notifications ready. Make `askForRoom`
return before readiness and during teardown. Merge `ui/notifications/host-context-changed` display
updates. Preserve complete-input gating, explicit UUID pinning, early-result queuing, and mismatch
refusal.

**Verify**: strict-host browser tests record zero violations; full browser suite passes twice.

### Step F: Dashboard-only fallback when no asset host is ready

This step replaces Steps 2–8 for the current release:

1. Remove `_meta.ui.resourceUri` from `steel_session_replay` so Claude does not preload/render the
   oversized resource.
2. Do not fetch or return HLS manifest metadata. Resolve the requested/latest finished session and
   return only its sanitized Steel dashboard link and a clear note that inline replay is temporarily
   unavailable.
3. Keep the replay tool in the browse profile so the public fourteen-tool contract does not churn.
   Keep self-hosted replay rejected: this temporary tool is a resolver for the Steel Cloud dashboard,
   not a generic self-hosted URL opener. If a Cloud session has no exact, safe
   `https://app.steel.dev` URL, return a guarded `not_found` result with no raw URL rather than a
   successful but unusable response.
4. Stop registering `ui://steel/session-replay`. Delete `src/core/apps/session-replay.ts` and its
   app-specific unit/browser tests so `tsc` cannot emit a dormant app. Update `resources/list` tests
   to exclude it and `resources/read` tests to expect not-found.
5. Remove Hls.js staging/build code, the `hls.js` dev dependency, and the staging script. Regenerate
   the tracked `package-lock.json`. Remove the staging-script `COPY` from `Dockerfile` and update the
   packaging tests that currently require both Hls.js and the copy step.
6. Clean `dist` before every build using the same cross-platform mechanism described in Step 5.
   Extend stage/archive verification so old `hls.light.min.js`, its license, and replay-app output
   cannot enter the MCPB even if those paths existed before the build.
7. Keep `SteelRestClient.getSessionHls` and its transport/type tests for now: the fallback is temporary
   and that API belongs to the Steel client layer. Make the tool-level boundary explicit instead:
   explicit-ID and latest-session replay calls may list/get sessions but must leave fake
   `hlsReads` empty. Do not keep HLS-only fake setup in replay-tool tests.
8. Update tool description, server instructions, README, manifest, submission notes,
   `src/core/instructions.ts`, and `PLAN.md` so none claims inline playback, preparing/polling, a
   signed manifest, or `kind: hls`. The tool remains explicit-user-only and returns a dashboard link.
9. Extend `scripts/verify-mcpb-stage.mjs` to assert the replay tool has no resource URI and the replay
   UI resource is absent. Leave a tracked follow-up in `plans/README.md` pointing back to the preferred
   path.

**Verify**:

- `tools/list` still reports fourteen browse tools, and replay copy says explicit watch/replay plus
  dashboard-only behavior, with no UI `resourceUri`.
- `resources/list` excludes `ui://steel/session-replay`; reading that URI returns not-found.
- Explicit-ID and latest-session tool calls perform only session list/get operations, leave
  `hlsReads` empty, and contain no `steel/replay`, manifest, signed URL, `kind: hls`, preparing,
  polling, or inline-playback claim.
- Safe exact dashboard URLs are returned; missing, credentialed, lookalike, and otherwise unsafe URLs
  produce a sanitized `not_found` result. Self-hosted mode remains `self_host_unsupported`.
- `npm run build && npm run pack:mcpb` leaves both staged and archived artifacts free of the replay app
  and Hls.js/player files, including after seeding stale old outputs.
- `docker build -t steel-mcp:dashboard-replay-plan .` succeeds.

## Test plan

Preferred path:

- Unit tests validate immutable script descriptors, SRI shape, and generated markup.
- Integration tests enforce the `<100,000 byte` payload and exact resource CSP domains.
- Browser tests execute an externally loaded fake Hls runtime, strict host capability negotiation,
  script failure, SRI failure, early pushes, exact-session recovery, and teardown.
- Packaging tests prove the 354 KB bundle is no longer staged.

Fallback path:

- Integration tests prove no resource URI/resource registration, no HLS fetch/metadata, a safe
  dashboard link, and sanitized missing/unsafe-link failure.
- Packaging tests and the staged JSON-RPC verifier prove no replay app or Hls.js survives in clean or
  stale-output builds; Docker builds without the deleted staging script.
- The surviving live-viewer browser suite still executes; fallback verification does not name deleted
  replay unit/browser files.
- Profile/tool budgets and docs reflect dashboard-only behavior.

## Done criteria

Exactly one outcome must be complete.

**Preferred external asset:**

- [ ] Asset contract and immutable Steel-owned URL are verified.
- [ ] Replay resource is under 100,000 UTF-8 bytes.
- [ ] External script uses versioned URL, exact SHA-384 SRI, and anonymous CORS.
- [ ] Asset and media origins are declared in the correct CSP directives.
- [ ] Hls.js is no longer embedded or staged in dist/MCPB.
- [ ] Capability-dependent requests are negotiated and lifecycle ordering is clean.
- [ ] External-script and strict-host browser tests pass twice.

**Dashboard-only fallback:**

- [ ] Replay tool has no UI `resourceUri`.
- [ ] No HLS endpoint is called and no manifest is returned.
- [ ] Only a sanitized dashboard link is returned.
- [ ] Missing/unsafe dashboard URLs fail safely and self-hosted mode remains explicitly unsupported.
- [ ] Replay UI source/resource/tests and Hls.js/staging code are absent from build and package.
- [ ] Browse still exposes fourteen tools.
- [ ] Clean build, stale-output build, MCPB verification, and Docker build all pass.
- [ ] Docs do not claim inline playback.

Both outcomes require typecheck, lint, core tests, budgets, build, conformance, and MCPB packaging to
pass.

## STOP conditions

- The asset URL is not immutable, Steel-owned, public, or CORS-enabled.
- The remote bytes do not match the pinned 1.6.17 SRI hash.
- A redirect changes the final asset origin.
- Claude Desktop still refuses a verified sub-100-KiB external-script app; capture host logs and use
  the dashboard-only fallback rather than weakening CSP/SRI.
- The fix requires a third-party CDN or runtime download by the MCP server.

## Maintenance notes

Changing Hls.js requires publishing new immutable bytes first, then updating versioned URL, SRI,
package pin, CSP test, and release documentation in one reviewed change. Never overwrite an existing
asset URL. Treat the 100,000-byte resource budget as a regression gate.
