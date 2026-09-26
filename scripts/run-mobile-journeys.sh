#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Drive the mobile apps' main journeys — pairing, search, opening a document,
# asking the agent — against a synthetic gateway, the way a person does:
# launch, tap, type, read what appears.
#
# Usage:
#   scripts/run-mobile-journeys.sh ios       # XCUITest on an iPhone simulator (macOS + Xcode)
#   scripts/run-mobile-journeys.sh android   # Compose UI tests on a running emulator
#
# The gateway is the demo gateway (`scripts/start-demo-gateway.sh`): the
# `default` universe's invented corpus, with the replay backend answering the
# agent from recorded scenarios, so no model runs. It listens on a high port
# with its own config dir and is stopped on exit.
#
# iOS runs `MobileJourneyUITests` plus the self-contained UI tests beside it
# (push-notification tap, agent scrolling) on the simulator named by
# OMNESIS_JOURNEY_IOS_SIMULATOR. Android needs an emulator already booted and
# visible to adb — the CI lane boots one; locally, start your AVD first — and
# runs `:app:connectedPlayDebugAndroidTest`, which holds only the journeys.
#
# A journey that fails is retried once (OMNESIS_JOURNEY_RETRIES), because
# simulators and emulators have known one-off flakes; a journey that fails
# every attempt fails the run. The screen is recorded for the whole run.
# Everything worth reading after a failure lands in OMNESIS_JOURNEY_ARTIFACTS:
# the recording, per-failure screenshots, test reports / the xcresult bundle,
# and the gateway's logs.
#
# Overrides:
#   OMNESIS_CONFIG_DIR               gateway state   (default: /tmp/omnesis-mobile-journeys/gateway)
#   OMNESIS_GATEWAY_PORT             gateway port    (default: 17720)
#   OMNESIS_JOURNEY_ARTIFACTS        artifact dir    (default: /tmp/omnesis-mobile-journeys/artifacts)
#   OMNESIS_JOURNEY_RETRIES          extra attempts for a failed journey (default: 1)
#   OMNESIS_JOURNEY_IOS_SIMULATOR    simulator device name (default: iPhone 17)
#   OMNESIS_JOURNEY_ONLY             run one journey: an XCTest identifier (iOS) or
#                                    Class#method (Android)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM="${1:-}"
case "$PLATFORM" in
  ios | android) ;;
  *)
    echo "usage: scripts/run-mobile-journeys.sh ios|android" >&2
    exit 2
    ;;
esac

if [[ -d /opt/homebrew/opt/node@24/bin ]]; then
  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
fi

WORK="/tmp/omnesis-mobile-journeys"
export OMNESIS_CONFIG_DIR="${OMNESIS_CONFIG_DIR:-$WORK/gateway}"
export OMNESIS_GATEWAY_PORT="${OMNESIS_GATEWAY_PORT:-17720}"
ARTIFACTS="${OMNESIS_JOURNEY_ARTIFACTS:-$WORK/artifacts}"
RETRIES="${OMNESIS_JOURNEY_RETRIES:-1}"
URL="https://localhost:${OMNESIS_GATEWAY_PORT}"

case "$OMNESIS_GATEWAY_PORT" in
  7600 | 27600)
    echo "Refusing port $OMNESIS_GATEWAY_PORT: it belongs to a live or demo gateway." >&2
    exit 2
    ;;
esac
case "$RETRIES" in
  '' | *[!0-9]*)
    echo "OMNESIS_JOURNEY_RETRIES must be a non-negative integer (got: $RETRIES)." >&2
    exit 2
    ;;
esac

rm -rf "$ARTIFACTS"
mkdir -p "$ARTIFACTS"

RECORDER_PID=""
stop_recording() {
  if [[ -n "$RECORDER_PID" ]]; then
    kill -INT "$RECORDER_PID" 2>/dev/null || true
    wait "$RECORDER_PID" 2>/dev/null || true
    RECORDER_PID=""
  fi
}

