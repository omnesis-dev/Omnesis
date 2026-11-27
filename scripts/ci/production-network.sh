#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Keep a CI test job away from production Omnesis services: omnesis.app and
# omnesis.dev, and every name under them (the cloud relay, each gateway's relay
# name, the DNS broker, the push relay, the account pages, the website and its
# installer). Test jobs only; the site and release workflows that publish to
# production never call this.
#
#   isolate  make those names unresolvable for everything on this runner, and
#            prove it with a deliberate lookup of the relay that must fail
#   verify   fail the job if anything in it asked for one of those names since
#
# The block sits below every program: a spawned gateway, a CLI, curl, Swift,
# the JVM, Chromium, the iOS simulators and, on Linux, Docker containers. Each
# refused question is recorded outside the code under test, so the job fails
# even when that code swallowed the lookup error.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    exec pwsh -NoLogo -NoProfile -NonInteractive -File "${ROOT}/scripts/ci/production-network.windows.ps1" "${1:-}"
    ;;
esac

DOMAINS=(omnesis.app omnesis.dev)
# The deliberate lookups that must fail: the relay and the installer's host.
PROBES=(relay.omnesis.app telemetry.omnesis.app omnesis.dev)
STATE="${RUNNER_TEMP:?RUNNER_TEMP is not set}/production-network"
BASELINE="${STATE}/baseline"
# Linux: the kernel log prefix of a refused question.
PREFIX="omnesis-production-dns: "
# macOS: the local DNS server that refuses and records every question.
SINK_PORT="5533"
SINK_RECORD="${STATE}/dns-sink.log"

block_linux() {
  # Log and reject every DNS question for one of these domains or a name under
  # it, at the packet level. A name travels as length-prefixed labels, so
  # "\x07omnesis\x03app\x00" ends the question exactly when it asks for
  # omnesis.app or a subdomain of it, and no other name. OUTPUT covers the runner's own processes, the
  # systemd-resolved stub and the Docker daemon's resolver; DOCKER-USER covers
  # containers that ask the runner's upstream server directly.
  local name tool chain proto reject
  for tool in iptables ip6tables; do
    command -v "$tool" >/dev/null || continue
    for chain in OUTPUT DOCKER-USER; do
      sudo "$tool" -n -L "$chain" >/dev/null 2>&1 || continue
      for name in '|07|omnesis|03|app|00|' '|07|omnesis|03|dev|00|'; do
        for proto in udp tcp; do
          reject=(-j REJECT)
          [[ "$proto" == tcp ]] && reject+=(--reject-with tcp-reset)
          sudo "$tool" -I "$chain" 1 -p "$proto" --dport 53 \
            -m string --algo bm --icase --hex-string "$name" "${reject[@]}"
          sudo "$tool" -I "$chain" 1 -p "$proto" --dport 53 \
            -m string --algo bm --icase --hex-string "$name" -j LOG --log-prefix "$PREFIX"
        done
      done
    done
  done
  if command -v resolvectl >/dev/null; then sudo resolvectl flush-caches || true; fi
}

block_macos() {
  # A /etc/resolver file sends every question for a domain and the names under
  # it to one server, here the sink, which refuses and records each one.
  local domain
  nohup python3 "${ROOT}/scripts/ci/dns-sink.py" "$SINK_PORT" "$SINK_RECORD" \
    >"${STATE}/dns-sink.out" 2>&1 &
  local tries=0
  until grep -q '^ready$' "${STATE}/dns-sink.out" 2>/dev/null; do
    ((++tries < 50)) || {
      echo "::error::the DNS sink never reported that it was listening" >&2
      cat "${STATE}/dns-sink.out" >&2
      return 1
    }
    sleep 0.2
  done
  sudo mkdir -p /etc/resolver
  for domain in "${DOMAINS[@]}"; do
    printf 'nameserver 127.0.0.1\nport %s\ntimeout 2\n' "$SINK_PORT" |
      sudo tee "/etc/resolver/${domain}" >/dev/null
  done
  sudo dscacheutil -flushcache
  sudo killall -HUP mDNSResponder || true
}

# Refused questions recorded so far, one line each.
refusals() {
  case "$(uname -s)" in
    Linux) sudo dmesg 2>/dev/null | grep -F "$PREFIX" || true ;;
    Darwin) cat "$SINK_RECORD" 2>/dev/null || true ;;
  esac
}

# Resolution through the system resolver, as curl, Swift, the JVM, Chromium
# and Node resolve. Fails when the name does not resolve.
system_resolves() {
  NODE_OPTIONS="" node -e '
    require("node:dns").lookup(process.argv[1], (error, address) => {
      console.error(`${process.argv[1]}: ${error ? error.code : address}`);
      process.exit(error ? 1 : 0);
    });
    setTimeout(() => process.exit(1), 20000).unref();
  ' "$1"
}

isolate() {
  mkdir -p "$STATE"
  case "$(uname -s)" in
    Linux) block_linux ;;
    Darwin) block_macos ;;
    *)
      echo "::error::no production network block for $(uname -s)" >&2
      return 1
      ;;
  esac
  local before probe
  for probe in "${PROBES[@]}"; do
    before="$(refusals | wc -l)"
    if system_resolves "$probe"; then
      echo "::error::${probe} still resolves on this runner after the block" >&2
      return 1
    fi
    if (($(refusals | wc -l) <= before)); then
      echo "::error::the lookup of ${probe} failed but no refusal was recorded" >&2
      return 1
    fi
  done
  # The block takes only these names: anything else still resolves.
  system_resolves github.com || {
    echo "::error::the block broke name resolution for everything else" >&2
    return 1
  }
  refusals | wc -l >"$BASELINE"
  echo "${DOMAINS[*]} and every name under them are unreachable from this job."
}

verify() {
  if [[ ! -f "$BASELINE" ]]; then
    echo "::error::no production network baseline at ${BASELINE}; was the job isolated?" >&2
    return 1
  fi
  local seen
  seen="$(refusals | tail -n "+$(($(cat "$BASELINE") + 1))")"
  if [[ -n "$seen" ]]; then
    echo "::error::this test job asked for production Omnesis names (${DOMAINS[*]}):" >&2
    echo "$seen" >&2
    return 1
  fi
  echo "Nothing in this job asked for ${DOMAINS[*]}."
}

case "${1:-}" in
  isolate) isolate ;;
  verify) verify ;;
  *)
    echo "usage: $0 isolate|verify" >&2
    exit 2
    ;;
esac
