#!/usr/bin/env bash
# ABOUTME: Packs the MCPB bundle Claude Desktop installs, from a staging tree carrying only what the
# ABOUTME: stdio entrypoint actually imports, and proves the packed server answers tools/list.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$ROOT/build/mcpb"
OUT="$ROOT/build"
MCPB="npx --yes @anthropic-ai/mcpb@2.1.2"

echo "==> Building"
npm --prefix "$ROOT" run build

echo "==> Staging $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$ROOT/dist" "$STAGE/dist"
cp "$ROOT/manifest.json" "$ROOT/package.json" "$ROOT/LICENSE" "$ROOT/README.md" "$STAGE/"

# The icon the manifest names, and nothing else from assets/ — the demo recordings that live there
# are 75MB the bundle has no use for. Read from the manifest so the two cannot drift apart.
ICON="$(node -p "require('$ROOT/manifest.json').icon")"
mkdir -p "$STAGE/$(dirname "$ICON")"
cp "$ROOT/$ICON" "$STAGE/$ICON"

# Claude Desktop installs nothing, so every byte here ships to every user. Narrowing the staged
# package.json first means npm never resolves the hosted-only trees: ioredis and its six
# dependencies, @modelcontextprotocol/node and hono, and the OpenTelemetry exporter stack.
echo "==> Narrowing the staged package.json"
node "$ROOT/scripts/stage-mcpb-package.mjs" "$STAGE"

# `npm install` rather than `ci`: the staged package manifest is deliberately narrowed and therefore
# no longer matches the tracked root lockfile.
echo "==> Installing runtime dependencies"
npm --prefix "$STAGE" install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund

# Source maps help package consumers debug, but the Desktop bundle is a release artifact rather than
# a development install. Remove them after install so dependency maps cannot carry embedded source.
find "$STAGE" -type f -name '*.map' -delete

echo "==> Verifying the staged server starts and lists its tools"
# Verify from outside the repository tree. Otherwise Node can resolve a dependency omitted from the
# bundle through ROOT/node_modules and turn a broken Desktop install into a false-positive pass.
VERIFY_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/steel-mcp-verify.XXXXXX")"
trap 'rm -rf "$VERIFY_STAGE"' EXIT
cp -R "$STAGE/." "$VERIFY_STAGE/"
node "$ROOT/scripts/verify-mcpb-stage.mjs" "$VERIFY_STAGE"

echo "==> Validating the manifest"
$MCPB validate "$STAGE/manifest.json"

echo "==> Packing"
VERSION="$(node -p "require('$ROOT/package.json').version")"
BUNDLE="$OUT/steel-mcp-$VERSION.mcpb"
rm -f "$BUNDLE"
$MCPB pack "$STAGE" "$BUNDLE"

$MCPB info "$BUNDLE"
echo
echo "Bundle: $BUNDLE"
