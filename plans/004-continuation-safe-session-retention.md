# Plan 004: Optionally align idle retention with a normal continuation window

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. This plan changes the abandoned-session billing envelope: obtain
> the product approval required by Step 1 before editing defaults. If anything
> in the "STOP conditions" section occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md` unless a
> reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c0a4e7c..HEAD -- src/core/lifecycle.ts src/core/config.ts src/core/mrtr.ts src/core/tools/session.ts src/stdio.ts src/hosted.ts tests/unit/config.test.ts tests/unit/registry.test.ts tests/unit/registry-conformance.test.ts tests/integration/tools.test.ts tests/smoke/cloud.test.ts README.md NOTES.md plans/README.md`
> Replace `c0a4e7c` and refresh excerpts/line references if any earlier plan has
> landed. If any in-scope file has unrelated uncommitted changes,
> stop and reconcile ownership before proceeding.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: explicit product/billing approval; no code-plan dependency
- **Category**: bug
- **Planned at**: commit `c0a4e7c`, 2026-08-13

## Why this matters

The audited Amazon session was healthy, then quiet for about nine minutes between
Claude's `tool_use_limit` stop and the user's `Continue`. Steel was configured to end
after 120 seconds without browser activity, while the local registry reaper considered
the handle idle after 150 seconds. By the time `Continue` arrived, the immutable
15-minute hard deadline had also elapsed, so continuation correctly returned `not_found`
and the cart session was lost. This run therefore does **not** show that a longer idle
window alone would have saved the cart.

This is not an MCP call timeout. To make a normal continuation window viable, both the
Steel inactivity clock and local reaper must move together **and** the cart-holding
session must be created late enough to have that much immutable hard runway left. The
recommended default is 10 minutes of Steel inactivity and a local reaper threshold one
sweep later, while hard expiry remains authoritative. A nine-minute quiet continuation
is promised only when at least ten minutes remain before `expires_at`, leaving a
one-minute operation/sweep margin. The larger idle
window increases abandoned-session cost and concurrency occupancy, so it requires an
explicit product/billing decision before implementation.

## Current state

- `src/core/config.ts:64-67` defines independent defaults:

  ```ts
  const DEFAULT_INACTIVITY_TIMEOUT_MS = 120_000;
  const DEFAULT_SESSION_TIMEOUT_MS = 900_000;
  ```

- `src/core/config.ts:230-234` sends the configured idle timeout when it is strictly
  below hard expiry, otherwise halves the hard timeout or omits an unusably small value.

- `src/stdio.ts:13-15` and `src/hosted.ts:12-14` each duplicate:

  ```ts
  const REAPER_INTERVAL_MS = 30_000;
  const REAPER_IDLE_MS = 150_000;
  ```

  These constants can drift from the Steel inactivity setting and ignore an operator's
  `STEEL_INACTIVITY_TIMEOUT_MS` override.

- `src/core/mrtr.ts:41-47` gives a pending handoff up to 600,000ms of local grace, clamped
  to hard expiry. It does not extend Steel's independent inactivity clock.

- `src/core/registry.ts:313-321` skips local idle reaping while input/human control is
  active, but always honors hard expiry. The registry accepts `idleMs`; policy belongs
  above it rather than being duplicated inside both backends.

- `src/core/tools/session.ts:193-220` already reports `expires_at`, `remaining_ms`,
  `inactivity_timeout_ms`, `hard_timeout_mutable: false` and takeover capabilities.

- `README.md:166-176` documents 900,000ms hard and 120,000ms idle defaults.

- Existing tests cover timeout clamping (`tests/unit/config.test.ts:144-165`), create
  output (`tests/integration/tools.test.ts:541-621`), reaping/hard-expiry precedence
  (`tests/unit/registry.test.ts:330-455`) and handoff pinning
  (`tests/integration/mrtr.test.ts`). No test composes a nine-minute continuation.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Config/registry units | `npm run test:unit -- tests/unit/config.test.ts tests/unit/registry.test.ts tests/unit/registry-conformance.test.ts` | all three files pass |
