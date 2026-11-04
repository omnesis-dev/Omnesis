#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# A lane's host resources over time: memory pressure, swap, paging, load,
# whether Spotlight is indexing (macOS) and the largest and busiest
# processes, every few seconds, so a slow lane shows whether the machine was
# starved and by what.
#
#   E2E_WORK=<scratch dir> scripts/install-e2e/host-sampler.sh start
#   E2E_WORK=<scratch dir> scripts/install-e2e/host-sampler.sh stop
#   E2E_WORK=<scratch dir> scripts/install-e2e/host-sampler.sh print
#
# `start` detaches a sampler that outlives the step; it ends on `stop`, when
# the scratch directory goes, or with the job. `print` stops it and writes
# what it gathered through the lane's redactor. Only process names, sizes and
# counts are recorded, never arguments, paths or environment; the supervised
# gateway and collector are named as such.
set -uo pipefail

E2E_WORK="${E2E_WORK:?set E2E_WORK}"
E2E_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$E2E_WORK/host-samples.log"
PID_FILE="$E2E_WORK/host-sampler.pid"
INTERVAL="${HOST_SAMPLER_INTERVAL:-10}"

# "<pid> <name>" for each supervised Omnesis daemon that is running.
daemon_pids() {
  local unit pid
  case "$(uname -s)" in
    Darwin)
      launchctl list 2>/dev/null |
        awk '$3 ~ /^dev\.omnesis\./ && $1 ~ /^[0-9]+$/ { sub(/^dev\.omnesis\./, "", $3); print $1, $3 }'
      ;;
    *)
      for unit in gateway collector; do
        pid="$(systemctl --user show -p MainPID --value "omnesis-$unit.service" 2>/dev/null)"
        [ -n "$pid" ] && [ "$pid" != 0 ] && echo "$pid $unit"
      done
      ;;
  esac
}

# Every process: pid, resident KiB, cpu%, name.
process_table() {
  case "$(uname -s)" in
    Darwin) ps -axo pid=,rss=,%cpu=,ucomm= ;;
    *) ps -eo pid=,rss=,%cpu=,comm= ;;
  esac
}

# The largest processes by resident size, then any of the busiest by CPU not
# already listed: pid, resident KiB, cpu%, threads, name.
top_processes() {
  local daemons table pid rss cpu threads name label
  daemons="$(daemon_pids)"
  # A function, not a `case` inside `$(...)`: macOS's bash 3.2 cannot parse
  # the latter.
  table="$(process_table)"
  {
    printf '%s\n' "$table" | sort -k2 -nr 2>/dev/null | head -12
    printf '%s\n' "$table" | sort -k3 -nr 2>/dev/null | head -6
  } | awk 'NF && !seen[$1]++' | while read -r pid rss cpu name; do
    case "$(uname -s)" in
      Darwin) threads="$(ps -M -p "$pid" 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')" ;;
      *) threads="$(awk '/^Threads:/ { print $2 }' "/proc/$pid/status" 2>/dev/null)" ;;
    esac
    label="$(printf '%s\n' "$daemons" | awk -v p="$pid" '$1 == p { print " (omnesis " $2 ")" }')"
    printf '  %6s %8sKiB cpu=%5s thr=%3s %s%s\n' "$pid" "$rss" "$cpu" "${threads:-?}" "$name" "$label"
  done
}

# Whether Spotlight indexes the system and data volumes, on one line.
spotlight_status() {
  local volume state
  for volume in / /System/Volumes/Data; do
    state="$(mdutil -s "$volume" 2>&1 | awk 'NR > 1 { gsub(/^[ \t]+|[ \t]+$/, ""); printf "%s", $0 }')"
    printf ' %s=%s' "$volume" "${state:-unknown}"
  done
}

sample_darwin() {
  printf '== %s load %s\n' "$(date -u +%H:%M:%S)" "$(sysctl -n vm.loadavg)"
  printf 'swap %s\n' "$(sysctl -n vm.swapusage)"
  printf 'spotlight%s\n' "$(spotlight_status)"
  memory_pressure -Q 2>/dev/null | sed 's/^/pressure /'
  vm_stat | awk '/page size|free|active|inactive|wired|compressor|Pageins|Pageouts|Swapins|Swapouts|Compressions|Decompressions/ { printf "%s ", $0 } END { print "" }' |
    tr -s ' '
  top_processes
}

sample_linux() {
  printf '== %s load %s\n' "$(date -u +%H:%M:%S)" "$(cut -d' ' -f1-3 /proc/loadavg)"
  free -m | awk '$1 == "Mem:" { printf "mem MiB total=%s used=%s available=%s ", $2, $3, $7 } $1 == "Swap:" { printf "swap MiB total=%s used=%s", $2, $3 } END { print "" }'
  grep -E '^(pswpin|pswpout|pgmajfault) ' /proc/vmstat | tr '\n' ' '
  echo
  top_processes
}

stop_sampler() {
  [ -f "$PID_FILE" ] || return 0
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  rm -f "$PID_FILE"
}

case "${1:-}" in
  start)
    mkdir -p "$E2E_WORK"
    stop_sampler
    : >"$OUT"
    (
      while [ -d "$E2E_WORK" ]; do
        case "$(uname -s)" in
          Darwin) sample_darwin ;;
          *) sample_linux ;;
        esac >>"$OUT" 2>&1
        sleep "$INTERVAL"
      done
    ) </dev/null >/dev/null 2>&1 &
    echo "$!" >"$PID_FILE"
    echo "host sampler started (pid $!), every ${INTERVAL}s into $OUT"
    ;;
  stop)
    stop_sampler
    ;;
  print)
    stop_sampler
    if [ -f "$OUT" ]; then
      printf '::group::Host samples\n'
      INSTALL_E2E_SECRETS_FILE="$E2E_WORK/secrets" node "$E2E_DIR/redact.mjs" <"$OUT" ||
        echo "the redactor failed; samples withheld"
      printf '::endgroup::\n'
    else
      echo "no host samples at $OUT"
    fi
    # Observation only: printing never decides the job's outcome.
    exit 0
    ;;
  *)
    echo "usage: host-sampler.sh start|stop|print" >&2
    exit 2
    ;;
esac
