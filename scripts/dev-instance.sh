#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# One command to stand up ONE observable, isolated HTTPS Omnesis instance the
# agent can immediately drive `cli`/curl against — replacing the multi-step
# worktree dance (manual OMNESIS_CONFIG_DIR / port / DB-path / token wiring).
#
# It is a thin, fail-loud wrapper around scripts/synth-gateway.sh: it reuses
# that script's gateway + collector boot, then layers (1) a bounded,
# deterministic /health readiness gate so "ready" means actually-serving, and
# (2) an `info` subcommand that prints the URL / TOKEN / CA-cert triple in
# copy-paste form so the next shell can hit the instance with zero guesswork.
#
# It NEVER touches live state: it spawns its own processes on a HIGH port under
# its own isolated config dir, never the live gateway, port 7600, or
# ~/.config/omnesis.
#
# Usage:
#   scripts/dev-instance.sh start            # boot a SYNTHETIC instance (default universe), seeded
#   scripts/dev-instance.sh start --bare     # boot synthetic but add sources yourself via the portal
#   scripts/dev-instance.sh start --real     # boot with REAL sources (synthetic mode OFF, nothing seeded)
#   scripts/dev-instance.sh start --universe <name>   # a specific synthetic universe
#   scripts/dev-instance.sh info             # print URL / TOKEN / CA-cert triple (copy-paste form)
#   scripts/dev-instance.sh stop             # stop gateway + collector (keeps config dir on disk)
#
# Configuration (all optional, generic defaults — nothing operator-private):
#   OMNESIS_CONFIG_DIR     isolated config dir   (default: /tmp/omnesis-dev-instance)
#   OMNESIS_GATEWAY_PORT   high port to serve on  (default: 17600 — the fleet's
#                          isolated-worktree convention; never the live 7600)
#   OMNESIS_SYNTH_UNIVERSE synthetic universe     (default: default)
#   OMNESIS_DEV_READY_TIMEOUT  seconds to wait for /health 200 (default: the
#                          shared gateway boot budget, scripts/lib/gateway-boot-budget.json)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYNTH="${ROOT}/scripts/synth-gateway.sh"

# One boot budget across everything that spawns a gateway — see the `why` field
# in scripts/lib/gateway-boot-budget.json.
# shellcheck source=lib/boot_budget
source "${ROOT}/scripts/lib/boot_budget"

# Isolated defaults. The high port keeps us clear of the live gateway (7600)
# and the OAuth callback ports (3000-3003). Override via env for parallel
# instances. Both this script and the delegated synth-gateway.sh read the same
# env vars, so they always agree on the config dir + port.
CONFIG_DIR="${OMNESIS_CONFIG_DIR:-/tmp/omnesis-dev-instance}"
PORT="${OMNESIS_GATEWAY_PORT:-17600}"
URL="https://localhost:${PORT}"
TOKEN_FILE="${CONFIG_DIR}/token"
CA_CERT="${CONFIG_DIR}/tls/cert.pem"
READY_TIMEOUT="${OMNESIS_DEV_READY_TIMEOUT:-$(gateway_boot_budget_seconds)}"

# Refuse to point at the live instance even if the env is misconfigured. This
# is a hard safety rail: an isolated dev instance must never collide with the
# operator's live setup.
guard_isolation() {
  if [[ "${PORT}" == "7600" ]]; then
    echo "REFUSING TO START: port 7600 is the live gateway's reserved port." >&2
    echo "Set OMNESIS_GATEWAY_PORT to a high port (e.g. 17600)." >&2
    exit 4
  fi
  if [[ "${CONFIG_DIR}" == "${HOME}/.config/omnesis" ]]; then
    echo "REFUSING TO START: ${CONFIG_DIR} is the live config dir." >&2
    echo "Set OMNESIS_CONFIG_DIR to an isolated path (e.g. /tmp/omnesis-dev-instance)." >&2
    exit 4
  fi
}

