#!/usr/bin/env bash
# ABOUTME: Owns the real-browser E2E stack lifecycle and waits for every service to become ready.
# ABOUTME: Always tears the stack down, including when Vitest fails or the runner is interrupted.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/tests/e2e/docker-compose.yml")

cleanup() {
  "${COMPOSE[@]}" down
}
trap cleanup EXIT INT TERM

"${COMPOSE[@]}" up -d --wait
npm --prefix "$ROOT" run test:e2e:direct
