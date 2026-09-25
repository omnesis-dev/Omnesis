#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Empirically probes whether simctl drives a notification service extension
# that replaces a constant wake with fetched content and sets a badge. Builds
# with simulator signing ON because keychain sharing and extension entitlements
# are the point of the test.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/boot_budget
source "${ROOT}/scripts/lib/boot_budget"
HOST="${OMNESIS_EPIC_MACOS_HOST:-}"
DEVELOPMENT_TEAM="${OMNESIS_IOS_DEVELOPMENT_TEAM:-}"
PORT="${OMNESIS_IOS_PUSH_SPIKE_PORT:-17835}"
REMOTE_WORKTREE="${OMNESIS_EPIC_MACOS_IOS_PUSH_WORKTREE:-\$HOME/omnesis-ios-push-spike}"
DEVICE_NAME="${OMNESIS_IOS_PUSH_SPIKE_DEVICE:-iPhone 17}"
BUNDLE_ID="${OMNESIS_IOS_PUSH_SPIKE_BUNDLE_ID:-dev.omnesis.ios}"
READY_TIMEOUT="$(gateway_boot_budget_seconds)"
SSH_CMD=(ssh -o ControlMaster=no -o ControlPath=none)
RSYNC_RSH="ssh -o ControlMaster=no -o ControlPath=none"

