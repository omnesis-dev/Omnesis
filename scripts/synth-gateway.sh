#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Boot an isolated synthetic-providers gateway + collector for portal demos
# and ad-hoc inspection. Spawns its own processes — never touches the live
# setup. Logs / PIDs / DBs live under $OMNESIS_CONFIG_DIR.
#
# Usage:
#   scripts/synth-gateway.sh start                # boot + seed the active universe's sources
#   scripts/synth-gateway.sh start --no-seed      # boot empty (add sources via portal)
#   scripts/synth-gateway.sh start --universe <n> # use a specific universe (default: $OMNESIS_SYNTH_UNIVERSE or `default`)
#   scripts/synth-gateway.sh seed                 # seed the active universe on a running gateway
#   scripts/synth-gateway.sh seed-privacy         # re-drive just the privacy exchanges
#   scripts/synth-gateway.sh stop                 # kill PIDs (keeps config dir on disk)
#   scripts/synth-gateway.sh refresh-snapshot     # nudge the search snapshot
#   scripts/synth-gateway.sh pair                 # mint a portal pairing code
#
# Override:
#   OMNESIS_CONFIG_DIR (default: /tmp/omnesis-synth-portal)
#   OMNESIS_GATEWAY_PORT (default: 27600)
#   OMNESIS_SYNTH_UNIVERSE (default: default)
#   OMNESIS_SYNTH_READY_TIMEOUT (default: shared gateway boot budget)
#   OMNESIS_DEV_REAL_SOURCES=1  boot the collector WITHOUT synthetic mode and
#                               WITHOUT seeding any universe, so the operator
#                               adds real sources via the portal. Used by
#                               scripts/dev-instance.sh --real; unset = the
#                               default synthetic behavior.

set -euo pipefail

CONFIG_DIR="${OMNESIS_CONFIG_DIR:-/tmp/omnesis-synth-portal}"
PORT="${OMNESIS_GATEWAY_PORT:-27600}"
URL="https://localhost:${PORT}"
GATEWAY_PID="${CONFIG_DIR}/gateway.pid"
COLLECTOR_PID="${CONFIG_DIR}/collector.pid"
TOKEN_FILE="${CONFIG_DIR}/token"
CA_CERT="${CONFIG_DIR}/tls/cert.pem"
UNIVERSE="${OMNESIS_SYNTH_UNIVERSE:-default}"
# Real-sources mode skips the synthetic universe + seeding so the operator can
# add their own (real) sources. Off by default (purely synthetic).
REAL_SOURCES="${OMNESIS_DEV_REAL_SOURCES:-0}"

# Node 24 is keg-only on the macOS build host; on Linux the keg dir is absent
# so this prepend is a harmless no-op. Guarded so it never shadows a system
# node on a generic open-source checkout.
if [[ -d /opt/homebrew/opt/node@24/bin ]]; then
  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
fi

# Worktree root is one level up from this script. Resolved here so commands
# can be invoked from anywhere.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Use the same cold-start allowance as every other gateway-spawning script.
# shellcheck source=lib/boot_budget
source "${ROOT}/scripts/lib/boot_budget"

READY_TIMEOUT="${OMNESIS_SYNTH_READY_TIMEOUT:-$(gateway_boot_budget_seconds)}"

# kill_pid_tree: group TERM→KILL with confirmation — a bare `kill` on the
# recorded wrapper PID leaves the node process underneath alive (see the lib).
source "${ROOT}/scripts/lib/kill_tree"

# Parse --universe out of all subcommands' args. Other args (like --no-seed)
# pass through to the per-subcommand handlers.
parse_universe_arg() {
  REMAINING=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --universe)
        UNIVERSE="$2"
        shift 2
        ;;
      --universe=*)
        UNIVERSE="${1#--universe=}"
        shift
        ;;
      *)
        REMAINING+=("$1")
        shift
        ;;
    esac
  done
}

