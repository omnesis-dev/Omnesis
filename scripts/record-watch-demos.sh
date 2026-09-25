#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# record-watch-demos.sh — Automated screen recordings of the Apple Watch
# "Ask Omnesis" flow, driven end to end by a real synthetic gateway.
#
# Usage:
#   scripts/record-watch-demos.sh [scenario ...]
#
# With no arguments, records all three scenarios of the `wrist` universe.
#
# What actually happens on screen is the real thing: the watch app relays
# the question to the paired iPhone over WatchConnectivity, the phone runs
# the shared SiriAskRunner against a synthetic gateway whose agent is the
# replay backend, and the wrist shows the live activity (tool labels,
# per-source icons, counters) before speaking the answer with the
# read-along highlight. Nothing on the wrist is mocked.
#
# The only thing standing in for reality is the trigger: Siri cannot be
# invoked in a simulator, so `DEMO_WATCH_ASK` hands the question straight
# to `WatchAskRouter` exactly as `AskOmnesisIntent` would.
#
# Two simulators are needed because the watch app holds no gateway pairing
# by design — the phone owns it. The watch simulator is created on demand;
# the phone simulator is an existing one (OMNESIS_WATCH_DEMO_PHONE).
#
# Prerequisites:
#   - Xcode with BOTH an iOS and a watchOS simulator runtime installed.
#   - No demo gateway already running on the chosen port.
#
# Output: demos/watch/<scenario>.mp4 masters, then web-ready assets via
# watch-demos-to-video.sh.

set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"

UNIVERSE="${OMNESIS_WATCH_DEMO_UNIVERSE:-wrist}"
WATCH_DEVICE_NAME="${OMNESIS_WATCH_DEMO_WATCH:-Omnesis Watch Demo}"
PHONE_DEVICE_NAME="${OMNESIS_WATCH_DEMO_PHONE:-iPhone 16e}"
# A dedicated port + state dir so a recording never collides with another
# demo gateway (or with the reel's, on 27600).
GATEWAY_PORT="${OMNESIS_GATEWAY_PORT:-27610}"
DEMO_CONFIG_DIR="${OMNESIS_CONFIG_DIR:-/tmp/omnesis-wrist-demo}"
PAIRING_FILE="/tmp/omnesis-watch-pairing.json"
OUTPUT_DIR="demos/watch"
BUILD_DIR="${OMNESIS_WATCH_DEMO_BUILD_DIR:-/tmp/omnesis-watch-demo-build}"
PROJECT="ios/Omnesis.xcodeproj"

ALL_SCENARIOS=(eurostar last_call wifi)

# The question each scenario asks. The trigger substrings live in the
# universe's agent-demos/*.meta.json; these are the utterances that match
# them, phrased the way someone would actually speak to a watch.
prompt_for() {
    case "$1" in
        eurostar)  echo "Remind me if I booked my Eurostar to Paris for the triathlon?" ;;
        last_call) echo "When did I last call my sister?" ;;
        wifi)      echo "Hey, what's the wifi password for the Airbnb?" ;;
        *) echo "Unknown scenario: $1" >&2; return 1 ;;
    esac
}

