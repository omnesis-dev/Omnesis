#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Generate App Store-ready screenshots from the synthetic demo universe.
# Runs only on macOS because it drives iOS/watchOS simulators. No review portal,
# production gateway, personal corpus, or store API is touched.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/boot_budget"

[[ "$(uname -s)" == "Darwin" ]] || {
  echo "error: App Store screenshots require macOS with Xcode simulators" >&2
  exit 78
}
command -v xcodegen >/dev/null || { echo "error: xcodegen is required" >&2; exit 78; }
command -v xcrun >/dev/null || { echo "error: Xcode command-line tools are required" >&2; exit 78; }

IPHONE_NAME="${OMNESIS_STORE_IPHONE_SIMULATOR:-iPhone 17 Pro Max}"
IPAD_NAME="${OMNESIS_STORE_IPAD_SIMULATOR:-iPad Pro 13-inch (M5)}"
LOCK_DIR="/tmp/omnesis-app-store-screenshots.lock"
mkdir "$LOCK_DIR" 2>/dev/null || {
  echo "error: another App Store screenshot run owns $LOCK_DIR" >&2
  exit 75
}
RUN_ROOT="$(mktemp -d /tmp/omnesis-app-store-screenshots.XXXXXX)"
DEMO_CONFIG_DIR="$RUN_ROOT/gateway"
PAIRING_FILE="$RUN_ROOT/pairing.json"
TMP_ROOT="$RUN_ROOT/captures"
if [[ -n "${OMNESIS_GATEWAY_PORT:-}" ]]; then
  GATEWAY_PORT="$OMNESIS_GATEWAY_PORT"
else
  GATEWAY_PORT="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
fi
OUT_ROOT="$ROOT/ios/AppStoreAssets/screenshots"
TESTS=(
  OmnesisDemoUITests/ScreenshotTests/test_store_01_agent
  OmnesisDemoUITests/ScreenshotTests/test_store_02_search
  OmnesisDemoUITests/ScreenshotTests/test_store_03_people
  OmnesisDemoUITests/ScreenshotTests/test_store_04_settings
)

cleanup() {
  OMNESIS_CONFIG_DIR="$DEMO_CONFIG_DIR" OMNESIS_GATEWAY_PORT="$GATEWAY_PORT" \
    bash scripts/start-demo-gateway.sh stop >/dev/null 2>&1 || true
  case "$RUN_ROOT" in
    /tmp/omnesis-app-store-screenshots.*) rm -rf -- "$RUN_ROOT" ;;
  esac
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

resolve_simulator() {
  local name="$1"
  local id
  id="$(xcrun simctl list devices available | awk -v wanted="$name" '
    index($0, wanted " (") { if (match($0, /[A-F0-9-]{36}/)) { print substr($0, RSTART, RLENGTH); exit } }
  ')"
  [[ -n "$id" ]] || {
    echo "error: simulator '$name' is unavailable; override its name with OMNESIS_STORE_IPHONE_SIMULATOR or OMNESIS_STORE_IPAD_SIMULATOR" >&2
    exit 78
  }
  printf '%s' "$id"
}

wait_for_gateway() {
  local deadline
  deadline=$((SECONDS + $(gateway_boot_budget_seconds)))
  until curl -sfk "https://localhost:$GATEWAY_PORT/health" >/dev/null 2>&1; do
    (( SECONDS < deadline )) || { echo "error: synthetic gateway did not become healthy" >&2; exit 1; }
    sleep 1
  done
}

wait_for_index() {
  local attempts=0 ready
  while true; do
    ready="$(curl -sfk "https://localhost:$GATEWAY_PORT/index/stats" \
      -H "Authorization: Bearer $(<"$DEMO_CONFIG_DIR/token")" 2>/dev/null \
      | node -e '
          let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
            try { const j=JSON.parse(s); process.stdout.write((j.totalGatewayDocs||0)>0 && j.totalIndexed>=j.totalGatewayDocs ? "1" : "0"); }
            catch { process.stdout.write("0"); }
          });
        ' || true)"
    [[ "$ready" == "1" ]] && return
    attempts=$((attempts + 1))
    [[ "$attempts" -lt 120 ]] || { echo "error: synthetic corpus did not finish indexing" >&2; exit 1; }
    sleep 2
  done
}

