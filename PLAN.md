# Steel MCP Server v2 — Hosted Streamable-HTTP Design Plan

**Status:** Draft for review
**Branch:** `niko/steel-mcp-server-v2`
**Supersedes:** the v1 Puppeteer/Web-Voyager server on `main` (`src/index.ts`, MCP SDK 1.0.1, last touched Feb 2025)

---

## 1. Goals

1. **One canonical Steel MCP server** that serves every MCP host — Claude Desktop/Code, Cursor, Goose, ChatGPT connectors, Buzz — instead of per-host forks.
2. **Hosted-first**: a multi-tenant Streamable-HTTP endpoint at `https://mcp.steel.dev/mcp`. Zero install, auth via Steel API key. Tool-surface improvements ship continuously without anyone updating a binary.
3. **Same core runs locally**: a stdio entrypoint from the identical tool implementation, for self-hosters (local `steel-browser` Docker) and stdio-only hosts (Buzz brains today).
4. **Scrape-first, token-cheap tool surface**: markdown reads as the primary primitive; screenshots and CDP interaction as escalation, not default.
5. **Server-side session lifecycle**: browser sessions are created lazily and torn down by the server (MCP session end, idle reaper, hard TTL). The billed-session-leak risk class is eliminated structurally, not by hoping every host's stop-hook fires.

## 2. Non-goals

- Not an agent/brain. No LLM calls, no orchestration. The host's model decides *when*; we execute *how*.
- No Buzz-specific artifact in this repo. The Buzz persona pack lives with the Buzz integration and merely points at this server (hosted URL, or `npx`/binary for stdio).
- No bundled Chromium. The browser is always a Steel session (cloud or self-hosted); we use `puppeteer-core` purely as a CDP client.
- No v1 feature parity for its own sake. The Web-Voyager numbered-screenshot loop is replaced, not ported.

## 3. Protocol targets (verified 2026-07-27)

| Thing | Version | Notes |
|---|---|---|
| MCP spec | **2025-11-25** (current) | Negotiate down to 2025-06-18 for older clients |
| `@modelcontextprotocol/sdk` | ^1.29.0 | `StreamableHTTPServerTransport` + `StdioServerTransport` |
| `steel-sdk` | ^0.18.0 | Sessions + scrape/screenshot/pdf REST |
| Spec features we use | Streamable HTTP, `Mcp-Session-Id`, SSE polling/resumption (SEP-1699), RFC 9728 protected-resource metadata, tool icons | Experimental `tasks` (SEP-1686) deferred — see §12 |

## 4. Architecture

```
 MCP host (Claude / Cursor / Goose / Buzz brain)
   │  Streamable HTTP  (POST /mcp, GET /mcp SSE, DELETE /mcp)
   │  Authorization: Bearer <STEEL_API_KEY>   or OAuth token (later)
   ▼
 mcp.steel.dev  — this server, N stateless-ish replicas
   ├─ AuthN/AuthZ: key → Steel org, plan limits
   ├─ SessionBinder: Mcp-Session-Id ⇄ Steel session id (Redis)
   ├─ Tool layer (shared core, transport-agnostic)
   │    ├─ one-shot reads ──► Steel REST  POST /v1/scrape | /screenshot | /pdf
   │    └─ stateful browse ──► Steel session + CDP  wss://connect.steel.dev?sessionId=…
   └─ Reaper: idle timeout + hard TTL → POST /v1/sessions/{id}/release
```

**Package shape** — one npm package, three entrypoints, one core:

```
src/
  core/
    server.ts          # buildServer(deps): McpServer with all tools registered
    tools/
      scrape.ts        # steel_scrape (stateless REST)
      screenshot.ts    # steel_screenshot
      pdf.ts           # steel_pdf
      browse.ts        # steel_navigate, steel_click, steel_type, steel_scroll,
                       #   steel_wait_for, steel_go_back, steel_page_read
      session.ts       # steel_session_info, steel_release_session
    session-binder.ts  # MCP session ⇄ Steel session mapping + lazy create + reaper
    steel-client.ts    # thin wrapper over steel-sdk + puppeteer-core CDP connect
    page-snapshot.ts   # a11y-tree text snapshot with stable element refs
  http.ts              # Streamable HTTP entrypoint (hosted + self-host)
  stdio.ts             # stdio entrypoint (bin: steel-mcp)
  config.ts            # env parsing: STEEL_API_KEY, STEEL_BASE_URL, mode flags
```

`buildServer(deps)` takes an injected Steel client so every tool is unit-testable without the network.

## 5. Transport & session model

