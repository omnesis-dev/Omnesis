#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# The failure this workstream exists to remove: a release that cannot build,
# applied to a host that is serving. Without a rollback the operator is left
# with a checkout on a tag whose build failed, a node_modules belonging to it,
# and no working command to get back.
#
# The gateway host is pointed at `omnesis-broken.git`, whose newest tag
# (v9.9.3) carries a deliberate type error. That repository is a superset of
# the working one — same base commit, same v9.9.0 through v9.9.2 — so the
# update resolves v9.9.3 as a genuine forward target, takes its backup, and
# gets as far as the build before it fails. What is asserted afterwards is that the
# host is exactly where it started: the same commit, the same reported
# version, a clean tree, and a gateway that never stopped serving.
source "$(dirname "$0")/../lib.sh"

echo "== 04 a release that cannot build is rolled back =="

assert_eq "the gateway host starts on the working tag" "9.9.1" "$(installed_version gateway)"
assert_contains "the gateway is serving before the failed update" \
  '"version":"9.9.1"' "$(gateway_health_json)"
ref_before="$(on gateway "git -C $CHECKOUT rev-parse HEAD" | tr -d '\r\n')"
assert "the starting commit resolved" test -n "$ref_before"

# Point this host at the repository whose newest release cannot build. Every
# earlier tag is the same object, so nothing about the installed commit moves.
# The remote is restored on the way out however this scenario ends: leaving a
# kept topology aimed at the broken repository would make every later run of
# 03 fail for a reason that has nothing to do with the code under test.
on gateway "git -C $CHECKOUT remote set-url origin $FIXTURE_BROKEN_URL"
trap 'on gateway "git -C '"$CHECKOUT"' remote set-url origin '"$FIXTURE_URL"'" || true' EXIT

set +e
update_output="$(on gateway '~/.local/bin/omnesis update --yes 2>&1')"
update_status=$?
set -e
printf '%s\n' "$update_output" | tail -20

assert "the update failed loudly instead of reporting success" test "$update_status" -ne 0
# The build command is echoed twice before it runs, so only its FAILURE line
# distinguishes a build that broke from one that was never reached.
assert_contains "the failure named the build that broke" \
  '`npm run build` failed' "$update_output"
assert_contains "the update said it was rolling back" "Rolling back" "$update_output"

assert_eq "the checkout is back on the commit it was serving" \
  "$ref_before" "$(on gateway "git -C $CHECKOUT rev-parse HEAD" | tr -d '\r\n')"
assert_eq "the host still reports the working version" "9.9.1" "$(installed_version gateway)"

# The gateway was never stopped: the build failed before anything restarted,
# and the rollback put the tree back under the process that is still serving.
assert_contains "the gateway is still serving the working version" \
  '"version":"9.9.1"' "$(gateway_health_json)"

# A rolled-back checkout is a working checkout: the next update must be able
# to run, not refuse because the tree is dirty or half-installed.
clean="$(on gateway "git -C $CHECKOUT status --porcelain" | tr -d '\r\n')"
assert_eq "the rolled-back checkout is clean" "" "$clean"

echo "== 04 PASSED =="
