# Plan 006: Prepare and cut v2.0.0-rc.1 without changing Steel endpoint contracts

> **Executor instructions**: This is a release-orchestration plan, not permission to publish. Keep
> Steel's `Content-Disposition: attachment` response unchanged and preserve the fourteen-tool product
> surface. Do not push, tag, create a release, publish npm, or publish a container until the operator
> gives explicit approval after the clean-build and Desktop-smoke evidence is presented.
>
> **Drift check (run first)**:
> `git fetch --prune --tags origin`, `git status --short`,
> `git rev-list --left-right --count origin/main...HEAD`, `git tag --list`,
> `git ls-remote --exit-code --tags origin refs/tags/v2.0.0-rc.1`,
> `npm run sync:version -- --check`, and
> `git diff --stat 6b1473a..HEAD && git diff --stat`.
> This plan was written while the rc.1 implementation was still uncommitted on
> `niko/steel-mcp-server-v2`. Stop if the version, branch topology, release trigger, publish flags, or
> selected Plan 003 outcome has changed.

## Status

- **Execution status**: implementation and local artifact preflight DONE; publishing BLOCKED at the protected approval boundary
- **Priority**: P0 release gate
- **Effort**: M after the prerequisite fixes
- **Risk**: HIGH — approving the protected publish job creates a durable tag and external release
- **Depends on**: Plan 001; Plan 002; exactly one Plan 003 outcome; Plan 004 Steps 4–5; Plan 005
  Steps 1–5
- **Category**: release / packaging / verification
- **Planned at**: commit `6b1473a`, 2026-08-07

## Execution record — 2026-08-07

- Frozen contract: fourteen browse tools; Steel artifact endpoints retain
  `Content-Disposition: attachment`; URL screenshots use a bounded MCP image block plus attachment
  link; diagnostics scopes direct CDP takeover gaps; replay is explicit-user-only and dashboard-only;
  npm and GHCR publishing remain off.
- Local preflight: 866 unit/integration tests, 48 browser tests in three consecutive runs, 17 E2E
  tests, budgets, conformance baseline, clean MCPB staging, and both container entrypoints passed.
- Local disposable MCPB: `steel-mcp-2.0.0-rc.1.mcpb`, 2,055,971 bytes,
  SHA-256 `8efe06f3196ef34e73147fdd03ba3c0e5637dadd2a3b4f7fd84a964e7b03ea54`. This proves the
  packaging path only; the workflow-built artifact remains the release candidate of record.
- Archive inspection found fourteen tools and no replay app resource, Hls.js/player file, `.env`,
  or source map. The staged JSON-RPC verifier also proves the retired replay URI returns not-found.
- Local and remote `v2.0.0-rc.1` tags were absent at the final local preflight.
- Remaining operator gates: review/merge to `main`; configure the protected `release` environment;
  dispatch the workflow at the merged SHA; download and checksum its candidate; install/smoke that
  exact MCPB in Claude Desktop with Steel Cloud; approve the pending publish job. Do not tag or
  publish from this feature branch.

## Release interpretation

“Release as is” means release the current rc.1 feature set and Steel API behavior after narrowly
scoped correctness, packaging, and truthfulness fixes. It does **not** mean tagging an uncommitted
worktree or knowingly publishing an app the target host does not render.

The Steel artifact endpoint keeps `Content-Disposition: attachment`. Inline screenshot display comes
from the bounded MCP `image` block; the hosted URL remains the download/resource-link fallback. No
release task may request an upstream header change or depend on a Markdown image URL rendering that
attachment.

## Current state and evidence

- The worktree has 33 modified tracked files plus untracked replay source/tests and these plans. A tag
  points at committed `HEAD`, never dirty worktree bytes; tagging now would omit rc.1 changes and fail
  the workflow's package-version check.
- `HEAD` is 75 commits ahead of `origin/main`. The release commit must be reviewed and merged to the
  intended public source branch before its tag is pushed, unless the maintainer explicitly chooses a
  different published-source policy.
- `package.json`, `manifest.json`, `src/core/version.ts`, and README currently agree on
  `2.0.0-rc.1`, but those edits are uncommitted. Local absence of the tag is not sufficient; the
  remote tag must be fetched/queried again before approval and immediately before creation.
- `package-lock.json` exists locally but is ignored. CI uses `npm ci` and npm caching, so Plan 001 is
  a clean-checkout blocker.
