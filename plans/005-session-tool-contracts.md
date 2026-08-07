# Plan 005: Normalize session contracts and set honest trace expectations

> **Executor instructions**: Use exact structured-output assertions, concise budgeted tool copy, and
> a real self-hosted browser for mobile behavior. Do not add viewer telemetry in this plan. Update
> `plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 6b1473a..HEAD -- src/core/tools/session.ts src/core/tools/replay.ts src/core/instructions.ts tests/integration/tools.test.ts tests/e2e tests/e2e/fixture-site/server.mjs README.md manifest.json tool-budgets.json`
> and the dirty-worktree equivalent. Stop if diagnostics target kinds or the E2E stack shape no
> longer match “Current state.”

## Status

- **Execution status**: RC contract DONE; post-RC mobile E2E BLOCKED because self-hosted Steel reports zero touch points
- **Priority**: P2
- **Effort**: M
- **Risk**: LOW–MED — corrects a structured response shape used by models
- **Depends on**: `plans/003-replay-protocol-contract.md` (its replay delivery decision changes the
  same tool description)
- **Category**: bug / tests
- **Planned at**: commit `6b1473a`, 2026-08-07

## Why this matters

Diagnostics inputs distinguish an opaque live MCP `session_id` from a durable Steel
`steel_session_id`, but historical outputs currently populate both fields with the UUID. A model can
then feed that UUID to live-only tools and receive a misleading handle error.

Diagnostics also cannot promise a complete record of human takeover. The inline live viewer sends
clicks, scrolling, and typing directly over CDP; those actions may never enter Steel's agent-trace
endpoint. Hidden diagnostic entries are routine browser network Request/Response logs, not hidden
user actions. Finally, the replay tool's current discovery copy does not tell the model to call it
only when the user explicitly asks to watch, so a request to explain traces can unnecessarily launch
the replay app. The mobile test has a similar expectation problem: it checks only a fake REST payload
while claiming a genuine mobile browser.

## Current state

- `diagnosticsInputSchema` documents `session_id` as live and `steel_session_id` as a finished UUID.
- `DiagnosticsTarget.kind` already distinguishes `live_handle`, `historical_id`, and
  `latest_released`.
- The success response always emits `session_id: target.reference`, then adds `steel_session_id` for
  non-live targets.
- Current tests assert event counts and text but not exact identifier fields for all target kinds.
- The viewport description says `Defaults to 1280x720` unconditionally, contradicting mobile mode's
  Steel-selected viewport.
- The “genuine mobile” integration test only inspects `FakeSteelApi.created[0].deviceConfig`.
- The E2E stack already runs a real self-hosted browser and fixture site through `npm run test:e2e`.
- The live viewer issues `Input.*` CDP commands directly; no code forwards those commands to
  `/agent-traces`.
- Diagnostics currently says `Hid N routine request and response log entries`, but does not name
  these as browser network logs.
- `steel_session_replay` says what it can play but not that it should run only after an explicit user
  request. Server instructions mention both diagnostics and replay in one paragraph.
- The browse tool-description budget currently has little spare capacity; improve wording by
  replacement/shortening, never by raising `tool-budgets.json`.

## Target behavior

- Live diagnostics structured output contains `session_id` and no `steel_session_id`.
- Explicit/latest historical output contains `steel_session_id` and no `session_id`.
- Diagnostics tool/result copy explicitly warns that live-viewer takeover clicks, scrolling, and
  typing may be absent because direct CDP input is not guaranteed to enter Steel agent traces.
- `hidden_log_count` is described as filtered routine browser network Request/Response entries;
  failures and navigations remain visible.
- Replay discovery copy says to call it only when the user explicitly asks to watch/replay. A request
  to explain what happened routes to diagnostics and does not launch an app.
- Desktop viewport guidance says 1280×720 is the desktop default; mobile guidance says omitting the
  viewport lets Steel select its mobile viewport.
- A real E2E call through the MCP server creates a mobile session, navigates to a device-probe fixture,
  demonstrates mobile UA/viewport/touch characteristics, performs one interaction, and releases the
  session even on failure.

## Delivery split