manifest_path() {
  echo "$ROOT/evals/universes/$UNIVERSE/universe.json"
}

# Absolute path to the universe's replay-scenario directory, or empty when the
# universe declares none. Read from the manifest's `agentDemos` field.
agent_demos_dir() {
  local manifest="$(manifest_path)"
  [[ -f "$manifest" ]] || return 0
  MANIFEST="$manifest" UNIVERSE_DIR="$ROOT/evals/universes/$UNIVERSE" python3 -c "
import json, os
with open(os.environ['MANIFEST']) as f:
    rel = json.load(f).get('agentDemos')
print(os.path.join(os.environ['UNIVERSE_DIR'], rel) if rel else '')
"
}

health_ok() {
  local code
  code="$(curl -sS --cacert "${CA_CERT}" -o /dev/null -w '%{http_code}' \
    "${URL}/health" 2>/dev/null || echo 000)"
  [[ "${code}" == "200" ]]
}

stop_failed_gateway_start() {
  local pid
  [[ -s "${GATEWAY_PID}" ]] || return 0
  pid="$(cat "${GATEWAY_PID}")"
  if ! kill_pid_tree "${pid}"; then
    echo "SYNTH_GATEWAY_CLEANUP_FAILED: gateway process ${pid} survived TERM and KILL." >&2
    return 1
  fi
  rm -f "${GATEWAY_PID}"
}

# The external-agent requests that drive this universe's privacy cassettes, or
# empty when it ships none.
privacy_requests_path() {
  local demos="$(agent_demos_dir)"
  if [[ -n "$demos" && -f "$demos/privacy-requests.json" ]]; then
    echo "$demos/privacy-requests.json"
  fi
  return 0
}

