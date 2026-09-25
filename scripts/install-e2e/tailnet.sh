# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# shellcheck shell=bash disable=SC2034 # sourced: the variables are for the caller
# Tailnet helpers for the two-machine lane (sourced after lib.sh).
#
# The tailnet's own name must never reach a public log: the MagicDNS suffix
# is registered as a secret as soon as it is known, so the runner masks it and
# the redactor drops it. Node names are neutral and per run.

MAILBOX_PORT="${E2E_MAILBOX_PORT:-8765}"

# Read one field of `tailscale status --json` without printing the status.
ts_field() {
  tailscale status --json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      const j = JSON.parse(s);
      const v = (0, eval)("(j) => " + process.argv[1])(j);
      if (v === undefined || v === null || v === "") process.exit(3);
      process.stdout.write(String(v));
    });' "$1"
}

# Mask the tailnet's DNS suffix and this node's tailnet address, and export
# TS_SUFFIX / TS_SELF_IP for the caller.
ts_register() {
  TS_SUFFIX="$(ts_field 'j.MagicDNSSuffix')" || die "the tailnet has no MagicDNS suffix (is MagicDNS on?)"
  secret "$TS_SUFFIX"
  TS_SELF_IP="$(tailscale ip -4 | head -1)"
  secret "$TS_SELF_IP"
  export TS_SUFFIX TS_SELF_IP
}

# Wait until a peer answers `tailscale ping`, for up to $2 seconds.
ts_wait_peer() {
  local host="$1" deadline=$(($(date +%s) + $2))
  until tailscale ping -c 1 --timeout 5s "$host" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || die "peer $host never answered tailscale ping"
    sleep 5
  done
  log "peer $host answers on the tailnet"
}

# Make sure a MagicDNS name resolves through the system resolver, which is
# what the installer, curl and the CLI use. Returns non-zero when it does not.
resolves() {
  node -e 'require("node:dns").lookup(process.argv[1], (err) => process.exit(err ? 1 : 0))' "$1"
}

ts_wait_resolves() {
  local fqdn="$1" deadline=$(($(date +%s) + $2))
  until resolves "$fqdn"; do
    [ "$(date +%s)" -lt "$deadline" ] || die "$fqdn does not resolve through the system resolver"
    sleep 3
  done
}