- **RC contract slice (required):** Steps 1–5. Fix identifier shape, state honest trace limits, make
  replay explicit-user-only, and correct viewport guidance without changing endpoint behavior.
- **Post-RC coverage slice:** Steps 6–7. Add the real mobile E2E proof. The existing REST serialization
  coverage remains in the RC; lack of this stronger behavioral test alone does not delay rc.1.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused integration | `npm run test:integration -- tests/integration/tools.test.ts` | all pass |
| Build | `npm run build` | exit 0 |
| E2E | `npm run test:e2e` | Docker stack starts; all E2E tests pass |
| Core checks | `npm run typecheck && npm run lint && npm test && npm run budget` | all pass |

## Scope

**In scope**:

- `src/core/tools/session.ts`
- `src/core/tools/replay.ts`
- `src/core/instructions.ts`
- `tests/integration/tools.test.ts`
- `tests/e2e/fixture-site/server.mjs`
- A new `tests/e2e/mobile.e2e.test.ts`, or an equivalently isolated new E2E file
- `tests/e2e/stack.ts` only if a probe URL constant is needed
- `README.md`
- `manifest.json`
- `tool-budgets.json` only to verify the existing ceiling; do not increase it

**Out of scope**:

- Changing Steel's mobile device payload (`deviceConfig: { device: 'mobile' }`).
- Exposing the internal Steel UUID for live MCP handles.
- Reworking diagnostics pagination or partial endpoint behavior.
- Adding viewer-click/typing telemetry or a new telemetry tool.
- Recording raw typed values, coordinates, or page content outside the existing diagnostics path.
- Calling paid Steel Cloud; the test must use the existing self-hosted E2E stack.

## Git workflow

- Suggested branch: `fix/session-tool-contracts`.
- Suggested commits: `fix(session): clarify diagnostics and replay contracts`, then
  `test(session): prove mobile mode end to end`.
- Do not push or publish.

## Steps

### Step 1: Pin the structured identifier contract with failing tests

In `tests/integration/tools.test.ts`, assert exact identifier presence for:

1. Live handle: `session_id === handle`; `steel_session_id` absent.
2. Explicit historical UUID: `steel_session_id === uuid`; `session_id` absent.
3. Latest released selection: `steel_session_id === selected uuid`; `session_id` absent.

Do not merely use `toMatchObject` with one expected field; explicitly assert absence of the other.

**Verify**: focused integration command before production change → historical cases fail because
`session_id` is present.

### Step 2: Emit the identifier appropriate to the target kind

Build the structured identity conditionally:

- `live_handle` → `{ session_id: target.reference }`.
- `historical_id` or `latest_released` → `{ steel_session_id: target.steelSessionId }`.

Keep provenance text and `selectionNote` unchanged. Do not expose `target.steelSessionId` for live
handles.

**Verify**: focused integration tests pass, including the ownership/leak assertions.

### Step 3: State the boundary of Steel-recorded diagnostics

Replace, rather than merely append to, tool/result copy so budgets stay fixed:

- State that clicks, scrolling, and typing performed directly in the live viewer may be absent from
  diagnostics because viewer input travels over CDP and is not guaranteed to enter Steel agent
  traces.
- Change the hidden-entry note to name `routine browser network Request/Response entries`; retain the
  statement that failures and navigations are kept.
- Keep the note server-authored and outside the untrusted activity fence.
- Do not imply that ordinary `steel_act` calls are absent; this limitation is specific to direct
  viewer takeover.

Add tests that an exact hidden count is still returned, the visible note names network logs, and the
takeover limitation appears without claiming that all clicks are missing.

**Verify**: focused integration tests pass and the browse/tool-description budget stays at or below
its current configured ceiling.

### Step 4: Make replay explicitly user-invoked

Preserve Plan 003's selected delivery mode and rewrite the replay tool description concisely: call it
only when the user explicitly asks to watch or replay a finished session. State that a request to
inspect/explain activity belongs to `steel_session_diagnostics`. Mirror the distinction in server
instructions, README, and manifest. If Plan 003 selected dashboard-only fallback, do not reintroduce
inline/app wording or a resource URI.

