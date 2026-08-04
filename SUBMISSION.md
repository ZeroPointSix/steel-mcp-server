<!-- ABOUTME: The work remaining before this server can be submitted to Anthropic's MCPB Desktop
     Extensions directory, split into repository work and work that needs a human. -->

# MCPB Desktop Extensions submission

Target: Anthropic's featured-extensions directory for Claude on macOS and Windows. The submission is
a Google Form that requires a `.mcpb` file attachment, so nothing can be submitted until the bundle
exists.

Verified against `@anthropic-ai/mcpb@2.1.2` and manifest schema **v0.4** on 2026-08-04. Required
manifest fields are `name`, `version`, `description`, `author`, `server`; `server` requires `type`,
`entry_point` and `mcp_config.command`; each `user_config` entry requires `type`, `title` and
`description`.

RESEARCH.md §8 covers the wider distribution plan. This file is only the Claude Desktop directory.

## Where we already comply

Recorded so review prep does not re-litigate it.

| Requirement | Status |
|---|---|
| Public GitHub repo, MIT licensed | `steel-dev/steel-mcp-server`, MIT |
| Built with Node.js | Node ≥20, ESM |
| Tool names ≤64 chars (policy 5C) | Longest is `steel_session_diagnostics`, 25 |
| `title` + `readOnlyHint`/`destructiveHint` on every tool (5E) | All 13, enforced by `tests/integration/tools.test.ts:92` |
| Graceful, specific errors (5A) | Named errors with recovery actions; RESEARCH.md §7 |
| Token frugality (5B) | `npm run budget` gate, screenshots return links, post-action snapshots off by default |
| No extraneous conversation data (1D) | Telemetry loads no exporter unless an `OTEL_*` var asks; `tests/unit/packaging.test.ts` guards it |
| No catch-all tool | Every tool is a narrow verb; RESEARCH.md:94 notes a catch-all is an outright rejection |

---

## Phase 1 — repository work

All in-repo, all testable, no external dependency. Ordered so each step builds on the last.

### 1.1 Fix the facts the repo currently states wrongly

Policy 2B requires descriptions to match actual functionality, and a reviewer reads the README first.

**Done 2026-08-04.** All three, with guards in `tests/unit/packaging.test.ts`:

- ~~README documented `vision` and `full` as aliases of `browse`~~ — both are now refused rather
  than aliased (`PROFILE_NAMES` is `scrape`, `browse`), and the README documents only those two.
- ~~README said "twelve tools"~~ — it says thirteen and lists `steel_session_live_view`, noting
  that hosts hide it from the model via `_meta.ui.visibility: ['app']`. A test now asserts the
  README mentions every entry in `TOOL_TABLE`.
- ~~`repository.url` and `bugs` pointed at `steel-dev/mcp-server` and 404ed~~ — both now name
  `steel-dev/steel-mcp-server`, asserted against the real remote.

### 1.2 Prune the dependency tree for a desktop bundle

An MCPB bundle ships its own `node_modules`; Claude Desktop runs its bundled Node and installs
nothing. Two packages are pure weight on the stdio path:

- **`ioredis` (1.1M)** — reachable only from `src/hosted.ts` and `src/hosted-runtime.ts`. `stdio.ts`
  never imports it, directly or transitively. Verified by import trace.
- **`@opentelemetry/*` (35M)** — `sdk-node` and `exporter-trace-otlp-http` are already
  `optionalDependencies`, but a plain `npm ci --omit=dev` still fetches them. `@opentelemetry/api`
  alone is needed and is small.

Pack from a pruned install (`npm ci --omit=dev --omit=optional`) and exclude `ioredis`. Leaves
`@modelcontextprotocol/*` (21M), `zod` (6.3M) and `ws` (196K) — roughly 28M raw, well inside the
form's 1GB cap.

