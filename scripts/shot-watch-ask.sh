#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# shot-watch-ask.sh — Screenshot every state of the watch "Ask Omnesis"
# screen, on the smallest and largest watch, for review.
#
# Usage:
#   scripts/shot-watch-ask.sh [--states a,b,c] [--sizes small,large] [--keep]
#
# The iPhone app has PreviewSnapshotTests; watchOS has no equivalent, because
# its views render only in a watch simulator. This is the wrist's version of
# that loop: build the watch app once, then launch it once per state with
# DEMO_WATCH_STATE set (see WatchStateStaging) and capture the screen.
#
# The smallest watch is the one that matters. The ask screen's status line is
# a single line that must never wrap or truncate, and 41mm is where it breaks
# first. The 49mm Ultra is captured as the other extreme.
#
# PNGs land in /tmp/omnesis-watch-shots/<size>-<state>.png. No golden corpus,
# no comparison — you look at them.

set -euo pipefail
cd "$(dirname "$0")/.."

# Must match WatchStateStaging.known — the app refuses anything else, and a
# name checked only there would fail one launch at a time.
KNOWN_STATES="idle received thinking searching reading widest long-question answered working failed note-idle note-done"

STATES="idle received thinking searching reading widest long-question answered working failed note-idle note-done"
SIZES="small large"
KEEP=0
while [ $# -gt 0 ]; do
    case "${1:-}" in
        --states) [ $# -ge 2 ] || { echo "error: --states needs a value" >&2; exit 1; }
                  STATES="${2//,/ }"; shift 2 ;;
        --sizes) [ $# -ge 2 ] || { echo "error: --sizes needs a value" >&2; exit 1; }
                 SIZES="${2//,/ }"; shift 2 ;;
        --keep) KEEP=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
done

for state in $STATES; do
    case " $KNOWN_STATES " in
        *" $state "*) ;;
        *) echo "error: unknown state '$state' (known: $KNOWN_STATES)" >&2; exit 1 ;;
    esac
done
for size in $SIZES; do
    case "$size" in
        small|large) ;;
        *) echo "error: unknown size '$size' (expected small or large)" >&2; exit 1 ;;
    esac
done

SMALL_TYPE="${OMNESIS_WATCH_SMALL:-com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-9-41mm}"
LARGE_TYPE="${OMNESIS_WATCH_LARGE:-com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-2-49mm}"
OUT="/tmp/omnesis-watch-shots"
DERIVED="/tmp/omnesis-watch-shots-build"

# The app writes this once the state is on screen, so the capture waits for a
# fact instead of a duration. READY_TIMEOUT bounds that wait: a state the app
# refused (an unknown name) never writes it.
READY_MARKER="/tmp/omnesis-watch-state-ready"
READY_TIMEOUT="${OMNESIS_WATCH_READY_TIMEOUT:-30}"
# A beat after the marker for the frame to actually paint.
SETTLE="${OMNESIS_WATCH_SETTLE:-1}"

CREATED=()
cleanup() {
    for udid in "${CREATED[@]:-}"; do
        [ -n "$udid" ] || continue
        # --keep leaves the simulator booted and installed so the next run
        # skips the boot; otherwise it is torn down, because these exist only
        # for this run and would quietly grow the device list.
        [ "$KEEP" = "1" ] && continue
        xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
        xcrun simctl delete "$udid" >/dev/null 2>&1 || true
    done
}
trap cleanup EXIT

command -v xcodegen >/dev/null || { echo "error: xcodegen not installed (brew install xcodegen)" >&2; exit 1; }

echo "==> Regenerating the Xcode project"
(cd ios && xcodegen generate >/dev/null)

# Highest *available* watchOS runtime. `|| true` keeps a no-match grep from
# taking the whole script down under `set -e` before the guard below can say
# what is actually wrong.
WATCH_RUNTIME=$(xcrun simctl list runtimes available 2>/dev/null \
    | grep -o 'watchOS [0-9][0-9.]*' \
    | awk '{print $2}' \
    | sort -t. -k1,1n -k2,2n \
    | tail -1 || true)
