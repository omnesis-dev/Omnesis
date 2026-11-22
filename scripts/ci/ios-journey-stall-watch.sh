#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Watch an iOS journey run and, when a journey fails, record what the
# simulator's networking was doing at that moment.
#
# Usage: scripts/ci/ios-journey-stall-watch.sh <simulator-udid> <xcodebuild-log> <out-dir>
#
# A journey on a hosted runner can find every new TLS connection from the
# simulator stalled for minutes, the app's and the UI test runner's alike,
# while the gateway sits idle (#1206). The client side of a TLS handshake
# asks the simulator's trust service (trustd) to evaluate the certificate,
# so a stall there is invisible to the gateway's logs. On each of the first
# three failures the xcodebuild log reports, this takes, at the same moment,
# a stack sample of the simulator's trustd and securityd, of the app and of
# the test runner, and the simulator's security and network log for the
# minutes before. It runs until it is killed.
set -uo pipefail

udid="${1:?simulator udid}"
xcodebuild_log="${2:?xcodebuild log}"
out="${3:?output directory}"
mkdir -p "$out"

# Host process ids of a simulator process, by the path of its executable. A
# simulator's processes are host processes started from its runtime root or
# from the app bundles installed on it.
pids_of() {
  pgrep -f "$1" 2>/dev/null | tr '\n' ' '
}

# A stack sample of one process for three seconds. `sample` needs no
# privileges for the user's own processes; spindump, as root, reaches the ones
# `sample` may not attach to.
sample_process() {
  local name="$1" pid="$2" dir="$3"
  if ! sample "$pid" 3 -mayDie -file "$dir/sample-$name-$pid.txt" >/dev/null 2>&1; then
    sudo -n spindump "$pid" 3 -o "$dir/spindump-$name-$pid.txt" >/dev/null 2>&1 \
      || echo "could not sample $name ($pid)" >>"$dir/capture-errors.txt"
  fi
}

capture() {
  local dir="$1"
  mkdir -p "$dir"
  date -u '+%Y-%m-%dT%H:%M:%SZ' >"$dir/captured-at.txt"
  ps -axo pid,ppid,stat,%cpu,etime,command >"$dir/processes.txt" 2>&1
  local name pattern pid
  for entry in \
    "trustd=RuntimeRoot/usr/libexec/trustd" \
    "securityd=RuntimeRoot/usr/libexec/securityd" \
    "app=OmnesisDemo.app/OmnesisDemo" \
    "runner=OmnesisDemoUITests-Runner.app/OmnesisDemoUITests-Runner"; do
    name="${entry%%=*}"
    pattern="${entry#*=}"
    for pid in $(pids_of "$pattern"); do
      sample_process "$name" "$pid" "$dir" &
    done
  done
  xcrun simctl spawn "$udid" log show --last 5m --info --style compact --predicate '
    process == "trustd" OR process == "securityd"
    OR (process IN {"OmnesisDemo", "OmnesisDemoUITests-Runner"}
        AND (subsystem BEGINSWITH "com.apple.network" OR subsystem BEGINSWITH "com.apple.CFNetwork"
             OR subsystem BEGINSWITH "com.apple.security" OR subsystem == "com.apple.securityd"))' \
    >"$dir/simulator-network.log" 2>&1
  wait
}

seen=0
captures=0
while ((captures < 3)); do
  sleep 3
  failures="$(grep -c ': error: -\[' "$xcodebuild_log" 2>/dev/null || true)"
  failures="${failures:-0}"
  if ((failures > seen)); then
    seen="$failures"
    captures=$((captures + 1))
    capture "$out/failure-$captures"
  fi
done