Also satisfies policy 5G ("reasonably current versions of all dependencies, including packages in
`node_modules`"): bump `ws` to 8.21.2 and `@biomejs/biome` to 2.5.6. `ioredis` 6.0.0 is a major bump
and only affects the hosted path — decide separately, it does not gate this.

### 1.3 Write `manifest.json`

At repo root, `manifest_version: "0.4"`.

- `server`: `{ type: "node", entry_point: "dist/stdio.js", mcp_config: { command: "node", args: ["${__dirname}/dist/stdio.js"], env: { STEEL_API_KEY: "${user_config.steel_api_key}" } } }`
- `user_config.steel_api_key`: `{ type: "string", title: "Steel API key", required: true, sensitive: true }` so Desktop prompts instead of demanding hand-edited JSON. Add `steel_profile` as an optional string defaulting to `browse`.
- `tools`: all 13, names and descriptions generated from `TOOL_TABLE` so they cannot drift.
- `compatibility`: `{ platforms: ["darwin", "win32"], runtimes: { node: ">=20" } }`.
- `privacy_policies`, `repository`, `homepage`, `documentation`, `support`, `license: "MIT"`, `keywords`.
- `author` — **needs a decision from you, see 2.1.**

TDD: a test in `tests/unit/packaging.test.ts` that reads `manifest.json`, asserts its `version`
equals `SERVER_VERSION`, asserts its `tools` array matches `TOOL_TABLE` exactly, and asserts
`entry_point` is the file the build actually emits.

### 1.4 Add the pack script

`scripts/pack-mcpb.sh` plus an `npm run pack:mcpb`: clean build, staging dir, pruned prod install,
`mcpb validate manifest.json`, `mcpb pack`, then `mcpb info` on the result. Wire `mcpb validate` into
CI so a malformed manifest fails the build rather than the submission.

### 1.5 Add the missing developer-requirement docs

- **`SECURITY.md`** — disclosure contact and response expectation (policy 3B).
- **README: Privacy Policy section** linking the policy URL, and a Support section (3A, 3B).
- **README: Troubleshooting** already exists at §162 — extend it with the Desktop-specific failures
  (missing API key, plan concurrency limit, session timeout).
- **Three worked examples** (policy 3E). The four bullets at the top of the README already do this
  well; promote them to a labelled "Example prompts" section so the form answer and the README match.

### 1.6 Install and exercise the bundle locally

Install the packed `.mcpb` into Claude Desktop, run all 13 tools against a real Steel key, and
confirm the session viewer renders. This is the step that catches whatever the schema did not. Record
findings in NOTES.md, which is where measured facts live.

---

## Phase 2 — needs you

Ordered by lead time. 2.1 and 2.2 block Phase 1 finishing; the rest block submission.

### 2.1 Decide the `author` field — blocks 1.3

The form requires `author` pointed at *your* GitHub profile, but the repo is org-owned. Options:

- `author: { name: "Nikola Balić", url: "https://github.com/nibzard", email: … }` with Steel ownership
  carried by `homepage` and `repository`. Matches the form's literal wording.
- `author: { name: "Steel", url: "https://github.com/steel-dev" }`. Reads more official, but a
  reviewer following the form's instruction may see an org where they expect a person.

Recommend the first. Also tell me which email to put in the manifest — it is public.

### 2.2 Decide the release version — blocks 1.6

Current version is `2.0.0-beta.1` and the README says `mcp.steel.dev` "is not production-ready yet".
Submitting a beta to a featured directory is a weak look. Cut `2.0.0`, or `2.0.0-rc.1` at minimum.
Your call — it also affects the npm/registry timeline in RESEARCH.md §8.

### 2.3 Publish a real privacy policy — immediate-rejection item

`https://steel.dev/privacy` currently **308-redirects to a Google Doc**
(`docs.google.com/document/d/1q3QBkFm4ke-…`). It resolves, but policy 3A wants a clear, accessible
policy and a Google Doc reads as unmaintained. RESEARCH.md §8 item 8 already flags a missing policy as
an immediate rejection. Needs a real page on `steel.dev` — a web/marketing task, not a repo task.

Once it is live I can add it to the manifest's `privacy_policies` and the README.

### 2.4 Provision the reviewer demo account — policy 3D

A dedicated Steel org: fully populated, **no MFA, no SMS, no email confirmation, no private-network
access**. Reviewers run every tool with these credentials. Spec already written in RESEARCH.md §8
item 9. Steel platform work.

### 2.5 Server icon

PNG for the manifest's `icon`. `assets/` exists — if there is already a usable mark, point me at it
and I will wire it in; otherwise it needs design.

### 2.6 Submit the form

Needs your Google account (`nikola.balic@gmail.com`), the packed `.mcpb`, and agreement to the MCP
Directory Terms. Draft answers below.

---

## Draft form answers

| Field | Answer |
|---|---|
| Is this an update to an existing extension? | No |
| Primary Contact Name | Nikola Balić |
| Primary Contact Email | niko@steelbrowser.com |
| GitHub Link | `https://github.com/steel-dev/steel-mcp-server` |
| Primary Party Confirmation | **Yes** — you work for Steel, which owns the service |
| MCP Server Description (50 words max) | Draft: "Gives Claude a real Chrome browser in the cloud via Steel. Reads pages that block plain fetch as markdown, captures screenshots and PDFs, and drives interactive sites — clicking, typing, filling forms, working through logins — using accessibility-tree references rather than pixel coordinates." (44 words) |

---

## Explicitly not blocking

- **`src/index.ts`** — the 35KB v1 monolith, excluded from the build by `tsconfig.build.json` and
  never shipped. Dead code worth deleting, but out of scope here; file an issue.
- **MCP Apps session viewer** — the inline viewer is a differentiator, not a requirement. Whether
  Claude Desktop honours `_meta.ui.visibility` from an MCPB install is worth confirming in 1.6, but
  a "no" costs us a hidden tool becoming visible, not a rejection.
- **OAuth / `mcp.steel.dev`** — the Connectors Directory needs it (RESEARCH.md §8 item 20). The MCPB
  directory does not. This is the OAuth-free route, which is why it goes first.
