#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# record-screenshots.sh — Automated still screenshots of the demo app for
# the landing page's "Manage from anywhere" showcase.
#
# Captures the Sources tab of the OmnesisDemo app, paired to the synthetic
# demo gateway (synthetic "John Smith" corpus — no personal data), in both
# dark and light appearance. The companion screenshots-to-image.sh scales
# them into the landing assets the page frames with a CSS device bezel.
#
# Usage:
#   scripts/record-screenshots.sh                 # both appearances
#   scripts/record-screenshots.sh --dark          # dark only
#   scripts/record-screenshots.sh --light         # light only
#
# This mirrors record-demos.sh's boot/gateway/build dance, but instead of
# screen-recording a replay-agent conversation it launches the app on a
# single static screen (via DEMO_INITIAL_TAB=sources) and the UITest grabs
# one frame with XCUIScreen. No simctl video timing dance is needed.
#
# Prerequisites:
#   - Demo gateway NOT already running (this script starts/stops it).
#   - Xcode 26+ with the matching simulator runtime installed.

set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"

# Which appearances to capture (default: both).
APPEARANCES=()
while [ $# -gt 0 ]; do
    case "$1" in
        --dark) APPEARANCES+=("dark"); shift ;;
        --light) APPEARANCES+=("light"); shift ;;
        *) echo "Unknown arg: $1 (expected --dark or --light)" >&2; exit 1 ;;
    esac