capture_family() {
  local simulator_name="$1" family="$2" expected_width="$3" expected_height="$4"
  local simulator_id destination tmp_out final_out staged_out
  simulator_id="$(resolve_simulator "$simulator_name")"
  destination="platform=iOS Simulator,id=$simulator_id"
  tmp_out="$TMP_ROOT/$family"
  final_out="$OUT_ROOT/$family"
  staged_out="$TMP_ROOT/$family-ready"
  mkdir -p "$tmp_out" "$staged_out"
  rm -f "$tmp_out"/*.png "$staged_out"/*.png

  xcrun simctl boot "$simulator_id" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$simulator_id" -b >/dev/null
  xcrun simctl status_bar "$simulator_id" override \
    --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 \
    --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100 \
    >/dev/null 2>&1 || true
  # Keep system consent sheets out of the store artwork. These permissions
  # affect only this disposable simulator and avoid UI-test races at launch.
  for service in notifications speech-recognition microphone; do
    xcrun simctl privacy "$simulator_id" grant "$service" "$DEMO_BUNDLE_ID" \
      >/dev/null 2>&1 || true
  done

  local args=()
  local test
  for test in "${TESTS[@]}"; do args+=("-only-testing:$test"); done
  TEST_RUNNER_STORE_SCREENSHOT_OUTPUT_DIR="$tmp_out" \
  TEST_RUNNER_DEMO_PAIRING_JSON="$(<"$PAIRING_FILE")" \
    xcodebuild test \
      -project ios/Omnesis.xcodeproj \
      -scheme OmnesisDemoUITests \
      -destination "$destination" \
      "${args[@]}" \
      >/tmp/omnesis-store-screenshots-$family.log 2>&1 || {
        tail -60 "/tmp/omnesis-store-screenshots-$family.log" >&2
        exit 1
      }

  local png width height count=0
  for png in "$tmp_out"/*.png; do
    [[ -f "$png" ]] || { echo "error: no $family screenshots were generated" >&2; exit 1; }
    width="$(sips -g pixelWidth "$png" | awk '/pixelWidth/ {print $2}')"
    height="$(sips -g pixelHeight "$png" | awk '/pixelHeight/ {print $2}')"
    [[ "$width" == "$expected_width" && "$height" == "$expected_height" ]] || {
      echo "error: $(basename "$png") is ${width}x${height}, expected ${expected_width}x${expected_height}" >&2
      exit 1
    }
    cp "$png" "$staged_out/$(basename "$png")"
    count=$((count + 1))
  done
  [[ "$count" == "${#TESTS[@]}" ]] || {
    echo "error: expected ${#TESTS[@]} $family screenshots, found $count" >&2
    exit 1
  }
  # Preserve the previous known-good family until the complete replacement
  # has built and passed count + dimension validation.
  rm -rf -- "$final_out"
  mv "$staged_out" "$final_out"
  xcrun simctl status_bar "$simulator_id" clear >/dev/null 2>&1 || true
}

export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
echo "==> Starting isolated synthetic gateway"
OMNESIS_CONFIG_DIR="$DEMO_CONFIG_DIR" OMNESIS_GATEWAY_PORT="$GATEWAY_PORT" \
  bash scripts/start-demo-gateway.sh start
wait_for_gateway

token="$(<"$DEMO_CONFIG_DIR/token")"
fingerprint="$(openssl x509 -in "$DEMO_CONFIG_DIR/tls/cert.pem" -noout -fingerprint -sha256 \
  | sed 's/://g' | awk -F= '{print tolower($2)}')"
printf '{"url":"https://localhost:%s","token":"%s","fingerprint":"%s","name":"Synthetic Review Gateway"}\n' \
  "$GATEWAY_PORT" "$token" "$fingerprint" >"$PAIRING_FILE"
wait_for_index

echo "==> Generating Xcode project"
(cd ios && xcodegen generate >/dev/null)
DEMO_BUNDLE_ID="$(scripts/ios-resolved-bundle-id.sh OmnesisDemo)"

echo "==> Capturing iPhone 6.9-inch set"
capture_family "$IPHONE_NAME" iphone-6.9 1320 2868

echo "==> Capturing iPad 13-inch set"
capture_family "$IPAD_NAME" ipad-13 2064 2752

echo "==> Capturing Apple Watch set"
bash scripts/shot-watch-ask.sh --states idle,answered --sizes large
mkdir -p "$OUT_ROOT/watch"
rm -f "$OUT_ROOT/watch"/*.png
cp /tmp/omnesis-watch-shots/large-idle.png "$OUT_ROOT/watch/01-ask.png"
cp /tmp/omnesis-watch-shots/large-answered.png "$OUT_ROOT/watch/02-answer.png"
for watch_png in "$OUT_ROOT/watch"/*.png; do
  width="$(sips -g pixelWidth "$watch_png" | awk '/pixelWidth/ {print $2}')"
  height="$(sips -g pixelHeight "$watch_png" | awk '/pixelHeight/ {print $2}')"
  [[ "$width" == 410 && "$height" == 502 ]] || {
    echo "error: $(basename "$watch_png") is ${width}x${height}, expected 410x502" >&2
    exit 1
  }
done

echo "App Store screenshots ready in $OUT_ROOT"
