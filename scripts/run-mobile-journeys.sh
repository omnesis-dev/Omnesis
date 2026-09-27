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
# The gateway is a synthetic gateway (`scripts/synth-gateway.sh`) serving the
# `e2e-minimal` universe's invented corpus, small enough for a hosted runner
# to embed in a few minutes. The replay backend answers the agent from the
# `default` universe's recorded scenarios, so no model runs. It listens on a
# high port with its own config dir and is stopped on exit.
#
# iOS runs `MobileJourneyUITests` on the simulator named by
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
#   OMNESIS_JOURNEY_READY_TIMEOUT    seconds to wait for the corpus to be searchable (default: 900)
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

# Runs a command for at most $1 seconds where `timeout` exists (a command on a
# device that has gone away can otherwise wait forever), unbounded elsewhere.
bounded() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  else
    "$@"
  fi
}

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
  "$ROOT/scripts/synth-gateway.sh" stop >/dev/null 2>&1 || true
  mkdir -p "$ARTIFACTS/gateway-logs"
  cp "$OMNESIS_CONFIG_DIR"/logs/*.log "$ARTIFACTS/gateway-logs/" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ── iOS ────────────────────────────────────────────────────────────────────

# Boots the simulator and builds the app and its UI tests in the background,
# so the build overlaps the gateway's indexing. Sets IOS_UDID and
# IOS_BUILD_PID for run_ios.
IOS_UDID=""
IOS_BUILD_PID=""
IOS_PACKAGE_FLAGS=()
prepare_ios() {
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
  IOS_UDID="$udid"

  (cd "$ROOT/ios" && xcodegen generate >/dev/null)
  export OMNESIS_IOS_PACKAGES_DIR="${OMNESIS_IOS_PACKAGES_DIR:-$ROOT/ios/build/packages}"
  "$ROOT/scripts/ci/resolve-ios-packages.sh" OmnesisDemoUITests
  IOS_PACKAGE_FLAGS=(-clonedSourcePackagesDirPath "$OMNESIS_IOS_PACKAGES_DIR" -disableAutomaticPackageResolution)
  echo "→ Building the app and its UI tests while the gateway indexes…"
  # A generic destination: the build needs no particular simulator, and a
  # freshly booted one is not always visible to xcodebuild yet.
  xcodebuild build-for-testing \
    -project "$ROOT/ios/Omnesis.xcodeproj" \
    -scheme OmnesisDemoUITests \
    -destination "generic/platform=iOS Simulator" \
    "${IOS_PACKAGE_FLAGS[@]}" \
    -derivedDataPath "$IOS_DERIVED_DATA" \
    >"$ARTIFACTS/xcodebuild-build.log" 2>&1 &
  IOS_BUILD_PID=$!
}

run_ios() {
  local udid="$IOS_UDID"
  if ! wait "$IOS_BUILD_PID"; then
    grep -E 'error:|\*\* BUILD' "$ARTIFACTS/xcodebuild-build.log" | tail -40 >&2
    echo "✗ The iOS app or its UI tests did not build." >&2
    return 1
  fi
  local bundle_id
  bundle_id="$("$ROOT/scripts/ios-resolved-bundle-id.sh" OmnesisDemo)"
  # A person grants these when the app asks; the journeys are not about the
  # prompts, so grant them up front where the simulator allows it. Any prompt
  # that still appears is answered by the tests' interruption monitor.
  for service in microphone speech-recognition; do
    xcrun simctl privacy "$udid" grant "$service" "$bundle_id" >/dev/null 2>&1 || true
  done
  # The keyboard's one-time swipe-typing tutorial would cover the app.
  xcrun simctl spawn "$udid" defaults write com.apple.keyboard.preferences \
    DidShowContinuousPathIntroduction -bool true >/dev/null 2>&1 || true

  local config
  config="$(TOKEN="$TOKEN" FINGERPRINT="$FINGERPRINT" python3 -c '
import json, os
print(json.dumps({"gatewayURL": os.environ["URL"], "token": os.environ["TOKEN"], "fingerprint": os.environ["FINGERPRINT"]}))
')"

  local classes=(MobileJourneyUITests)
  local tests=()
  local expected=0
  if [[ -n "${OMNESIS_JOURNEY_ONLY:-}" ]]; then
    tests=("-only-testing:OmnesisDemoUITests/$OMNESIS_JOURNEY_ONLY")
  else
    local class
    for class in "${classes[@]}"; do
      tests+=("-only-testing:OmnesisDemoUITests/$class")
      expected=$((expected + $(grep -cE '^\s*func test\w*\(' "$ROOT/ios/UITests/OmnesisDemoUITests/$class.swift")))
    done
  fi

  xcrun simctl io "$udid" recordVideo --codec h264 --force "$ARTIFACTS/ios-journeys.mp4" \
    >"$ARTIFACTS/recorder.log" 2>&1 &
  RECORDER_PID=$!

  echo "→ Running the iOS journeys…"
  # The full xcodebuild output goes to the artifacts; the console keeps the
  # test verdicts and errors.
  local status=0
  set +e
  TEST_RUNNER_OMNESIS_JOURNEY_CONFIG="$config" xcodebuild test-without-building \
    -project "$ROOT/ios/Omnesis.xcodeproj" \
    -scheme OmnesisDemoUITests \
    -destination "platform=iOS Simulator,id=$udid" \
    -derivedDataPath "$IOS_DERIVED_DATA" \
    "${IOS_PACKAGE_FLAGS[@]}" \
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
  # A skipped test reads as TEST SUCCEEDED. The lane passes only when every
  # journey it selected ran and passed.
  xcrun xcresulttool get test-results summary --path "$ARTIFACTS/ios-journeys.xcresult" \
    >"$ARTIFACTS/summary.json"
  python3 - "$ARTIFACTS/summary.json" "$expected" <<'PY' || return 1
import json, sys
summary, expected = json.load(open(sys.argv[1])), int(sys.argv[2])
total, passed = summary["totalTestCount"], summary["passedTests"]
skipped, failed = summary["skippedTests"], summary["failedTests"]
print(f"iOS journeys: {total} run, {passed} passed, {skipped} skipped, {failed} failed; {expected or 'any'} expected")
if skipped or total == 0 or (expected and passed < expected):
    sys.exit("✗ Not every iOS journey ran and passed.")
PY
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
  bounded 120 adb wait-for-device
  if [[ "$(bounded 30 adb shell getprop sys.boot_completed | tr -d '\r')" != 1 ]]; then
    echo "The emulator has not finished booting." >&2
    return 1
  fi
  local device_url="https://10.0.2.2:${OMNESIS_GATEWAY_PORT}"
  local results="$ROOT/android/app/build/outputs/androidTest-results/connected"
  local reports="$ROOT/android/app/build/reports/androidTests/connected"
  local device_shots="/sdcard/omnesis-journeys"

  local device_video="/sdcard/omnesis-journeys-video"
  bounded 30 adb shell rm -rf "$device_shots" "$device_video" >/dev/null 2>&1 || true
  bounded 30 adb shell mkdir -p "$device_video" >/dev/null 2>&1 || true
  # The device records itself: `screenrecord` stops after three minutes, so the
  # loop starts a new numbered segment each time one ends.
  bounded 30 adb shell "nohup sh -c 'i=0; while [ ! -e $device_video/stop ]; do i=\$((i+1)); screenrecord --bit-rate 2000000 --time-limit 180 $device_video/segment-\$(printf %03d \$i).mp4; done' >/dev/null 2>&1 &" \
    >/dev/null 2>&1 || true

  local filter="${OMNESIS_JOURNEY_ONLY:+dev.omnesis.android.journeys.$OMNESIS_JOURNEY_ONLY}"
  local attempt=0 status=0
  while :; do
    attempt=$((attempt + 1))
    rm -rf "$results"
    if ! bounded 120 adb wait-for-device; then
      echo "The emulator is gone (adb devices: $(adb devices | tr '\n' ' '))." >&2
      { free -m; sudo -n dmesg 2>/dev/null | tail -40; } >"$ARTIFACTS/host-after-emulator-loss.txt" 2>&1 || true
      status=1
      break
    fi
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

  bounded 30 adb shell "touch $device_video/stop; pkill -INT screenrecord" >/dev/null 2>&1 || true
  sleep 2
  bounded 60 adb logcat -d -v time >"$ARTIFACTS/logcat.txt" 2>/dev/null || true
  bounded 60 adb pull "$device_shots" "$ARTIFACTS/failure-screenshots" >/dev/null 2>&1 || true
  if [[ "$status" != 0 ]]; then
    bounded 120 adb pull "$device_video" "$ARTIFACTS/screen-recording" >/dev/null 2>&1 || true
    rm -f "$ARTIFACTS/screen-recording/stop"
  fi

  if [[ "$status" != 0 ]]; then
    echo "✗ Android journeys failed. Artifacts: $ARTIFACTS" >&2
    return "$status"
  fi
  # A skipped test counts as passed in Gradle's verdict. The lane passes only
  # when every journey ran and passed in some attempt.
  if [[ -z "${OMNESIS_JOURNEY_ONLY:-}" ]]; then
    python3 - "$ARTIFACTS/test-results" "$ROOT/android/app/src/androidTest/kotlin/dev/omnesis/android/journeys/MobileJourneyTest.kt" <<'PY' || return 1
import pathlib, re, sys
import xml.etree.ElementTree as ElementTree
results, source = pathlib.Path(sys.argv[1]), sys.argv[2]
declared = set(re.findall(r"@Test\s+fun\s+(\w+)\s*\(", open(source).read()))
passed, skipped = set(), set()
for report in results.rglob("TEST-*.xml"):
    for case in ElementTree.parse(report).getroot().iter("testcase"):
        name = case.get("name")
        if case.find("skipped") is not None:
            skipped.add(name)
        elif case.find("failure") is None and case.find("error") is None:
            passed.add(name)
print(f"Android journeys: {len(passed & declared)} of {len(declared)} passed, {len(skipped)} skipped")
if not declared or skipped or not declared <= passed:
    sys.exit(f"✗ Not every Android journey ran and passed: missing {sorted(declared - passed)}")
PY
  fi
  if (( attempt > 1 )); then
    echo "✓ Android journeys passed on attempt $attempt."
  else
    echo "✓ Android journeys passed."
  fi
}

# ── Gateway ────────────────────────────────────────────────────────────────

# The apps search through POST /search, which answers only once documents are
# embedded, so the gateway needs its embedding model. A machine that already
# has one in ~/.config/omnesis/models lends it (synth-gateway.sh links it);
# anywhere else it is downloaded once into OMNESIS_JOURNEY_MODEL_CACHE and
# checked against its published digest.
MODEL_FILE="nomic-embed-text-v1.5.Q8_0.gguf"
MODEL_URL="https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/$MODEL_FILE"
MODEL_SHA256="3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7"
MODEL_CACHE="${OMNESIS_JOURNEY_MODEL_CACHE:-$HOME/.cache/omnesis-journeys}"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

if [[ ! -f "$HOME/.config/omnesis/models/$MODEL_FILE" ]]; then
  mkdir -p "$MODEL_CACHE" "$OMNESIS_CONFIG_DIR/models"
  if [[ ! -f "$MODEL_CACHE/$MODEL_FILE" || "$(sha256_of "$MODEL_CACHE/$MODEL_FILE")" != "$MODEL_SHA256" ]]; then
    echo "→ Downloading the embedding model…"
    curl -fsSL --retry 3 -o "$MODEL_CACHE/$MODEL_FILE.part" "$MODEL_URL"
    if [[ "$(sha256_of "$MODEL_CACHE/$MODEL_FILE.part")" != "$MODEL_SHA256" ]]; then
      echo "The downloaded $MODEL_FILE does not match its expected SHA-256." >&2
      exit 1
    fi
    mv "$MODEL_CACHE/$MODEL_FILE.part" "$MODEL_CACHE/$MODEL_FILE"
  fi
  ln -sf "$MODEL_CACHE/$MODEL_FILE" "$OMNESIS_CONFIG_DIR/models/$MODEL_FILE"
fi

echo "→ Booting the synthetic gateway on $URL (universe e2e-minimal, replay agent)…"
# A blank slate every run; the model link survives.
if [[ -d "$OMNESIS_CONFIG_DIR" ]]; then
  "$ROOT/scripts/synth-gateway.sh" stop >/dev/null 2>&1 || true
  find "$OMNESIS_CONFIG_DIR" -mindepth 1 -maxdepth 1 -not -name models -exec rm -rf {} +
fi
# OAuth-backed synthetic sources sync without waiting on an add-source wizard.
OMNESIS_SYNTH_UNIVERSE=e2e-minimal \
  OMNESIS_SYNTH_PRE_DISCOVERED=1 \
  OMNESIS_AGENT_FIXTURE="$ROOT/evals/universes/default/agent-demos" \
  "$ROOT/scripts/synth-gateway.sh" start >"$ARTIFACTS/gateway-start.log" 2>&1 || {
  cat "$ARTIFACTS/gateway-start.log" >&2
  exit 1
}

TOKEN="$(cat "$OMNESIS_CONFIG_DIR/token")"
FINGERPRINT="$(openssl x509 -in "$OMNESIS_CONFIG_DIR/tls/cert.pem" -noout -fingerprint -sha256 \
  | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f')"

IOS_DERIVED_DATA="$WORK/ios-derived-data"
if [[ "$PLATFORM" == ios ]]; then
  export URL
  prepare_ios
fi

# The search journeys look for this invented document; the index is ready for
# them once the gateway's own search returns it. Search reads a snapshot that
# refreshes on a timer, so each check asks for a fresh one first. A cold macOS
# runner can take minutes just to load the embedding model.
READY_DOCUMENT="Acme Q3 Planning"
READY_BUDGET_SECONDS="${OMNESIS_JOURNEY_READY_TIMEOUT:-900}"
echo "→ Waiting for the corpus to be searchable…"
ready=0
ready_deadline=$((SECONDS + READY_BUDGET_SECONDS))
while ((SECONDS < ready_deadline)); do
  curl -sk -m 20 -X POST "$URL/admin/search-snapshot/refresh" \
    -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
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
  echo "The gateway never returned \"$READY_DOCUMENT\" from /search within ${READY_BUDGET_SECONDS}s." >&2
  exit 1
fi
echo "  corpus ready after ${SECONDS}s."

export URL
"run_$PLATFORM"
