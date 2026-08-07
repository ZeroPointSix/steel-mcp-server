# Plan 002: Bound screenshot embedding and preserve fallback links

> **Executor instructions**: Follow every step and verification gate. Use TDD: add the failure and
> oversize tests before changing production code. Stop rather than widening scope. Update the row in
> `plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 6b1473a..HEAD -- src/core/tools/stateless.ts src/core/context.ts tests/helpers/fakes.ts tests/integration/tools.test.ts README.md manifest.json SUBMISSION.md`
> and the same command without `6b1473a..HEAD`. Compare `downloadArtifact` and the screenshot schema
> against the excerpts below.

## Status

- **Execution status**: DONE on 2026-08-07
- **Priority**: P1
- **Effort**: M
- **Risk**: MED — response shape and fallback wording are user-visible
- **Depends on**: `plans/001-reproducible-npm-installs.md`
- **Category**: bug / performance
- **Planned at**: commit `6b1473a`, 2026-08-07

## Why this matters

URL screenshots now inline by default. `downloadArtifact` reads the whole body and then creates
Buffer and base64 copies without any byte limit; a tall full-page capture can exhaust server memory
or exceed a client's MCP message limit. A download error also throws before the already-valid Steel
resource link is returned, contradicting the advertised fallback. Embedding should be bounded and
best-effort while preserving cancellation semantics.

Steel intentionally serves hosted artifacts with `Content-Disposition: attachment`. That remains the
default endpoint contract for this release. The MCP server may read those bytes to create a bounded
`image` content block, but it must not require, rewrite, or reinterpret the upstream disposition
header; the resource link must continue to behave as a download.

## Current state

- `src/core/tools/stateless.ts:19-29` calls `response.arrayBuffer()` and throws on non-2xx.
- `src/core/tools/stateless.ts:222-243` defaults `inline` to true, downloads before building the
  resource link, and includes `size` only after a successful download.
- The `session_id` branch always emits a JPEG image even when the caller passes `inline: false`.
- `tests/helpers/fakes.ts` returns the eight-byte string `fake-png`, so current tests do not exercise
  response size, streaming, MIME mismatch, or fetch failure.
- Repository convention: tool failures use `SteelToolError`, while successful tool responses are
  assembled with `successResult`; cancellation must continue to propagate through `guard`.

## Target behavior

- Keep URL screenshot embedding enabled by default, but cap the decoded artifact at **4 MiB**.
- Accept `Content-Disposition: attachment` as the normal successful response; validate image bytes by
  status and `Content-Type`, not by requiring an inline disposition.
- Check `Content-Length` when present, and also count streamed chunks so a missing or false header
  cannot bypass the cap.
- Inline only a successful `image/png` response within the cap.
- The MCP `image` content block, not a Markdown image pointed at the attachment URL, is the inline
  rendering mechanism. Always keep the resource link as the download path.
- On network failure, non-2xx, wrong MIME, or oversize: return the resource link, omit the image, and
  include a short safe note explaining that inline preview was unavailable.
- If the caller's abort signal fires, rethrow the abort; do not convert cancellation into success.
- For `session_id` captures, reject `inline: false` as `invalid_argument` because that path has no
  hosted artifact URL to return. Update the schema text to say this explicitly.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused integration | `npm run test:integration -- tests/integration/tools.test.ts` | all focused tests pass |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0, no fixes applied |
| Response budgets | `npm run budget` | every budget remains within limit |
| Full core tests | `npm test` | all unit/integration tests pass |

## Scope

**In scope**:

- `src/core/tools/stateless.ts`
- `src/core/context.ts` only if the injected fetch type needs refinement
- `tests/helpers/fakes.ts`
- `tests/integration/tools.test.ts`
- `README.md`
- `manifest.json`
- `SUBMISSION.md`
- `PLAN.md` only if it still describes screenshots as always link-only

**Out of scope**:

- Changing Steel's `Content-Disposition: attachment` default or asking the Steel endpoint to emit
  `inline`.
- Uploading session screenshots to a new storage service.
- Changing PDF behavior.
- Changing screenshot billing, Steel API calls, or session lifetime behavior.
- Raising MCP prompt/tool-description budgets.

## Git workflow

- Suggested branch: `fix/bounded-screenshot-embedding`.
- Suggested commit: `fix(screenshot): bound inline artifact downloads`.
- Do not push or publish.

