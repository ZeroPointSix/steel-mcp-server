# Plan 004: Bound replay polling and enforce real-browser coverage

> **Executor instructions**: The browser-gate slice (Steps 4–5) follows either Plan 003 outcome and is
> required for rc.1. The replay-runtime slice (Steps 1–3 and 6) executes only after Plan 003's
> preferred external-asset outcome; if Plan 003 shipped dashboard-only fallback, mark only that slice
> BLOCKED. Add deterministic schedule tests before modifying polling. Keep finalization polling,
> missed-result recovery, and fatal-media refresh as separate counters. Update `plans/README.md` when
> complete.
>
> **Drift check (run first)**:
> `git diff --stat 6b1473a..HEAD -- src/core/apps/session-replay.ts src/core/server.ts src/core/rate-limit.ts tests/unit/session-replay.test.ts tests/unit/rate-limit.test.ts tests/browser/session-replay.browser.test.ts tests/browser/session-viewer.browser.test.ts tests/helpers/headless-chrome.ts tests/helpers/fake-cdp-server.ts tests/integration/apps.test.ts .github/workflows/ci.yml .github/workflows/release.yml package.json`
> plus the dirty-worktree form. Stop if Plan 003 is not present or the tests for its selected outcome
> are failing.

## Status

- **Execution status**: RC browser gate DONE; replay-runtime steps BLOCKED by the selected dashboard-only fallback
- **Priority**: P2
- **Effort**: M–L
- **Risk**: MED — affects retry timing and CI duration
- **Depends on**: `plans/003-replay-protocol-contract.md`
- **Category**: performance / tests / CI
- **Planned at**: commit `6b1473a`, 2026-08-07

## Why this matters

A preparing replay currently polls every three seconds for up to forty calls. Each replay tool call
costs one budget unit, so one viewer consumes the entire default sustained allowance of twenty units
per minute and can starve normal work. Separately, `test:browser` is omitted from CI/release and can
silently skip without Chrome, so the only runtime validation for the replay app is not a merge gate.
The replay-runtime slice assumes Plan 003 has already reduced the resource below 100,000 bytes and proven
external script loading; it does not restore or modify the Hls.js delivery strategy.

For rc.1, Steps 4–5 stand alone: even a dashboard-only replay outcome still ships the live viewer and
therefore still needs a non-skipping browser gate. Polling/backoff and real replay-media interception
remain post-RC hardening when the replay app is absent.

## Current state

- `src/core/apps/session-replay.ts` declares `POLL_MS = 3000` and `MAX_POLLS = 40`.
- `schedulePoll` uses a constant delay, and `requestReplay` increments one shared `polls` counter.
- Fatal HLS refresh already has a separate `MAX_MEDIA_REFRESHES = 2`; preserve that separation.
- `src/core/rate-limit.ts` sets `refillPerMinute: 20`, burst 40, and replay cost 1.
- `package.json` defines `test:browser`, but neither workflow runs it.
- `announceMissing` prints a skip reason but never makes missing Chrome/openssl fatal.
- Replay manifest validation and CSP use `fly.storage.tigris.dev`; after Plan 003, the Steel script
  asset origin is separate and must remain separate from recording media directives.

## Target behavior

- One preparing viewer makes at most six automatic readiness polls after initial recovery, using
  delays `[3s, 6s, 12s, 24s, 30s, 30s]` (105 seconds total).
- Recovery, finalization polls, and media refreshes have separate counters.
- Terminal unavailable/error states and teardown cancel all future calls.
- Browser suites run in CI and release; missing required binaries fail in CI rather than skip.
- The replay media host/origin has one source of truth shared by validation, HTML CSP, and resource
  metadata, with a test that fails on drift. The external script asset remains governed by Plan 003's
  distinct immutable URL and SRI contract.

## Delivery split

- **RC gate (required after either Plan 003 outcome):** Steps 4–5. CI/release run the remaining
  browser suite, missing prerequisites fail in CI, and lifecycle tests assert protocol invariants.
- **Post-RC replay hardening (preferred external-asset outcome only):** Steps 1–3 and 6. Bound polling,
  consolidate media-origin policy, and exercise a real segment request.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Preferred-path focused unit | `npm run test:unit -- tests/unit/session-replay.test.ts tests/unit/rate-limit.test.ts` | all pass |
| Preferred-path focused browser | `npm run test:browser -- tests/browser/session-replay.browser.test.ts` | pass, not skipped |
| Full browser | `npm run test:browser` | all browser files pass |
| Core verification | `npm run typecheck && npm run lint && npm test && npm run budget` | all pass |
| Workflow-equivalent build | `npm run build && npm run test:browser` | both exit 0 |

## Scope

**In scope**:

