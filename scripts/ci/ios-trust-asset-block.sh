#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Keep an iOS simulator's trust service (trustd) from updating its trust data
# from Apple while a CI job runs, because each update stops every TLS
# connection in the simulator.
#
#   block   make Apple's trust asset servers unresolvable on this macOS
#           runner, before the simulator boots, and prove it
#   report  print which of those names were asked for, and whether trustd
#           still updated its trust data (OMNESIS_JOURNEY_IOS_UDID names the
#           simulator; a warning when it did)
#
# Every TLS handshake in a simulator, the app's and a UI test runner's, asks
# the simulator's trustd to evaluate the server's certificate, on one serial
# queue. A fresh simulator's trustd fetches newer trust data from Apple's
# MobileAsset servers whenever it starts and whenever mobileassetd announces a
# new catalog, so during a long job it starts several downloads. Installing
# the pinning rules of a PKITrustSupplementals asset rewrites trustd's pinning
# database in one exclusive SQLite transaction, which took minutes on a hosted
# runner; every evaluation reads that database and waits, so every handshake
# waits (#1253). A new PKITrustStore asset makes trustd exit and hand over to a
# new process, and evaluations wait for that too (#1206). Without the servers
# trustd keeps the trust data the simulator runtime ships with.
#
# The simulator resolves names through the host, so a /etc/resolver file for a
# domain sends every question for it and the names under it to a loopback DNS
# server that refuses and records each one (`dns-sink.py`, as
# `production-network.sh` uses for production Omnesis names).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Where trustd's trust data comes from: MobileAsset catalogs and assets, the
# asset metadata service, the CDNs that serve assets and their cache locator,
# and the certificate revocation (Valid) database.
DOMAINS=(
  mesu.apple.com
  gdmf.apple.com
  updates.cdn-apple.com
  updates-http.cdn-apple.com
  appldnld.apple.com
  lcdn-locator.apple.com
  valid.apple.com
)
STATE="${RUNNER_TEMP:?RUNNER_TEMP is not set}/ios-trust-assets"
SINK_PORT="5534"
SINK_RECORD="${STATE}/dns-sink.log"

# trustd messages that mean newer trust data reached the simulator: a download
# began after a catalog arrived, a pinning or Valid database update ran, or
# trustd announced that it will exit to load a new trust store.
UPDATES='begin download of OTATrust asset|Received asset download notification|New asset path obtained|Will exit when clean|Pinning database should update|updating asset version from|download started at|update started at'

# Resolution through the system resolver, as the simulator resolves. Fails
# when the name does not resolve.
system_resolves() {
  NODE_OPTIONS="" node -e '
    require("node:dns").lookup(process.argv[1], (error, address) => {
      console.error(`${process.argv[1]}: ${error ? error.code : address}`);
      process.exit(error ? 1 : 0);
    });
    setTimeout(() => process.exit(1), 20000).unref();
  ' "$1"
}

# Count completed records only; a not-yet-created journal has no evidence.
sink_record_lines() {
  if [[ ! -e "$SINK_RECORD" ]]; then
    printf '0\n'
    return
  fi
  wc -l <"$SINK_RECORD" | tr -d '[:space:]'
}

recorded_domain_after() {
  local domain="$1" boundary="$2" complete
  complete="$(sink_record_lines)" || return 1
  if ((complete <= boundary)); then
    printf '0\n'
    return
  fi
  head -n "$complete" "$SINK_RECORD" | awk -v boundary="$boundary" -v domain="$domain" '
    NR > boundary && NF == 5 &&
    $1 ~ /^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/ &&
    $2 == "DNS" && $3 == "query" && $4 == "for" && tolower($5) == domain { count++ }
    END { print count + 0 }
  '
}

block() {
  if [[ "$(uname -s)" != Darwin ]]; then
    echo "::error::the iOS trust asset block is for macOS runners only" >&2
    return 1
  fi
  mkdir -p "$STATE"
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
  local domain
  sudo mkdir -p /etc/resolver
  for domain in "${DOMAINS[@]}"; do
    printf 'nameserver 127.0.0.1\nport %s\ntimeout 2\n' "$SINK_PORT" |
      sudo tee "/etc/resolver/${domain}" >/dev/null
  done
  # One evidence epoch for the complete installed configuration. Background
  # queries after this boundary can qualify their own later negative probe.
  local configuration_start
  configuration_start="$(sink_record_lines)"
  sudo dscacheutil -flushcache
  sudo killall -HUP mDNSResponder || true

  local refusals
  for domain in "${DOMAINS[@]}"; do
    if system_resolves "$domain"; then
      echo "::error::${domain} still resolves on this runner after the block" >&2
      return 1
    fi
    refusals="$(recorded_domain_after "$domain" "$configuration_start")"
    if ((refusals == 0)); then
      echo "::error::the lookup of ${domain} failed but no matching refusal was recorded for this configuration" >&2
      return 1
    fi
  done
  system_resolves github.com || {
    echo "::error::the block broke name resolution for everything else" >&2
    return 1
  }
  wc -l <"$SINK_RECORD" | tr -d ' ' >"${STATE}/baseline"
  echo "Apple's trust asset servers (${DOMAINS[*]}) are unreachable from this job."
}

report() {
  local baseline=0
  [[ -f "${STATE}/baseline" ]] && baseline="$(cat "${STATE}/baseline")"
  echo "Questions for Apple's trust asset servers refused since the block (count, first, last, name):"
  if [[ -f "$SINK_RECORD" ]]; then
    tail -n "+$((baseline + 1))" "$SINK_RECORD" | awk '
      { name = tolower($NF); count[name]++; if (!(name in first)) first[name] = $1; last[name] = $1 }
      END { for (name in count) printf "%6d  %s  %s  %s\n", count[name], first[name], last[name], name }
    ' | sort -rn
  fi

  local udid="${OMNESIS_JOURNEY_IOS_UDID:-}"
  [[ -n "$udid" ]] || return 0
  local log activity
  if ! log="$(xcrun simctl spawn "$udid" log show --last 3h --info --style compact \
    --predicate 'process == "trustd" AND category IN {"OTATrust", "pinningDb", "validupdate"}' 2>&1)"; then
    echo "::warning::could not read the simulator's trust service log: ${log##*$'\n'}"
    return 0
  fi
  if ! grep -q 'trustd\[' <<<"$log"; then
    echo "::warning::the simulator's trust service logged nothing about its trust data"
    return 0
  fi
  activity="$(grep -E "$UPDATES" <<<"$log" || true)"
  if [[ -z "$activity" ]]; then
    echo "The simulator's trust service updated none of its trust data."
    return 0
  fi
  echo "::warning::the simulator's trust service still updated its trust data; every TLS connection in the simulator waits while it does:"
  echo "$activity"
}

case "${1:-}" in
  block) block ;;
  report) report ;;
  *)
    echo "usage: $0 block|report" >&2
    exit 2
    ;;
esac
