#!/usr/bin/env bash
# ABOUTME: Boots the localhost harness and checks both legacy MCP compatibility and the final
# ABOUTME: 2026-07-28 stateless protocol, failing the build if either wire era regresses.
set -euo pipefail

PORT="${PORT:-3399}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Scenarios that exercise capabilities this server declares. Tool-call fixture scenarios, prompts,
# resources and input-required cases rely on reference-server fixtures this server does not expose.
LEGACY_SCENARIOS=(
  tools-list
  dns-rebinding-protection
)

MODERN_SCENARIOS=(
  server-stateless
  tools-list
  caching
  http-header-validation
  dns-rebinding-protection
)

node "$ROOT/scripts/conformance-harness.mjs" &
HARNESS_PID=$!
trap 'kill "$HARNESS_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/mcp" -X POST \
      -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'; then
    break
  fi
  sleep 0.25
done

run_scenarios() {
  local version="$1"
  shift
  for scenario in "$@"; do
    npx conformance server \
      --url "http://127.0.0.1:${PORT}/mcp" \
      --spec-version "$version" \
      --expected-failures "$ROOT/conformance-baseline.yml" \
      --scenario "$scenario"
  done
}

run_scenarios 2025-11-25 "${LEGACY_SCENARIOS[@]}"
run_scenarios 2026-07-28 "${MODERN_SCENARIOS[@]}"

echo "Conformance: ${#LEGACY_SCENARIOS[@]} legacy and ${#MODERN_SCENARIOS[@]} modern scenarios passed."
