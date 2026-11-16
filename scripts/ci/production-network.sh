#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Keep a CI test job away from production Omnesis services: omnesis.app and
# every name under it (the cloud relay, each gateway's relay name, the DNS
# broker, the push relay, the account pages). Test jobs only; the site and
# release workflows that publish to production never call this.
#
#   isolate  make those names unresolvable on this runner, preload the Node
#            tripwire into every later step, and prove that both hold
#   verify   fail the job if anything in it tried to reach one of them
#
# The DNS block covers every program on the runner, Node or not, the
# simulators that use the host's resolver and, on Linux, Docker containers.
# The tripwire records each attempt by a Node process (including spawned
# gateways, CLIs and worker threads), so the job fails even when the code
# under test swallowed the lookup error.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOMAIN="omnesis.app"
PROBE="relay.${DOMAIN}"
# A copy outside the checkout, so a lane that replaces its checkout keeps it.
TRIPWIRE="${RUNNER_TEMP:?RUNNER_TEMP is not set}/omnesis-network-tripwire.cjs"
LOG="${RUNNER_TEMP}/production-network-tripwire.log"
# macOS: nothing listens on the discard port, so a query sent there is refused.
BLACKHOLE_ADDRESS="127.0.0.1"
BLACKHOLE_PORT="9"

block_linux() {
  # Reject every DNS query for omnesis.app or a name under it at the packet
  # level: the name travels as length-prefixed labels, so "\x07omnesis\x03app\x00"
  # ends the query name exactly when it is that domain or a subdomain of it.
  # OUTPUT covers the runner's own processes, the systemd-resolved stub and the
  # Docker daemon's resolver; DOCKER-USER covers containers that ask the
  # runner's upstream server directly. This works the same on every Ubuntu
  # release, unlike resolver routing.
  local name='|07|omnesis|03|app|00|' tool chain
  for tool in iptables ip6tables; do
    command -v "$tool" >/dev/null || continue
    for chain in OUTPUT DOCKER-USER; do
      sudo "$tool" -n -L "$chain" >/dev/null 2>&1 || continue
      sudo "$tool" -I "$chain" 1 -p udp --dport 53 -m string --algo bm --icase \
        --hex-string "$name" -j REJECT
      sudo "$tool" -I "$chain" 1 -p tcp --dport 53 -m string --algo bm --icase \
        --hex-string "$name" -j REJECT --reject-with tcp-reset
    done
  done
  if command -v resolvectl >/dev/null; then sudo resolvectl flush-caches || true; fi
}

block_macos() {
  # A /etc/resolver file scopes a resolver to a domain and every name under it.
  sudo mkdir -p /etc/resolver
  printf 'nameserver %s\nport %s\ntimeout 1\n' "$BLACKHOLE_ADDRESS" "$BLACKHOLE_PORT" | sudo tee "/etc/resolver/${DOMAIN}" >/dev/null
  sudo dscacheutil -flushcache
  sudo killall -HUP mDNSResponder || true
}

# Resolution through the system resolver, the way curl, Swift, the JVM and
# Chromium resolve: fails when the name does not resolve.
system_resolves() {
  NODE_OPTIONS="" node -e '
    require("node:dns").lookup(process.argv[1], (error, address) => {
      console.error(`${process.argv[1]}: ${error ? error.code : address}`);
      process.exit(error ? 1 : 0);
    });
    setTimeout(() => process.exit(1), 15000).unref();
  ' "$1"
}

isolate() {
  case "$(uname -s)" in
    Linux) block_linux ;;
    Darwin) block_macos ;;
    *)
      echo "::error::no production network block for $(uname -s)" >&2
      return 1
      ;;
  esac
  if system_resolves "$PROBE"; then
    echo "::error::${PROBE} still resolves on this runner after the block" >&2
    return 1
  fi
  # The block must take only these names: anything else still resolves.
  system_resolves github.com || {
    echo "::error::the ${DOMAIN} block broke name resolution for everything else" >&2
    return 1
  }

  cp -f "${ROOT}/scripts/ci/network-tripwire.cjs" "$TRIPWIRE"
  # The tripwire refuses and records the probe in a scratch record, not the job's.
  local proof
  proof="$(mktemp)"
  if OMNESIS_NETWORK_TRIPWIRE_LOG="$proof" NODE_OPTIONS="--require ${TRIPWIRE}" node -e '
    require("node:dns").lookup(process.argv[1], (error) => process.exit(error?.code === "ENOTFOUND" ? 0 : 1));
  ' "$PROBE" 2>/dev/null && grep -q "blocked dns.lookup(${PROBE})" "$proof"; then
    rm -f "$proof"
  else
    rm -f "$proof"
    echo "::error::the Node network tripwire did not refuse and record ${PROBE}" >&2
    return 1
  fi

  : >"$LOG"
  {
    echo "OMNESIS_NETWORK_TRIPWIRE_LOG=${LOG}"
    echo "NODE_OPTIONS=${NODE_OPTIONS:+${NODE_OPTIONS} }--require ${TRIPWIRE}"
  } >>"${GITHUB_ENV:?GITHUB_ENV is not set}"
  echo "${DOMAIN} and every name under it are unreachable from this job."
}

verify() {
  if [[ ! -f "$LOG" ]]; then
    echo "::error::no tripwire record at ${LOG}; was the job isolated?" >&2
    return 1
  fi
  if [[ -s "$LOG" ]]; then
    echo "::error::this test job tried to reach production Omnesis services (${DOMAIN}):" >&2
    cat "$LOG" >&2
    return 1
  fi
  echo "Nothing in this job tried to reach ${DOMAIN}."
}

case "${1:-}" in
  isolate) isolate ;;
  verify) verify ;;
  *)
    echo "usage: $0 isolate|verify" >&2
    exit 2
    ;;
esac
