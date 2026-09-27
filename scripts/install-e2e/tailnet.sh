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

# The Mac's name resolution, after the Tailscale action has run.
#
# On macOS the action points the Ethernet service's DNS at MagicDNS
# (100.100.100.100) whenever the tailnet has MagicDNS on. The standalone
# tailscaled then forwards every non-tailnet name to the nameservers it read
# from /etc/resolv.conf, and it reads that file again on every change to its
# network map: any node joining or leaving the tailnet, including the other
# lane's. By then the file lists only 100.100.100.100, which tailscaled skips,
# so it is left with no upstream and answers SERVFAIL for every public name.
# npm, git and the runner's own connection to GitHub all lose DNS mid-job.
#
# So the collector joins with --accept-dns=false (the workflow passes it),
# gets back the Ethernet settings the workflow saved before the action ran
# (none saved, or none set, means the DHCP ones), and reaches the one tailnet
# name it needs, the gateway's, through a pinned /etc/hosts entry
# (ts_pin_host).
ts_restore_system_dns() {
  [ "$(uname -s)" = Darwin ] || return 0
  local servers domains
  servers="$(saved_dns_values "$E2E_WORK/dns-servers" '^[0-9A-Fa-f:.]+$')"
  domains="$(saved_dns_values "$E2E_WORK/dns-search-domains" '^[A-Za-z0-9.-]+$')"
  # shellcheck disable=SC2086 # one argument per saved value
  sudo networksetup -setdnsservers Ethernet ${servers:-Empty}
  # shellcheck disable=SC2086
  sudo networksetup -setsearchdomains Ethernet ${domains:-Empty}
  flush_dns_cache
}

# The lines of a saved `networksetup -get…` listing that match $2, space
# separated. The "There aren't any … set" line matches neither pattern.
saved_dns_values() {
  grep -E "$2" "$1" 2>/dev/null | tr '\n' ' ' || true
}

flush_dns_cache() {
  [ "$(uname -s)" = Darwin ] || return 0
  sudo dscacheutil -flushcache
  sudo killall -HUP mDNSResponder 2>/dev/null || true
}

# Pin a peer's tailnet address under a name in /etc/hosts. The address is
# masked before anything could print it.
ts_pin_host() {
  local node="$1" name="$2" ip
  ip="$(tailscale ip -4 "$node" 2>/dev/null | head -1)" || true
  [ -n "$ip" ] || die "peer $node has no tailnet address"
  secret "$ip"
  printf '%s %s\n' "$ip" "$name" | sudo tee -a /etc/hosts >/dev/null
  flush_dns_cache
}

# Fail fast when this machine can no longer resolve or reach the public
# hosts the lane depends on, instead of letting npm retry for minutes or the
# runner lose its connection to GitHub. Each host gets about a minute.
ts_check_internet() {
  local host tries
  for host in registry.npmjs.org github.com; do
    tries=0
    until resolves "$host" && curl -sS -o /dev/null --max-time 10 "https://$host/" 2>/dev/null; do
      tries=$((tries + 1))
      if [ "$tries" -ge 6 ]; then
        if grep -q '^nameserver 100\.100\.100\.100' /etc/resolv.conf 2>/dev/null; then
          die "cannot resolve or reach $host after joining the tailnet: the system resolver is MagicDNS (100.100.100.100)"
        fi
        die "cannot resolve or reach $host after joining the tailnet"
      fi
      sleep 5
    done
  done
  log "public DNS and HTTPS still work"
}
