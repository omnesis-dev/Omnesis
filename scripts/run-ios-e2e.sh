#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Boot a synth gateway against the e2e-minimal universe and run the iOS
# live-gateway E2E test class against it. Tears the gateway down on exit.
#
# Why this exists: the iOS XCTest target ships unit tests that mock the
# HTTP layer (`SearchClientTests`, `GatewayClientTests`, etc.), which
# catch wire-shape bugs at decode time but miss the class of regression
# where the GATEWAY's actual response shape drifts. This wrapper runs
# `GatewayLiveE2ETests` — the same Swift transport code, against a real
# gateway process — so a renamed field or moved route fails CI
# explicitly.
#
# Usage:
#   scripts/run-ios-e2e.sh                    # default destination
#   OMNESIS_E2E_DEST='platform=iOS Simulator,name=iPhone 17' scripts/run-ios-e2e.sh
#
# Layout:
#   - port 17601 (avoids prod 7600, demo 27600)
#   - config dir /tmp/omnesis-ios-e2e (wiped on each run)
#   - universe e2e-minimal (slim, deterministic, fast boot)
#
# The shell script does NOT register iOS as a paired device — the tests
# use the bootstrap admin token directly, bypassing the pairing flow.
# Pairing-flow E2E coverage is a follow-up; this wrapper is intentionally
# scoped to "the Swift transport classes decode real gateway responses."

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
export OMNESIS_CONFIG_DIR="${OMNESIS_CONFIG_DIR:-/tmp/omnesis-ios-e2e}"
export OMNESIS_GATEWAY_PORT="${OMNESIS_GATEWAY_PORT:-17601}"
export OMNESIS_SYNTH_UNIVERSE="${OMNESIS_SYNTH_UNIVERSE:-e2e-minimal}"

DEST="${OMNESIS_E2E_DEST:-platform=iOS Simulator,name=iPhone 17}"

URL="https://localhost:${OMNESIS_GATEWAY_PORT}"

# Wipe previous state so each run is deterministic.
if [[ -d "$OMNESIS_CONFIG_DIR" ]]; then
  "$ROOT/scripts/synth-gateway.sh" stop >/dev/null 2>&1 || true
  rm -rf "$OMNESIS_CONFIG_DIR"
fi

echo "→ Booting synth gateway on $URL (universe=$OMNESIS_SYNTH_UNIVERSE)…"
# Seed via /admin/sources/add so docs + people land in the gateway DB
# before the iOS tests run. Without seeding, /people/search returns
# empty and the SearchClient tests have nothing to decode against.
"$ROOT/scripts/synth-gateway.sh" start >/dev/null

cleanup() {
  echo "→ Stopping synth gateway…"
  "$ROOT/scripts/synth-gateway.sh" stop >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Wait for /health to succeed before launching xcodebuild.
for _ in $(seq 1 30); do
  if curl -sk "${URL}/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -sk "${URL}/health" >/dev/null 2>&1; then
  echo "Gateway did not come up on $URL after 30s" >&2
  tail -50 "$OMNESIS_CONFIG_DIR/logs/gateway.stdout.log" 2>/dev/null || true
  exit 1
fi

TOKEN="$(cat "$OMNESIS_CONFIG_DIR/token")"
if [[ -z "$TOKEN" ]]; then
  echo "No admin token at $OMNESIS_CONFIG_DIR/token" >&2
  exit 1
fi
echo "→ Gateway up. Token captured."

# Poll until Jane Doe resolves in the people graph. `synth-gateway.sh
# seed_sources` returns when /admin/sources/add POSTs land, but
# `resolveDocumentPeople` runs as a background writer-handler — the
# iOS tests assume the graph is stable, so block until it is.
echo "→ Waiting for people graph to settle (looking for Jane Doe)…"
for _ in $(seq 1 60); do
  count=$(curl -sk -H "Authorization: Bearer $TOKEN" \
    "${URL}/people/search?q=Jane%20Doe&limit=1" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('items',[])))" 2>/dev/null || echo "0")
  if [[ "$count" -ge 1 ]]; then
    echo "  people graph ready."
    break
  fi
  sleep 1
done
if [[ "$count" -lt 1 ]]; then
  echo "Jane Doe never appeared in /people/search after 60s." >&2
  tail -30 "$OMNESIS_CONFIG_DIR/logs/collector.log" 2>/dev/null || true
  exit 1
fi

# Make sure the Xcode project is current (project.yml might have changed
# since the last xcodegen run).
cd "$ROOT/ios"
xcodegen generate >/dev/null
export OMNESIS_IOS_PACKAGES_DIR="${OMNESIS_IOS_PACKAGES_DIR:-$ROOT/ios/build/packages}"
"$ROOT/scripts/ci/resolve-ios-packages.sh" Omnesis
PACKAGE_FLAGS=(-clonedSourcePackagesDirPath "$OMNESIS_IOS_PACKAGES_DIR" -disableAutomaticPackageResolution)

echo "→ Running OmnesisTests/GatewayLiveE2ETests against the gateway…"
# Hand the URL + token to the simulator's test process via a file at a
# host-readable path. xcodebuild doesn't propagate env vars into the
# simulator-side test runner, but the simulator inherits the macOS user's
# filesystem access and CAN read `/tmp/*` paths. The test class
# (GatewayLiveE2ETests.setUpWithError) reads this file and throws
# XCTSkip if it's missing — so running xcodebuild test directly without
# this wrapper script skips the suite cleanly.
CONFIG_FILE=/tmp/omnesis-ios-e2e-config.json
# The config carries the gateway admin token; create it owner-only from the
# start (umask in a subshell, no world-readable window) and remove it on exit.
(umask 077; python3 -c "
import json, sys
json.dump({'gatewayURL': '$URL', 'apiToken': '$TOKEN'}, sys.stdout)
" > "$CONFIG_FILE")
RESULT_DIR="$(mktemp -d)"
trap 'cleanup; rm -f "'"$CONFIG_FILE"'"; rm -rf "'"$RESULT_DIR"'"' EXIT INT TERM

xcodebuild test \
  -project Omnesis.xcodeproj \
  -scheme Omnesis \
  -destination "$DEST" \
  "${PACKAGE_FLAGS[@]}" \
  -resultBundlePath "$RESULT_DIR/live.xcresult" \
  -only-testing:OmnesisTests/GatewayLiveE2ETests

# A missing config file makes every test throw XCTSkip, which xcodebuild
# reports as TEST SUCCEEDED. The lane passes only when every test in the class
# ran against the gateway.
xcrun xcresulttool get test-results summary --path "$RESULT_DIR/live.xcresult" \
  >"$RESULT_DIR/summary.json"
python3 - "$RESULT_DIR/summary.json" Tests/OmnesisTests/GatewayLiveE2ETests.swift <<'PY'
import json, re, sys
summary_path, source = sys.argv[1:3]
expected = len(re.findall(r"^\s*func test\w*\(", open(source).read(), re.M))
summary = json.load(open(summary_path))
total, passed = summary["totalTestCount"], summary["passedTests"]
skipped, failed = summary["skippedTests"], summary["failedTests"]
print(f"GatewayLiveE2ETests: {total} run, {passed} passed, {skipped} skipped, {failed} failed; the class declares {expected}")
if expected == 0 or total != expected or passed != expected:
    sys.exit("✗ iOS live-gateway E2E did not run every test against the gateway.")
PY
echo "✓ iOS live-gateway E2E complete."