Add a tool-list/instructions test that checks the explicit-user requirement and diagnostics
distinction. Do not add logic that tries to infer user intent at runtime; tool discovery copy is the
control surface.

**Verify**: `npm run budget` passes without changing `tool-budgets.json`; integration tests pass.

### Step 5: Correct the viewport guidance

Change the viewport schema description to state that 1280×720 is the desktop default and that mobile
mode chooses a mobile viewport when the field is omitted. Update the existing description assertion
to prevent the contradiction from returning.

**Verify**: focused integration tests pass and `npm run budget` remains within its existing limit.

### Step 6: Add a device-probe fixture

Add an E2E fixture route that renders, as ordinary visible text:

- `navigator.userAgent`;
- `navigator.maxTouchPoints`;
- `window.innerWidth` and `window.innerHeight`;
- a button whose successful click changes visible text.

Keep it deterministic and dependency-free. Do not expose headers, environment variables, or
credentials.

**Verify**: while the E2E stack is running, the fixture probe URL returns HTTP 200.

### Step 7: Drive mobile mode through the real MCP binary

Model the new E2E test after `tests/e2e/leak.e2e.test.ts`:

1. Connect a real MCP client to `dist/stdio.js` using the self-hosted `STEEL_BASE_URL`.
2. Call `steel_session_create` with `{ device: 'mobile' }`.
3. Navigate to the device-probe fixture and call `steel_snapshot`.
4. Assert a mobile user-agent signal, positive touch-point count, and a viewport narrower than the
   desktop default. Prefer invariant ranges over one hard-coded phone model.
5. Find/click the probe button and assert its visible state changes.
6. Release the MCP session in `finally`, then close the client.

If self-hosted Steel does not implement mobile emulation, stop and report that contract gap rather
than weakening the test to another fake-payload assertion.

**Verify**: `npm run build && npm run test:e2e` → all E2E tests pass with the new test executed.

## Test plan

- Integration tests own exact structured response shapes, trace/replay expectations, hidden network
  count wording, and schema descriptions.
- The new E2E test owns browser-visible mobile behavior and one real interaction.
- The E2E test must clean up sessions in `finally` so failures do not leave a browser running.
- Existing REST serialization tests continue to assert `deviceConfig: { device: 'mobile' }`.
- No test should assert that direct viewer interactions appear in agent traces unless instrumentation
  is introduced in a separate approved design.

## Done criteria

**RC contract slice:**

- [ ] Live diagnostics return only `session_id`.
- [ ] Historical/latest diagnostics return only `steel_session_id`.
- [ ] No internal Steel UUID leaks for a live handle.
- [ ] Diagnostics explicitly scopes the live-viewer takeover gap.
- [ ] Hidden counts are identified as routine browser network entries.
- [ ] Replay is discoverable only for an explicit watch/replay request, not trace inspection.
- [ ] Viewport guidance distinguishes desktop and mobile defaults.
- [ ] Typecheck, lint, focused/core tests, and budgets pass.

**Post-RC coverage slice:**

- [ ] A real self-hosted mobile session proves UA, touch, viewport, and interaction behavior.
- [ ] The E2E test always releases the session.
- [ ] Build and the full E2E suite pass.

## STOP conditions

- Downstream compatibility explicitly requires historical UUIDs in the `session_id` field; report
  the consumer and contract before preserving the ambiguity.
- The self-hosted Steel image does not support `deviceConfig.mobile`.
- The E2E assertion would require a paid Steel Cloud key.
- The device probe can only pass by checking one brittle, exact browser version string.
- Adding honest trace/replay wording cannot fit the existing tool/instructions budgets without
  removing a separate safety-critical instruction; report the byte measurements before raising a
  budget.

## Maintenance notes

Treat `session_id` as an opaque live capability everywhere and `steel_session_id` as a durable
historical identifier. Mobile E2E should assert behavior, while REST unit tests assert payload shape.
Direct viewer telemetry is intentionally deferred: if the product later requires a complete human
takeover audit trail, first design an authenticated app-only path for click/scroll events and
redacted typing metadata (`inputType` and `valueLength`, never values), with ordering, retention,
rate-limit, consent, and privacy tests. Do not bolt raw CDP input logging onto diagnostics.
