#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# An agent harness added to a machine that already runs a collector. The
# `--openclaw` role on such a host must connect with the CLI already there:
# it may not move the checkout the running collector was built from, rewrite
# the launcher it started through, rebuild either, or arm a keyring that
# would seal the collector's credentials.
#
# The pairing code is deliberately one the gateway never minted. A real
# connect would then wait for someone to approve its sign-in in the portal,
# which this lane has no one to do; a refused code stops it right after the
# installer has chosen how to run it — the choice this scenario is about — and
# after the connect has reached the gateway with the installed CLI.
source "$(dirname "$0")/../lib.sh"

echo "== 06 a harness role on a collector host =="

# The harness is never installed by the role; its home is what makes this a
# machine the role accepts.
on collector 'mkdir -p ~/.openclaw'

# What the role must leave alone. The running collector keeps writing its own
# state under the config directory, so that part is the files an install or a
# keyring would change: the credential, the trust, the settings, the install
# record, and whatever the keyring directory holds.
snapshot() {
  on collector "git -C $CHECKOUT rev-parse HEAD; git -C $CHECKOUT status --porcelain; \
    sha256sum ~/.local/bin/omnesis; \
    cd ~/.config/omnesis && for f in collector-token tls/cert.pem .env update-state.json; do \
      [ -e \"\$f\" ] && sha256sum \"\$f\"; done; ls -A keyring 2>/dev/null; true"
}

before="$(snapshot)"
collector_pid_before="$(on collector 'cat ~/collector.pid' | tr -d '\r\n')"
fp="$(gateway_fingerprint)"

set +e
output="$(on collector "sh /opt/install.sh --openclaw --gateway-url $GATEWAY_URL \
  --trust-fingerprint sha256:$fp --code 0000000000 2>&1")"
status=$?
set -e
printf '%s\n' "$output" | tail -20

assert "the connect with a code the gateway never minted failed" test "$status" -ne 0
assert_contains "the role used the install already on this host" \
  "This machine already runs Omnesis" "$output"
assert_contains "and the connect reached the gateway before it was refused" \
  "Connecting OpenClaw failed" "$output"
assert_not_contains "nothing was built" "npm ci" "$output"
assert_eq "the checkout, the launcher and the config directory are untouched" \
  "$before" "$(snapshot)"
assert "no keyring was armed on the collector host" \
  on collector 'test ! -e ~/.config/omnesis/keyring/secret-files-required && test ! -e ~/.config/omnesis/keyring/storage-encryption-required'
assert_eq "the collector kept running" \
  "$collector_pid_before" "$(on collector 'cat ~/collector.pid' | tr -d '\r\n')"
assert "and it is still running" \
  on collector "kill -0 $collector_pid_before"
wait_device_online collector

echo "== 06 PASSED =="