# Reap stale sibling instances: any /tmp/omnesis-dev-instance* or
# /tmp/omnesis-shot-portal* config dir older than MAX_AGE hours gets its
# recorded PIDs killed (PID-file-based — never a pattern kill) and the dir
# removed. Instances leak when a test run or agent session is killed mid-flight;
# without this they accumulate ~1.4 GiB of RSS each on the shared box. The live
# gateway is untouchable by construction: its config dir is ~/.config/omnesis,
# never under /tmp. Quiet and tolerant — reaping must never fail a start.
# kill_pid_tree: group TERM→KILL with confirmation, shared with
# synth-gateway.sh so both scripts kill instance trees the same way.
source "${ROOT}/scripts/lib/kill_tree"

# Kill every gateway/collector process whose OMNESIS_CONFIG_DIR is exactly OUR
# config dir. Evidence-based (env read from /proc), never a pattern kill.
# Catches generations a past stop leaked: each start overwrites the PID files,
# so the PID-file path can no longer see older survivors — but a leaked
# collector still holds its providers' sessions (a second WhatsApp connection
# on the same creds mutually evicts the live one in a 440-conflict loop), and
# a leaked gateway keeps the port, so a fresh gateway loses the bind and the
# readiness gate green-lights the WRONG process. Linux-only (/proc); a no-op
# elsewhere.
sweep_own_generations() {
  [[ -r /proc/self/environ ]] || return 0
  local pid cfg
  for pid in $(pgrep -f 'gateway/src/index.ts|collector/src/main.ts' 2>/dev/null || true); do
    [[ -r "/proc/${pid}/environ" ]] || continue   # exited while we walked the list
    cfg="$(tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null |
      grep -m1 '^OMNESIS_CONFIG_DIR=' | cut -d= -f2-)" || continue
    [[ "${cfg}" == "${CONFIG_DIR}" ]] || continue
    if kill_pid_tree "${pid}"; then
      echo "swept leftover instance process pid=${pid} (${CONFIG_DIR})"
    else
      echo "WARNING: leftover pid=${pid} survived TERM+KILL" >&2
    fi
  done
  return 0
}

# Recover instances whose config dir is already gone but whose processes live on.
# Such a process is unambiguously garbage — it serves a DB that no longer exists
# and no dir remains to tie it back to an instance, so the dir-globbing reap can
# never see it again. This is evidence-based, not a pattern kill: every PID is
# confirmed to point at a deleted /tmp instance dir before it is signalled.
#
# Covers the collector as well as the gateway: synth-gateway.sh boots both as
# `nohup … &` daemons under the same config dir, so both strand the same way.
# Linux-only (needs /proc to read the environment); a no-op elsewhere.
reap_orphans() {
  [[ -r /proc/self/environ ]] || return 0
  local pid cfg age_s what
  for pid in $(pgrep -f 'gateway/src/index.ts|collector/src/main.ts' 2>/dev/null || true); do
    [[ -r "/proc/${pid}/environ" ]] || continue   # exited while we walked the list
    cfg="$(tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null |
      grep -m1 '^OMNESIS_CONFIG_DIR=' | cut -d= -f2-)" || continue
    case "${cfg}" in
      /tmp/omnesis-dev-instance*|/tmp/omnesis-shot-portal*) ;;
      *) continue ;;   # live instance (~/.config/omnesis) and e2e temps: not ours
    esac
    [[ "${cfg}" == "${CONFIG_DIR}" ]] && continue
    [[ -d "${cfg}" ]] && continue   # dir still present → the dir-based reap owns it
    # Don't race an instance still laying down its dir.
    age_s="$(ps -o etimes= -p "${pid}" 2>/dev/null | tr -d ' ')" || continue
    [[ -n "${age_s}" ]] && (( age_s < 600 )) && continue
    what="$(ps -o args= -p "${pid}" 2>/dev/null | grep -qF 'collector/src/main.ts' &&
      echo collector || echo gateway)"
    if kill_pid_tree "${pid}"; then
      echo "reaped orphaned ${what} pid=${pid} (config dir ${cfg} already gone)"
    else
      echo "WARNING: orphaned ${what} pid=${pid} survived TERM+KILL" >&2
    fi
  done
  return 0
}

