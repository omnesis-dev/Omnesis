#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# A lane's host resources over time: memory pressure, swap, paging, load and
# the largest processes, every few seconds, so a slow lane shows whether the
# machine was starved and by what.
#
#   E2E_WORK=<scratch dir> scripts/install-e2e/host-sampler.sh start
#   E2E_WORK=<scratch dir> scripts/install-e2e/host-sampler.sh print
#
# `start` detaches a sampler that outlives the step; the runner ends it with
# the job. `print` writes what it gathered. Only process names, sizes and
# counts are recorded: no arguments, paths or environment.
set -uo pipefail

E2E_WORK="${E2E_WORK:?set E2E_WORK}"
mkdir -p "$E2E_WORK"
OUT="$E2E_WORK/host-samples.log"
INTERVAL="${HOST_SAMPLER_INTERVAL:-10}"

sample_darwin() {
  printf '== %s load %s\n' "$(date -u +%H:%M:%S)" "$(sysctl -n vm.loadavg)"
  printf 'swap %s\n' "$(sysctl -n vm.swapusage)"
  memory_pressure -Q 2>/dev/null | sed 's/^/pressure /'
  vm_stat | awk '/free|active|inactive|wired|compressor|Pageins|Pageouts|Swapins|Swapouts|Compressions|Decompressions/ { printf "%s ", $0 } END { print "" }' |
    tr -s ' '
  # pid, resident KiB, cpu%, threads (from ps -M line count), command name
  ps -axo pid=,rss=,%cpu=,comm= | sort -k2 -nr 2>/dev/null | head -12 | while read -r pid rss cpu comm; do
    threads="$(ps -M -p "$pid" 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')"
    printf '  %6s %8sKiB cpu=%5s thr=%3s %s\n' "$pid" "$rss" "$cpu" "$threads" "$(basename "$comm")"
  done
}

sample_linux() {
  printf '== %s load %s\n' "$(date -u +%H:%M:%S)" "$(cut -d' ' -f1-3 /proc/loadavg)"
  free -m | awk 'NR>1 { printf "%s ", $0 } END { print "" }' | tr -s ' '
  grep -E '^(pswpin|pswpout|pgmajfault) ' /proc/vmstat | tr '\n' ' '
  echo
  ps -eo pid=,rss=,%cpu=,nlwp=,comm= --sort=-rss 2>/dev/null | head -12 |
    awk '{ printf "  %6s %8sKiB cpu=%5s thr=%3s %s\n", $1, $2, $3, $4, $5 }'
}

case "${1:-}" in
  start)
    : >"$OUT"
    (
      while :; do
        case "$(uname -s)" in
          Darwin) sample_darwin ;;
          *) sample_linux ;;
        esac >>"$OUT" 2>&1
        sleep "$INTERVAL"
      done
    ) </dev/null >/dev/null 2>&1 &
    echo "host sampler started (pid $!), every ${INTERVAL}s into $OUT"
    ;;
  print)
    [ -f "$OUT" ] && cat "$OUT" || echo "no host samples at $OUT"
    ;;
  *)
    echo "usage: host-sampler.sh start|print" >&2
    exit 2
    ;;
esac