if [ $# -gt 0 ]; then
    SCENARIOS=("$@")
else
    SCENARIOS=("${ALL_SCENARIOS[@]}")
fi

echo "==> Universe: $UNIVERSE  ·  Watch: $WATCH_DEVICE_NAME  ·  Phone: $PHONE_DEVICE_NAME"

cleanup() {
    echo "Cleaning up..."
    [ -n "${RECORD_PID:-}" ] && kill -INT "$RECORD_PID" 2>/dev/null && wait "$RECORD_PID" 2>/dev/null || true
    OMNESIS_CONFIG_DIR="$DEMO_CONFIG_DIR" OMNESIS_GATEWAY_PORT="$GATEWAY_PORT" \
        bash scripts/start-demo-gateway.sh stop 2>/dev/null || true
}
trap cleanup EXIT

# ── Step 1: Resolve the two simulators and pair them ──────────────
# The watch device is created on demand: a watchOS simulator is not part
# of anyone's default set, and one purpose-built device keeps the
# recording reproducible without disturbing the user's own simulators.
PHONE_ID=$(xcrun simctl list devices available \
    | grep -F "$PHONE_DEVICE_NAME (" | head -1 | grep -oE '[A-F0-9-]{36}' || true)
if [ -z "$PHONE_ID" ]; then
    echo "error: no available simulator named '$PHONE_DEVICE_NAME'." >&2
    echo "       Set OMNESIS_WATCH_DEMO_PHONE to one from 'xcrun simctl list devices available'." >&2
    exit 1
fi

WATCH_ID=$(xcrun simctl list devices available \
    | grep -F "$WATCH_DEVICE_NAME (" | head -1 | grep -oE '[A-F0-9-]{36}' || true)
if [ -z "$WATCH_ID" ]; then
    WATCH_RUNTIME=$(xcrun simctl list runtimes | grep -oE 'com\.apple\.CoreSimulator\.SimRuntime\.watchOS-[0-9-]+' | tail -1)
    if [ -z "$WATCH_RUNTIME" ]; then
        echo "error: no watchOS simulator runtime installed." >&2
        echo "       Install one with: xcodebuild -downloadPlatform watchOS" >&2
        exit 1
    fi
    WATCH_TYPE=$(xcrun simctl list devicetypes \
        | grep -oE 'com\.apple\.CoreSimulator\.SimDeviceType\.Apple-Watch-Series-[0-9]+-46mm' | tail -1)
    : "${WATCH_TYPE:=com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-10-46mm}"
    echo "==> Creating watch simulator '$WATCH_DEVICE_NAME'"
    WATCH_ID=$(xcrun simctl create "$WATCH_DEVICE_NAME" "$WATCH_TYPE" "$WATCH_RUNTIME")
fi

# Pairing is what makes WatchConnectivity work between the two
# simulators. It also wipes third-party apps off the watch, so it must
# happen before any install — and both devices must be shut down for it.
if ! xcrun simctl list pairs | grep -A2 -F "$WATCH_ID" | grep -qF "$PHONE_ID"; then
    echo "==> Pairing watch to phone"
    xcrun simctl shutdown "$WATCH_ID" 2>/dev/null || true
    xcrun simctl shutdown "$PHONE_ID" 2>/dev/null || true
    xcrun simctl pair "$WATCH_ID" "$PHONE_ID" >/dev/null
fi

echo "==> Booting simulators"
xcrun simctl boot "$PHONE_ID" 2>/dev/null || true
xcrun simctl boot "$WATCH_ID" 2>/dev/null || true
xcrun simctl bootstatus "$PHONE_ID" -b >/dev/null
xcrun simctl bootstatus "$WATCH_ID" -b >/dev/null

# ── Step 2: Start the demo gateway on the universe ────────────────
echo "==> Starting demo gateway (universe=$UNIVERSE, port=$GATEWAY_PORT)"
OMNESIS_CONFIG_DIR="$DEMO_CONFIG_DIR" OMNESIS_GATEWAY_PORT="$GATEWAY_PORT" \
    bash scripts/start-demo-gateway.sh start --universe "$UNIVERSE"

for _i in $(seq 1 30); do
    curl -sfk "https://localhost:$GATEWAY_PORT/health" >/dev/null 2>&1 && break
    sleep 1
done
echo "==> Gateway healthy."

# ── Step 3: Pairing file with the TLS fingerprint ─────────────────
TOKEN=$(cat "$DEMO_CONFIG_DIR/token")
FINGERPRINT=$(openssl x509 -in "$DEMO_CONFIG_DIR/tls/cert.pem" -noout -fingerprint -sha256 \
    | sed 's/://g' | awk -F= '{print tolower($2)}')
cat > "$PAIRING_FILE" <<EOF
{"url":"https://localhost:$GATEWAY_PORT","token":"$TOKEN","fingerprint":"$FINGERPRINT","name":"Demo Gateway"}
EOF
echo "==> Pairing file written (fingerprint: ${FINGERPRINT:0:16}…)"

# ── Step 3b: Warm the gateway's source-icon cache ─────────────────
# The gateway rasterises each provider's icon on demand, and the phone
# resolves the whole set exactly once per launch — so a source whose icon
# is still being fetched when the first scenario runs shows a generic
# document glyph on the wrist for that entire clip, while later scenarios
# come out right. Poll until every source the universe declares has a
# data-URI icon, so the first recording looks like the rest.
echo "==> Warming source icons"
SOURCE_TYPES=$(python3 -c "
import json,sys
m=json.load(open('evals/universes/$UNIVERSE/universe.json'))
print(' '.join(s['descriptorId'] for s in m['sources']))
")
for _i in $(seq 1 40); do
    if curl -sk "https://localhost:$GATEWAY_PORT/portal/source-meta.json" 2>/dev/null | python3 -c "
import json,sys
meta=json.load(sys.stdin)
want='''$SOURCE_TYPES'''.split()
missing=[t for t in want
         if not str((meta.get(t) or {}).get('icon') or '').startswith('data:')]
sys.exit(1 if missing else 0)
" 2>/dev/null; then
        echo "==> Source icons ready."
        break
    fi
    sleep 1
done

# ── Step 4: Build both apps ───────────────────────────────────────
# The watch app is embedded in the production `Omnesis` target (not
# `OmnesisDemo`), and its Info.plist names the production app as the
# companion — so WatchConnectivity only pairs with that bundle id. The
# `-pairingFile` launch argument is `#if DEBUG`-gated rather than
# target-gated, so the production target still points at the demo gateway
# for the recording. Code signing must stay ON: the simulator applies the
# app's entitlements through ad-hoc signing, and skipping it silently
# breaks the pairing write.
echo "==> Generating Xcode project"
(cd ios && xcodegen generate >/dev/null)

echo "==> Building Omnesis (iPhone + embedded watch app)"
xcodebuild build \
    -project "$PROJECT" \
    -scheme Omnesis \
    -destination "platform=iOS Simulator,id=$PHONE_ID" \
    -configuration Debug \
    -derivedDataPath "$BUILD_DIR" \
    -quiet 2>&1 | tail -5

PHONE_APP="$BUILD_DIR/Build/Products/Debug-iphonesimulator/Omnesis.app"
WATCH_APP="$BUILD_DIR/Build/Products/Debug-watchsimulator/OmnesisWatch.app"
[ -d "$PHONE_APP" ] || { echo "error: phone app not built at $PHONE_APP" >&2; exit 1; }
[ -d "$WATCH_APP" ] || { echo "error: watch app not built at $WATCH_APP" >&2; exit 1; }
PHONE_BUNDLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PHONE_APP/Info.plist")"
WATCH_BUNDLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$WATCH_APP/Info.plist")"

# ── Step 5: Prime the WatchConnectivity link ──────────────────────
# The phone only forwards progress snapshots while `WCSession.isReachable`
# is true, and that takes a while to settle the first time the two freshly
# booted simulators establish their link. Without this pass the first
# scenario of a run records a wrist stuck on the fallback label with no
# source icons, while every later one is fine. Installing and running both
# apps once, with no question asked, gets that settling out of the way
# before anything is being captured.
echo "==> Priming the watch link"
xcrun simctl install "$PHONE_ID" "$PHONE_APP"
xcrun simctl install "$WATCH_ID" "$WATCH_APP"
xcrun simctl launch "$PHONE_ID" "$PHONE_BUNDLE" -pairingFile "$PAIRING_FILE" >/dev/null
xcrun simctl launch "$WATCH_ID" "$WATCH_BUNDLE" >/dev/null
sleep 12
xcrun simctl terminate "$WATCH_ID" "$WATCH_BUNDLE" 2>/dev/null || true

# ── Step 6: Record each scenario ──────────────────────────────────
mkdir -p "$OUTPUT_DIR"

for scenario in "${SCENARIOS[@]}"; do
    PROMPT=$(prompt_for "$scenario")
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Recording: $scenario"
    echo "  Prompt:    $PROMPT"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    RAW_VIDEO="/tmp/omnesis-watch-raw-${scenario}.mp4"
    VIDEO_PATH="$OUTPUT_DIR/${scenario}.mp4"
    rm -f "$RAW_VIDEO" "$VIDEO_PATH" /tmp/demo-recording-ready /tmp/demo-recording-done

    # A fresh phone container per scenario. The replay backend locks one
    # cassette per conversation and errors `fixture_exhausted` on a second
    # turn, while the phone's ask continuity resumes the previous
    # conversation for five minutes — so back-to-back scenarios would all
    # replay as failures. Reinstalling is the reliable reset: deleting the
    # preferences plist does not work, because cfprefsd keeps it cached
    # and writes it back. Uninstalling the phone app also removes its
    # companion watch app, so both are reinstalled together.
    xcrun simctl terminate "$PHONE_ID" "$PHONE_BUNDLE" 2>/dev/null || true
    xcrun simctl terminate "$WATCH_ID" "$WATCH_BUNDLE" 2>/dev/null || true
    xcrun simctl uninstall "$PHONE_ID" "$PHONE_BUNDLE" 2>/dev/null || true
    xcrun simctl install "$PHONE_ID" "$PHONE_APP"
    # Removing the phone app kicks off an asynchronous uninstall of its
    # companion watch app, which races a reinstall pushed too soon
    # ("Client appconduitd requested uninstall"). Retry until the watch
    # side has settled.
    for _try in $(seq 1 12); do
        sleep 2
        if xcrun simctl install "$WATCH_ID" "$WATCH_APP" 2>/dev/null; then
            WATCH_INSTALLED=1
            break
        fi
    done
    [ -n "${WATCH_INSTALLED:-}" ] || { echo "error: watch app never installed for $scenario" >&2; exit 1; }
    WATCH_INSTALLED=""

    xcrun simctl launch "$PHONE_ID" "$PHONE_BUNDLE" -pairingFile "$PAIRING_FILE" >/dev/null
    # Let the phone finish pairing and activate its WatchConnectivity
    # session before the watch tries to reach it.
    sleep 7

    # Launch the watch app first: it parks on the idle hint until the
    # ready marker appears, so recording can start on a settled screen and
    # the clip opens on "Ask Omnesis" rather than mid-launch.
    DEMO_ENV=(SIMCTL_CHILD_DEMO_WATCH_ASK="$PROMPT")
    [ -n "${DEMO_WATCH_LEAD_IN:-}" ] && DEMO_ENV+=(SIMCTL_CHILD_DEMO_WATCH_LEAD_IN="$DEMO_WATCH_LEAD_IN")
    [ -n "${DEMO_WATCH_TAIL_HOLD:-}" ] && DEMO_ENV+=(SIMCTL_CHILD_DEMO_WATCH_TAIL_HOLD="$DEMO_WATCH_TAIL_HOLD")
    env "${DEMO_ENV[@]}" xcrun simctl launch "$WATCH_ID" "$WATCH_BUNDLE" >/dev/null
    sleep 3

    echo "==> Recording…"
    xcrun simctl io "$WATCH_ID" recordVideo --codec h264 --force "$RAW_VIDEO" &
    RECORD_PID=$!
    # recordVideo needs a beat to actually start capturing frames. Every
    # second here is dead footage on the idle hint, so keep it just long
    # enough to be safe.
    sleep 2.5
    touch /tmp/demo-recording-ready

    # The watch app writes the done marker once the answer has been read
    # out and held. Bounded well above the relay's own 70s ceiling.
    for _i in $(seq 1 240); do
        [ -f /tmp/demo-recording-done ] && break
        sleep 0.5
    done
    if [ ! -f /tmp/demo-recording-done ]; then
        echo "warning: $scenario never signalled done — recording what we have" >&2
    fi

    kill -INT "$RECORD_PID" 2>/dev/null || true
    wait "$RECORD_PID" 2>/dev/null || true
    RECORD_PID=""

    [ -s "$RAW_VIDEO" ] || { echo "error: no video captured for $scenario" >&2; exit 1; }

    # Re-encode rather than copy: simctl writes very long GOPs, which make
    # the clip unseekable and awkward to trim downstream.
    ffmpeg -y -loglevel error -i "$RAW_VIDEO" \
        -c:v libx264 -crf 12 -preset medium -pix_fmt yuv420p -an "$VIDEO_PATH"
    rm -f "$RAW_VIDEO"
    echo "==> Wrote $VIDEO_PATH ($(du -h "$VIDEO_PATH" | cut -f1))"
done

echo ""
echo "==> Encoding web assets"
bash scripts/watch-demos-to-video.sh "${SCENARIOS[@]}"

echo ""
echo "✓ Done. Masters in $OUTPUT_DIR/, web assets in $OUTPUT_DIR/web/"