| Lifecycle integration | `npm run test:integration -- tests/integration/tools.test.ts` | create-result lifecycle contract passes |
| Cloud characterization | `STEEL_RETENTION_SMOKE=1 npm run test:smoke -- tests/smoke/cloud.test.ts -t "preserves a nine-minute quiet window"` | the one selected opt-in case keeps one disposable session live for nine quiet minutes, then releases it |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Unit/integration regression | `npm test` | all pass |
| Build | `npm run build` | exit 0 |

The selected opt-in cloud characterization bills one disposable session for about nine
minutes. Run it once before release, never in ordinary CI, and always release in
`finally`. Its test-specific timeout must exceed nine minutes; the smoke project's
ordinary 120-second default is intentionally insufficient.

## Scope

**In scope**:

- `src/core/lifecycle.ts` (new shared policy module)
- `src/core/config.ts`
- `src/core/mrtr.ts`
- `src/core/tools/session.ts`
- `src/stdio.ts`
- `src/hosted.ts`
- `tests/unit/config.test.ts`
- `tests/unit/registry.test.ts`
- `tests/unit/registry-conformance.test.ts`
- `tests/integration/tools.test.ts`
- `tests/smoke/cloud.test.ts`
- `README.md`
- `NOTES.md` (decision reference and redacted smoke outcome only)
- `plans/README.md` (status only)

**Out of scope**:

- Raising the immutable hard default above 15 minutes as the fix; Launch clamps it.
- Automatically extending an existing Steel session; the API/contract does not support it.
- A keepalive loop, synthetic browser input, or hidden model tool calls.
- Promising survival across arbitrary pauses or beyond `expires_at`.
- Cross-session cart/profile persistence.
- Logging raw handles, profile IDs, URLs, page content, player/CDP links or credentials.

## Git workflow

- Branch: `fix/continuation-safe-session-retention`
- Use TDD for shared-policy and fake-clock cases.
- Suggested commit: `fix(session): preserve normal continuation runway`
- Do not push or open a PR unless explicitly asked.

## Steps

### Step 1: Record the product and billing decision

Before code changes, obtain explicit maintainer approval for this recommended policy:

- Steel inactivity default: `600_000`ms (10 minutes).
- Local registry idle: the configured inactivity timeout plus one 30-second sweep,
  adding cleanup slack without treating the two activity clocks as identical.
- Hard default remains `900_000`ms and is still clamped to the account maximum.
- When configured inactivity is not strictly below a shorter hard lifetime, omit the
  separate inactivity timeout and let that immutable hard deadline clean up; do not
  halve the available continuation window.
- Handoff grace remains bounded and never exceeds hard expiry.

Record the accepted values, decision owner and dated PR/issue reference in a short
`NOTES.md` measurement entry; also link that artifact from the implementation PR. Do
not add a source-history comment. Quantify all three bounds: Steel's abandoned-browser
idle bill can rise from roughly two to ten minutes; the local threshold becomes 10.5
minutes and periodic sweep timing can make observed handle cleanup approach 11 minutes;
genuine browser or handoff activity can still occupy the unchanged 15-minute hard
lifetime. Explicit release and process shutdown still reclaim immediately.
For explicitly shorter sessions, replacing the current half-hard fallback can increase
occupancy from half of that requested lifetime to its full hard deadline; include that
case in the approval.

If the maintainer rejects the increased cost, stop this plan after documenting the
decision. Plans 002, 003 and 005's create-late guidance remain worthwhile, but a nine-
minute ordinary `Continue` pause cannot be promised under a two-minute idle setting.

**Verify**: `NOTES.md` contains the accepted idle value, date, decision owner and
reviewable PR/issue reference. Otherwise this plan remains BLOCKED and no default
changes are made.

### Step 2: Centralize lifecycle policy

Create `src/core/lifecycle.ts` with two `ABOUTME:` lines and the shared low-level policy:

- reaper sweep interval;
- default Steel inactivity timeout;
- default hard timeout;
- handoff grace;
- a pure resolver for local reaper idle from configured Steel inactivity.

