#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# shot-portal.sh — on-demand portal screenshot loop. Boots (or reuses) an
# isolated SYNTHETIC-data gateway FROM THIS WORKTREE on a high port, navigates
# the headless portal to /portal/<route>, waits on a SELECTOR (never
# networkidle — the portal holds SSE/WS connections; see docs/agent-gotchas.md),
# optionally clicks a selector, and writes a PNG to /tmp the agent can Read and
# self-critique. The "screenshot + Read + self-critique" loop for any portal/
# change, mirroring the iOS preview-snapshot workflow.
#
# It NEVER touches live state: it spawns its OWN gateway on a HIGH port under an
# isolated config dir — never the live gateway, port 7600, or ~/.config/omnesis.
# The synthetic corpus is invented universe data (no personal data).
#
# Usage:
#   scripts/shot-portal.sh <route> [--wait <selector>] [--click <selector>]
#                                  [--out <path>] [--light] [--keep] [--universe <n>]
#
# Examples:
#   scripts/shot-portal.sh people                       # /portal/people
#   scripts/shot-portal.sh ""                           # /portal/ (the Ask landing)
#   scripts/shot-portal.sh sources --click .sources-add-btn --wait .add-source-modal
#   scripts/shot-portal.sh settings/devices --click .devices-pair-btn \
#     --click '#pair-kind=collector' --click '.devices-pair-actions .btn-primary'
#   scripts/shot-portal.sh settings --keep              # leave the gateway up for more shots
#
# Routes are the portal's nav routes: "" and agent (both the Ask landing),
# search, people, sources, capture, privacy, watches, debug, and settings.
# The last two are tabbed pages, whose tabs are addressed as debug/data,
# debug/sql, debug/graph, debug/metrics, debug/background-jobs,
# debug/cognition, debug/doctor, and settings/config, settings/models,
# settings/access, settings/access/connect (the connect-an-agent dialog),
# settings/policies, settings/devices.
#
# Flags:
#   --wait <selector>   selector to wait for after navigation
#                       (default: .app-sidebar — proves the SPA booted + authed)
#   --click <step>      one interaction to perform before shooting, repeatable
#                       and applied in order — e.g. open a modal, then pick
#                       something inside it. A bare selector is clicked; the
#                       form `<selector>=<value>` picks that option in a
#                       <select>, which a click cannot do to a native option.
#   --out <path>        output PNG path (default: /tmp/omnesis-portal-shot[-<route>].png)
#   --light             light theme (default dark)
#   --keep              leave the gateway running afterwards for repeated shots
#                       (otherwise it is stopped on exit)
#   --universe <name>   synthetic universe to seed (default: default)
#
# Env (all optional, generic defaults — nothing operator-private):
#   OMNESIS_SHOT_PORT        high port to serve on  (default: 18700)
#   OMNESIS_SHOT_CONFIG_DIR  isolated config dir    (default: /tmp/omnesis-shot-portal)
#   OMNESIS_SHOT_READY_TIMEOUT  seconds to wait for /health 200 (default: the
#                          shared gateway boot budget, scripts/lib/gateway-boot-budget.json)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_INSTANCE="${ROOT}/scripts/dev-instance.sh"

# One boot budget across everything that spawns a gateway — see the `why` field
# in scripts/lib/gateway-boot-budget.json.
# shellcheck source=lib/boot_budget
source "${ROOT}/scripts/lib/boot_budget"

# Node 24 is keg-only on the macOS build host; on Linux the keg dir is absent so
# this prepend is a harmless no-op. Guarded so it never shadows a system node.
if [[ -d /opt/homebrew/opt/node@24/bin ]]; then
  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
fi

# Isolated defaults. The port + config dir are distinct from the other dev
# scripts (dev-instance 17600, playwright 17800, demo 27600) so a shot can run
# alongside them. Never the live 7600 / ~/.config/omnesis.
PORT="${OMNESIS_SHOT_PORT:-18700}"
CONFIG_DIR="${OMNESIS_SHOT_CONFIG_DIR:-/tmp/omnesis-shot-portal}"
READY_TIMEOUT="${OMNESIS_SHOT_READY_TIMEOUT:-$(gateway_boot_budget_seconds)}"
URL="https://localhost:${PORT}"
TOKEN_FILE="${CONFIG_DIR}/token"
CA_CERT="${CONFIG_DIR}/tls/cert.pem"

usage() {
  # Print the whole header block — from the usage line to the last comment line
  # before the first statement — so --help can never truncate as the header
  # grows, the way a hardcoded line range does.
  awk 'NR >= 5 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
  exit "${1:-1}"
}

# ── Parse args ────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
  echo "ERROR: a <route> is required (use \"\" for the Ask landing)." >&2
  usage 64