- `src/core/apps/session-replay.ts`
- `src/core/server.ts`
- `src/core/rate-limit.ts` only for comments/tests; do not raise the limit
- `tests/unit/session-replay.test.ts`
- `tests/unit/rate-limit.test.ts`
- `tests/browser/session-replay.browser.test.ts`
- `tests/browser/session-viewer.browser.test.ts` only to replace brittle exact-order assertions
- `tests/helpers/headless-chrome.ts`
- `tests/helpers/fake-cdp-server.ts`
- `tests/integration/apps.test.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `package.json` only if adding a required-browser script is necessary

**Out of scope**:

- Increasing the rate limit or making replay calls free.
- Changing Steel's HLS API or adding server-side media proxying.
- Widening the recording-media origin.
- Refactoring the live viewer beyond ordering-test stability.

## Git workflow

- Suggested branch: `fix/replay-runtime-gates`.
- Suggested commits: `fix(replay): back off recording polls`, then
  `test(apps): require browser runtime coverage`.
- Do not push or publish.

## Steps

### Step 1: Extract and test the readiness schedule

Create a pure schedule helper in `session-replay.ts` whose exact sequence is
`[3000, 6000, 12000, 24000, 30000, 30000]`, then returns `null`. Inject that helper into the generated
app in the same style as existing parser helpers. Use a dedicated `preparingPolls` counter; do not
count missed-result recovery or fatal-media refresh against it.

Add unit tests for the full sequence, terminal `null`, and total elapsed time of 105 seconds.

**Verify**: focused unit command → new schedule tests pass.

### Step 2: Apply bounded backoff to the app state machine

When a replay result is `preparing`, schedule the next delay by index. When the schedule is exhausted,
show the dashboard/unavailable fallback and stop. Clear the timer when ready, unavailable, failed,
or torn down. Ensure two rapid preparing results cannot create two timers.

Add deterministic app/browser tests using either injected short schedule constants or fake timers;
do not make the browser suite sleep 105 seconds.

**Verify**: tests prove no more than six readiness polls after the initial recovery call (seven replay
tool calls total), no call after teardown, and no readiness poll after a ready/unavailable result.

### Step 3: Remove media-origin duplication and test the invariant

Export one recording origin/hostname constant from `session-replay.ts`. Use it when assembling the
generated document's media/connect CSP and when registering resource CSP in `server.ts`. Do not
reuse the external script asset domain as a media origin. Because validators are stringified into
the app, inject the hostname constant explicitly into generated JavaScript rather than relying on a
module closure.

Add tests asserting:

- an accepted manifest URL's origin is in both standard MCP Apps and OpenAI resource metadata;
- a different HTTPS origin and lookalike subdomain are rejected;
- generated HTML CSP contains the same origin.

**Verify**: replay unit and integration app tests pass.

### Step 4: Make browser prerequisites required in CI

Add `npm run test:browser` to CI after build/integration tests and to release alongside the other
gates. Modify `announceMissing` so missing Chrome or openssl throws when `CI=true`, while retaining the
current loud skip for local machines. Add an `OPENSSL_PATH` override to `findOpenssl`, parallel to
`CHROME_PATH`, so both prerequisite failures are deterministic and testable. GitHub's Ubuntu image
should satisfy both; add a preflight line that prints the resolved Chrome and openssl paths so
failures are diagnosable.

**Verify**:

- Preferred path:
  `CI=true CHROME_PATH=/definitely/missing npm run test:browser -- tests/browser/session-replay.browser.test.ts`
  → exits nonzero with a clear missing-browser message.
- Dashboard fallback:
  `CI=true CHROME_PATH=/definitely/missing npm run test:browser -- tests/browser/session-viewer.browser.test.ts`
  → exits nonzero with the same clear missing-browser message; do not name the deleted replay file.
- Either path:
  `CI=true OPENSSL_PATH=/definitely/missing npm run test:browser -- tests/browser/session-viewer.browser.test.ts`
  → exits nonzero with a clear missing-openssl message.
- Ordinary `npm run test:browser` with local Chrome → all pass.
- `rg -n "test:browser" .github/workflows/ci.yml .github/workflows/release.yml` → both workflows list it.

### Step 5: Replace brittle sequence equality with protocol invariants

In every app browser test file that remains after Plan 003, assert that initialize is first and
initialized occurs before any other outbound call/notification. Under the dashboard-only fallback,
the replay browser file is deleted and this step applies to the live viewer only. Filter or separately
assert valid size-change notifications after that boundary. Do not require an incidental resize count
or exact position after initialization.

Run the full browser suite three consecutive times to expose ordering flakiness.

**Verify**: `for i in 1 2 3; do npm run test:browser || exit 1; done` → three passes.

### Step 6: Exercise a real segment request under CSP

Reuse or extend Plan 003's narrowly scoped CDP `Fetch` interception utility to fulfill one expected
HTTPS media request from the app frame. Make the replay test's fake external HLS implementation read
the Blob playlist and fetch its segment URL; fulfill the exact Tigris URL with a tiny media response.
Assert the script request and media request are distinct, the media request occurs once, and no
undeclared origin is contacted. Keep all traffic local through CDP fulfillment.

**Verify**: focused replay browser test proves the segment request was observed and fulfilled, with
zero CSP or app exceptions.

## Test plan

- Pure unit tests own timing arithmetic.
- Browser tests own lifecycle, teardown, and actual CSP-governed fetch behavior.
- Integration app tests own resource metadata and origin invariants.
- CI-required behavior has a negative missing-browser command and a positive full-suite command.

## Done criteria

**RC browser gate:**

- [ ] CI and release run browser tests and cannot silently skip prerequisites.
- [ ] Full browser suite passes three consecutive runs.

**Preferred-path replay hardening:**

- [ ] Preparing replay retry schedule is capped at six automatic polls over 105 seconds after the
      initial recovery call (seven replay tool calls total).
- [ ] Recovery, readiness, and media-refresh counters are independent.
- [ ] One constant drives validator, generated CSP, and resource metadata.
- [ ] A real browser performs an intercepted media request under CSP.
- [ ] Core checks and budgets pass without raising the rate limit.

## STOP conditions

- Plan 003 has not landed. A dashboard-only outcome blocks Steps 1–3 and 6, but not the RC browser-gate
  Steps 4–5.
- GitHub's supported runner image has no Chrome and installing it requires an unreviewed third-party
  action; report before adding one.
- CDP fetch interception requires weakening the production CSP.
- Finalization measurements show recordings routinely need more than 105 seconds; report the data
  before changing the schedule.

## Maintenance notes

If Steel changes the recording origin, update the shared constant, live contract probe, and CSP test
in one change. Retry schedules should remain below the sustained request budget, not merely below the
burst bucket.