start() {
  # `start` boots gateway + collector and seeds the universe's sources. Pass
  # `--no-seed` to leave the gateway empty so you can add sources one-by-one
  # via the portal's +Add Source flow — useful for screen-recording the auth
  # screens or just walking through the add wizard.
  parse_universe_arg "$@"
  set -- "${REMAINING[@]+"${REMAINING[@]}"}"
  case "${READY_TIMEOUT}" in
    '' | *[!0-9]* | 0)
      echo "OMNESIS_SYNTH_READY_TIMEOUT must be a positive integer (got: ${READY_TIMEOUT})." >&2
      exit 2
      ;;
  esac
  local seed=1
  for arg in "$@"; do
    case "$arg" in
      --no-seed|--bare) seed=0 ;;
    esac
  done

  # Real-sources mode boots without synthetic data: never seed a universe and
  # do not require a universe manifest at all.
  if [[ "${REAL_SOURCES}" == "1" ]]; then
    seed=0
  else
    local manifest="$(manifest_path)"
    if [[ ! -f "$manifest" ]]; then
      echo "Universe '$UNIVERSE' has no manifest at $manifest" >&2
      exit 1
    fi
  fi

  if [[ -f "${GATEWAY_PID}" ]] && kill -0 "$(cat "${GATEWAY_PID}")" 2>/dev/null; then
    echo "Gateway already running (pid $(cat "${GATEWAY_PID}")) at ${URL}"
    exit 1
  fi

  mkdir -p "${CONFIG_DIR}/logs" "${CONFIG_DIR}/models"

  # Seed config with replay assignments so the agent and the privacy reviewer
  # both work without a real LLM. They read the same universe cassette
  # directory; each scenario's meta declares which of the two roles it answers
  # for, so the two never pick each other's cassettes up. The gateway merges
  # this with whatever the seed_sources step adds later.
  if [[ ! -f "${CONFIG_DIR}/omnesis.json" ]]; then
    echo '{"inference":{"assignments":{"agent":"replay","privacy-reviewer":"replay"}}}' \
      > "${CONFIG_DIR}/omnesis.json"
  fi

  # Symlink the embedding model so we don't re-download ~500 MB.
  if [[ ! -e "${CONFIG_DIR}/models/nomic-embed-text-v1.5.Q8_0.gguf" ]]; then
    ln -sf "${HOME}/.config/omnesis/models/nomic-embed-text-v1.5.Q8_0.gguf" \
      "${CONFIG_DIR}/models/"
  fi

  echo "Booting gateway on ${URL} (universe=${UNIVERSE})…"
  (
    cd "${ROOT}"
    export OMNESIS_CONFIG_DIR="${CONFIG_DIR}"
    export OMNESIS_DB_PATH="${CONFIG_DIR}/omnesis.db"
    export OMNESIS_INDEX_DB_PATH="${CONFIG_DIR}/index.db"
    export OMNESIS_ANALYTICS_DB_PATH="${CONFIG_DIR}/analytics.db"
    export OMNESIS_GATEWAY_PORT="${PORT}"
    export OMNESIS_LOG_FILE="${CONFIG_DIR}/logs/gateway.log"
    export OMNESIS_LOG_LEVEL="${OMNESIS_LOG_LEVEL:-info}"
    export OMNESIS_SYNTH_UNIVERSE="${UNIVERSE}"
    # Where the `replay` assignments read their cassettes from. Without it the
    # replay backends resolve to nothing and every agent/reviewer turn is
    # unconfigured. `start-demo-gateway.sh` exports the same path before
    # delegating here; setting it again from the manifest is harmless and makes
    # a direct `synth-gateway.sh start` behave the same way.
    demos_dir="$(agent_demos_dir)"
    if [[ -n "${demos_dir}" && -d "${demos_dir}" ]]; then
      export OMNESIS_AGENT_FIXTURE="${OMNESIS_AGENT_FIXTURE:-${demos_dir}}"
    fi
    # Throwaway instances prefer stability over embedding throughput: on a
    # shared unified-memory box a CUDA allocation for the local GGUF embedder
    # can fail under memory pressure and GGML_ABORT kills the whole gateway
    # (/health never turns 200). Default to CPU; export explicitly to override.
    export OMNESIS_LLAMA_GPU="${OMNESIS_LLAMA_GPU:-false}"
    # Tell the gateway it's serving a synthetic corpus too (not just the collector),
    # so synthetic-only relaxations apply — e.g. the merge-candidate head gate is
    # disabled so curated demo duplicates surface. Skipped when serving real sources.
    if [[ "${REAL_SOURCES}" != "1" ]]; then
      export OMNESIS_SYNTHETIC=1
    fi
    nohup npx tsx packages/gateway/src/index.ts \
      >"${CONFIG_DIR}/logs/gateway.stdout.log" 2>&1 </dev/null &
    echo $! >"${GATEWAY_PID}"
  )

  # A cold tsx transform can take much longer on a busy machine. Do not carry
  # a shorter private timeout here, and never continue unless both the token
  # and the verified HTTPS endpoint are actually ready.
  local ready_deadline=$((SECONDS + READY_TIMEOUT))
  while (( SECONDS < ready_deadline )); do
    if [[ -s "${TOKEN_FILE}" && -f "${CA_CERT}" ]] && health_ok; then
      break
    fi
    if [[ -s "${GATEWAY_PID}" ]] && ! kill -0 "$(cat "${GATEWAY_PID}")" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  if [[ ! -s "${TOKEN_FILE}" || ! -f "${CA_CERT}" ]] || ! health_ok; then
    echo "SYNTH_GATEWAY_NOT_READY: ${URL}/health did not return 200 within ${READY_TIMEOUT}s." >&2
    echo "  config dir: ${CONFIG_DIR}" >&2
    echo "  gateway log: ${CONFIG_DIR}/logs/gateway.stdout.log" >&2
    echo "The gateway is NOT serving; refusing to start the collector." >&2
    stop_failed_gateway_start || true
    exit 1
  fi

  TOKEN="$(cat "${TOKEN_FILE}")"
  echo "Gateway up (pid $(cat "${GATEWAY_PID}"))."

  if [[ "${REAL_SOURCES}" == "1" ]]; then
    echo "Booting collector (real sources — synthetic mode OFF)…"
  else
    echo "Booting collector with OMNESIS_SYNTHETIC=1 universe=${UNIVERSE}…"
  fi
  (
    cd "${ROOT}"
    unset OMNESIS_TOKEN
    export OMNESIS_CONFIG_DIR="${CONFIG_DIR}"
    export OMNESIS_GATEWAY_URL="${URL}"
    export NODE_EXTRA_CA_CERTS="${CONFIG_DIR}/tls/cert.pem"
    export OMNESIS_LOG_FILE="${CONFIG_DIR}/logs/collector.log"
    export OMNESIS_LOG_LEVEL="${OMNESIS_LOG_LEVEL:-info}"
    if [[ "${REAL_SOURCES}" != "1" ]]; then
      export OMNESIS_SYNTHETIC=1
      export OMNESIS_SYNTH_UNIVERSE="${UNIVERSE}"
      # Register under a neutral host name so demo captures (Sources list in
      # the iOS app + portal) show a synthetic machine, not the operator's
      # real hostname. Matches the universe's John Smith persona.
      export OMNESIS_COLLECTOR_HOSTNAME="${OMNESIS_COLLECTOR_HOSTNAME:-Johns-MacBook-Pro}"
    fi
    nohup npx tsx packages/collector/src/main.ts \
      >"${CONFIG_DIR}/logs/collector.stdout.log" 2>&1 </dev/null &
    echo $! >"${COLLECTOR_PID}"
  )

  # Wait for collector to connect.
  sleep 8

  if [[ "${seed}" == "1" ]]; then
    seed_sources
  elif [[ "${REAL_SOURCES}" == "1" ]]; then
    echo ""
    echo "✓ Gateway ready (real sources — none added yet): ${URL}/portal"
    echo "  Token:   $(cat "${TOKEN_FILE}")"
    echo "  Add real sources via the portal '+Add source' flow."
    return 0
  else
    echo ""
    echo "✓ Synth gateway ready (no sources added): ${URL}/portal"
    echo "  Token:   $(cat "${TOKEN_FILE}")"
    echo "  Add sources via portal '+Add source', or run: scripts/synth-gateway.sh seed"
    return 0
  fi

  echo ""
  echo "✓ Synth gateway ready: ${URL}/portal"
  echo "  Token:   $(cat "${TOKEN_FILE}")"
  echo "  Pair UI: scripts/synth-gateway.sh pair"
}

