#!/usr/bin/env bash
# ABOUTME: Boots the localhost conformance harness over the built core and runs the MCP conformance
# ABOUTME: scenarios that apply to a tools-only server, failing the build if any of them regress.
set -euo pipefail

PORT="${PORT:-3399}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Scenarios that exercise capabilities this server declares. The remaining scenarios in the suite
# call fixture tools, resources and prompts that only the SDK's reference server implements, and
# exercise logging, sampling and elicitation, which this server deliberately does not offer.
SCENARIOS=(
  server-initialize
  ping
  tools-list
  server-sse-multiple-streams
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

ARGS=()
for scenario in "${SCENARIOS[@]}"; do ARGS+=(--scenario "$scenario"); done

OUTPUT="$(npx conformance server --url "http://127.0.0.1:${PORT}/mcp" "${ARGS[@]}" 2>&1)"
echo "$OUTPUT"

if echo "$OUTPUT" | grep -qE '[1-9][0-9]* failed'; then
  echo "Conformance regressed." >&2
  exit 1
fi
echo "Conformance: all ${#SCENARIOS[@]} applicable scenarios passed."