done
if [ ${#APPEARANCES[@]} -eq 0 ]; then
    APPEARANCES=(dark light)
fi

SIMULATOR_NAME="iPhone 17 Pro"
DEMO_CONFIG_DIR="/tmp/omnesis-agent-demo"
GATEWAY_PORT="${OMNESIS_GATEWAY_PORT:-27600}"
PAIRING_FILE="/tmp/omnesis-demo-pairing.json"
SCHEME="OmnesisDemoUITests"
PROJECT="ios/Omnesis.xcodeproj"
# Resolve device ID to avoid ambiguity when multiple runtimes exist.
SIMULATOR_ID=$(xcrun simctl list devices available | grep "$SIMULATOR_NAME" | head -1 | grep -oE '[A-F0-9-]{36}')
DESTINATION="platform=iOS Simulator,id=$SIMULATOR_ID"

echo "==> Appearances: ${APPEARANCES[*]}  ·  Simulator: $SIMULATOR_NAME"

cleanup() {
    echo "Cleaning up..."
    xcrun simctl status_bar "$SIMULATOR_ID" clear 2>/dev/null || true
    bash scripts/start-demo-gateway.sh stop 2>/dev/null || true
}
trap cleanup EXIT

# ── Step 1: Boot simulator ────────────────────────────────────────
# Target the resolved device ID everywhere. Shut any OTHER booted twin
# that shares this exact name (a duplicate runtime) so "booted" is
# unambiguous; unrelated simulators are left alone.
echo "==> Booting simulator: $SIMULATOR_NAME ($SIMULATOR_ID)"
xcrun simctl list devices available | grep "$SIMULATOR_NAME" \
    | grep -oE '[A-F0-9-]{36}' \
    | grep -v "$SIMULATOR_ID" \
    | while read -r twin; do xcrun simctl shutdown "$twin" 2>/dev/null || true; done || true
xcrun simctl boot "$SIMULATOR_ID" 2>/dev/null || true
xcrun simctl bootstatus "$SIMULATOR_ID" -b

# ── Step 2: Start demo gateway ────────────────────────────────────
echo "==> Starting demo gateway..."
bash scripts/start-demo-gateway.sh start

for _i in $(seq 1 30); do
    if curl -sfk "https://localhost:$GATEWAY_PORT/health" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
echo "==> Demo gateway healthy."

# ── Step 3: Create pairing file with TLS fingerprint ─────────────
TOKEN=$(cat "$DEMO_CONFIG_DIR/token")
FINGERPRINT=$(openssl x509 -in "$DEMO_CONFIG_DIR/tls/cert.pem" -noout -fingerprint -sha256 \
    | sed 's/://g' | awk -F= '{print tolower($2)}')
cat > "$PAIRING_FILE" <<EOF
{"url":"https://localhost:$GATEWAY_PORT","token":"$TOKEN","fingerprint":"$FINGERPRINT","name":"Demo Gateway"}
EOF
echo "==> Pairing file written (fingerprint: ${FINGERPRINT:0:16}…)"

# ── Step 4: Wait for the synthetic corpus to finish indexing ──────
# The screenshot should show every source "SYNCED · 100% indexed", so we
# wait until the indexer has caught up with the gateway document count
# before launching the capture. /index/stats reports both totals.
echo "==> Waiting for indexing to complete..."
for _i in $(seq 1 120); do
    STATS=$(curl -sfk "https://localhost:$GATEWAY_PORT/index/stats" \
        -H "Authorization: Bearer $TOKEN" 2>/dev/null || echo '{}')
    READY=$(printf '%s' "$STATS" | node -e '
        let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
            try {
                const j = JSON.parse(s);
                const g = j.totalGatewayDocs ?? 0, i = j.totalIndexed ?? 0;
                process.stdout.write(g > 0 && i >= g ? "1" : "0");
            } catch { process.stdout.write("0"); }
        });
    ')
    if [ "$READY" = "1" ]; then
        echo "==> Indexing complete."
        break
    fi
    sleep 2
done

# ── Step 5: Regenerate Xcode project + build ──────────────────────
echo "==> Generating Xcode project..."
cd ios && xcodegen generate && cd ..
DEMO_BUNDLE_ID="$(scripts/ios-resolved-bundle-id.sh OmnesisDemo)"

echo "==> Building OmnesisDemo + OmnesisDemoUITests..."
xcodebuild build-for-testing \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -destination "$DESTINATION" \
    -quiet 2>&1 | tail -5

# ── Step 6: Capture each appearance ───────────────────────────────
# A clean marketing status bar (9:41, full signal/battery) so the frame
# doesn't carry the simulator's wall clock. Applies to the booted device
# for the whole run; cleared on exit.
xcrun simctl status_bar "$SIMULATOR_ID" override \
    --time "9:41" \
    --dataNetwork "wifi" --wifiMode "active" --wifiBars 3 \
    --cellularMode "active" --cellularBars 4 \
    --batteryState "charged" --batteryLevel 100 2>/dev/null || true

for appearance in "${APPEARANCES[@]}"; do
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Capturing: $appearance"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    RAW_OUT="/tmp/omnesis-screenshot-${appearance}.png"
    rm -f "$RAW_OUT"

    # TEST_RUNNER_-prefixed env vars reach the on-simulator runner with the
    # prefix stripped, so the UITest sees DEMO_APPEARANCE. The test writes
    # the PNG to $RAW_OUT itself (XCUIScreen capture).
    set +e
    TEST_RUNNER_DEMO_APPEARANCE="$appearance" \
    xcodebuild test-without-building \
        -project "$PROJECT" \
        -scheme "$SCHEME" \
        -destination "$DESTINATION" \
        -only-testing:"OmnesisDemoUITests/ScreenshotTests/test_sources_screenshot" \
        2>&1 | tail -20
    TEST_EXIT=${PIPESTATUS[0]}
    set -e

    if [ "$TEST_EXIT" -eq 0 ] && [ -f "$RAW_OUT" ]; then
        echo "  ✓ $appearance → $RAW_OUT"
    else
        echo "  ✗ $appearance FAILED (exit $TEST_EXIT, raw present: $([ -f "$RAW_OUT" ] && echo yes || echo no))"
        exit 1
    fi

    # Reset app state between appearances (relaunch reinstalls).
    xcrun simctl terminate "$SIMULATOR_ID" "$DEMO_BUNDLE_ID" 2>/dev/null || true
    sleep 1
done

# ── Step 7: Scale into landing assets ─────────────────────────────
echo ""
echo "==> Encoding landing screenshots..."
bash scripts/screenshots-to-image.sh "${APPEARANCES[@]}"