**Streamable HTTP (hosted + self-host HTTP mode)**
- `POST /mcp` for client→server messages; server may reply JSON or open SSE.
- `GET /mcp` for the standalone SSE stream; support **polling mode** (SEP-1699) — we may disconnect at will; event IDs encode stream identity for resumption.
- `DELETE /mcp` ends the MCP session → immediately releases any bound Steel session.
- Validate `Origin`, reply `403` on mismatch (spec requirement, and our DNS-rebinding guard for self-host).
- `Mcp-Session-Id` issued at `initialize`. Session state (bound Steel session id, event log for resumption, last-activity timestamp) lives in **Redis** so replicas are interchangeable — no sticky routing.

**Steel session binding (the core invariant)**
- **Lazy**: no Steel session exists until the first tool that needs a live browser (`steel_navigate` etc.). `steel_scrape`/`steel_screenshot`/`steel_pdf` on a bare URL use the stateless REST endpoints — no session, no per-minute billing.
- **One Steel session per MCP session**, reused across tool calls (cold-start cost + state continuity).
- **Teardown, in order of preference**: client `DELETE` → idle reaper (default 5 min without a tool call) → hard TTL (default 30 min) → Steel-side session timeout as final backstop. Every path calls `POST /v1/sessions/{id}/release` and records which path fired (leak metric).

**stdio mode**
- Same core; the "MCP session" is the process lifetime. Release on shutdown signal and on `close`. This is what Buzz brains spawn today and what the Buzz persona pack points at until ACP HTTP-transport support is confirmed (§12).

## 6. Auth