- The current replay resource is about 375,844 UTF-8 bytes, of which Hls.js is 354,471 bytes. Plan 003
  must either externalize verified immutable bytes or ship the dashboard-only fallback.
- The latest dirty-tree baseline passed typecheck, lint, build, 916 unit/integration tests, 49 browser
  tests, 17 E2E tests, budgets, conformance, and version synchronization. These are diagnostic only;
  they do not certify the eventual committed release checkout.
- The current local rc.1 MCPB was built from dirty state and is unsigned. It is disposable evidence,
  not the release artifact.
- `release.yml` has never run. It always creates a GitHub release, while npm and GHCR publication are
  guarded by repository variables. Its current `gh release create` call does not explicitly mark an
  `-rc.*` version as a prerelease.
- Browse `tools/list` is close to its 16 KiB budget. Contract-copy changes must replace/shorten text,
  not raise `tool-budgets.json`.

## Release policy

- Release `v2.0.0-rc.1`, not final `v2.0.0`.
- Keep npm and GHCR publishing disabled for this candidate unless separately approved with ownership,
  credentials, and prerelease dist-tag/image-tag behavior reviewed.
- Publish one GitHub **prerelease** with the clean-built MCPB and a SHA-256 checksum file.
- Do not make the RC “Latest.”
- Build the official candidate exactly once in GitHub Actions. The protected publish job must download
  and release those same artifact bytes after Desktop smoke; it must never rebuild the MCPB.
- Never move or reuse a published tag. A correction after tagging becomes `v2.0.0-rc.2`.
- Do not submit to an extension directory until its code-signing requirement and the MCPB CLI's
  current unsigned warning have an explicit owner decision.

GitHub's official workflow-artifact documentation confirms that an uploaded artifact can be shared
with a dependent job in the same run, and protected environments can require a reviewer before the
publish job proceeds:

- `https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts`
- `https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments`

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Version agreement | `npm run sync:version -- --check` | all four version surfaces report `2.0.0-rc.1` |
| Clean install | `npm ci` | exit 0 from a fresh Node 22 checkout |
| Source hygiene | `git diff --check` | no whitespace errors |
| Core gates | `npm run typecheck && npm run lint && npm run build && npm run test:unit && npm run test:integration` | all pass |
| Runtime gates | `npm run test:browser && npm run test:e2e` | all execute and pass; no prerequisite skip |
| Contract gates | `npm run budget && ./scripts/run-conformance.sh` | all pass without budget increases |
| Local packaging preflight | `npm run pack:mcpb` | packaging succeeds; this local file is not the approved release artifact |
| Container artifact | `docker build -t steel-mcp:2.0.0-rc.1 .` | build succeeds; both entrypoint smokes pass |
| npm inventory | `npm pack --dry-run` | only intended `files` entries; no secret/local/replay-staging debris |
| Remote tag preflight | `git ls-remote --exit-code --tags origin refs/tags/v2.0.0-rc.1` | exit 2/no output means absent; exit 0 means STOP because it exists; network/auth errors also STOP |
| Download official candidate | `gh run download <run-id> -n steel-mcp-2.0.0-rc.1-candidate` | retrieves the build job's MCPB and `SHA256SUMS` |
| Verify on macOS | `shasum -a 256 -c SHA256SUMS` | downloaded Actions artifact matches its recorded digest |
| Workflow checksum (Linux) | `sha256sum -c SHA256SUMS` | protected publish job verifies the same downloaded bytes |

## Scope

**In scope**:

- Integrating the release-blocking slices from Plans 001–005.
- `.github/workflows/release.yml`, `.github/workflows/ci.yml`, and their packaging tests for clean
  installs, required browser coverage, and prerelease semantics.
- A protected GitHub `release` environment with required reviewer approval for the exact-artifact
  promotion job.
- `RELEASING.md` and `SUBMISSION.md` release-state corrections.
- Clean-checkout build, MCPB/container inventory, checksums, and manual Claude Desktop/Steel Cloud
  smoke evidence.
- Reviewed commits, PR/merge preparation, and an annotated tag after explicit approval.

**Out of scope**:

- Changing Steel's artifact `Content-Disposition` behavior.
- Shipping new viewer telemetry, raw typing logs, or a new telemetry endpoint.
- Provisioning the HLS asset host during the release lane. If it is not already ready, select Plan
  003's dashboard-only fallback.
- Plan 004's polling/media hardening and Plan 005's mobile E2E coverage slice.
- Publishing npm or GHCR, claiming package names, or promoting `latest` tags.
- Promoting to final `2.0.0` or submitting to a directory.