The resolver should use `configuredInactivityMs + REAPER_INTERVAL_MS` as best-effort
local cleanup slack, validate positive finite integers through existing config parsing,
and leave hard-expiry enforcement to the handle record. Do not call Steel's clock
"authoritative": registry idle is measured from MCP touches, while Steel inactivity is
measured from remote browser input, so their ordering is not identical. Keep
`resolveInactivityTimeout` in `config.ts` unless moving it makes the API clearer; do not
create a circular import.

Make `src/core/config.ts`, `src/core/mrtr.ts`, `src/stdio.ts` and `src/hosted.ts` import
the shared values. Both entrypoints must derive the reaper threshold from the loaded
configuration rather than a second fixed number, so
`STEEL_INACTIVITY_TIMEOUT_MS` affects both cleanup layers coherently.

Add unit assertions in `tests/unit/config.test.ts` for the accepted default, the local
reaper derivation, env overrides, and this explicitly approved short-hard truth table:

- configured 600,000ms with a 900,000ms hard timeout sends 600,000ms;
- configured 600,000ms with a 600,000ms or shorter hard timeout sends no separate
  inactivity value and relies on hard expiry.

Do not weaken the invariant that Steel inactivity is strictly below hard timeout when
sent. This deliberately replaces the current half-hard fallback; if product does not
approve that cost behavior, return to Step 1 rather than silently changing this table.

**Verify**:
`npm run test:unit -- tests/unit/config.test.ts`
→ all lifecycle policy/default/override tests pass.

### Step 3: Characterize nine-minute continuation and hard-expiry precedence

Using fake time (never a real nine-minute test), extend registry coverage. Before
advancing the successful case, assert the handle has at least ten minutes of immutable
hard runway remaining; the scenario is invalid otherwise.

1. Create one handle immediately before cart interaction with a 15-minute hard deadline
   and the accepted idle policy.
2. Advance nine minutes after the last agent touch without handoff; a sweep at the
   derived local idle threshold must not yet release it.
3. Touch the same handle as a `Continue` call would; it remains resolvable and no new
   Steel session is created.
4. Reproduce the audited timing separately: leave only about four minutes of hard runway,
   advance a nine-minute pause, and assert hard expiry wins even with the longer idle
   policy. This guards against claiming Plan 004 alone would have saved that run.
5. Advance beyond the derived idle threshold with no activity; the handle is released.
6. Advance past hard expiry even after recent activity or pending handoff; hard expiry
   still releases it.

Put backend-neutral behavior in `tests/unit/registry-conformance.test.ts`, in-memory
details in `tests/unit/registry.test.ts`. Use the registry's injected clock or
`vi.setSystemTime`; do not advance timer queues across an MCP client/server stack. Do
not wait in real time or use a real profile UUID. Plan 005 owns the composed
cart/handoff flow; do not duplicate it here.

**Verify**:

- `npm run test:unit -- tests/unit/registry.test.ts tests/unit/registry-conformance.test.ts`
  → all pass under fake timers.

### Step 4: Preserve the existing truthful lifecycle result

Do not add redundant requested/actual/clamped fields. The result already returns the
actual post-clamp `remaining_ms`, absolute `expires_at`, actual
`inactivity_timeout_ms`, `hard_timeout_mutable: false`, and plan maximum. Update their
tests for the accepted default and retain the invariant that every displayed duration
is the value actually sent to Steel.

Only if the existing plan-clamp case lacks model-visible clarity, add one compact text
note saying the account maximum reduced the requested lifetime; do not add a new public
field solely for that note. Preserve the existing profile/session-state warning from
the current branch. Do not claim an idle session is reserved merely because its viewer
is visible, or that a replacement inherits its cart.

**Verify**:
`npm run test:integration -- tests/integration/tools.test.ts`
→ default, explicit, plan-clamped and unknown-plan-maximum cases report truthful
existing values and preserve takeover/profile fields.

### Step 5: Update operator documentation

In `README.md`:

- update the inactivity default;
- state the abandoned-session cost/concurrency tradeoff;
- explain that ordinary chat pauses are bounded by both inactivity and hard expiry;
- explain that a visible viewer alone does not reserve a session;
- state that explicit handoff pins local reclamation only within the existing hard
  deadline and human browser input resets Steel inactivity;