seed_sources() {
  parse_universe_arg "$@"
  local manifest="$(manifest_path)"
  if [[ ! -f "$manifest" ]]; then
    echo "Universe '$UNIVERSE' has no manifest at $manifest" >&2
    exit 1
  fi

  TOKEN="$(cat "${TOKEN_FILE}")"
  # The collector registers as a device asynchronously after boot; under load
  # (e.g. a concurrent app build during demo recording) that can take longer
  # than the initial settle wait. Poll /admin/devices until a collector device
  # appears rather than querying once and dying on an empty list — and if it
  # never shows, fail loud with a pointer to the collector log (the usual
  # cause is the collector process having crashed on startup).
  DEVICE_ID=""
  for _ in $(seq 1 40); do
    DEVICE_ID=$(curl -sk -H "Authorization: Bearer ${TOKEN}" "${URL}/admin/devices" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); ids=[x['id'] for x in d.get('items',[]) if x.get('kind')=='collector']; print(ids[0] if ids else '')" 2>/dev/null)
    [[ -n "${DEVICE_ID}" ]] && break
    sleep 1
  done
  if [[ -z "${DEVICE_ID}" ]]; then
    echo "No collector device registered after boot — the collector likely failed to start; see ${CONFIG_DIR}/logs/collector.stdout.log" >&2
    exit 1
  fi

  # Read (descriptorId, accountId) pairs out of universe.json:sources[]. Each
  # entry expands to one source per accountId so multi-account universes
  # (e.g. multiple Google workspaces) register each as a separate source.
  # sources[].device is ignored here: the demo runs one real collector and no
  # synthetic phones, so every source — phone-attributed ones included — is
  # polled by that collector's synth twin.
  local specs
  specs=$(MANIFEST="$manifest" python3 -c "
import json, os
with open(os.environ['MANIFEST']) as f:
    m = json.load(f)
for s in m['sources']:
    for aid in s['accountIds']:
        print(f\"{s['descriptorId']}|{aid}\")
")

  local count=$(echo "$specs" | wc -l | tr -d ' ')
  echo "Adding ${count} synth source(s) from universe '${UNIVERSE}'…"
  while IFS= read -r spec; do
    [[ -z "$spec" ]] && continue
    desc="${spec%|*}"
    aid="${spec#*|}"
    local add_response
    if ! add_response=$(curl -skS --fail-with-body -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
      "${URL}/admin/sources/add" \
      -d "{\"deviceId\":\"${DEVICE_ID}\",\"descriptorId\":\"${desc}\",\"accountIds\":[\"${aid}\"]}" \
    ); then
      echo "Failed to add synth source ${desc} (${aid}): ${add_response:-no gateway response}" >&2
      return 1
    fi
  done <<< "$specs"

  # Give the indexer + writer-worker a beat, then advance the search snapshot
  # so BM25 + vector queries see the newly-ingested chunks immediately
  # instead of waiting 10 minutes for the auto-refresh.
  echo "Waiting for initial indexing to settle…"
  sleep 5
  echo "Refreshing search snapshot…"
  curl -sk -X POST -H "Authorization: Bearer ${TOKEN}" \
    "${URL}/admin/search-snapshot/refresh" >/dev/null

  seed_privacy
}

# Drive the universe's privacy cassettes through the real /answer pipeline, so
# the Privacy page shows exchanges an external caller actually produced —
# candidate, review, release — rather than rows written straight into the
# database. Each named external agent gets its own device and its own
# answer-scoped token; the token's name is what the exchange displays as the
# caller. A universe that ships no privacy-requests.json is a no-op.
seed_privacy() {
  parse_universe_arg "$@"
  local requests="$(privacy_requests_path)"
  if [[ -z "${requests}" ]]; then
    return 0
  fi
  TOKEN="$(cat "${TOKEN_FILE}")"
  echo "Driving privacy exchanges from $(basename "$(dirname "${requests}")")/privacy-requests.json…"
  REQUESTS="${requests}" GATEWAY_URL="${URL}" ADMIN_TOKEN="${TOKEN}" python3 - <<'PY'
import json, os, ssl, urllib.error, urllib.request

url = os.environ["GATEWAY_URL"]
admin = os.environ["ADMIN_TOKEN"]
# The dev gateway serves a self-signed certificate on localhost; this client
# only ever talks to the instance this script just booted.
ctx = ssl._create_unverified_context()


def call(path, token, body=None, method=None):
    req = urllib.request.Request(
        f"{url}{path}",
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method=method or ("GET" if body is None else "POST"),
    )
    with urllib.request.urlopen(req, context=ctx, timeout=180) as resp:
        return json.load(resp)


def device_for(name):
    """The external agent's device, reused across re-seeds so the caller keeps
    one identity on the Devices page instead of accumulating duplicates. A
    revoked row of that name can no longer mint tokens and still holds the
    name, so it is forgotten (it hosts no sources) before a fresh device is
    created in its place."""
    for existing in call("/admin/devices", admin).get("items", []):
        if existing.get("name") != name or existing.get("kind") != "agent":
            continue
        if not existing.get("revokedAt"):
            return existing["id"]
        call(f"/admin/devices/{existing['id']}?forget=true", admin, method="DELETE")
    return call("/admin/devices", admin, {"name": name, "kind": "agent", "scopes": ["answer"]})[
        "device"
    ]["id"]


with open(os.environ["REQUESTS"]) as f:
    requests = json.load(f)["requests"]

tokens = {}
for entry in requests:
    agent = entry["externalAgent"]
    if agent not in tokens:
        # The token's name is what an exchange displays as the caller, so it
        # carries the agent's name rather than a generic label.
        tokens[agent] = call(
            "/admin/tokens",
            admin,
            {"deviceId": device_for(agent), "scopes": ["answer"], "name": agent},
        )["token"]
    # No workflow or conversation id: the gateway rejects ids it did not issue,
    # so it mints them and the workflow name/purpose below name the caller's
    # stated reason for asking.
    body = {
        "question": entry["question"],
        "workflowName": entry["workflowName"],
        "workflowPurpose": entry["workflowPurpose"],
        # Nothing here waits on the operator: the demo wants exchanges that
        # already reached a release decision, not a page of pending approvals.
        "approval": "never",
    }
    try:
        answer = call("/answer", tokens[agent], body)
        print(f"  {agent}: {entry['question']} → {answer.get('status', '?')}")
    except urllib.error.HTTPError as err:
        print(f"  FAILED {agent}: {entry['question']} → HTTP {err.code} {err.read().decode()[:200]}")
PY
}

stop() {
  local pid
  for f in "${GATEWAY_PID}" "${COLLECTOR_PID}"; do
    if [[ -f "${f}" ]]; then
      pid="$(cat "${f}" 2>/dev/null || true)"
      if [[ -n "${pid}" ]] && ! kill_pid_tree "${pid}"; then
        echo "WARNING: pid ${pid} (${f##*/}) survived TERM+KILL" >&2
      fi
    fi
    rm -f "${f}"
  done
  echo "Stopped. Leaving ${CONFIG_DIR} on disk; rm -rf manually if you want to wipe."
}

refresh_snapshot() {
  TOKEN="$(cat "${TOKEN_FILE}")"
  curl -sk -X POST -H "Authorization: Bearer ${TOKEN}" \
    "${URL}/admin/search-snapshot/refresh" | python3 -m json.tool
}

pair() {
  TOKEN="$(cat "${TOKEN_FILE}")"
  curl -sk -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    "${URL}/admin/devices/pair" \
    -d '{"name":"portal-browser","kind":"portal","scopes":["read","admin"],"ttlMs":600000}' \
    | python3 -m json.tool
}

case "${1:-}" in
  start) shift; start "$@" ;;
  stop) stop ;;
  seed) shift; seed_sources "$@" ;;
  seed-privacy) shift; seed_privacy "$@" ;;
  refresh-snapshot) refresh_snapshot ;;
  pair) pair ;;
  *)
    cat <<USAGE
Usage: $0 <command> [args]

Commands:
  start                   Boot gateway + collector AND seed the active universe's sources.
  start --no-seed         Boot gateway + collector with zero sources — add them
                          manually via the portal's +Add Source flow.
  start --universe <name> Use a specific universe (default: \$OMNESIS_SYNTH_UNIVERSE or \`default\`).
  seed                    Seed the active universe on an already-running gateway.
  seed --universe <name>  Seed a specific universe.
  seed-privacy            Re-drive only the universe's privacy exchanges (no-op
                          for a universe that ships no privacy-requests.json).
  pair                    Mint a portal pairing code (10-minute TTL).
  refresh-snapshot        Advance the gateway's search snapshot to the WAL head.
  stop                    Kill gateway + collector. Leaves config dir on disk.

Universes live under evals/universes/<name>/. See docs/universes.md.
USAGE
    exit 1
    ;;
esac