reap_stale() {
  local max_age_hours="${1:-24}"
  local now epoch age_s dir pidf pid all_dead
  now="$(date +%s)"
  for dir in /tmp/omnesis-dev-instance* /tmp/omnesis-shot-portal*; do
    [[ -d "${dir}" ]] || continue
    [[ "${dir}" == "${CONFIG_DIR}" ]] && continue   # never reap the dir we're about to use
    epoch="$(stat -c %Y "${dir}" 2>/dev/null || stat -f %m "${dir}" 2>/dev/null)" || continue
    age_s=$((now - epoch))
    (( age_s > max_age_hours * 3600 )) || continue
    all_dead=1
    for pidf in "${dir}/gateway.pid" "${dir}/collector.pid"; do
      [[ -f "${pidf}" ]] || continue
      pid="$(cat "${pidf}" 2>/dev/null)" || continue
      kill_pid_tree "${pid}" || all_dead=0
    done
    # The dir only goes once nothing is left alive behind it. Removing it while a
    # process survives strands that process for good: the dir is the sole marker
    # tying it to an instance, and this reap globs on dirs to find its work.
    if (( all_dead )); then
      rm -rf "${dir}" 2>/dev/null || true
      echo "reaped stale instance: ${dir} (age $((age_s / 3600))h)"
    else
      echo "WARNING: ${dir} has a surviving process; keeping the dir so the next reap can retry" >&2
    fi
  done
  reap_orphans
  return 0
}

# Probe /health once. Returns 0 only on a real HTTP 200, trusting the gateway's
# self-signed cert. Quiet — the caller decides what to print.
health_ok() {
  local code
  code="$(curl -sS --cacert "${CA_CERT}" -o /dev/null -w '%{http_code}' \
    "${URL}/health" 2>/dev/null || echo 000)"
  [[ "${code}" == "200" ]]
}

# Bounded, deterministic readiness gate. Polls /health until it returns 200 or
# the deadline passes. FAILS LOUD with one named signal if the instance never
# serves — it never reports a non-serving instance as ready.
wait_until_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT))
  while (( SECONDS < deadline )); do
    if [[ -s "${TOKEN_FILE}" && -f "${CA_CERT}" ]] && health_ok; then
      return 0
    fi
    sleep 0.5
  done
  echo "DEV_INSTANCE_NOT_READY: ${URL}/health did not return 200 within ${READY_TIMEOUT}s." >&2
  echo "  config dir: ${CONFIG_DIR}" >&2
  echo "  gateway log: ${CONFIG_DIR}/logs/gateway.stdout.log" >&2
  echo "The instance is NOT serving — refusing to report it as ready." >&2
  exit 5
}

print_triple() {
  if [[ ! -s "${TOKEN_FILE}" || ! -f "${CA_CERT}" ]]; then
    echo "No isolated instance found at ${CONFIG_DIR} (no token / CA cert)." >&2
    echo "Start one first: scripts/dev-instance.sh start" >&2
    exit 6
  fi
  local token
  token="$(cat "${TOKEN_FILE}")"
  # Copy-paste form: paste this block into another shell and immediately drive
  # `cli`/curl at the isolated instance. The CA path is absolute so it resolves
  # from any working directory; the URL is https; the token is the live one.
  cat <<TRIPLE
# Isolated dev instance — paste into another shell to drive it:
export OMNESIS_GATEWAY_URL=${URL}
export OMNESIS_TOKEN=${token}
export NODE_EXTRA_CA_CERTS=${CA_CERT}

# URL:   ${URL}
# TOKEN: ${token}
# CA:    ${CA_CERT}
TRIPLE
}