fi
# The route is the first positional arg (may be the empty string for /portal/).
ROUTE="$1"; shift
WAIT_SELECTOR=""
CLICK_SELECTOR=""
OUT=""
APPEARANCE="dark"
KEEP=0
UNIVERSE_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait) WAIT_SELECTOR="${2:?--wait needs a selector}"; shift 2 ;;
    --click)
      # Repeatable: each --click is a step, clicked in order. Newline-joined
      # because a selector may legitimately contain a comma.
      CLICK_SELECTOR="${CLICK_SELECTOR:+$CLICK_SELECTOR$'\n'}${2:?--click needs a selector}"
      shift 2
      ;;
    --out) OUT="${2:?--out needs a path}"; shift 2 ;;
    --light) APPEARANCE="light"; shift ;;
    --dark) APPEARANCE="dark"; shift ;;
    --keep) KEEP=1; shift ;;
    --universe) UNIVERSE_ARGS=(--universe "${2:?--universe needs a name}"); shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage 64 ;;
  esac
done

# Default output path: a predictable /tmp file keyed by the route so repeated
# shots of different routes don't clobber each other and the agent knows where
# to Read. The empty route gets a "home" suffix.
if [[ -z "${OUT}" ]]; then
  slug="$(printf '%s' "${ROUTE}" | tr '/ ' '--' | tr -cd 'a-zA-Z0-9-')"
  [[ -z "${slug}" ]] && slug="home"
  OUT="/tmp/omnesis-portal-shot-${slug}.png"
fi

# Refuse the empty output silently-blank trap: always start from a clean slate
# so a stale PNG from a prior run can never masquerade as this run's output.
rm -f "${OUT}"

# ── Boot or reuse the isolated synthetic gateway ──────────────────
export OMNESIS_CONFIG_DIR="${CONFIG_DIR}"
export OMNESIS_GATEWAY_PORT="${PORT}"
export OMNESIS_DEV_READY_TIMEOUT="${READY_TIMEOUT}"

# Is a gateway already serving on our isolated port (a previous --keep run)?
already_up=0
if [[ -s "${TOKEN_FILE}" && -f "${CA_CERT}" ]]; then
  if curl -sS --cacert "${CA_CERT}" -o /dev/null -w '%{http_code}' "${URL}/health" 2>/dev/null \
    | grep -q '^200$'; then
    already_up=1
  fi
fi

stop_gateway() {
  bash "${DEV_INSTANCE}" stop >/dev/null 2>&1 || true
}

booted_this_run=0
if [[ "${already_up}" == "1" ]]; then
  echo "==> Reusing the synthetic gateway already serving at ${URL}"
else
  echo "==> Booting an isolated synthetic gateway at ${URL} (this may take a moment)…"
  # dev-instance.sh enforces the isolation rail (refuses 7600 / live config dir)
  # and gates on a real /health 200, failing loud (exit 5) if it never serves.
  bash "${DEV_INSTANCE}" start "${UNIVERSE_ARGS[@]+"${UNIVERSE_ARGS[@]}"}"
  booted_this_run=1
fi

# Stop the gateway on exit UNLESS the caller asked to keep it (or it was already
# up before we ran — then we leave it as we found it).
cleanup() {
  if [[ "${KEEP}" == "0" && "${booted_this_run}" == "1" ]]; then
    echo "==> Stopping the synthetic gateway (pass --keep to leave it up)…"
    stop_gateway
  fi
}
trap cleanup EXIT

# ── Capture ───────────────────────────────────────────────────────
TOKEN="$(cat "${TOKEN_FILE}")"
export NODE_EXTRA_CA_CERTS="${CA_CERT}"

# Playwright's bundled Chromium must be present; install it loudly if missing
# rather than letting the capture fail with an opaque launch error.
npx playwright install chromium >/dev/null 2>&1 || true

echo "==> Capturing /portal/${ROUTE} (theme=${APPEARANCE}) …"
PORTAL_URL="${URL}" \
PORTAL_TOKEN="${TOKEN}" \
PORTAL_OUT="${OUT}" \
PORTAL_ROUTE="${ROUTE}" \
PORTAL_WAIT="${WAIT_SELECTOR}" \
PORTAL_CLICK="${CLICK_SELECTOR}" \
PORTAL_APPEARANCE="${APPEARANCE}" \
  node "${ROOT}/scripts/shot-portal.mjs"

# Fail loud if the capture claimed success but produced nothing — never report
# a missing/blank asset as a usable screenshot.
if [[ ! -s "${OUT}" ]]; then
  echo "ERROR: no screenshot was written to ${OUT}." >&2
  exit 1
fi

echo
echo "✓ Screenshot written: ${OUT}"
echo "  Read it and self-critique: did /portal/${ROUTE} render as intended?"
