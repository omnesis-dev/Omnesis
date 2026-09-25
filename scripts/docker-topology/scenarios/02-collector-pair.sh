#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# The second machine, in one command. `install.sh --collector` installs the
# CLI, redeems a pairing code minted on the gateway against a certificate it
# verifies by fingerprint rather than trusting on sight, and saves the device
# token the collector daemon authenticates with.
#
# The code crosses out of band and is passed with --code, which is what the
# role exists for on an unattended host; the terminal prompt it uses otherwise
# is covered by the installer's own pseudo-terminal tests.
#
# The two refusals at the end go through `omnesis pair` rather than the role a
# second time: they are about the redeem the role performs, and re-running the
# role would re-clone and rebuild the whole workspace to reach the same call.
source "$(dirname "$0")/../lib.sh"

echo "== 02 collector pairing =="

# Mint a pairing code on the gateway and print it. The code is the only thing
# that crosses between the hosts, and it crosses out of band.
mint_pairing_code() {
  on gateway '~/.local/bin/omnesis devices pair --kind collector --json' | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const match = s.match(/"pairingCode"\s*:\s*"([A-F0-9]+)"/i) ?? s.match(/\b([A-F0-9]{10})\b/);
    if (!match) { console.error("no pairing code in: " + s); process.exit(1); }
    process.stdout.write(match[1]);
  });
'
}

# The redeem the collector role performs, run on its own so a refusal can be
# observed without paying for a second source install.
redeem_on_collector() {
  local code="$1" pin="$2"
  on collector "~/.local/bin/omnesis pair $code --gateway-url $GATEWAY_URL \
    --trust-fingerprint sha256:$pin --save /tmp/redeem-attempt-token"
}

code="$(mint_pairing_code)"
assert "a pairing code was minted" test -n "$code"

fp="$(gateway_fingerprint)"
assert "the gateway certificate has a fingerprint to pin" test -n "$fp"

# The one-liner. A container has no user service manager, so `install_on`'s
# --no-service leaves the daemon to this lane to start — everything else in the
# role runs for real: the CLI install, the pin, the redeem, and the token.
install_on collector --collector --version 9.9.0 \
  --gateway-url "$GATEWAY_URL" --trust-fingerprint "sha256:$fp" --code "$code"

assert_eq "the collector host has the same release" "9.9.0" "$(installed_version collector)"
assert "the wrapper is where the installer says it is" \
  on collector 'test -x ~/.local/bin/omnesis'
assert "the role saved the device token" \
  on collector 'test -s ~/.config/omnesis/collector-token'
assert "redeeming pinned the gateway certificate for the daemon" \
  on collector 'test -s ~/.config/omnesis/tls/cert.pem'
assert "the pinned certificate is the one the gateway serves" \
  on collector "test \"\$(openssl x509 -in ~/.config/omnesis/tls/cert.pem -outform DER | sha256sum | cut -d' ' -f1)\" = $fp"
assert "the collector minted a durable install identity" \
  on collector 'test -s ~/.config/omnesis/install-id'
# `install_on` passes --no-service to every host in this lane, so an absent
# unit proves nothing about the role. A gateway's databases would exist on any
# host that had ever started one, and those are the role's own doing.
assert "the role started no gateway on the collector host" \
  on collector 'test ! -e ~/.config/omnesis/omnesis.db && test ! -e ~/.config/omnesis/index.db'

start_collector
wait_collector_connected
wait_device_online collector

devices="$(on gateway '~/.local/bin/omnesis devices list')"
assert_contains "the gateway lists the collector device" "collector" "$devices"

# A second redeem of a spent code must fail: the code is one-shot.
if redeem_on_collector "$code" "$fp" >/dev/null 2>&1; then
  echo "  FAILED: a spent pairing code was accepted a second time" >&2
  exit 1
fi
echo "  ok: a spent pairing code is refused"

# A pin the served certificate does not match must refuse, rather than fall
# back to trusting whatever answered. A fresh code proves the refusal is the
# pin's doing and not the spent code's.
bogus="$(printf 'b%.0s' $(seq 64))"
fresh_code="$(mint_pairing_code)"
if redeem_on_collector "$fresh_code" "$bogus" >/dev/null 2>&1; then
  echo "  FAILED: a certificate that did not match the pin was accepted" >&2
  exit 1
fi
assert "the refused redeem wrote no token" \
  on collector 'test ! -e /tmp/redeem-attempt-token'
echo "  ok: a fingerprint the certificate does not match is refused"

echo "== 02 PASSED =="
