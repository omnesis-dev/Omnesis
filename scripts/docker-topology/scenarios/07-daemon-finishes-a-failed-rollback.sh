#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# A rollback that fails, and the daemon that finishes it.
#
# The failure is a real one. The collector host is pointed at the repository
# whose newest release cannot build, and for the length of that one update its
# npm stops installing once the build has failed — a disk that filled, a
# registry that went away. So the update fails at its build, and the rollback
# fails at `npm ci`, twice, as it retries from an empty node_modules. That
# leaves what the update leaves on a real machine: a record at "rolling-back"
# and a tree with no dependencies.
#
# An operator repairs that with `omnesis update`. A daemon under a service
# manager cannot, and used to exit on every start until someone did. What is
# asserted here is that the collector's next start restores the release it ran
# before, by itself, and that a start which cannot is not repeated every few
# seconds. A container has no service manager, so this scenario plays it.
source "$(dirname "$0")/../lib.sh"

echo "== 07 a daemon finishes a failed rollback =="

STATE='~/.config/omnesis/update-state.json'
MARKER='~/.config/omnesis/update-recovery-attempt'
phase() { on collector "node -p 'JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")).phase' $STATE" | tr -d '\r\n'; }
collector_head() { on collector "git -C $CHECKOUT rev-parse HEAD" | tr -d '\r\n'; }

assert_eq "the collector host starts on the release 05 left" "9.9.2" "$(installed_version collector)"
assert_eq "with a completed update record" "complete" "$(phase)"
ref_before="$(collector_head)"
wait_device_online collector

# ── an update whose rollback cannot install ────────────────────────────────
# The shim is the first npm on PATH for this one command. It is the real npm
# until a build has failed; from then on `npm ci` fails, which is the rollback.
on collector 'mkdir -p ~/fault-bin && cat > ~/fault-bin/npm <<"SHIM"
#!/bin/sh
real=/usr/local/bin/npm
if [ "${1:-}" = ci ] && [ -e "$HOME/fault-bin/build-failed" ]; then
  echo "npm ci: the fault under test (no space left on device)" >&2
  exit 1
fi
if [ "${1:-}" = run ] && [ "${2:-}" = build ]; then
  "$real" "$@" || { status=$?; : > "$HOME/fault-bin/build-failed"; exit "$status"; }
  exit 0
fi
exec "$real" "$@"
SHIM
chmod +x ~/fault-bin/npm; rm -f ~/fault-bin/build-failed'
on collector "git -C $CHECKOUT remote set-url origin $FIXTURE_BROKEN_URL"
trap 'on collector "git -C '"$CHECKOUT"' remote set-url origin '"$FIXTURE_URL"'; rm -rf ~/fault-bin" || true' EXIT

set +e
update_output="$(on collector 'PATH="$HOME/fault-bin:$PATH" ~/.local/bin/omnesis update --yes 2>&1')"
update_status=$?
set -e
printf '%s\n' "$update_output" | tail -12
assert "the update failed" test "$update_status" -ne 0
assert_contains "at the build of the release that cannot build" '`npm run build` failed' "$update_output"
assert_contains "and its rollback failed too" "The rollback also failed at" "$update_output"
assert_eq "the record is left at rolling-back" "rolling-back" "$(phase)"

# The collector that was running is the supervisor's to restart; from here on
# every start goes through the launcher over that record.
stop_collector
on collector "git -C $CHECKOUT remote set-url origin $FIXTURE_URL"

# ── everything but a daemon is still refused ───────────────────────────────
set +e
refused="$(on collector '~/.local/bin/omnesis status 2>&1')"
refused_status=$?
set -e
assert "an ordinary command is refused over the unfinished update" test "$refused_status" -ne 0
assert_contains "and sent to omnesis update" "Run 'omnesis update' before starting another command" "$refused"
assert_eq "which changed nothing" "rolling-back" "$(phase)"

# ── a start that cannot restore is not repeated every few seconds ──────────
on collector ': > ~/fault-bin/build-failed'
set +e
first="$(on collector "PATH=\"\$HOME/fault-bin:\$PATH\" OMNESIS_GATEWAY_URL=$GATEWAY_URL timeout 300 ~/.local/bin/omnesis collector run 2>&1")"
first_status=$?
second="$(on collector "PATH=\"\$HOME/fault-bin:\$PATH\" OMNESIS_GATEWAY_URL=$GATEWAY_URL timeout 300 ~/.local/bin/omnesis collector run 2>&1")"
second_status=$?
set -e
assert "a start whose restore fails exits" test "$first_status" -eq 1
assert_contains "after trying to restore the last completed release" \
  "Restoring the last completed release before starting" "$first"
assert_contains "and saying it could not" "Could not restore source dependencies" "$first"
assert "the next start exits too" test "$second_status" -eq 1
assert_contains "without installing again" "attempted less than 15 minutes ago" "$second"
assert_not_contains "so nothing was restored a second time" \
  "Restoring the last completed release before starting" "$second"
assert_eq "the record is still unfinished" "rolling-back" "$(phase)"

# ── fifteen minutes on, with the fault gone, the daemon restores itself ────
on collector "touch -d '16 minutes ago' $MARKER"
start_collector
wait_collector_connected 1200
collector_log="$(on collector 'cat ~/collector.log')"
assert_contains "the collector restored the last completed release before starting" \
  "Restoring the last completed release before starting" "$collector_log"
assert_contains "and rebuilt it" "Restored the last completed build" "$collector_log"
assert_eq "the record is complete again" "complete" "$(phase)"
assert_eq "on the commit that had completed" "$ref_before" "$(collector_head)"
assert_eq "the host reports the release it ran before" "9.9.2" "$(installed_version collector)"
assert "nothing is left to say a restore is owed" on collector "test ! -e $MARKER"
assert "the update lock was released" on collector 'test ! -e ~/.config/omnesis/update.lock'
clean="$(on collector "git -C $CHECKOUT status --porcelain" | tr -d '\r\n')"
assert_eq "the restored checkout is clean" "" "$clean"
wait_device_online collector
wait_device_version collector 9.9.2

# The update that failed was not applied again, and ordinary commands work.
assert "an ordinary command runs again" on collector '~/.local/bin/omnesis --version >/dev/null'

echo "== 07 PASSED =="
