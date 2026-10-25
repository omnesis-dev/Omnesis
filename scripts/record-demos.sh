#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# record-demos.sh — Automated demo screen recordings of replay-agent
# conversations on an iPhone (portrait) or iPad (landscape) simulator.
#
# Usage:
#   scripts/record-demos.sh [--ipad] [--light] [scenario ...]
#
# With no scenario args, records all default-universe scenarios. Pass
# scenario names (matching test method suffixes) to record a subset:
#
#   scripts/record-demos.sh find_maria birthday_gifts
#   scripts/record-demos.sh --ipad birthday_gifts swim_progress
#   scripts/record-demos.sh --light birthday_gifts        # light-mode phone
#   scripts/record-demos.sh --ipad --light swim_progress  # light-mode iPad
#
# Form variants (device + orientation):
#   (default)  iPhone 17 Pro, portrait → demos/<scenario>.mp4
#   --ipad     iPad Pro 13" (M5), landscape (exercises the agent
#              side-panel split) → demos/ipad/<scenario>.mp4
#
# Appearance variants (the app's forced colour scheme):
#   (default)  dark  → demos[/ipad]/<scenario>.mp4
#   --light    light → demos/light[/ipad]/<scenario>.mp4
#
# --light sets DEMO_APPEARANCE=light, forwarded to the demo app via the
# UITest so it forces the SwiftUI light colour scheme for the capture, and
# routes the masters + landing assets under a parallel light/ subtree. The
# landing page swaps to those assets when the visitor picks light mode.
#
# The UITest (`DemoRecorderTests`) rotates to landscape automatically on
# an iPad simulator, so the only thing the --ipad flag changes here is
# which simulator + output dir we target.
#
# Prerequisites:
#   - Demo gateway NOT already running (this script starts/stops it).
#   - Xcode 26+ with the matching simulator runtime installed.
#
# Output: demos[/ipad]/<scenario>.mp4 per scenario, then web-ready
# landing assets via demos-to-video.sh.

set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
source scripts/lib/boot_budget

# Parse the --ipad form flag and --light/--dark appearance flag out of the
# args; everything else is a scenario name.
VARIANT="phone"
APPEARANCE="dark"
POSITIONAL=()
while [ $# -gt 0 ]; do
    case "$1" in
        --ipad) VARIANT="ipad"; shift ;;
        --phone) VARIANT="phone"; shift ;;
        --light) APPEARANCE="light"; shift ;;
        --dark) APPEARANCE="dark"; shift ;;
        *) POSITIONAL+=("$1"); shift ;;
    esac
done
set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

# Masters live under demos/ for dark and demos/light/ for light, with the
# iPad capture in an ipad/ subdir of whichever appearance root applies.
if [ "$APPEARANCE" = "light" ]; then
    MASTER_ROOT="demos/light"
else
    MASTER_ROOT="demos"
fi
if [ "$VARIANT" = "ipad" ]; then
    SIMULATOR_NAME="iPad Pro 13-inch (M5)"
    OUTPUT_DIR="$MASTER_ROOT/ipad"
else
    SIMULATOR_NAME="iPhone 17 Pro"
    OUTPUT_DIR="$MASTER_ROOT"
fi