cleanup() {
  local status=$?
  stop_recording
  if [[ "$PLATFORM" == android ]] && command -v adb >/dev/null 2>&1; then
    adb emu screenrecord stop >/dev/null 2>&1 || true
  fi
  "$ROOT/scripts/start-demo-gateway.sh" stop >/dev/null 2>&1 || true
  mkdir -p "$ARTIFACTS/gateway-logs"
  cp "$OMNESIS_CONFIG_DIR"/logs/*.log "$ARTIFACTS/gateway-logs/" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ── Gateway ────────────────────────────────────────────────────────────────
echo "→ Booting the synthetic gateway on $URL (universe default, replay agent)…"
"$ROOT/scripts/start-demo-gateway.sh" start >"$ARTIFACTS/gateway-start.log" 2>&1 || {
  cat "$ARTIFACTS/gateway-start.log" >&2
  exit 1
}

TOKEN="$(cat "$OMNESIS_CONFIG_DIR/token")"
FINGERPRINT="$(openssl x509 -in "$OMNESIS_CONFIG_DIR/tls/cert.pem" -noout -fingerprint -sha256 \
  | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f')"

# The search journeys look for this invented document; the index is ready for
# them once the gateway's own search returns it.
READY_DOCUMENT="Acme Q3 Planning"
echo "→ Waiting for the corpus to be searchable…"
ready=0
for _ in $(seq 1 120); do
  if curl -sk -m 20 -X POST "$URL/search" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"text\":\"$READY_DOCUMENT\",\"limit\":10}" 2>/dev/null \
    | node -e '
        let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
          try { process.exit(JSON.parse(s).results.some(r => r.title === process.argv[1]) ? 0 : 1); }
          catch { process.exit(1); }
        });
      ' "$READY_DOCUMENT"; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" != 1 ]]; then
  echo "The gateway never returned \"$READY_DOCUMENT\" from /search." >&2
  exit 1
fi
echo "  corpus ready."

# ── iOS ────────────────────────────────────────────────────────────────────
run_ios() {
  local simulator_name="${OMNESIS_JOURNEY_IOS_SIMULATOR:-iPhone 17}"
  local udid
  udid="$(xcrun simctl list devices available --json | SIMULATOR_NAME="$simulator_name" python3 -c '
import json, os, sys
wanted = os.environ["SIMULATOR_NAME"]
runtimes = json.load(sys.stdin)["devices"]
def version(runtime):
    return [int(part) for part in runtime.rsplit(".", 1)[-1].split("-")[1:] if part.isdigit()]
matches = [(version(runtime), device["udid"])
           for runtime, devices in runtimes.items() if ".iOS-" in runtime
           for device in devices if device["name"] == wanted]
if not matches:
    sys.exit(f"no available iOS simulator named {wanted!r}")
print(max(matches)[1])
')"
  echo "→ Simulator: $simulator_name ($udid)"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null

  (cd "$ROOT/ios" && xcodegen generate >/dev/null)
  local bundle_id
  bundle_id="$("$ROOT/scripts/ios-resolved-bundle-id.sh" OmnesisDemo)"
  # A person grants these when the app asks; the journeys are not about the
  # prompts, so grant them up front where the simulator allows it. Any prompt
  # that still appears is answered by the tests' interruption monitor.
  for service in microphone speech-recognition; do
    xcrun simctl privacy "$udid" grant "$service" "$bundle_id" >/dev/null 2>&1 || true
  done

  local config
  config="$(TOKEN="$TOKEN" FINGERPRINT="$FINGERPRINT" python3 -c '
import json, os
print(json.dumps({"gatewayURL": os.environ["URL"], "token": os.environ["TOKEN"], "fingerprint": os.environ["FINGERPRINT"]}))
')"

  local tests=()
  if [[ -n "${OMNESIS_JOURNEY_ONLY:-}" ]]; then
    tests=("-only-testing:OmnesisDemoUITests/$OMNESIS_JOURNEY_ONLY")
  else
    tests=(
      -only-testing:OmnesisDemoUITests/MobileJourneyUITests
      -only-testing:OmnesisDemoUITests/PushTapUITests
      -only-testing:OmnesisDemoUITests/AgentScrollUITests
    )
  fi

  xcrun simctl io "$udid" recordVideo --codec h264 --force "$ARTIFACTS/ios-journeys.mp4" \
    >"$ARTIFACTS/recorder.log" 2>&1 &
  RECORDER_PID=$!

  echo "→ Running the iOS journeys…"
  # The full xcodebuild output goes to the artifacts; the console keeps the
  # test verdicts and errors.
  local status=0
  set +e
  TEST_RUNNER_OMNESIS_JOURNEY_CONFIG="$config" xcodebuild test \
    -project "$ROOT/ios/Omnesis.xcodeproj" \
    -scheme OmnesisDemoUITests \
    -destination "platform=iOS Simulator,id=$udid" \
    -resultBundlePath "$ARTIFACTS/ios-journeys.xcresult" \
    -retry-tests-on-failure -test-iterations $((RETRIES + 1)) \
    "${tests[@]}" 2>&1 | tee "$ARTIFACTS/xcodebuild.log" \
    | grep -E --line-buffered '^(Test Case|Test Suite|Testing|Executed|\*\*)|error:'
  status="${PIPESTATUS[0]}"
  set -e
  stop_recording

  if [[ "$status" != 0 ]]; then
    mkdir -p "$ARTIFACTS/failure-attachments"
    xcrun xcresulttool export attachments --path "$ARTIFACTS/ios-journeys.xcresult" \
      --output-path "$ARTIFACTS/failure-attachments" --only-failures >/dev/null 2>&1 || true
    echo "✗ iOS journeys failed (xcodebuild exit $status). Artifacts: $ARTIFACTS" >&2
    return "$status"
  fi
  rm -f "$ARTIFACTS/ios-journeys.mp4"
  echo "✓ iOS journeys passed."
}

# ── Android ────────────────────────────────────────────────────────────────

# The journeys that failed in a directory of JUnit XML reports, as the
# comma-separated `Class#method` list an instrumentation `class` argument
# takes, so a retry runs only those. Empty when none failed or none reported.
failed_journeys() {
  python3 - "$1" <<'PY' || true
import pathlib, sys
import xml.etree.ElementTree as ElementTree
failed = []
for report in sorted(pathlib.Path(sys.argv[1]).rglob("TEST-*.xml")):
    for case in ElementTree.parse(report).getroot().iter("testcase"):
        if case.find("failure") is not None or case.find("error") is not None:
            name = f"{case.get('classname')}#{case.get('name')}"
            if name not in failed:
                failed.append(name)
print(",".join(failed))
PY
}

run_android() {
  command -v adb >/dev/null || { echo "adb is not on PATH." >&2; return 1; }
  adb wait-for-device
  if [[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" != 1 ]]; then
    echo "The emulator has not finished booting." >&2
    return 1
  fi
  local device_url="https://10.0.2.2:${OMNESIS_GATEWAY_PORT}"
  local results="$ROOT/android/app/build/outputs/androidTest-results/connected"
  local reports="$ROOT/android/app/build/reports/androidTests/connected"
  local device_shots="/sdcard/omnesis-journeys"

  adb shell rm -rf "$device_shots" >/dev/null 2>&1 || true
  adb emu screenrecord start --time-limit 1800 "$ARTIFACTS/android-journeys.webm" >/dev/null 2>&1 || true

  local filter="${OMNESIS_JOURNEY_ONLY:+dev.omnesis.android.journeys.$OMNESIS_JOURNEY_ONLY}"
  local attempt=0 status=0
  while :; do
    attempt=$((attempt + 1))
    rm -rf "$results"
    echo "→ Running the Android journeys (attempt $attempt)…"
    local args=(
      -Pandroid.testInstrumentationRunnerArguments.journeyGatewayUrl="$device_url"
      -Pandroid.testInstrumentationRunnerArguments.journeyToken="$TOKEN"
      -Pandroid.testInstrumentationRunnerArguments.journeyFingerprint="$FINGERPRINT"
    )
    [[ -n "$filter" ]] && args+=(-Pandroid.testInstrumentationRunnerArguments.class="$filter")
    status=0
    (
      cd "$ROOT/android"
      ./gradlew :app:connectedPlayDebugAndroidTest "${args[@]}" --no-daemon --max-workers=2
    ) >"$ARTIFACTS/gradle-attempt-$attempt.log" 2>&1 || status=$?
    mkdir -p "$ARTIFACTS/test-results/attempt-$attempt"
    cp -R "$results/." "$ARTIFACTS/test-results/attempt-$attempt/" 2>/dev/null || true
    cp -R "$reports" "$ARTIFACTS/test-report-attempt-$attempt" 2>/dev/null || true
    if [[ "$status" == 0 ]]; then
      break
    fi
    local failed
    failed="$(failed_journeys "$results")"
    if [[ -z "$failed" ]]; then
      echo "The Android run failed before any journey reported a result:" >&2
      tail -60 "$ARTIFACTS/gradle-attempt-$attempt.log" >&2
      break
    fi
    echo "  failed: ${failed//,/ }"
    if (( attempt > RETRIES )); then
      break
    fi
    filter="$failed"
  done

  adb emu screenrecord stop >/dev/null 2>&1 || true
  adb logcat -d -v time >"$ARTIFACTS/logcat.txt" 2>/dev/null || true
  adb pull "$device_shots" "$ARTIFACTS/failure-screenshots" >/dev/null 2>&1 || true

  if [[ "$status" != 0 ]]; then
    echo "✗ Android journeys failed. Artifacts: $ARTIFACTS" >&2
    return "$status"
  fi
  if (( attempt > 1 )); then
    echo "✓ Android journeys passed on attempt $attempt."
  else
    rm -f "$ARTIFACTS/android-journeys.webm"
    echo "✓ Android journeys passed."
  fi
}

export URL
"run_$PLATFORM"