[ -n "$WATCH_RUNTIME" ] || {
    echo "error: no watchOS simulator runtime installed (xcodebuild -downloadPlatform watchOS)" >&2
    exit 1
}

echo "==> Building OmnesisWatch (watchOS $WATCH_RUNTIME)"
# Built by target rather than by scheme: the watch app has no scheme of its
# own, and building the Omnesis scheme would pull in the whole phone app for
# a screenshot of the wrist. CONFIGURATION_BUILD_DIR (not -derivedDataPath,
# which xcodebuild refuses alongside -target) puts the product somewhere
# predictable.
rm -rf "$DERIVED"
xcodebuild build \
    -project ios/Omnesis.xcodeproj \
    -target OmnesisWatch \
    -configuration Debug \
    -sdk "watchsimulator$WATCH_RUNTIME" \
    CONFIGURATION_BUILD_DIR="$DERIVED" \
    CODE_SIGNING_ALLOWED=NO \
    >/tmp/omnesis-watch-shots-build.log 2>&1 \
    || { echo "error: build failed — see /tmp/omnesis-watch-shots-build.log" >&2; tail -30 /tmp/omnesis-watch-shots-build.log >&2; exit 1; }

APP="$DERIVED/OmnesisWatch.app"
[ -d "$APP" ] || { echo "error: built app not found at $APP" >&2; exit 1; }
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")"

mkdir -p "$OUT"

shoot_size() {
    local label="$1" type="$2"
    local name="Omnesis Watch Shot ($label)"
    local udid

    echo "==> $label: $type"
    # A watch simulator is created on demand: Xcode ships watch device *types*
    # but no watch devices, so there is nothing to look up on a fresh machine.
    udid=$(xcrun simctl create "$name" "$type" "com.apple.CoreSimulator.SimRuntime.watchOS-${WATCH_RUNTIME//./-}") \
        || { echo "error: could not create a simulator of type '$type'" >&2; exit 1; }
    CREATED+=("$udid")

    xcrun simctl boot "$udid" >/dev/null 2>&1 || true
    xcrun simctl bootstatus "$udid" -b >/dev/null \
        || { echo "error: simulator $udid never finished booting" >&2; exit 1; }
    xcrun simctl install "$udid" "$APP"

    for state in $STATES; do
        xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
        rm -f "$READY_MARKER"
        # simctl only forwards SIMCTL_CHILD_-prefixed variables into the app.
        env "SIMCTL_CHILD_DEMO_WATCH_STATE=$state" \
            xcrun simctl launch "$udid" "$BUNDLE_ID" >/dev/null

        # Wait for the app to say the state is staged. Without this the
        # capture is a guess, and a slow cold start yields a plausible-looking
        # screenshot of the launch screen filed under the state's name.
        local waited=0
        while [ ! -f "$READY_MARKER" ]; do
            if [ "$waited" -ge "$READY_TIMEOUT" ]; then
                echo "error: '$state' never staged (no $READY_MARKER after ${READY_TIMEOUT}s)" >&2
                exit 1
            fi
            sleep 1
            waited=$((waited + 1))
        done
        sleep "$SETTLE"

        local png="$OUT/$label-$state.png"
        xcrun simctl io "$udid" screenshot "$png" >/dev/null \
            || { echo "error: screenshot failed for $label-$state" >&2; exit 1; }
        # A zero-length or absurdly small PNG is a failed capture wearing the
        # right filename.
        [ -f "$png" ] && [ "$(wc -c <"$png")" -gt 1024 ] \
            || { echo "error: $png is empty or truncated" >&2; exit 1; }
        echo "    $label-$state.png"
    done
    xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
    rm -f "$READY_MARKER"
}

for size in $SIZES; do
    case "$size" in
        small) shoot_size small "$SMALL_TYPE" ;;
        large) shoot_size large "$LARGE_TYPE" ;;
    esac
done

echo
echo "PNGs in $OUT"
