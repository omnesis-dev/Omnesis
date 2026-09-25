#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# record-cli-terminal.sh — Regenerate the landing page's "Manage from
# anywhere" CLI surface as an inline HTML terminal from real `omnesis status`
# output against the synthetic demo gateway (John Smith corpus — no personal
# data). Unlike the iPhone/portal surfaces this isn't a screenshot: the output
# is injected as themed HTML/CSS into website/index.html (see
# scripts/render-cli-terminal.mjs), so it stays crisp and follows the page's
# light/dark theme with no macOS window furniture.
#
# Usage:
#   scripts/record-cli-terminal.sh
#
# Prerequisites:
#   - Demo gateway NOT already running (this script starts/stops it).

set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"

GATEWAY_PORT="${OMNESIS_GATEWAY_PORT:-27600}"
DEMO_CONFIG_DIR="/tmp/omnesis-agent-demo"

cleanup() {
    echo "Cleaning up..."
    bash scripts/start-demo-gateway.sh stop 2>/dev/null || true
}
trap cleanup EXIT

# ── Step 1: Start demo gateway ────────────────────────────────────
echo "==> Starting demo gateway..."
bash scripts/start-demo-gateway.sh start

for _i in $(seq 1 30); do
    curl -sfk "https://localhost:$GATEWAY_PORT/health" >/dev/null 2>&1 && break
    sleep 1
done
echo "==> Demo gateway healthy."

TOKEN=$(cat "$DEMO_CONFIG_DIR/token")

# ── Step 2: Wait for indexing (so rows read "100% indexed") ───────
echo "==> Waiting for indexing to complete..."
for _i in $(seq 1 120); do
    STATS=$(curl -sfk "https://localhost:$GATEWAY_PORT/index/stats" \
        -H "Authorization: Bearer $TOKEN" 2>/dev/null || echo '{}')
    READY=$(printf '%s' "$STATS" | node -e '
        let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
            try {
                const j = JSON.parse(s);
                const g = j.totalGatewayDocs ?? 0, i = j.totalIndexed ?? 0;
                process.stdout.write(g > 0 && i >= g ? "1" : "0");
            } catch { process.stdout.write("0"); }
        });
    ')
    [ "$READY" = "1" ] && { echo "==> Indexing complete."; break; }
    sleep 2
done

# ── Step 3: Render the terminal HTML into website/index.html ──────
echo "==> Rendering CLI terminal..."
OMNESIS_GATEWAY_URL="https://localhost:$GATEWAY_PORT" \
OMNESIS_TOKEN="$TOKEN" \
OMNESIS_CONFIG_DIR="$DEMO_CONFIG_DIR" \
NODE_EXTRA_CA_CERTS="$DEMO_CONFIG_DIR/tls/cert.pem" \
    node scripts/render-cli-terminal.mjs

echo "==> Done."