- retain explicit-release guidance.

Do not document Claude's observed 50-call cap as an MCP guarantee.

**Verify**:
`rg -n "120000|two quiet minutes|2-minute|2 minute" README.md src/core`
→ no stale default claim remains (test fixtures with explicit values may still exist).

### Step 6: Add and run one opt-in cloud retention characterization

In `tests/smoke/cloud.test.ts`, add a case skipped unless
`STEEL_RETENTION_SMOKE=1`. It must:

- create one disposable session with the accepted hard and inactivity values;
- perform one harmless browser action/read;
- wait nine minutes without MCP/browser activity;
- verify through Steel that the same session is still live;
- release it in `finally`, including failure paths;
- print only elapsed durations and status, never session/player/CDP/profile identifiers.

Give this individual test an explicit timeout of at least 660,000ms so it can exceed
the smoke project's 120-second default. Filter by its exact test name in the command
above so the existing session-create smoke does not create a second browser. While
touching the file, redact the existing `afterAll` release-failure message so it no
longer prints a raw session ID.

Do not add this long, billed case to ordinary CI. Run it once with an authorized test
credential before releasing the candidate.

**Verify**:
`STEEL_RETENTION_SMOKE=1 npm run test:smoke -- tests/smoke/cloud.test.ts -t "preserves a nine-minute quiet window"`
→ the opt-in case passes in roughly nine minutes and confirms cleanup.

### Step 7: Run regression gates

**Verify**:

- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0.
- `npm run build` → exit 0.
- `npm test` → all unit/integration tests pass.
- `npm run budget` → all existing budgets pass.
- `git diff --check` → no output.

## Test plan

- Pure policy: accepted defaults, env override, reaper derivation, short hard lifetime.
- Registry: nine-minute survival only with enough hard runway, audited low-runway
  failure, post-window idle release, hard expiry always wins, backend-neutral parity.
- Tool output: existing actual timeout/expiry/idle fields remain truthful after the
  default change; no cart-persistence promise.
- Opt-in cloud: real Steel accepts and honors a nine-minute quiet window, then cleans up.

## Done criteria

- [ ] Product/billing owner explicitly accepted the increased idle envelope.
- [ ] Steel inactivity and local reaper values come from one shared policy.
- [ ] Operator overrides affect both layers coherently.
- [ ] Fake-clock tests prove a nine-minute continuation survives when hard time remains.
- [ ] Fake-clock tests prove the audited low-hard-runway timing still expires.
- [ ] Hard expiry wins over activity and handoff in every test.
- [ ] Create output's existing remaining, idle, plan-limit and absolute-expiry facts
      remain truthful.
- [ ] README states the cost and bounded guarantee without promising arbitrary pauses.
- [ ] The opt-in real-Steel retention smoke passed once and released its session.
- [ ] Typecheck, lint, build, unit/integration, budget and diff checks pass.
- [ ] No file outside scope changed.
- [ ] `plans/README.md` marks Plan 004 DONE.

## STOP conditions

Stop and report back if:

- No explicit product approval exists for increasing abandoned-session occupancy.
- No authorized disposable Steel credential is available, or the test account's hard
  maximum leaves less than ten minutes of runway for the cloud characterization.
- Steel rejects the accepted inactivity value or releases before the opt-in smoke's
  nine-minute check. Characterize the actual supported semantics; do not guess.
- The account's hard maximum is shorter than the accepted continuation window.
- Coordinating entrypoints would require weakening hard expiry or shutdown cleanup.
- A test would need real credentials/profile IDs in fixtures or logs.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Any future change to handoff grace, inactivity or reaper cadence must update the shared
  lifecycle invariants and the nine-minute fake-clock case together.
- The hard maximum is account-owned and immutable after creation. Create-late workflow
  remains essential even with a longer idle window.
- Low-cardinality lifecycle-cause telemetry is intentionally separate in
  `plans/006-session-release-cause-observability.md`.