## Git workflow

- Keep the current branch until the dirty work is separated into reviewed Conventional Commits.
- Suggested sequence:
  1. `fix(ci): make release installs reproducible`
  2. `fix(screenshot): bound attachment-backed previews`
  3. `fix(replay): make finished-session playback truthful`
  4. `fix(session): clarify diagnostics and replay contracts`
  5. `test(release): require browser and prerelease gates`
  6. `docs(release): prepare v2 release candidate`
- Review the complete staged diff before each commit; do not sweep unrelated dirty files into a
  release commit merely because they are present.
- Merge the reviewed candidate to `main`, wait for that exact SHA's CI run, then dispatch the
  candidate workflow. Its protected publish job creates the tag only after artifact smoke and approval.

## Steps

### Step 1: Freeze the release contract and replay outcome

Record these decisions in the PR/release checklist:

- Steel artifacts remain `Content-Disposition: attachment`.
- Browse remains fourteen tools.
- Screenshots use a bounded MCP image block plus attachment link, with link-only degradation.
- Diagnostics does not promise direct takeover events and names filtered Request/Response logs.
- Replay is called only for an explicit watch/replay request.
- Choose exactly one Plan 003 outcome. For this RC, prefer dashboard-only if the immutable Steel asset
  already fails any readiness condition; do not delay the RC to provision new asset infrastructure.
- npm and GHCR remain off.

**Verify**: the selected outcome and deferred items appear in release notes and no active doc promises
the other replay mode.

### Step 2: Land only the release-blocking implementation slices

Execute Plan 001, Plan 002, the selected Plan 003 branch, Plan 004 Steps 4–5, and Plan 005 Steps 1–5.
Use their focused tests and STOP conditions. Do not pull post-RC polling, media, mobile, or telemetry
work into the candidate.

After Plan 002, specifically prove an attachment response creates an MCP image block within the cap,
keeps its resource link, and never relies on `structuredContent.markdown`. After Plan 003 fallback,
prove the replay UI/Hls.js is absent from source emission, resources, staged package, and MCPB.

**Verify**: every required slice's focused tests and done criteria pass; `npm run budget` stays within
the existing ceiling.

### Step 3: Make the workflow produce a real prerelease

Replace the tag-triggered build-and-publish path with one manually dispatched, two-job promotion
workflow on the exact `main` SHA:

1. **Build candidate (no environment, no publishing):** use Plan 001's `npm ci`; run every clean
   automated gate; pack the MCPB once; inspect it; generate `SHA256SUMS`; upload the MCPB and checksum
   together as a uniquely named Actions artifact containing version and commit SHA.
2. **Publish exact candidate:** depend on the build job and reference a protected `release`
   environment with required reviewer approval. Download the artifact from job 1, verify its checksum,
   re-check version/SHA and local/remote tag absence, create the annotated tag at that SHA, and attach
   those exact downloaded bytes to the GitHub release. This job must not run `npm install`, build,
   `pack:mcpb`, or otherwise regenerate the bundle.

The workflow must be dispatchable only for `main` and use concurrency so a second release run cannot
race the pending candidate. Configure the `release` environment to require review before its job can
start. The operator downloads the job-1 artifact and completes Steps 6–8 while job 2 remains pending.

For a package version containing a prerelease suffix, pass both `--prerelease` and `--latest=false` to
`gh release create`; stable versions must not receive those flags. Add packaging/workflow tests for
manual dispatch, exact artifact upload/download, the protected publish job, no publish-job rebuild,
prerelease classification, and checksum attachment. Keep `PUBLISH_NPM`/`PUBLISH_DOCKER` guarded and
off. Add `npm run test:browser` through Plan 004's RC slice.

**Verify**: workflow tests pass; the build job can complete and expose its artifact while the publish
job remains pending approval; inspection shows rc.1 cannot become normal/latest and cannot be rebuilt
between smoke and release.

### Step 4: Turn the dirty worktree into reviewable commits

Re-run the initial drift check. Inventory every modified/untracked path and assign it to one suggested
commit or explicitly exclude it. Ensure all new runtime files and tests are tracked; ensure ignored
build outputs, credentials, recordings, `.env` files, and the disposable local MCPB are not staged.

Review `git diff --cached --stat`, `git diff --cached`, and `git diff --check` for each commit. Confirm
the final commit reports `2.0.0-rc.1` in all four version surfaces. Open/merge the normal reviewed PR;
do not tag the feature branch while the default branch still describes older install behavior.

