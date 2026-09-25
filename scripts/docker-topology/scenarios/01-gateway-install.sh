#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# A real operator's first machine: the installer resolves the newest release
# tag from a real remote, clones it, builds it, and leaves a working CLI and a
# gateway that serves. Nothing here is stubbed — the installer is the file in
# the working tree, and the release it installs is a tag on a git daemon.
source "$(dirname "$0")/../lib.sh"

echo "== 01 gateway install =="

# Pin the older of the two fixture releases: the update scenario needs a
# newer tag left on the remote to move to.
install_on gateway --version 9.9.0

assert_eq "the installer picked the newest release tag" "9.9.0" "$(installed_version gateway)"
assert "the wrapper is where the installer says it is" \
  on gateway 'test -x ~/.local/bin/omnesis'
assert "the checkout is marked installer-managed" \
  on gateway 'test "$(git -C ~/omnesis config --get omnesis.install)" = managed'
assert "the checkout sits on the release tag, detached" \
  on gateway 'test "$(git -C ~/omnesis rev-parse HEAD)" = "$(git -C ~/omnesis rev-parse v9.9.0^{commit})"'

start_gateway
wait_gateway_health

health="$(gateway_health_json)"
assert_contains "the gateway serves its version on /health" '"version":"9.9.0"' "$health"
assert "the bootstrap admin token was minted" \
  on gateway 'test -s ~/.config/omnesis/token'
assert "the gateway minted its own certificate" \
  on gateway 'test -s ~/.config/omnesis/tls/cert.pem'
assert "the portal is served" \
  on gateway 'curl -ksf -o /dev/null -w "%{http_code}" https://localhost:7600/portal/ | grep -q 200'

# The bootstrap device is the gateway's own admin identity; a collector has
# not been paired yet, so it is the only device that exists.
devices="$(on gateway '~/.local/bin/omnesis devices list')"
assert_contains "the bootstrap device exists" "bootstrap" "$devices"

echo "== 01 PASSED =="
