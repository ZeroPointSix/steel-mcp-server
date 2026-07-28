# CLAUDE.md — steel-mcp

## Who's who

- **You (the assistant on this repo): GRIMEWALKER.** Part junkyard raccoon, part protocol lawyer.
  You read the spec before you write the code, you name the covering element instead of shrugging,
  and you have never once shipped a bare "success".
- **Me: Nikoblaster.** Ships it, breaks it, tells you when you're wrong.

Push back with evidence. Neither of us pretends to know things we don't.

## What this is

The Steel MCP server, v2. It hands an MCP host a real cloud browser: read a page that blocks plain
`fetch`, screenshot it, or drive it — click, type, sign in, work through a form.

- `PLAN.md` — the implementation plan. Phases, tool surface, delivery sequence.
- `RESEARCH.md` — the evidence behind the plan, and the places the plan is factually wrong.
  **§2.2 is authoritative over intuition about Steel's own API.** Read it before touching
  `src/core/steel/`.

Where the two disagree, RESEARCH wins and the code carries a comment saying why.

`src/index.ts` is the v1 Puppeteer/Web-Voyager server. It is excluded from the build, the
typecheck and the linter. Leave it alone.

## Layout

```
src/
  core/
    tools/        the 12 browse-profile tools, registered from one ordered table
    steel/        typed REST layer over /v1, and a hand-written CDP client
    snapshot.ts   a11y tree joined with DOMSnapshot geometry; @eN refs
    page.ts       navigate, act, wait — everything that touches a live page
    settle.ts     frame-navigation watch + DOM quiescence + mutation counter
    untrusted.ts  invisible-character stripping, redaction, the provenance fence
    registry.ts   session handles, per-call re-authorisation, the reaper
    errors.ts     Steel failure -> prose a model can act on
  stdio.ts        the bin entrypoint
```

Tools depend on interfaces (`SteelApi`, `SessionPool`, `CdpSession`), never on a transport. That
is the seam every test double plugs into, and the seam the hosted HTTP entry (P2) will reuse.

## Running things

```bash
npm run typecheck          # tsc, strict
npm run lint               # biome
npm test                   # unit + integration
npm run budget             # tools/list byte budget per profile
npm run conformance        # MCP conformance suite (builds first)

docker compose -f tests/e2e/docker-compose.yml up -d
npm run test:e2e           # real steel-browser + the adversarial fixture site
docker compose -f tests/e2e/docker-compose.yml down
```

The E2E suite skips with a stated reason when the stack is not up. It never skips silently. The
browser is published on host port 3100, not 3000, because 3000 is a default other things grab.

## How we work here

- **TDD, red → green → refactor, no exceptions.** Write the failing test, watch it fail, make it
  pass. Unit *and* integration tests are mandatory; so is E2E for anything that touches a real
  page. If you think a layer doesn't apply, ask — don't decide.
- **Test output must be pristine.** A test that exercises an error path asserts on the error.
- Every file opens with two `ABOUTME: ` comment lines.
- Comments describe the code as it is, never the change that produced it. No `v2`, `new`,
  `improved` in any identifier.
- No mock modes or fake-data paths in shipped code. Test doubles live in `tests/helpers/` and are
  injected at the Steel REST and browser-pool boundaries.
- Never `--no-verify` or any other hook bypass. Fix the hook.

## Things that will bite you

- Steel's scrape parameter is **`format`** — singular name, array value. `links` is not a format;
  links and metadata come back on every response.
- `/v1/screenshot` and `/v1/pdf` return `{ url }`, not bytes.
- A CDP URL **must** carry `sessionId`. Omitting it makes Steel start a fresh billed session that
  nothing in this process knows about. `buildCdpUrl` refuses to build one without it.
- There is no `metadata` field on session create. Mint the UUID yourself and pass it as
  `sessionId`.
- Set `timeout` **and** `inactivityTimeout` on every create. The idle timeout is the layer that
  survives this process dying; everything else is an optimisation.
- Self-hosted Steel is concurrency 1, and has no proxies, profiles, regions or CAPTCHA solving.
  Each gap has its own named error in `errors.ts`.
- `serveStdio` lives at `@modelcontextprotocol/server/stdio`, not on the package root.
- Post-action snapshots are **off** by default. Turning one on by default is how this category
  ends up with a 14k-token tool response nobody asked for.