**Verify**: the merge commit contains the intended source/docs/tests and tracked lockfile, has no
untracked release source, and its required CI run is green.

### Step 5: Run a clean local preflight, then build the official candidate once

Create a fresh temporary checkout of the exact merged SHA under a `mktemp -d` path. Use Node 22 and no
files from the developer's dirty tree. Run, in order:

1. `npm ci`.
2. `npm run sync:version -- --check`.
3. Typecheck, lint, build, unit, integration, browser, E2E, budget, and conformance.
4. `npm run pack:mcpb` as a packaging preflight only.
5. Docker build plus the CI-equivalent stdio `tools/list` and hosted `/healthz` smokes.
6. `npm pack --dry-run` and archive inventories.

Browser output must list executed tests; a skip caused by missing Chrome or openssl is a failure. Do
not copy the existing `build/` directory into this checkout.

After the local preflight passes, manually dispatch the revised release workflow against the exact
merged `main` SHA. Record the workflow run ID. Confirm its build job checks out that SHA, runs the same
gates, produces one candidate artifact plus `SHA256SUMS`, and completes. Confirm the protected publish
job is pending and has not created a tag or release. Do not approve it yet.

**Verify**: local commands exit zero; the Actions build job is green; its artifact is downloadable;
the publish job is pending approval; local and remote rc.1 tags/releases remain absent.

### Step 6: Download, inspect, and checksum the exact Actions candidate

Download the named artifact from the recorded workflow run. Verify `SHA256SUMS` before opening or
installing it. This downloaded MCPB, not the local preflight build, is the only release candidate from
this point onward.

Inspect its manifest, version, entrypoint, dependency inventory, resources, and tool count.
Require exactly fourteen browse tools. Confirm no `.env`, key, signed playlist, source recording,
unwanted dev dependency, stale Hls.js/player file, or source map is present.

For the preferred replay path, require replay HTML below 100,000 UTF-8 bytes and the exact external
asset/SRI/CSP contract. From the clean release checkout, immediately before Desktop smoke, re-probe
the exact production asset URL and require: HTTPS Steel-owned final URL with no redirect, correct
JavaScript content type, public CORS, immutable one-year cache policy, exact byte length, and the
committed SHA-384 digest. This is mandatory, not an optional network test. For dashboard-only, require
no replay resource URI, resource, HLS metadata, or player file. The build job must generate
`SHA256SUMS` after its automated artifact inspection and retain the clean checkout SHA beside the
digest.

Do not regenerate `SHA256SUMS` locally: compare the workflow-provided checksum with an independent
macOS `shasum -a 256` calculation. Record candidate run ID, source SHA, filename, size, and digest.

**Verify**: independent checksum matches the workflow file; the dirty-tree and local-preflight MCPBs
are never reused or substituted.

### Step 7: Smoke the MCPB in Claude Desktop against Steel Cloud

Install the exact downloaded Actions MCPB with a real, limited Steel key and exercise:

1. Initialization and fourteen-tool discovery.
2. A small URL screenshot: the MCP image block renders despite the source URL's attachment header,
   and the resource link still downloads.
3. A deliberately oversized/tall screenshot: the call returns its link without process failure or a
   huge image block.
4. PDF link behavior.
5. Create → navigate → snapshot → act → live viewer/takeover → release.
6. Diagnostics after release: direct takeover clicks/scrolling/typing are described as potentially
   absent and hidden entries are identified as routine browser Request/Response logs.
7. A trace/explanation request does not open replay. An explicit replay request either renders the
   verified small app or returns only the sanitized dashboard link, matching the selected outcome.

Inspect model-visible content and host logs for API keys, authorization headers, CDP tokens, and
signed playlists. Record pass/fail, Desktop version, OS, candidate SHA, artifact SHA-256, and selected
replay outcome without recording the credential.

**Verify**: all smoke cases pass on at least one supported Desktop platform. A second supported
platform is strongly recommended before final `2.0.0`.

### Step 8: Present the release packet and obtain approval

Present one compact packet containing:

- merged commit SHA and green CI URL;
- automated gate counts and any local prerequisites;
- manual Desktop smoke record;
- replay outcome and known RC limitations;
- MCPB filename, size, SHA-256, and unsigned/signing status;
- confirmation that npm/GHCR variables are absent or false;
- draft GitHub prerelease notes.

Stop here until the operator explicitly approves the pending protected `release` job. Preparing the
workflow artifact and packet is authorized; approving the environment, creating the tag, and
publishing are not implied.

