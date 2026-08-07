# Plan 001: Make clean npm installs reproducible

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. Stop on any condition listed below; do not improvise.
> When complete, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 6b1473a..HEAD -- .gitignore package.json package-lock.json .github/workflows/ci.yml .github/workflows/release.yml Dockerfile tests/unit/packaging.test.ts scripts/pack-mcpb.sh RELEASING.md`
> and
> `git diff --stat -- .gitignore package.json package-lock.json .github/workflows/ci.yml .github/workflows/release.yml Dockerfile tests/unit/packaging.test.ts scripts/pack-mcpb.sh RELEASING.md`.
> This plan was written against an uncommitted worktree. If the facts in “Current state” no longer
> match, stop and report the drift.

## Status

- **Execution status**: DONE on 2026-08-07
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: migration / CI
- **Planned at**: commit `6b1473a`, 2026-08-07

## Why this matters

CI uses `npm ci` and npm dependency caching, but the repository ignores and does not track a lockfile.
A clean checkout therefore fails before typechecking or tests, and the newly added `hls.js` version is
reproducible only on the current machine. Tracking the npm lockfile is the smallest fix that preserves
the existing CI design and makes releases deterministic.

## Current state

- `.gitignore:134` contains `package-lock.json`.
- `.github/workflows/ci.yml:13-17` enables `cache: npm` and runs `npm ci`.
- `.github/workflows/release.yml:38` runs `npm install`, so CI and release resolve dependencies
  differently.
- `Dockerfile:9-16` copies only `package.json` and deliberately uses `npm install` because no lockfile
  is tracked; `tests/unit/packaging.test.ts:150-154` enforces that old assumption.
- `scripts/pack-mcpb.sh` intentionally uses `npm install` after rewriting the staged package manifest
  to a reduced dependency set. The root lockfile cannot be reused for that different manifest.
- `package.json` pins `hls.js` at `1.6.17`, but the locally generated lockfile is ignored.
- Commit messages use Conventional Commits, for example `feat(session): support mobile device mode`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Generate lock metadata | `npm install --package-lock-only --ignore-scripts` | exit 0; `package-lock.json` updated |
| Prove tracking | `git ls-files --error-unmatch package-lock.json` | prints `package-lock.json` |
| Clean install | `npm ci` | exit 0 |
| Core checks | `npm run typecheck && npm run lint && npm test && npm run build` | all exit 0 |
| Package check | `npm run pack:mcpb` | exits 0 and produces the MCPB bundle |
| Container check | `docker build -t steel-mcp:lockfile-plan .` | exits 0 |

## Scope

**In scope**:

- `.gitignore`
- `package-lock.json`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `Dockerfile`
- `tests/unit/packaging.test.ts`
- `scripts/pack-mcpb.sh` comments only; keep its staged install behavior
- `RELEASING.md`

**Out of scope**:

- Changing dependency versions in `package.json`.
- Switching package managers.
- Reorganizing workflow jobs or Docker build steps.
- Forcing the rewritten MCPB staging manifest to use the root lockfile.
- Publishing or tagging a release.

## Git workflow

- Suggested branch: `fix/reproducible-npm-installs`.
- Use one commit: `fix(ci): make npm installs reproducible`.
- Do not push or open a pull request unless instructed.

## Steps

### Step 1: Adopt the tracked lockfile policy

Remove only the `package-lock.json` entry from `.gitignore`. Generate the lockfile with
`npm install --package-lock-only --ignore-scripts`; do not manually edit dependency graph entries.
Confirm the lock records `hls.js@1.6.17` and the current root package version.

This reflects the dependency graph at Plan 001 time. If Plan 003 later chooses dashboard-only replay
and removes `hls.js`, regenerate and commit the lock in that change; the lasting invariant is that the
lock matches `package.json`, not that Hls.js remains forever.

Stage the generated lockfile explicitly before using an index-based tracking check. Staging is part
of preparing the release commit, not permission to commit or publish it.

**Verify**:

- `node -e "const p=require('./package-lock.json'); if(!p.packages?.['node_modules/hls.js']) process.exit(1)"`
  → exit 0.
- `git check-ignore package-lock.json` → exit 1 with no output.
- `git add package-lock.json && git ls-files --error-unmatch package-lock.json` → prints
  `package-lock.json`.

### Step 2: Use the same install primitive in CI and release

Keep `cache: npm` in both workflows. Leave CI's `npm ci` intact and replace the release workflow's
`npm install` with `npm ci`. Do not add flags that omit dev dependencies because build and tests need
them.

**Verify**:

- `rg -n "npm (ci|install)" .github/workflows` → install steps in CI and release both use `npm ci`.
- `rg -n "cache: npm" .github/workflows/ci.yml .github/workflows/release.yml` → both remain cached.

### Step 3: Make the Docker builder consume the root lock

Copy `package-lock.json` beside `package.json` in the builder stage and replace only the builder's
initial `npm install --ignore-scripts` with `npm ci --ignore-scripts`. Update the surrounding comment.
Do not change the later explicit peer installation: it intentionally mutates the pruned manifest and
uses `npm install --no-save`.

Replace the packaging test that asserts Docker does not copy a lockfile with assertions that it copies
the tracked lock and uses `npm ci` for the initial dependency graph. Keep the test that every build
input is copied.

**Verify**:

- `npm run test:unit -- tests/unit/packaging.test.ts` → pass.
- `docker build -t steel-mcp:lockfile-plan .` → pass through both entrypoint build stages.
- `rg -n "npm ci|npm install" Dockerfile` → initial install is `ci`; only the intentional post-prune
  peer install remains `install`.

### Step 4: Preserve the narrowed MCPB install exception

Do not copy the root lockfile into the MCPB staging directory after
`scripts/stage-mcpb-package.mjs` rewrites `package.json`; `npm ci` correctly rejects a lock that no
longer matches its manifest. Update `scripts/pack-mcpb.sh`'s comment to state this reason instead of
the obsolete “root lockfile is ignored” reason. Keep the staged `npm install --omit=dev` behavior.

**Verify**: `npm run pack:mcpb` → pass, and the staged dependency-count checks remain unchanged.

### Step 5: Document the policy

Update `RELEASING.md` to state that `package-lock.json` is committed, dependency changes must update
it, local development may use `npm install`, and clean verification/release uses `npm ci`.

**Verify**: `rg -n "package-lock|npm ci" RELEASING.md` → both policy terms appear.

Document three deliberate cases: root development may use `npm install`; clean CI/release/Docker
builder use the tracked root lock with `npm ci`; narrowed MCPB staging uses `npm install` because its
generated manifest is not the root package graph.

### Step 6: Prove a clean install can execute the release-relevant checks

Run `npm ci`, then the core checks and MCPB packaging. Inspect `git status` afterward: only the files
listed in Scope may have changed because of this plan.

**Verify**:

- `npm ci` → exit 0.
- `npm run typecheck && npm run lint && npm test && npm run build && npm run pack:mcpb` → all exit 0.
- `docker build -t steel-mcp:lockfile-plan .` → exit 0.
- `git ls-files --error-unmatch package-lock.json` → exit 0.

## Test plan

This is an installation-policy fix rather than runtime logic. Update the existing packaging test
because it currently encodes the opposite Docker policy; do not add a redundant test that merely
checks `existsSync(package-lock.json)`. The tracked-file command and actual `npm ci` are the root
lockfile guards. Container and MCPB builds prove the two distinct install paths.

## Done criteria

- [ ] `package-lock.json` is tracked and no longer ignored.
- [ ] The lock matches the current `package.json`; before Plan 003 it contains `hls.js@1.6.17`, and a
      later dashboard-only replay change removes both entries together.
- [ ] CI and release both use `npm ci` with npm caching.
- [ ] Docker copies the root lock and uses `npm ci` for its initial install.
- [ ] The post-prune Docker peer install remains intentionally unlocked/no-save.
- [ ] MCPB staging still uses `npm install` against its narrowed generated manifest.
- [ ] `RELEASING.md` documents the lockfile policy.
- [ ] `npm ci`, core checks, Docker build, and `npm run pack:mcpb` exit 0.
- [ ] No dependency version in `package.json` changed.

## STOP conditions

- The maintainer confirms that lockfiles are intentionally forbidden for this repository.
- Generating the lockfile changes any declared dependency version in `package.json`.
- `npm ci` needs registry credentials that are not available.
- The current workflows no longer use npm or no longer contain the install steps described above.

## Maintenance notes

Review future dependency pull requests for both manifest and lockfile changes. A release built from a
different dependency graph than CI should be treated as a release blocker.