## Steps

### Step 1: Add characterization and failure tests

Extend the existing `steel_screenshot and steel_pdf` block in
`tests/integration/tools.test.ts`. Add test-local `artifactFetch` responses rather than production
mock modes. Cover:

1. A small PNG with `Content-Disposition: attachment` produces an exact base64 image block, exact
   byte size, and resource link without adding or relying on a Markdown image URL.
2. `Content-Length` above 4 MiB returns link-only without reading the body.
3. A chunked body that crosses 4 MiB returns link-only and cancels the reader.
4. HTTP 500 returns link-only, not an error result.
5. A rejected fetch returns link-only without leaking the thrown URL or headers.
6. A non-PNG content type returns link-only.
7. An already-aborted request remains an aborted/error call.
8. `session_id` with `inline: false` returns `invalid_argument` before CDP screenshot capture.

**Verify**: run the focused integration command before production changes → the new regression tests
must fail for the expected reasons.

### Step 2: Replace unbounded download with a discriminated best-effort result

Introduce a named exported or module-local constant equal to `4 * 1024 * 1024`. Rewrite
`downloadArtifact` to return a discriminated result such as `embedded` versus `link_only`, including
safe reason metadata but never the artifact body or signed URL in an error note.

Use `response.body.getReader()` and accumulate chunks only while the total is within the cap. Cancel
the reader as soon as the cap is exceeded. A trusted `Content-Length` precheck may skip the read but
must not replace streamed counting. Preserve the caller's `AbortSignal` and rethrow abort errors.

**Verify**: focused integration tests → all eight cases pass.

### Step 3: Assemble the link before optional inline content

In the URL branch, construct the resource link independently from embedding. Add an MCP `image`
content block only when the bounded download succeeds. Do not add a Markdown image URL: Steel's
intentional attachment disposition makes that an unreliable rendering path. On fallback, keep
`structuredContent.url` and add one concise note. Do not expose implementation errors or presigned
query details.

**Verify**: focused integration tests and `npm run budget` → pass.

### Step 4: Make session capture semantics explicit

Clarify that `inline` controls URL captures. Reject `session_id + inline:false` with a specific
recovery message: session captures are returned directly and have no hosted link; omit the flag or
use a URL capture. Perform this validation through `guard` before `withPage` so it becomes the
promised `invalid_argument` tool result, while still ensuring the session is never touched.

**Verify**: the new session-option test asserts an error and no page capture/touch side effect.

### Step 5: Align user-facing documentation

Update README, manifest, submission notes, and any active plan prose to state: screenshots are shown
through an MCP image block when small enough, always retain an attachment/download link for URL
captures, and fall back to link-only when embedding is unavailable or too large. Remove instructions
to preserve or echo a Markdown image and unconditional claims that screenshots always return links
or always inline.

**Verify**: `rg -n "screenshots? return links|return a link|inline" README.md manifest.json SUBMISSION.md PLAN.md`
→ no stale unconditional claim remains.

## Test plan

Use the existing integration harness and injected `artifactFetch`; do not make live network calls.
Assert exact content block types and structured fields, not just `some(type === 'image')`. Run the
full core suite after focused tests pass.

## Done criteria

- [ ] No screenshot artifact body can exceed 4 MiB in memory before rejection.
- [ ] Headerless/chunked bodies cannot bypass the limit.
- [ ] A normal `Content-Disposition: attachment` response still produces a bounded image block and
      leaves the fallback link as an attachment download.
- [ ] No rendering path depends on a Markdown image URL to the attachment endpoint.
- [ ] Fetch, HTTP, MIME, and oversize failures return a usable resource link.
- [ ] Caller cancellation still cancels the tool call.
- [ ] `session_id + inline:false` has explicit tested behavior.
- [ ] Docs and manifest describe bounded best-effort embedding.
- [ ] Typecheck, lint, focused tests, full tests, and budgets pass.

## STOP conditions

- Steel's artifact response is not a standard Fetch `Response` with a readable body.
- A host requires image blocks larger than 4 MiB for a documented compatibility reason.
- Implementing link fallback requires changing `successResult` globally.
- The solution requires persisting artifact bytes or adding a new upload service.

## Maintenance notes

Keep the byte cap close to the downloader and regression tests. Any future inline artifact type must
use the same bounded streaming pattern rather than `arrayBuffer()`.