| Phase | Mechanism | Serves |
|---|---|---|
| Launch | `Authorization: Bearer <STEEL_API_KEY>` — validated against Steel Cloud, resolves to org + plan | Claude Code, Cursor, Goose, any client that supports custom headers |
| Launch | No-auth mode (`STEEL_LOCAL=true` self-host, binds localhost, Origin-checked) | steel-browser Docker users |
| Later | OAuth 2.1 resource server: RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource`, pointing at Steel's authorization server; incremental scope consent via `WWW-Authenticate` | claude.ai / ChatGPT consumer connectors that require OAuth |

OAuth is deliberately **not** a launch blocker: it depends on Steel platform shipping an OAuth AS in front of existing identity (open question §12). API-key bearer covers every developer-tool host on day one.

## 7. Tool surface

Design principles: **cheapest sufficient read wins**; text snapshots before pixels; explicit token budgets on every text-returning tool; every session-touching result includes the live session-viewer URL so users can watch.

### One-shot reads (no session, REST-backed)

| Tool | Input | Output | Notes |
|---|---|---|---|
| `steel_scrape` | `url`, `formats[]` (markdown \| html \| links \| readability), `max_tokens?`, `cursor?` | markdown/etc. + pagination cursor | **The primary read.** Truncates at budget with a cursor to continue — never silently clips |
| `steel_screenshot` | `url?` (or current session page), `full_page?` | MCP image content block | |
| `steel_pdf` | `url?` (or current session page) | PDF resource | |

### Stateful browsing (lazily binds a Steel session)

| Tool | Maps to | Notes |
|---|---|---|
| `steel_navigate` | CDP `Page.navigate` + wait for load/network-idle | Returns page snapshot (below) |
| `steel_page_read` | a11y tree + DOM walk | Text snapshot with stable numeric element refs (`[12] link "Pricing"`), Playwright-MCP style. Replaces v1's vision-first numbered screenshots |
| `steel_click` / `steel_type` / `steel_scroll` | CDP `Input.*` targeting a snapshot ref | `steel_type` supports `submit?: bool` |
| `steel_wait_for` | selector / text / network-idle / timeout | Replaces blind `wait` |
| `steel_go_back` | CDP history | |
| `steel_session_info` | — | Session id, viewer URL, region, expiry |
| `steel_release_session` | `POST /v1/sessions/{id}/release` | Optional early release; lifecycle works without it |

Deliberately excluded for launch: `steel_execute_js` (arbitrary eval on a multi-tenant endpoint needs its own security review), file upload/download, profiles/credentials (Steel features worth exposing later, each behind its own design note).

Every tool: zod input schema → JSON Schema 2020-12; input-validation failures return **tool execution errors**, not protocol errors (SEP-1303, lets the model self-correct); tool icons set (spec 2025-11-25).

## 8. Multi-tenancy & operations

- **Limits**: per-org concurrent-session and requests/min caps derived from Steel plan; `429` with `Retry-After`.
- **Metrics** (Prometheus): sessions created/released by teardown path, *leaked* (backstop-fired) count — the alerting metric, tool latency histograms, scrape token counts, active MCP sessions.
- **Logging**: structured JSON to stderr (stdio mode: stderr is spec-sanctioned for all logging), request-id + org-id on every line, no page-content in logs.
- **Deploy**: containerized Node service in Steel Cloud infra alongside the API gateway (exact placement = platform-team conversation, §12). Staging env first. Redis for session binding + SSE event store.
- **Self-host**: same image, `STEEL_BASE_URL` pointed at local steel-browser, Redis optional (in-memory binder for single replica).

## 9. Testing (TDD, red→green→refactor, no exceptions)

| Layer | What | How |
|---|---|---|
| Unit | Every tool handler, session binder state machine (lazy create, reaper ordering, double-release idempotency), config parsing, snapshot ref stability | Vitest, injected fake Steel client |
| Integration | Real MCP client (`@modelcontextprotocol/sdk` `Client`) ↔ our server over in-process Streamable HTTP **and** stdio: initialize/negotiate (both spec revisions), session id issuance, SSE resumption after drop, `DELETE` → release observed on the fake | Vitest, fake Steel REST/CDP at the HTTP boundary |
| E2E | Docker-composed local `steel-browser` + our server + static fixture site: scrape → navigate → snapshot → click → screenshot → session provably released; leak test (kill client mid-session, assert reaper fires) | CI job, gated nightly + on release |

Test output pristine; expected-error paths capture and assert on logs.

## 10. Delivery phases

- **P0 — Scaffold** (day 1): fresh `src/` per §4 layout, strict TS, Vitest, CI (lint + unit + integration), CLAUDE.md, this plan merged. v1 stays untouched on `main` until P4.
- **P1 — Core over stdio** (week 1): tool surface of §7 against local steel-browser Docker. *This alone completes Buzz Phase-0/1 — a Buzz persona can spawn it via stdio with zero upstream changes beyond their gap-#3 PR.*
- **P2 — Streamable HTTP** (week 2): transport, `Mcp-Session-Id` + Redis binder, reaper, API-key auth, Origin checks, rate limits.
- **P3 — Hosted** (week 3): staging deploy, metrics/alerts (leak metric), load + soak test, then `mcp.steel.dev`.
- **P4 — Ecosystem**: MCP registry + Smithery listings, docs on steel.dev, v1 deprecation notice on `main` README, npm publish (`@steel-dev/mcp-server@2.0.0`, bin `steel-mcp`), hand the hosted URL + stdio command to the Buzz persona pack.
- **P5 — Later**: OAuth resource-server flow, experimental `tasks` for long scrapes, `steel_execute_js` security review, profiles/credentials/file tools.

## 11. Migration & compatibility

- npm name stays `@steel-dev/mcp-server`; major bump to 2.0.0; old bin `mcp-server-steel-puppeteer` removed in favor of `steel-mcp` (breaking, documented).
- v1 config keys honored where sensible: `STEEL_API_KEY`, `STEEL_LOCAL`, `STEEL_BASE_URL`. `GLOBAL_WAIT_SECONDS` dropped (replaced by `steel_wait_for`).
- Hosts that can't set auth headers and can't speak stdio: `mcp-remote`-style shim documented as the bridge to the hosted endpoint.

## 12. Open questions & risks

| # | Item | Owner / next step |
|---|---|---|
| 1 | **ACP HTTP-transport support per Buzz brain** — determines whether Buzz can consume the hosted URL directly or stays on stdio | Verify against buzz-acp + adapter sources; ~1 hr |
| 2 | **Steel OAuth AS** — exists today? Required only for consumer connectors | Steel platform team |
| 3 | **Hosted placement** — standalone service vs. behind existing API gateway; who owns the pager | Steel platform team |
| 4 | **Scrape-endpoint anti-bot parity** — stateless `/v1/scrape` vs. full session (proxies/captcha); may need a `use_session: true` escape hatch on `steel_scrape` | Test against known-hostile fixture sites in P1 |
| 5 | **Snapshot ref stability under DOM churn** — refs must survive between `steel_page_read` and the following `steel_click` | Unit-test with mutating fixture pages |
| 6 | Billed-session leaks despite reaper (process crash between create and bind) | Create-then-bind ordering: write binding to Redis *before* the Steel create call returns is impossible — instead tag Steel sessions (`metadata: mcp-session-id`) and run a sweeper that releases tagged-but-unbound sessions |

---

*Prepared on branch `niko/steel-mcp-server-v2`. Protocol/SDK versions verified against modelcontextprotocol.io and npm on 2026-07-27.*
