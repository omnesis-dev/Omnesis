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
#   scripts/run-ios-e2e.sh                    # prepare an available iPhone
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

# Preserve setup-node's selected binary (and caller tool shims).
if ! command -v node >/dev/null 2>&1; then
  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
fi
export OMNESIS_CONFIG_DIR="${OMNESIS_CONFIG_DIR:-/tmp/omnesis-ios-e2e}"
export OMNESIS_GATEWAY_PORT="${OMNESIS_GATEWAY_PORT:-17601}"
export OMNESIS_SYNTH_UNIVERSE="${OMNESIS_SYNTH_UNIVERSE:-e2e-minimal}"

# Resolve before starting the gateway: runtime download/boot can take minutes.
# CI may supply a destination it has already prepared on this runner.
if [[ -n "${OMNESIS_E2E_DEST:-}" ]]; then
  DEST="$OMNESIS_E2E_DEST"
else
  UDID="$(node "$ROOT/scripts/ci/prepare-ios-simulator.mjs")"
  DEST="platform=iOS Simulator,id=$UDID"
fi

# Make sure the Xcode project is current (project.yml might have changed
# since the last xcodegen run).
cd "$ROOT/ios"
xcodegen generate >/dev/null
export OMNESIS_IOS_PACKAGES_DIR="${OMNESIS_IOS_PACKAGES_DIR:-$ROOT/ios/build/packages}"
"$ROOT/scripts/ci/resolve-ios-packages.sh" Omnesis
PACKAGE_FLAGS=(-clonedSourcePackagesDirPath "$OMNESIS_IOS_PACKAGES_DIR" -disableAutomaticPackageResolution)

# CoreSimulator boot readiness does not guarantee Xcode has discovered the
# device. Wait for the actual scheme's eligible destination before booting data.
node "$ROOT/scripts/ci/wait-ios-destination.mjs" "$DEST" "${PACKAGE_FLAGS[@]}"

URL="https://localhost:${OMNESIS_GATEWAY_PORT}"

# Wipe previous state so each run is deterministic.
if [[ -d "$OMNESIS_CONFIG_DIR" ]]; then
  "$ROOT/scripts/synth-gateway.sh" stop >/dev/null 2>&1 || true
  rm -rf "$OMNESIS_CONFIG_DIR"
fi

cleanup() {
  echo "→ Stopping synth gateway…"
  "$ROOT/scripts/synth-gateway.sh" stop >/dev/null 2>&1 || true
}
# Startup can fail after spawning either process; always tear both down.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "→ Booting synth gateway on $URL (universe=$OMNESIS_SYNTH_UNIVERSE)…"
# start verifies the token, CA and HTTP 200 readiness, then seeds sources so
# the Swift search clients have real gateway data to decode.
if ! "$ROOT/scripts/synth-gateway.sh" start >/dev/null; then
  tail -50 "$OMNESIS_CONFIG_DIR/logs/gateway.stdout.log" >&2 2>/dev/null || true
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
trap 'cleanup; rm -f "$CONFIG_FILE"; rm -rf "$RESULT_DIR"' EXIT

xcodebuild test \
  -project Omnesis.xcodeproj \
  -scheme Omnesis \
  -destination "$DEST" \
  "${PACKAGE_FLAGS[@]}" \
  -resultBundlePath "$RESULT_DIR/live.xcresult" \
  -only-testing:OmnesisTests/GatewayLiveE2ETests \
  -only-testing:OmnesisTests/RealtimeAudioCaptureDeviceTests

# Gateway coverage must never silently skip. Hardware probes must pass when
# their explicit local fixture is enabled, and otherwise remain skipped.
xcrun xcresulttool get test-results tests --path "$RESULT_DIR/live.xcresult" \
  >"$RESULT_DIR/tests.json"
node "$ROOT/scripts/ci/verify-ios-e2e-results.mjs" \
  "$RESULT_DIR/tests.json" \
  Tests/OmnesisTests/GatewayLiveE2ETests.swift \
  Tests/OmnesisTests/RealtimeAudioCaptureDeviceTests.swift \
  /tmp/omnesis-ios-audio-capture-test.json
echo "✓ iOS live-gateway E2E complete."
