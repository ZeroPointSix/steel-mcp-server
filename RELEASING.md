<!-- ABOUTME: What this one package ships, how the four artifacts are built from it, and the steps to
     ABOUTME: cut a release. Read this before tagging anything. -->

# Releasing

This is **one npm package with several entrypoints**, not a monorepo. One transport-independent core
under `src/core/`, and thin entrypoints that adapt it to a transport. There are no workspaces and
there should not be: the core is shared by construction, so splitting it would buy version skew
between packages in exchange for nothing.

## What ships, and from what

| Artifact | Built from | For | Published by |
|---|---|---|---|
| **MCPB bundle** `steel-mcp-<version>.mcpb` | `dist/stdio.js` | Claude for macOS and Windows | `release.yml`, attached to the GitHub release |
| **npm package** `steel-mcp` | `bin` → `dist/stdio.js`, plus `exports` for embedding | `npx`, CLI hosts, anyone importing the core | `release.yml`, when `PUBLISH_NPM` is on |
| **Container image** | `dist/stdio.js` by default, `docker run <image> dist/hosted.js` for the HTTP endpoint | Self-hosters | `release.yml`, when `PUBLISH_DOCKER` is on |
| **`mcp.steel.dev`** | `dist/hosted.js` | Steel's own hosted service | Not wired up here; deployed from the image |

The entrypoints, since three of them have similar names:

| File | What it is |
|---|---|
| `src/stdio.ts` | The local server. One process, one credential, in-memory handles |
| `src/http.ts` | The hosted **boundary**: routing, DNS-rebinding guards, credential extraction. Not runnable |
| `src/hosted-runtime.ts` | The hosted **shared runtime**: Steel client reuse per credential, tenant isolation, handle store choice. Not runnable |
| `src/hosted.ts` | The runnable hosted server. Composes the two above onto Node's HTTP server |

## Dependencies are split on purpose

`dependencies` holds only what `dist/stdio.js` statically imports — four packages. Everything the
hosted path needs is an **optional `peerDependency`**, so it is absent from a default install:

| Package | Needed by | Why it is not a dependency |
|---|---|---|
| `ioredis` | `hosted-runtime.ts`, for the shared handle store | 1.1M plus six transitive packages |
| `@modelcontextprotocol/node` | `hosted.ts` | Pulls `hono`, 2.7M |
| `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http` | `tracing.ts`, only when an `OTEL_*` variable asks | 35M. Loaded through a dynamic `import()` in a `try`/`catch` that warns and carries on, so absent is a supported state |

Measured 2026-08-04: with those in `dependencies` and `optionalDependencies`, a consumer install was
**68M across 85 packages**. It is now **17M across 5** — the same tree the MCPB bundle carries. npm
installs `optionalDependencies` by default, which is why the exporter stack reached everyone; only
`peerDependenciesMeta.<name>.optional` actually keeps a package out of a default install.

All four are also in `devDependencies`, so this repository builds, typechecks and tests against them.
Consequences to remember:

- **A self-hoster running `dist/hosted.js` must install them.** The README's hosted section says so.
- **The container image installs them itself**, after `npm prune --omit=dev` removes them. It reads
  the versions out of `peerDependencies` so the two cannot drift.
- **`tests/unit/packaging.test.ts` walks the import graph from `stdio.ts`** and fails if a new static
  import would make the bundle need something it does not carry.

## The version lives in package.json

Four files state it: `package.json`, `src/core/version.ts`, `manifest.json`, and the README's Status
line. `scripts/sync-version.mjs` writes the other three from `package.json`, and npm's `version`
lifecycle hook runs it, so a bump is one command and lands in one commit.

`src/core/version.ts` is generated but checked in, because the server reports its version without
reading a file at startup.

```bash
npm run sync:version            # write the other three from package.json
npm run sync:version -- --check # fail if any disagree; this is what CI runs
```

Tests assert all four agree, so drift fails a pull request rather than a release.

## Cutting a release

```bash
# 1. On a clean tree, with the checks passing.
npm run typecheck && npm run lint && npm test && npm run budget && npm run conformance

# 2. Bump. This rewrites the other three files, commits, and tags.
npm version patch     # or minor / major / 2.1.0

# 3. Push the commit and the tag together.
git push --follow-tags
```

The tag starts `release.yml`, which:

1. **Refuses a tag that disagrees with `package.json`** before building anything. A published tag
   naming a version nobody shipped is the one mistake here that cannot be walked back.
2. Runs every gate `ci.yml` runs — a test asserts the two lists match, so a check added to CI cannot
   be quietly skipped on the artifact that actually reaches users.
3. Packs the MCPB bundle and **attaches it to the GitHub release**. Without that the only way to get
   the file is to clone and build, which no Claude Desktop user will do.
4. Publishes to npm and ghcr **only if** the repository variable `PUBLISH_NPM` or `PUBLISH_DOCKER` is
   `true`. Both are off; `NPM_TOKEN` has to exist as a secret before the npm one will work.

Prefer `npm version` over tagging by hand: it is what keeps the four files together. The exception is
below, and the tag check in step 1 is what makes it safe.

### When package.json already states the version you want to release

`npm version 2.0.0` fails with `Version not changed` when `package.json` is already at 2.0.0, so the
flow above cannot produce that tag. This is the situation for **2.0.0 itself**, which was set by
editing the files rather than by bumping.

Tag it directly, once:

```bash
npm run sync:version -- --check   # the four files agree
git tag -a v2.0.0 -m 'v2.0.0'
git push --follow-tags
```

`release.yml` still refuses the tag if it disagrees with `package.json`, so the guarantee that matters
holds either way — what you lose by tagging by hand is only the automatic bump, and here there is
nothing to bump. Every release after this one goes through `npm version`.

Worth knowing before the first one: **`release.yml` has never run.** Tagging a throwaway prerelease
(`npm version 2.0.1-rc.1`) exercises the whole workflow — including the publish steps' `if` guards —
without putting a wrong release in front of anyone.

## Before the first release

- [ ] `PUBLISH_NPM` + an `NPM_TOKEN` secret, once the name `steel-mcp` is claimed. It is unpublished
      today, so the README tells everyone to install from source.
- [ ] `PUBLISH_DOCKER`, if `ghcr.io/steel-dev/steel-mcp-server` is the image you want.
- [ ] The MCPB directory submission has its own checklist in [SUBMISSION.md](SUBMISSION.md).
- [ ] The registry record, the DNS verification ticket, and the rest of distribution are in
      [RESEARCH.md §8](RESEARCH.md#8-distribution-checklist).
