#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Print the live Omnesis topology, READ-ONLY. This never mutates anything: it
# only inspects listening processes and probes read-only HTTP endpoints. Use it
# before you test a change to answer "which gateway am I about to hit, and is it
# the one I think it is?" — the guard against accidentally driving the live
# gateway (or a peer worker's instance) when you meant to hit your own.
#
# It reports:
#   1. The PID listening on the gateway port → the checkout that PID is serving
#      from (discovered at runtime from the process's working directory),
#      compared against THIS worktree. A loud MISMATCH banner prints when they
#      differ — that is the "am I about to test the wrong instance" signal.
#   2. The gateway's paired devices (GET /admin/devices), if a token is set.
#   3. The isolated-port conventions the fleet uses for its own instances.
#
# Everything operator-specific is read from env vars / live probes with safe,
# generic defaults — nothing personal is baked in. The serving-checkout path is
# DISCOVERED from the listening PID at runtime; it is never hardcoded.
#
# Configuration (all optional, generic defaults):
#   OMNESIS_GATEWAY_URL   gateway base URL      (default: https://localhost:<port>)
#   OMNESIS_GATEWAY_PORT  gateway port          (default: 7600 — the repo default)
#   OMNESIS_TOKEN         bearer token, or read from $OMNESIS_CONFIG_DIR/token
#   OMNESIS_CONFIG_DIR    config dir (for the token + CA cert fallback)
#   NODE_EXTRA_CA_CERTS   CA cert for the gateway's self-signed HTTPS (else curl -k)
#
# Fail-loud: if it cannot resolve the listening PID because neither `lsof` nor
# `ss` is installed, it says exactly that and exits non-zero — it never prints
# an empty/partial topology as if it were complete.

set -euo pipefail

# Resolve this worktree's root from the script location, so MISMATCH compares
# against the checkout this script actually lives in, regardless of $PWD.
# `pwd -P` resolves symlinks so this matches the serving checkout, which is read
# back as a real (symlink-resolved) path (`readlink -f` on Linux; `lsof` on
# macOS, where /var → /private/var and /tmp → /private/tmp). Comparing a logical
# path here against a resolved path there would cry a false MISMATCH on a
# worktree that sits under a symlinked prefix.
WORKTREE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

PORT="${OMNESIS_GATEWAY_PORT:-7600}"
URL="${OMNESIS_GATEWAY_URL:-https://localhost:${PORT}}"
CONFIG_DIR="${OMNESIS_CONFIG_DIR:-}"