start() {
  guard_isolation
  reap_stale 24

  # Fast path: the recorded generation is fully alive (gateway AND collector)
  # and serving — reuse it, exactly like synth-gateway.sh's "already running".
  local gpid cpid
  gpid="$(cat "${CONFIG_DIR}/gateway.pid" 2>/dev/null || true)"
  cpid="$(cat "${CONFIG_DIR}/collector.pid" 2>/dev/null || true)"
  if [[ -n "${gpid}" && -n "${cpid}" ]] &&
    kill -0 "${gpid}" 2>/dev/null && kill -0 "${cpid}" 2>/dev/null && health_ok; then
    echo "Instance already running and healthy at ${URL} — reusing."
    echo
    print_triple
    return 0
  fi

  # Anything else — dead, half-dead, or a survivor from an older generation —
  # gets swept before we spawn, so exactly one generation ever runs per
  # config dir.
  sweep_own_generations

  # The port must be free before we spawn: a survivor (or foreign process)
  # holding it means our gateway loses the bind and dies, while the readiness
  # gate happily 200s against whoever answered — reporting the wrong instance
  # as ready. Fail loud instead.
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "REFUSING TO START: port ${PORT} already has a listener:" >&2
    lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >&2 || true
    echo "Stop it (or pick another OMNESIS_GATEWAY_PORT) and retry." >&2
    exit 7
  fi

  local real=0
  local passthrough=()
  for arg in "$@"; do
    case "$arg" in
      --real) real=1 ;;
      *) passthrough+=("$arg") ;;
    esac
  done

  if [[ "${real}" == "1" ]]; then
    echo "Standing up an isolated REAL-sources instance on ${URL} …"
    # Real mode: synthetic OFF, nothing seeded. --bare keeps synth-gateway from
    # trying to seed a universe (the env flag also forces seed off).
    OMNESIS_DEV_REAL_SOURCES=1 \
    OMNESIS_CONFIG_DIR="${CONFIG_DIR}" \
    OMNESIS_GATEWAY_PORT="${PORT}" \
    OMNESIS_SYNTH_READY_TIMEOUT="${READY_TIMEOUT}" \
      bash "${SYNTH}" start --bare
  else
    echo "Standing up an isolated SYNTHETIC instance on ${URL} …"
    OMNESIS_CONFIG_DIR="${CONFIG_DIR}" \
    OMNESIS_GATEWAY_PORT="${PORT}" \
    OMNESIS_SYNTH_READY_TIMEOUT="${READY_TIMEOUT}" \
      bash "${SYNTH}" start "${passthrough[@]+"${passthrough[@]}"}"
  fi

  # Re-assert readiness at this wrapper boundary so a gateway that stopped
  # after the delegated boot check is never reported as ready.
  wait_until_ready

  echo
  echo "✓ Isolated instance is SERVING (/health 200) at ${URL}/portal"
  echo
  print_triple
}

stop() {
  OMNESIS_CONFIG_DIR="${CONFIG_DIR}" \
  OMNESIS_GATEWAY_PORT="${PORT}" \
    bash "${SYNTH}" stop
  # Belt-and-braces: the PID files only know the newest generation; sweep any
  # older survivors bound to this config dir.
  sweep_own_generations
}

case "${1:-}" in
  start) shift; start "$@" ;;
  info) print_triple ;;
  stop) stop ;;
  reap) reap_stale "${2:-24}" ;;
  # Internal: run only the bounded /health readiness gate against the configured
  # instance and exit (0 = serving, 5 = DEV_INSTANCE_NOT_READY). Used by the
  # smoke test to exercise the fail-loud path without a full boot.
  wait) guard_isolation; wait_until_ready; echo "ready" ;;
  *)
    cat <<USAGE
Usage: $0 <command> [args]

Commands:
  start            Boot an isolated SYNTHETIC instance (default universe), seeded,
                   and wait until /health returns 200 before reporting ready.
  start --bare     Boot synthetic with no sources (add them via the portal).
  start --real     Boot with REAL sources: synthetic mode OFF, nothing seeded;
                   add your real sources via the portal '+Add source' flow.
  start --universe <name>   Use a specific synthetic universe.
  info             Print the URL / TOKEN / CA-cert triple in copy-paste form so
                   another shell can immediately drive cli/curl at the instance.
  stop             Stop the gateway + collector (leaves the config dir on disk).
  reap [hours]     Kill + remove stale /tmp/omnesis-dev-instance* and
                   /tmp/omnesis-shot-portal* instances older than [hours]
                   (default 24). Runs automatically before every start.

Isolation: serves on a HIGH port (default 17600) under an isolated config dir
(default /tmp/omnesis-dev-instance). Never the live gateway, port 7600, or
~/.config/omnesis. Override with OMNESIS_GATEWAY_PORT / OMNESIS_CONFIG_DIR.
USAGE
    exit 1
    ;;
esac
