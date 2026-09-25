#!/usr/bin/env bash
# Shared helpers for the Docker security-E2E scenarios. Each scenario runs
# inside the omnesis-e2e image (repo at /repo, node_modules installed) and
# exercises the REAL CLI + gateway from source against a throwaway config dir.
set -euo pipefail

REPO=/repo
export OMNESIS_CONFIG_DIR="${OMNESIS_CONFIG_DIR:-/e2e/config}"
export OMNESIS_GATEWAY_PORT="${OMNESIS_GATEWAY_PORT:-17600}"
export OMNESIS_GATEWAY_URL="https://localhost:${OMNESIS_GATEWAY_PORT}"
export OMNESIS_LLAMA_GPU=false
export OMNESIS_LOG_LEVEL=info

omnesis() { (cd "$REPO" && npx tsx packages/cli/src/index.ts "$@"); }

GATEWAY_PID=""

boot_gateway() {
  mkdir -p "$OMNESIS_CONFIG_DIR/logs"
  (
    cd "$REPO"
    export OMNESIS_DB_PATH="$OMNESIS_CONFIG_DIR/omnesis.db"
    export OMNESIS_INDEX_DB_PATH="$OMNESIS_CONFIG_DIR/index.db"
    export OMNESIS_ANALYTICS_DB_PATH="$OMNESIS_CONFIG_DIR/analytics.db"
    export OMNESIS_LOG_FILE="$OMNESIS_CONFIG_DIR/logs/gateway.log"
    setsid npx tsx packages/gateway/src/index.ts \
      >"$OMNESIS_CONFIG_DIR/logs/gateway.stdout.log" 2>&1 </dev/null &
    echo $! >"$OMNESIS_CONFIG_DIR/gateway.pid"
  )
  GATEWAY_PID="$(cat "$OMNESIS_CONFIG_DIR/gateway.pid")"
}

wait_health() {
  local deadline=$((SECONDS + ${1:-90}))
  while ((SECONDS < deadline)); do
    if curl -ksf "$OMNESIS_GATEWAY_URL/health" >/dev/null 2>&1; then return 0; fi
    if [[ -n "$GATEWAY_PID" ]] && ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
      echo "gateway process exited before /health turned 200" >&2
      tail -40 "$OMNESIS_CONFIG_DIR/logs/gateway.stdout.log" >&2 || true
      return 1
    fi
    sleep 1
  done
  echo "gateway did not become healthy in time" >&2
  tail -40 "$OMNESIS_CONFIG_DIR/logs/gateway.stdout.log" >&2 || true
  return 1
}

# Expect the gateway process to exit (refusing boot) instead of serving.
expect_boot_refusal() {
  local pattern="$1"
  local deadline=$((SECONDS + 60))
  while ((SECONDS < deadline)); do
    if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
      if grep -aq "$pattern" "$OMNESIS_CONFIG_DIR/logs/gateway.stdout.log"; then
        echo "gateway refused to boot as expected (matched: $pattern)"
        return 0
      fi
      echo "gateway exited but the log did not match: $pattern" >&2
      tail -40 "$OMNESIS_CONFIG_DIR/logs/gateway.stdout.log" >&2
      return 1
    fi
    if curl -ksf "$OMNESIS_GATEWAY_URL/health" >/dev/null 2>&1; then
      echo "gateway SERVED but was expected to refuse boot" >&2
      return 1
    fi
    sleep 1
  done
  echo "gateway neither exited nor served within 60s" >&2
  return 1
}

stop_gateway() {
  if [[ -n "$GATEWAY_PID" ]]; then
    # `setsid` made the gateway a process-group leader; a negative PID signals
    # the whole tree (npx -> tsx -> node worker threads). Kill the group, then
    # a command-line backstop for anything that escaped it.
    kill -TERM "-$GATEWAY_PID" 2>/dev/null || kill -TERM "$GATEWAY_PID" 2>/dev/null || true
  fi
  pkill -f "tsx packages/gateway/src/index.ts" 2>/dev/null || true
  # Wait for the port to actually free; escalate to SIGKILL if it lingers.
  for _ in $(seq 1 30); do
    curl -ksf "$OMNESIS_GATEWAY_URL/health" >/dev/null 2>&1 || break
    sleep 0.5
  done
  if curl -ksf "$OMNESIS_GATEWAY_URL/health" >/dev/null 2>&1; then
    [[ -n "$GATEWAY_PID" ]] && kill -KILL "-$GATEWAY_PID" 2>/dev/null || true
    pkill -9 -f "tsx packages/gateway/src/index.ts" 2>/dev/null || true
    for _ in $(seq 1 20); do curl -ksf "$OMNESIS_GATEWAY_URL/health" >/dev/null 2>&1 || break; sleep 0.5; done
  fi
  GATEWAY_PID=""
}

# Trust the gateway's self-signed cert for CLI HTTPS calls. The bearer token
# itself is resolved by the CLI from <configDir>/token — which may be an
# encrypted secret-file envelope once the keyring is armed, so scenarios must
# never cat it into OMNESIS_TOKEN.
use_gateway_tls() {
  # The CLI trusts the gateway's self-signed cert via TOFU on first call; only
  # add it to NODE_EXTRA_CA_CERTS when the gateway actually wrote one there.
  [[ -f "$OMNESIS_CONFIG_DIR/tls/cert.pem" ]] && export NODE_EXTRA_CA_CERTS="$OMNESIS_CONFIG_DIR/tls/cert.pem" || true
}

# Assert a named token row is present (proves a corpus-DB row served after a
# restart / restore). Uses the omnesis() function directly — never wrap it in a
# fresh `bash -c`, which would not inherit the shell function.
assert_token_present() {
  local name="$1"
  if omnesis tokens list 2>/dev/null | grep -q "$name"; then
    echo "  ok: token row '$name' is present"
  else
    echo "  FAILED: token row '$name' not found" >&2
    omnesis tokens list 2>&1 | grep -avE "npm notice" | tail -5 >&2 || true
    exit 1
  fi
}

# True when the file starts with the plaintext SQLite magic.
sqlite_is_plaintext() {
  [[ "$(head -c 15 "$1" 2>/dev/null)" == "SQLite format 3" ]]
}

assert() {
  local msg="$1"; shift
  if "$@"; then echo "  ok: $msg"; else echo "  FAILED: $msg" >&2; exit 1; fi
}

assert_not() {
  local msg="$1"; shift
  if "$@"; then echo "  FAILED (expected false): $msg" >&2; exit 1; else echo "  ok: $msg"; fi
}

trap 'stop_gateway' EXIT
