#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# The update, one machine at a time: newer release tags appear on the remote,
# and every host has to be brought to one with a command of its own.
#
# The target is named rather than left to "the newest tag". The remote carries
# a third release the fleet-update scenario moves to, so pinning v9.9.1 here
# keeps the two scenarios' subjects separate — and exercises the same
# `--target-version` a gateway-commanded device is run with.
#
# `omnesis update` does what each host's roles need. On the gateway host that
# starts with a backup taken through the gateway's own API, before anything
# irreversible happens. Neither container has a user service manager, so
# neither daemon is registered as a service and the updater reports the
# restart it may not perform rather than guessing at one — the restarts here
# are still done by hand, and the running gateway keeps serving the old build
# until they are.
#
# The device identity assertions are the important ones: an updated collector
# must come back as the SAME device, not a second row, because sources are
# owned by device id.
source "$(dirname "$0")/../lib.sh"

echo "== 03 update across two release tags =="

# ── the gateway host ────────────────────────────────────────────────────────
# The updater refuses to touch a checkout that is not installer-managed and
# clean, so this also proves the marker the installer left behind is read.
# The CLI is not attached to a terminal here, so its colour codes are
# suppressed; assertions match on the text, never on the decoration.
#
# The backup is counted rather than looked for by absence, so this scenario
# survives being re-run against a topology that `--keep` left up and already
# carries backups from an earlier pass.
backups_before="$(on gateway "~/.local/bin/omnesis backup --list | grep -c pre-update || true")"

update_output="$(on gateway '~/.local/bin/omnesis update --yes --target-version 9.9.1 2>&1')"
assert_eq "the gateway host moved to the newer tag" "9.9.1" "$(installed_version gateway)"

# The backup is the only way back from forward-only migrations, so the update
# takes it itself rather than recommending one.
assert_contains "the gateway host planned its own backup" \
  "back up the gateway's databases" "$update_output"
backups_after="$(on gateway "~/.local/bin/omnesis backup --list | grep -c pre-update || true")"
assert_eq "the update left one more pre-update backup than it found" \
  "$((backups_before + 1))" "$backups_after"

# No service manager in a container, so the gateway role is present but not
# supervised: the updater says what it cannot restart instead of restarting it.
assert_contains "the updater reported the gateway restart it may not perform" \
  "not registered as a service" "$update_output"
health_before_restart="$(gateway_health_json)"
assert_contains "the running gateway still serves the old version until restarted" \
  '"version":"9.9.0"' "$health_before_restart"

stop_gateway
start_gateway
wait_gateway_health
assert_contains "the restarted gateway serves the new version" \
  '"version":"9.9.1"' "$(gateway_health_json)"

# ── the collector host ──────────────────────────────────────────────────────
# A host that only collects has no corpus of its own, so its update takes no
# backup and only concerns its own daemon.
stop_collector
collector_output="$(on collector '~/.local/bin/omnesis update --yes --target-version 9.9.1 2>&1')"
assert_eq "the collector host moved to the newer tag" "9.9.1" "$(installed_version collector)"
assert_not_contains "the collector host took no backup — the corpus is not here" \
  "back up the gateway's databases" "$collector_output"
assert_contains "the updater reported the collector restart it may not perform" \
  "not registered as a service" "$collector_output"

start_collector
wait_collector_connected
wait_device_version collector 9.9.1

# Identity survived: still one collector device, not a fresh row beside it.
devices_after="$(on gateway '~/.local/bin/omnesis devices list')"
collector_rows="$(printf '%s' "$devices_after" | grep -c 'collector' || true)"
assert_eq "the updated collector is still one device" "1" "$collector_rows"

# The gateway knows what the collector is running: the version ledger reads a
# device's build from its hello. Asserted on the collector's own row — the
# gateway host's row carries the same version, so grepping the whole list
# would pass even with the collector row blank.
collector_row="$(printf '%s' "$devices_after" | grep 'collector' || true)"
assert_contains "the gateway sees the collector on the new release" "9.9.1" "$collector_row"

echo "== 03 PASSED =="