### Step 9: Promote the exact artifact after approval

Because `package.json` already states rc.1, do not run `npm version 2.0.0-rc.1` (`Version not changed`).
Approval lets the already-pending publish job start. It must fetch/query remote tags once more, stop if
`v2.0.0-rc.1` exists, verify the downloaded job-1 artifact against `SHA256SUMS`, create the annotated
tag at the recorded candidate SHA, and call `gh release create` with that same MCPB/checksum pair.

Verify the release is marked prerelease, is not Latest, points at the approved SHA, and contains
exactly the expected MCPB plus checksum file. Download the published MCPB, compare its SHA-256 with
both the release checksum and the Step 8 packet, and confirm byte identity with the Desktop-smoked
Actions artifact. Confirm no npm version or GHCR image was published.

If the publish job fails before creating the tag, keep it failed and investigate without substituting
another artifact into the run. If it fails after tag creation, do not move/reuse the tag; record the
rc.1 issue, fix on a new commit, and prepare rc.2.

## Test plan

- Focused plan tests establish each changed contract before the aggregate run.
- A clean checkout proves ignored local state cannot rescue the build.
- Browser/E2E suites prove runtime behavior; missing prerequisites are failures in CI/release.
- MCPB, npm dry-run, and Docker inventories cover all distribution forms without publishing them.
- Manual Desktop smoke owns host rendering, the attachment-backed screenshot path, and real Steel
  Cloud behavior that fakes cannot prove.
- Same-run artifact upload/download plus post-release checksum verification proves GitHub received
  the exact MCPB that was Desktop-smoked and approved.

## Done criteria

- [ ] No MCP code requests or depends on an inline disposition; an attachment-backed fake and real
      Steel smoke render through the bounded MCP image block while retaining the download link.
- [ ] Release-blocking slices of Plans 001–005 are complete; deferred slices are named.
- [ ] Replay has exactly one truthful release mode; no oversized app is advertised.
- [ ] The rc.1 implementation and version surfaces are committed, reviewed, and merged.
- [ ] The tracked lockfile makes a clean `npm ci` succeed.
- [ ] Automated suites execute and pass from the exact clean release SHA.
- [ ] MCPB/npm/Docker inventories contain no stale files or secrets.
- [ ] Claude Desktop smoke passes with the attachment-backed image block and selected replay mode.
- [ ] The workflow builds the official MCPB once; the protected publish job promotes those exact bytes
      without running install/build/pack again.
- [ ] GitHub workflow classifies rc.1 as prerelease/non-Latest and attaches SHA256SUMS.
- [ ] npm and GHCR remain unpublished.
- [ ] The operator approved the tag after reviewing the release packet.
- [ ] Fresh local and remote checks prove `v2.0.0-rc.1` did not already exist before creation.
- [ ] Published MCPB checksum matches the approved artifact.

## STOP conditions

- Any runtime source or release version remains uncommitted/untracked at tagging time.
- The lockfile remains ignored, `npm ci` fails, or the clean checkout differs from the reviewed SHA.
- Screenshot embedding remains unbounded or relies on a Markdown URL served as an attachment.
- The immutable replay asset is unready and dashboard-only fallback is incomplete.
- Replay/trace copy remains misleading or exceeds the existing tool budget.
- Any automated gate fails, flakes across the required repetitions, or skips a required prerequisite.
- The protected `release` environment/reviewer gate is unavailable, bypassed, or starts publishing
  before the Actions artifact has been downloaded and smoked.
- Manual Claude Desktop smoke cannot render a small screenshot image block or match the selected
  replay behavior.
- Secrets, signed media URLs, stale Hls.js, or unintended files appear in an artifact.
- `PUBLISH_NPM` or `PUBLISH_DOCKER` is enabled without separate publication approval.
- The GitHub workflow would publish rc.1 as a normal or Latest release.
- The publish job rebuilds the MCPB or cannot prove byte identity with the Desktop-smoked Actions
  artifact.
- `v2.0.0-rc.1` already exists locally or remotely; never move or overwrite it.
- The operator has not explicitly approved the tag push.

## Maintenance notes

Promote a successful candidate with `npm version 2.0.0`, which updates all version surfaces and makes
the stable tag. Do not promote by moving the rc.1 tag. Carry the attachment-response regression test
forward: future clients may render resource links differently, but the Steel endpoint contract remains
a download and MCP inline display must stay independent of it.