# Derive the port from the URL if a URL was given without an explicit port var,
# so the listener lookup matches the endpoint we probe.
if [[ -n "${OMNESIS_GATEWAY_URL:-}" && -z "${OMNESIS_GATEWAY_PORT:-}" ]]; then
  url_port="$(printf '%s' "$URL" | sed -nE 's#^[a-z]+://[^/:]+:([0-9]+).*#\1#p')"
  if [[ -n "$url_port" ]]; then
    PORT="$url_port"
  elif [[ "$URL" == https://* ]]; then
    PORT=443
  elif [[ "$URL" == http://* ]]; then
    PORT=80
  fi
fi

# A bright banner so MISMATCH can't be skimmed past in a wall of output.
banner() {
  printf '\n========================================================\n'
  printf '  %s\n' "$1"
  printf '========================================================\n'
}

echo "Omnesis topology (read-only)"
echo "  This worktree: ${WORKTREE_ROOT}"
echo "  Gateway URL:   ${URL}"
echo "  Gateway port:  ${PORT}"
echo

# --- 1. Listening PID → serving checkout --------------------------------------

# Resolve the PID listening on the gateway port. Prefer lsof; fall back to ss
# (Linux). If neither is available we cannot answer the core question, so we
# fail loud rather than print a misleading "nothing is listening".
listener_pid=""
if command -v lsof >/dev/null 2>&1; then
  listener_pid="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -n1 || true)"
elif command -v ss >/dev/null 2>&1; then
  # ss prints e.g. users:(("node",pid=12345,fd=23)) — pull the first pid=.
  listener_pid="$(ss -ltnpH "sport = :${PORT}" 2>/dev/null \
    | grep -oE 'pid=[0-9]+' | head -n1 | cut -d= -f2 || true)"
else
  banner "CANNOT INSPECT TOPOLOGY"
  echo "Neither 'lsof' nor 'ss' is installed, so the PID listening on port" >&2
  echo "${PORT} cannot be resolved. Install one of them and re-run." >&2
  exit 3
fi

serving_checkout=""
if [[ -n "$listener_pid" ]]; then
  echo "Listening PID on :${PORT} → ${listener_pid}"
  # Discover the serving checkout from the process's working directory. On
  # Linux this is /proc/<pid>/cwd; on macOS, lsof reports it. Never hardcoded.
  if [[ -r "/proc/${listener_pid}/cwd" ]]; then
    serving_checkout="$(readlink -f "/proc/${listener_pid}/cwd" 2>/dev/null || true)"
  elif command -v lsof >/dev/null 2>&1; then
    serving_checkout="$(lsof -a -p "${listener_pid}" -d cwd -Fn 2>/dev/null \
      | sed -nE 's/^n//p' | head -n1 || true)"
  fi

  if [[ -n "$serving_checkout" ]]; then
    echo "  serving from:  ${serving_checkout}"
    if [[ "$serving_checkout" != "$WORKTREE_ROOT" ]]; then
      banner "MISMATCH — gateway on :${PORT} is NOT this worktree"
      echo "  this worktree:   ${WORKTREE_ROOT}"
      echo "  gateway serving: ${serving_checkout}"
      echo
      echo "  You are about to test against a DIFFERENT checkout (possibly the"
      echo "  live gateway or another worker's instance). Point OMNESIS_GATEWAY_URL"
      echo "  at your own isolated instance before driving any test commands."
      banner "END MISMATCH"
    else
      echo "  match: gateway on :${PORT} is serving THIS worktree."
    fi
  else
    echo "  (could not resolve the serving checkout for PID ${listener_pid};" \
      "the process cwd was not readable — re-run with sufficient permissions)"
  fi
else
  echo "Nothing is listening on :${PORT} (no gateway up on this port)."
fi
echo

# --- 2. Paired devices (GET /admin/devices) -----------------------------------

# Read the admin token from env, else from the config dir's token file. Without
# it we cannot query /admin/devices — print a clear note, do not crash.
TOKEN="${OMNESIS_TOKEN:-}"
if [[ -z "$TOKEN" && -n "$CONFIG_DIR" && -s "${CONFIG_DIR}/token" ]]; then
  TOKEN="$(cat "${CONFIG_DIR}/token")"
fi

echo "Paired devices (GET ${URL}/admin/devices):"
if ! command -v curl >/dev/null 2>&1; then
  echo "  (curl is not installed — cannot probe /admin/devices)"
elif [[ -z "$TOKEN" ]]; then
  echo "  (no token: set OMNESIS_TOKEN or OMNESIS_CONFIG_DIR with a token file" \
    "to list paired devices)"
elif [[ -z "$listener_pid" ]]; then
  echo "  (no gateway listening on :${PORT} — nothing to query)"
else
  # Read-only GET. Trust the gateway's self-signed cert via NODE_EXTRA_CA_CERTS
  # if curl honors it; otherwise fall back to -k for local self-signed certs.
  cacert_args=()
  if [[ -n "${NODE_EXTRA_CA_CERTS:-}" && -f "${NODE_EXTRA_CA_CERTS}" ]]; then
    cacert_args=(--cacert "${NODE_EXTRA_CA_CERTS}")
  elif [[ -n "$CONFIG_DIR" && -f "${CONFIG_DIR}/tls/cert.pem" ]]; then
    cacert_args=(--cacert "${CONFIG_DIR}/tls/cert.pem")
  else
    cacert_args=(-k)
  fi

  http_body="$(mktemp)"
  trap 'rm -f "$http_body"' EXIT
  http_code="$(curl -sS "${cacert_args[@]}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -o "$http_body" -w '%{http_code}' \
    "${URL}/admin/devices" 2>/dev/null || echo "000")"

  if [[ "$http_code" == "200" ]]; then
    # Pretty-print id/name/kind if a JSON tool is around; else dump the body.
    if command -v node >/dev/null 2>&1; then
      node -e '
        const fs = require("node:fs");
        const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const items = Array.isArray(body.items) ? body.items : [];
        if (items.length === 0) { console.log("  (no paired devices)"); }
        for (const d of items) {
          console.log(`  - ${d.name ?? "?"} [${d.kind ?? "?"}] id=${d.id ?? "?"}`);
        }
      ' "$http_body" || cat "$http_body"
    else
      cat "$http_body"
    fi
  else
    echo "  (request failed: HTTP ${http_code} — token may lack admin scope," \
      "or the gateway is unreachable)"
  fi
fi
echo

# --- 3. Isolated-port conventions ---------------------------------------------

cat <<'CONVENTIONS'
Isolated-instance port conventions (the fleet's high-port scheme):
  - The live gateway uses the repo default port 7600. OAuth callback flows bind
    ports 3000-3003. Leave those alone unless you ARE the live instance.
  - Isolated worktree instances use a high port to avoid the live gateway and
    OAuth ports — convention: 17600 for a test gateway in an isolated worktree.
  - The synthetic-data demo gateway uses 27600 by default.
  - Set OMNESIS_GATEWAY_PORT (and a matching OMNESIS_CONFIG_DIR / OMNESIS_*_DB_PATH)
    so your instance is fully separate from the live one and from peer workers.
CONVENTIONS
