#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Boot a synthetic Omnesis gateway and run the Android live-gateway E2E on the host
# JVM. Mirrors scripts/run-ios-e2e.sh. The gateway serves HTTPS with a self-signed
# cert, so this exercises the real LeafCertPinner (pinned to the leaf fingerprint).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
export OMNESIS_CONFIG_DIR="${OMNESIS_CONFIG_DIR:-/tmp/omnesis-android-e2e}"
export OMNESIS_GATEWAY_PORT="${OMNESIS_GATEWAY_PORT:-17700}"
export OMNESIS_SYNTH_UNIVERSE="${OMNESIS_SYNTH_UNIVERSE:-e2e-minimal}"

URL="https://localhost:${OMNESIS_GATEWAY_PORT}"
CONFIG_FILE="/tmp/omnesis-android-e2e-config.json"

# Wipe previous state so each run is deterministic.
if [[ -d "$OMNESIS_CONFIG_DIR" ]]; then
  "$ROOT/scripts/synth-gateway.sh" stop >/dev/null 2>&1 || true
  rm -rf "$OMNESIS_CONFIG_DIR"
fi

echo "→ Booting synth gateway on $URL (universe=$OMNESIS_SYNTH_UNIVERSE)…"
"$ROOT/scripts/synth-gateway.sh" start >/dev/null

cleanup() {
  echo "→ Stopping synth gateway…"
  "$ROOT/scripts/synth-gateway.sh" stop >/dev/null 2>&1 || true
  rm -f "$CONFIG_FILE"
}
trap cleanup EXIT INT TERM

# Wait for /health.
for _ in $(seq 1 40); do
  curl -sk "${URL}/health" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sk "${URL}/health" >/dev/null 2>&1; then
  echo "Gateway did not come up at $URL after 40s" >&2
  tail -60 "$OMNESIS_CONFIG_DIR/logs/gateway.stdout.log" 2>/dev/null || true
  exit 1
fi

TOKEN="$(cat "$OMNESIS_CONFIG_DIR/token")"
FINGERPRINT="$(openssl x509 -fingerprint -sha256 -noout -in "$OMNESIS_CONFIG_DIR/tls/cert.pem" | cut -d= -f2 | tr -d ':')"

# Wait for at least one document to be ingested so search has something to return.
echo "→ Waiting for the universe to ingest…"
for _ in $(seq 1 90); do
  total=$(curl -sk -H "Authorization: Bearer $TOKEN" "${URL}/status" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('documents',{}).get('total',0))" 2>/dev/null || echo 0)
  [[ "${total:-0}" -ge 1 ]] && { echo "  ingested ${total} documents."; break; }
  sleep 1
done

# The config carries the gateway admin token; create it owner-only from the
# start (umask in a subshell, no world-readable window).
(umask 077; cat > "$CONFIG_FILE" <<EOF
{"gatewayURL":"$URL","apiToken":"$TOKEN","tlsFingerprint":"$FINGERPRINT"}
EOF
)
echo "→ Config written to $CONFIG_FILE (fingerprint=$FINGERPRINT)"

echo "→ Running Android live-gateway E2E (host JVM, real TLS pinning)…"
cd "$ROOT/android"
# shellcheck disable=SC1091
source scripts/android-env.sh
./gradlew :core-transport:testDebugUnitTest \
  --tests 'dev.omnesis.android.transport.e2e.GatewayLiveE2ETest' \
  -PomnesisE2e --rerun-tasks

echo "✓ Android live-gateway E2E complete."
