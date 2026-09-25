#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# The fleet update, unfaked: one command on the gateway machine brings that
# machine to a new release and then tells the second machine to bring itself.
#
# Nothing is downloaded by the gateway and no code crosses the socket. The
# command carries a version; the collector runs its OWN `omnesis update`
# against its OWN remote, which is what the two refusals asserted here defend.
#
# The ordering guarantee gets its proof from a property of this lane rather
# than a mock: a container has no user service manager, so the first
# `--fleet` run updates the checkout and cannot restart the gateway. The
# gateway therefore keeps serving the previous release, and the fan-out must
# refuse rather than tell every device to move past the build serving them.
# Once the gateway is restarted by hand the same command fans out for real.
source "$(dirname "$0")/../lib.sh"

echo "== 05 fleet update =="

assert_eq "the gateway host starts on the release 03 left" "9.9.1" "$(installed_version gateway)"
assert_eq "the collector host starts on the same release" "9.9.1" "$(installed_version collector)"
assert_contains "the gateway is serving that release" \
  '"version":"9.9.1"' "$(gateway_health_json)"

# ── the fan-out refuses while the gateway is still on the old build ─────────
# `--fleet` does this host first. Here that moves the checkout to v9.9.2 and
# reports the gateway restart it may not perform, so the running process is
# still serving 9.9.1 when the fleet step is reached.
set +e
first_run="$(on gateway '~/.local/bin/omnesis update --yes --fleet 2>&1')"
first_status=$?
set -e
printf '%s\n' "$first_run" | tail -20

assert_eq "the gateway host moved to the newest release" "9.9.2" "$(installed_version gateway)"
assert "the fleet step failed rather than fanning out" test "$first_status" -ne 0
assert_contains "it refused because the gateway is still serving the old build" \
  "still serving 9.9.1" "$first_run"
assert_eq "the collector host was left exactly where it was" \
  "9.9.1" "$(installed_version collector)"

# ── the gateway comes back on the new build ────────────────────────────────
stop_gateway
start_gateway
wait_gateway_health
assert_contains "the restarted gateway serves the new release" \
  '"version":"9.9.2"' "$(gateway_health_json)"
# The collector was not restarted, so its log still carries the authentication
# line from before the gateway went away — only the gateway's own view of the
# socket says the reconnect landed, and the fan-out below needs that socket.
wait_device_online collector

# ── the same command now fans out ──────────────────────────────────────────
# The host is already on the target, so nothing is rebuilt here; what runs is
# the fan-out. The collector receives the command over the socket it already
# holds, runs its own update, reports the result and exits for its supervisor
# — which a container does not have, so this scenario plays the supervisor.
# `--fleet` then waits until the collector is back on the target, so it runs
# in the background while the collector is restarted.
fleet_output="$(mktemp)"
on gateway '~/.local/bin/omnesis update --yes --fleet 2>&1' </dev/null >"$fleet_output" 2>&1 &
fleet_pid=$!

# The collector is doing `npm ci` and a build of its own; give it the same
# budget an install gets before deciding it failed.
#
# What is waited on is the daemon's OWN account of the outcome, not the
# version the CLI reports: `git checkout --detach` moves the tree in the first
# seconds, so a version poll goes green minutes before the build it depends on
# has finished.
deadline=$((SECONDS + 1500))
while ((SECONDS < deadline)); do
  on collector 'grep -q "Self-update to 9.9.2" ~/collector.log' && break
  sleep 5
done
collector_log="$(on collector 'cat ~/collector.log')"
assert_contains "the collector reported its own update installed" \
  "Self-update to 9.9.2: installed" "$collector_log"
assert_eq "the collector updated ITSELF to the version it was told" \
  "9.9.2" "$(installed_version collector)"

# It ran its own local update, with the restart withheld: the daemon reports
# and exits rather than restarting from inside the build it is running. The
# version is one argv token, so it can never be read as a separate flag.
assert_contains "the collector ran its own update against its own remote" \
  "update --yes --no-restart --target-version=9.9.2" "$collector_log"
assert_contains "the collector exited for its supervisor after installing" \
  "exiting so the service manager restarts this collector" "$collector_log"

start_collector
wait_collector_connected
wait_device_online collector
wait_device_version collector 9.9.2

set +e
wait "$fleet_pid"
fleet_status=$?
set -e
second_run="$(cat "$fleet_output")"
rm -f "$fleet_output"
printf '%s\n' "$second_run" | tail -20
assert "the fan-out finished once the collector came back" test "$fleet_status" -eq 0
assert_contains "the fan-out named the collector and the version it must reach" \
  "9.9.1 → 9.9.2" "$second_run"
assert_contains "the collector took the command" "dispatched" "$second_run"
assert_contains "and the fan-out saw it arrive on the target" ": updated" "$second_run"

# ── the loop closes on the device list ─────────────────────────────────────
# The shared wait above accounts for the gateway's short device-cache tick.
devices="$(on gateway '~/.local/bin/omnesis devices list')"
collector_row="$(printf '%s' "$devices" | grep 'collector' || true)"
printf '%s\n' "$devices"
assert_contains "the gateway sees the collector on the new release" "9.9.2" "$collector_row"
assert_contains "and reads it as current" "current" "$collector_row"

# Nothing is owed any more: a second `--fleet` finds no device behind.
third_run="$(on gateway '~/.local/bin/omnesis update --yes --fleet 2>&1')"
assert_contains "a fleet already on the target is asked for nothing" \
  "No device needs updating." "$third_run"

# ── the refusal that makes a commanded update safe ─────────────────────────
# A version the remote has no tag for is refused before a single git command
# runs against it. This is what stops a mistaken or compromised gateway from
# making a host check out arbitrary code.
set +e
bogus="$(on collector '~/.local/bin/omnesis update --yes --target-version 9.9.99 2>&1')"
bogus_status=$?
set -e
assert "an unresolvable target failed" test "$bogus_status" -ne 0
assert_contains "and said why" "No release v9.9.99 exists" "$bogus"
assert_eq "the collector host did not move" "9.9.2" "$(installed_version collector)"
clean="$(on collector "git -C $CHECKOUT status --porcelain" | tr -d '\r\n')"
assert_eq "and its checkout is untouched" "" "$clean"

echo "== 05 PASSED =="