DEMO_CONFIG_DIR="${OMNESIS_CONFIG_DIR:-/tmp/omnesis-agent-demo}"
export OMNESIS_CONFIG_DIR="$DEMO_CONFIG_DIR"
GATEWAY_PORT="${OMNESIS_GATEWAY_PORT:-27600}"
PAIRING_FILE="/tmp/omnesis-demo-pairing.json"
SCHEME="OmnesisDemoUITests"
PROJECT="ios/Omnesis.xcodeproj"
# Resolve device ID to avoid ambiguity when multiple runtimes exist.
SIMULATOR_ID="${OMNESIS_DEMO_SIMULATOR_ID:-$(xcrun simctl list devices available | grep -F "$SIMULATOR_NAME (" | head -1 | grep -oE '[A-F0-9-]{36}')}"
DESTINATION="platform=iOS Simulator,id=$SIMULATOR_ID"

ALL_SCENARIOS=(
    find_maria
    birthday_gifts
    marathon_prep
    swim_progress
    vendor_eval
    url_lookup
    trip_spending
    sleep_recovery
    tenancy_deposit
    person_catchup
    citation_edge_cases
    mixed_decks
    all_sticky_tabs
)

# Use scenario arguments if provided, otherwise run all.
if [ $# -gt 0 ]; then
    SCENARIOS=("$@")
else
    SCENARIOS=("${ALL_SCENARIOS[@]}")
fi

echo "==> Variant: $VARIANT  ·  Appearance: $APPEARANCE  ·  Simulator: $SIMULATOR_NAME  ·  Output: $OUTPUT_DIR/"

cleanup() {
    echo "Cleaning up..."
    # Stop any lingering recording.
    [ -n "${RECORD_PID:-}" ] && kill -INT "$RECORD_PID" 2>/dev/null && wait "$RECORD_PID" 2>/dev/null || true
    # Stop demo gateway.
    bash scripts/start-demo-gateway.sh stop 2>/dev/null || true
}
trap cleanup EXIT

# ── Step 1: Boot simulator ────────────────────────────────────────
# Capture and drive only the selected simulator; other devices may belong
# to another developer. OMNESIS_DEMO_SIMULATOR_ID selects an owned device.
echo "==> Booting simulator: $SIMULATOR_NAME ($SIMULATOR_ID)"
xcrun simctl boot "$SIMULATOR_ID" 2>/dev/null || true
# Wait for the simulator to be fully ready.
xcrun simctl bootstatus "$SIMULATOR_ID" -b

# ── Step 2: Start demo gateway ────────────────────────────────────
echo "==> Starting demo gateway..."
bash scripts/start-demo-gateway.sh start

# Wait for gateway to be healthy (HTTPS with self-signed cert).
for i in $(seq 1 "$(gateway_boot_budget_seconds)"); do
    if curl -sfk "https://localhost:$GATEWAY_PORT/health" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
curl -sfk "https://localhost:$GATEWAY_PORT/health" >/dev/null || {
    echo "error: demo gateway did not become healthy" >&2
    exit 1
}
echo "==> Demo gateway healthy."

# ── Step 3: Create pairing file with TLS fingerprint ─────────────
TOKEN=$(cat "$DEMO_CONFIG_DIR/token")
# Compute the SHA-256 fingerprint of the gateway's self-signed cert
# so the iOS app's PinnedSession trusts it.
FINGERPRINT=$(openssl x509 -in "$DEMO_CONFIG_DIR/tls/cert.pem" -noout -fingerprint -sha256 \
    | sed 's/://g' | awk -F= '{print tolower($2)}')
cat > "$PAIRING_FILE" <<EOF
{"url":"https://localhost:$GATEWAY_PORT","token":"$TOKEN","fingerprint":"$FINGERPRINT","name":"Demo Gateway"}
EOF
echo "==> Pairing file written to $PAIRING_FILE (fingerprint: ${FINGERPRINT:0:16}…)"

# ── Step 4: Regenerate Xcode project + build ──────────────────────
echo "==> Generating Xcode project..."
cd ios && xcodegen generate && cd ..
DEMO_BUNDLE_ID="$(scripts/ios-resolved-bundle-id.sh OmnesisDemo)"

echo "==> Building OmnesisDemo + OmnesisDemoUITests..."
xcodebuild build-for-testing \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -destination "$DESTINATION" \
    -quiet 2>&1 | tail -5

# ── Step 5: Record each scenario ──────────────────────────────────
mkdir -p "$OUTPUT_DIR"

for scenario in "${SCENARIOS[@]}"; do
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Recording: $scenario"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    RAW_VIDEO="/tmp/demo-raw-${scenario}.mp4"
    VIDEO_PATH="$OUTPUT_DIR/${scenario}.mp4"
    rm -f "$RAW_VIDEO" "$VIDEO_PATH" \
        /tmp/demo-recording-done /tmp/demo-oriented /tmp/demo-recording-ready

    # Launch the UI test FIRST, then start recording only once the test
    # signals /tmp/demo-oriented (app launched and — on iPad — finished
    # rotating to landscape). simctl's recordVideo cannot survive a
    # mid-stream framebuffer resolution change, so it must not be running
    # while the device rotates. The auto-pilot waits for recording readiness
    # before its first action, preserving the complete opening question.
    TEST_ID="OmnesisDemoUITests/DemoRecorderTests/test_${scenario}"
    set +e
    # TEST_RUNNER_-prefixed env vars reach the on-simulator test runner
    # with the prefix stripped, so the UITest sees DEMO_APPEARANCE and
    # forwards it to the app's launch environment. (A plain shell env var
    # does NOT propagate into the simulator-side runner — this prefix is
    # the supported channel.)
    TEST_RUNNER_DEMO_APPEARANCE="$APPEARANCE" \
    xcodebuild test-without-building \
        -project "$PROJECT" \
        -scheme "$SCHEME" \
        -destination "$DESTINATION" \
        -only-testing:"$TEST_ID" \
        2>&1 | tail -20 &
    TEST_PID=$!

    # Wait for the app to be up + oriented (up to 90s) before recording.
    for _i in $(seq 1 180); do
        [ -f /tmp/demo-oriented ] && break
        sleep 0.5
    done
    if [ ! -f /tmp/demo-oriented ]; then
        wait "$TEST_PID" || true
        echo "error: $scenario did not become ready for recording" >&2
        exit 1
    fi
    sleep 1  # Let the post-rotation frame settle.

    # Start screen recording in the background, on the EXACT device the
    # test is driving (not "booted"). SIGINT stops it gracefully and
    # finalizes the file.
    RECORD_LOG=$(mktemp "${TMPDIR:-/tmp}/omnesis-demo-recorder.XXXXXX")
    xcrun simctl io "$SIMULATOR_ID" recordVideo --codec h264 "$RAW_VIDEO" >"$RECORD_LOG" 2>&1 &
    RECORD_PID=$!

    # Wait for simctl to acknowledge capture startup rather than adding a
    # fixed lead-in to every video. The auto-pilot holds the question for
    # another second after this handshake, preserving the opening frame.
    for _i in $(seq 1 100); do
        grep -q "Recording started" "$RECORD_LOG" && break
        kill -0 "$RECORD_PID" 2>/dev/null || break
        sleep 0.1
    done
    if ! grep -q "Recording started" "$RECORD_LOG"; then
        cat "$RECORD_LOG" >&2
        echo "error: recorder did not start for $scenario" >&2
        exit 1
    fi
    sleep 0.25
    # Release the auto-pilot: the recorder is now capturing.
    touch /tmp/demo-recording-ready

    # Poll for the done marker so we can stop the recording BEFORE the
    # test framework tears down the app (which shows the home screen).
    for _i in $(seq 1 1800); do
        if [ -f /tmp/demo-recording-done ]; then
            sleep 0.2  # Capture the settled final frame.
            break
        fi
        sleep 0.1
    done

    # Stop recording while the app is still in the foreground.
    kill -INT "$RECORD_PID" 2>/dev/null
    wait "$RECORD_PID" 2>/dev/null || true
    unset RECORD_PID
    cat "$RECORD_LOG"
    rm -f "$RECORD_LOG"

    # Now let the test finish.
    wait "$TEST_PID" 2>/dev/null
    TEST_EXIT=$?
    set -e

    if [ "$TEST_EXIT" -eq 0 ] && [ -f /tmp/demo-recording-done ] && [ -s "$RAW_VIDEO" ]; then
        # No front-trim. The recorder-ready handshake means recordVideo is
        # live before the auto-pilot acts, and recordVideo only starts
        # capturing after orientation, so the raw clip already opens on the
        # pre-filled prompt — there's no boot lead-in to cut. (A wall-clock
        # trim can't help anyway: simctl buffers frames and flushes on stop,
        # so wall time can't be mapped to video time.) Re-encode the whole
        # clip rather than stream-copy: simctl's capture can use a very long
        # GOP, and `-c copy` once left a single decodable frame on the iPad
        # landscape capture. CRF 12 is visually lossless; demos-to-video.sh
        # re-encodes this master to the web target afterwards.
        ffmpeg -y -i "$RAW_VIDEO" \
            -c:v libx264 -crf 12 -preset medium -pix_fmt yuv420p -an \
            "$VIDEO_PATH" 2>/dev/null
        rm -f "$RAW_VIDEO"
        echo "  ✓ $scenario → $VIDEO_PATH"
    else
        echo "  ✗ $scenario FAILED (exit $TEST_EXIT)"
        echo "error: incomplete recording; retaining raw video at $RAW_VIDEO" >&2
        exit 1
    fi

    # Reset app state between scenarios by uninstalling + reinstalling
    # on next test launch (XCUIApplication.launch() reinstalls).
    xcrun simctl terminate "$SIMULATOR_ID" "$DEMO_BUNDLE_ID" 2>/dev/null || true
    sleep 1
done

echo ""
echo "==> Done. Recordings in $OUTPUT_DIR/:"
ls -lh "$OUTPUT_DIR"/*.mp4 2>/dev/null || echo "(no recordings)"

# ── Step 6: Encode landing-page videos ───────────────────────────
echo ""
echo "==> Encoding landing-page videos..."
bash scripts/demos-to-video.sh --variant "$VARIANT" --appearance "$APPEARANCE" "${SCENARIOS[@]}"