[[ -n "$HOST" ]] || { echo "ios-push-spike: OMNESIS_EPIC_MACOS_HOST is required" >&2; exit 78; }
[[ "$HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
  echo "ios-push-spike: invalid macOS SSH alias" >&2
  exit 64
}
[[ -n "$DEVELOPMENT_TEAM" ]] || { echo "ios-push-spike: OMNESIS_IOS_DEVELOPMENT_TEAM is required" >&2; exit 78; }
[[ "$BUNDLE_ID" =~ ^[A-Za-z][A-Za-z0-9.-]+$ ]] || { echo "ios-push-spike: invalid bundle id" >&2; exit 64; }
[[ "$DEVELOPMENT_TEAM" =~ ^[A-Z0-9]{10}$ ]] || { echo "ios-push-spike: invalid development team" >&2; exit 64; }
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || {
  echo "ios-push-spike: invalid fixture port" >&2
  exit 64
}
[[ "$DEVICE_NAME" =~ ^[A-Za-z0-9.()[:space:]-]+$ ]] || {
  echo "ios-push-spike: invalid simulator device name" >&2
  exit 64
}
[[ "$REMOTE_WORKTREE" =~ ^(\$HOME)?/[A-Za-z0-9._/-]+$ ]] || {
  echo "ios-push-spike: remote scratch path contains unsupported characters" >&2
  exit 64
}

TMP="$(mktemp -d /tmp/omnesis-ios-push-spike.XXXXXX)"
FIXTURE_PID=""
TUNNEL_PID=""
cleanup() {
  [[ -n "$TUNNEL_PID" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  [[ -n "$FIXTURE_PID" ]] && kill "$FIXTURE_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

HOST_HOME="$("${SSH_CMD[@]}" "$HOST" 'printf %s "$HOME"')"
case "$REMOTE_WORKTREE" in
  '$HOME/'*) RESOLVED_TARGET="$HOST_HOME/${REMOTE_WORKTREE#\$HOME/}" ;;
  *) RESOLVED_TARGET="$REMOTE_WORKTREE" ;;
esac
[[ "$RESOLVED_TARGET" =~ ^/[A-Za-z0-9._/-]+$ ]] || {
  echo "ios-push-spike: remote scratch path contains unsupported characters" >&2
  exit 64
}
case "$RESOLVED_TARGET" in */_work/*|*/_work) echo "ios-push-spike: refusing CI checkout $RESOLVED_TARGET" >&2; exit 1;; esac
[[ "$RESOLVED_TARGET" != "$HOST_HOME" ]] || { echo "ios-push-spike: refusing host HOME" >&2; exit 1; }
if "${SSH_CMD[@]}" "$HOST" "test -e \"$RESOLVED_TARGET/.omnesis-primary\""; then
  echo "ios-push-spike: refusing primary checkout $RESOLVED_TARGET" >&2
  exit 1
fi

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
FINGERPRINT="$(openssl x509 -in "$TMP/cert.pem" -fingerprint -sha256 -noout | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')"
STATE="$TMP/fixture.jsonl"
: >"$STATE"
python3 "$ROOT/scripts/fixtures/notification-claim-server.py" \
  --port "$PORT" --cert "$TMP/cert.pem" --key "$TMP/key.pem" --state "$STATE" &
FIXTURE_PID=$!

READY_DEADLINE=$((SECONDS + READY_TIMEOUT))
while (( SECONDS < READY_DEADLINE )); do
  curl -skf "https://localhost:$PORT/health" >/dev/null && break
  sleep 0.1
done
curl -skf "https://localhost:$PORT/health" >/dev/null || { echo "fixture did not start" >&2; exit 1; }

"${SSH_CMD[@]}" -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -N \
  -R "127.0.0.1:$PORT:127.0.0.1:$PORT" "$HOST" &
TUNNEL_PID=$!
READY_DEADLINE=$((SECONDS + READY_TIMEOUT))
while (( SECONDS < READY_DEADLINE )); do
  "${SSH_CMD[@]}" "$HOST" "curl -skf https://localhost:$PORT/health >/dev/null" && break
  sleep 0.25
done
"${SSH_CMD[@]}" "$HOST" "curl -skf https://localhost:$PORT/health >/dev/null" || {
  echo "reverse tunnel did not expose the isolated fixture" >&2
  exit 1
}

PAIRING="$TMP/pairing.json"
PAYLOAD="$TMP/wake.json"
python3 -c 'import json,sys; json.dump({"url":sys.argv[1],"token":"spike-device-token","claimToken":"spike-claim-token","fingerprint":sys.argv[2],"deviceId":"device_spike","name":"Push Spike Fixture"},open(sys.argv[3],"w"))' \
  "https://localhost:$PORT" "$FINGERPRINT" "$PAIRING"
python3 -c 'import json,sys; json.dump({"aps":{"alert":{"title":"Omnesis","body":"Omnesis has something for you"},"mutable-content":1,"sound":"default"}},open(sys.argv[1],"w"),separators=(",",":"))' "$PAYLOAD"

"${SSH_CMD[@]}" "$HOST" "mkdir -p \"$RESOLVED_TARGET/ios\""
rsync -e "$RSYNC_RSH" -az --delete --exclude '.build' --exclude 'Omnesis.xcodeproj' --exclude 'DerivedData' --exclude 'Local.xcconfig' \
  "$ROOT/ios/" "$HOST:$RESOLVED_TARGET/ios/"
rsync -e "$RSYNC_RSH" -az "$PAIRING" "$PAYLOAD" "$HOST:$RESOLVED_TARGET/"

REMOTE_PAIRING="$RESOLVED_TARGET/$(basename "$PAIRING")"
REMOTE_PAYLOAD="$RESOLVED_TARGET/$(basename "$PAYLOAD")"
REMOTE_REPORT="$RESOLVED_TARGET/delivered.json"
REMOTE_PIPELINE="$RESOLVED_TARGET/notification-pipeline.log"

printf -v REMOTE_COMMAND 'bash -l -s -- %q %q %q %q %q %q %q %q' \
  "$RESOLVED_TARGET" "$DEVICE_NAME" "$BUNDLE_ID" "$DEVELOPMENT_TEAM" \
  "$REMOTE_PAIRING" "$REMOTE_PAYLOAD" "$REMOTE_REPORT" "$REMOTE_PIPELINE"

"${SSH_CMD[@]}" "$HOST" "$REMOTE_COMMAND" <<'REMOTE_SCRIPT'
  set -euo pipefail
  RESOLVED_TARGET="$1"
  DEVICE_NAME="$2"
  BUNDLE_ID="$3"
  DEVELOPMENT_TEAM="$4"
  REMOTE_PAIRING="$5"
  REMOTE_PAYLOAD="$6"
  REMOTE_REPORT="$7"
  REMOTE_PIPELINE="$8"
  REMOTE_DERIVED="$RESOLVED_TARGET/DerivedData"
  REMOTE_XCODEBUILD_LOG=$(mktemp "$RESOLVED_TARGET/xcodebuild.log.XXXXXX")
  trap 'rm -f "$REMOTE_XCODEBUILD_LOG"' EXIT

  cd "$RESOLVED_TARGET/ios"
  rm -f Local.xcconfig
  xcodegen generate >/dev/null
  DEVICE_ID=$(xcrun simctl list devices available | grep -F "$DEVICE_NAME (" | head -1 | grep -oE '[A-F0-9-]{36}')
  test -n "$DEVICE_ID"
  xcrun simctl boot "$DEVICE_ID" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$DEVICE_ID" -b >/dev/null
  xcrun simctl uninstall "$DEVICE_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
  rm -f "$REMOTE_REPORT"
  xcodebuild build-for-testing \
    -project Omnesis.xcodeproj \
    -scheme OmnesisPushSpikeUITests \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=$DEVICE_ID" \
    -derivedDataPath "$REMOTE_DERIVED" \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
    OMNESIS_BUNDLE_ID="$BUNDLE_ID" \
    >"$REMOTE_XCODEBUILD_LOG" 2>&1 || {
      tail -120 "$REMOTE_XCODEBUILD_LOG" >&2
      exit 1
    }
  APP="$REMOTE_DERIVED/Build/Products/Debug-iphonesimulator/Omnesis.app"
  xcrun simctl install "$DEVICE_ID" "$APP"
  DATA_CONTAINER=$(xcrun simctl get_app_container "$DEVICE_ID" "$BUNDLE_ID" data)
  mkdir -p "$DATA_CONTAINER/Documents"
  cp "$REMOTE_PAIRING" "$DATA_CONTAINER/Documents/pairing.json"
  TEST_RUNNER_PUSH_SPIKE_PAIRING_FILE_NAME="pairing.json" xcodebuild test-without-building \
    -project Omnesis.xcodeproj \
    -scheme OmnesisPushSpikeUITests \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=$DEVICE_ID" \
    -derivedDataPath "$REMOTE_DERIVED" \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
    -only-testing:OmnesisPushSpikeUITests/PushPermissionUITests/testGrantNotificationPermission \
    >"$REMOTE_XCODEBUILD_LOG" 2>&1 || {
      tail -120 "$REMOTE_XCODEBUILD_LOG" >&2
      exit 1
    }
  DATA_CONTAINER=$(xcrun simctl get_app_container "$DEVICE_ID" "$BUNDLE_ID" data)
  test -f "$DATA_CONTAINER/Documents/pairing.json"
  APP_REPORT="$DATA_CONTAINER/Documents/delivered.json"
  rm -f "$APP_REPORT"
  EXT="$APP/PlugIns/OmnesisNotificationService.appex"
  APP_XCENT=$(find "$REMOTE_DERIVED/Build/Intermediates.noindex" -path '*Omnesis.build/Omnesis.app-Simulated.xcent' -print -quit)
  EXT_XCENT="$REMOTE_DERIVED/Build/Intermediates.noindex/Omnesis.build/Debug-iphonesimulator/OmnesisNotificationService.build/OmnesisNotificationService.appex-Simulated.xcent"
  test -d "$EXT"
  test -f "$APP_XCENT"
  codesign --verify --deep --strict "$APP"
  test "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.usernotifications.time-sensitive' "$APP_XCENT")" = "true"
  test "$(/usr/libexec/PlistBuddy -c 'Print :application-identifier' "$EXT_XCENT")" = "$DEVELOPMENT_TEAM.$BUNDLE_ID.notification-service"
  test "$(/usr/libexec/PlistBuddy -c 'Print :keychain-access-groups:0' "$EXT_XCENT")" = "$DEVELOPMENT_TEAM.$BUNDLE_ID.notifications"
  test "$(plutil -extract OmnesisKeychainAccessGroup raw "$EXT/Info.plist")" = "$DEVELOPMENT_TEAM.$BUNDLE_ID.notifications"
  xcrun simctl spawn "$DEVICE_ID" pluginkit -m -A -D -i "$BUNDLE_ID.notification-service" \
    | grep -F "$BUNDLE_ID.notification-service" >/dev/null
  xcrun simctl terminate "$DEVICE_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
  xcrun simctl push "$DEVICE_ID" "$BUNDLE_ID" "$REMOTE_PAYLOAD"
  sleep 4
  env SIMCTL_CHILD_PUSH_SPIKE_INSPECT_PATH="$APP_REPORT" \
    xcrun simctl launch --terminate-running-process "$DEVICE_ID" "$BUNDLE_ID" >/dev/null
  REPORT_FOUND=0
  for _ in $(seq 1 40); do
    if test -s "$APP_REPORT"; then
      cp "$APP_REPORT" "$REMOTE_REPORT"
      REPORT_FOUND=1
      break
    fi
    sleep 0.25
  done
  xcrun simctl spawn "$DEVICE_ID" log show --last 30s --info --debug --style compact 2>/dev/null \
    | grep -E "CoreSimulatorBridge|Adding notification request|$BUNDLE_ID.notification-service" \
    >"$REMOTE_PIPELINE" || true
  if test "$REPORT_FOUND" != 1; then
    echo 'post-delivery inspection report was not written' >&2
    exit 1
  fi
REMOTE_SCRIPT

rsync -e "$RSYNC_RSH" -az "$HOST:$REMOTE_REPORT" "$TMP/delivered.json"
rsync -e "$RSYNC_RSH" -az "$HOST:$REMOTE_PIPELINE" "$TMP/notification-pipeline.log"
CLASSIFICATION="$TMP/classification.json"
python3 "$ROOT/scripts/fixtures/classify-ios-push-spike.py" \
  "$TMP/delivered.json" "$STATE" "$TMP/notification-pipeline.log" >"$CLASSIFICATION"
RESULT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["result"])' "$CLASSIFICATION")"
python3 -m json.tool "$CLASSIFICATION"
case "$RESULT" in
  positive)
    echo "SPIKE_RESULT=positive"
    echo "The extension-set interruption level and badge survived post-delivery inspection."
    ;;
  negative)
    echo "SPIKE_RESULT=negative"
    echo "The extension claimed, confirmed, and rewrote the notification, but interruption level or badge did not survive."
    ;;
  *)
    echo "SPIKE_RESULT=blocked-extension-completion-not-proven" >&2
    echo "This is not evidence for either interruption-level product branch." >&2
    exit 1
    ;;
esac
