#!/usr/bin/env bash
# ABOUTME: Builds the release image and proves both its stdio and hosted entrypoints actually run.
# ABOUTME: CI and release share this script so the candidate cannot skip an image runtime gate.
set -euo pipefail

IMAGE="${1:-steel-mcp:smoke}"
CONTAINER="steel-mcp-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"
PORT="${STEEL_MCP_SMOKE_PORT:-18080}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker build -t "$IMAGE" .

printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"container-smoke","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | docker run -i --rm -e STEEL_API_KEY=smoke-not-a-real-key "$IMAGE" 2>/dev/null \
  | grep -q '"steel_scrape"'
echo 'stdio entrypoint lists its tools'

docker run -d --rm --name "$CONTAINER" -p "$PORT:8080" \
  -e STEEL_ALLOWED_HOSTS=localhost \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318 \
  "$IMAGE" dist/hosted.js >/dev/null
for _ in $(seq 1 30); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://localhost:$PORT/healthz" >/dev/null
echo 'hosted entrypoint answers /healthz'
docker logs "$CONTAINER" 2>&1 | grep -q 'Tracing was requested but could not start'
echo 'a missing exporter stack is a warning, not a crash'
