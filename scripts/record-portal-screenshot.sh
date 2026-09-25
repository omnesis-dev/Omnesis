#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# record-portal-screenshot.sh — Automated screenshot of the web portal's
# Sources page (with the "+ Add source" modal open) for the landing page's
# "Manage from anywhere" showcase.
#
# Usage:
#   scripts/record-portal-screenshot.sh                 # both appearances
#   scripts/record-portal-screenshot.sh --dark          # dark only
#   scripts/record-portal-screenshot.sh --light         # light only
#
# Mirrors record-screenshots.sh (the iPhone pipeline): boots the synthetic
# demo gateway (John Smith persona — no personal data), waits for indexing,
# then drives the portal headlessly with Playwright (scripts/capture-portal.mjs)
# and scales each capture into the landing assets — dark at the showcase root,
# light under the parallel light/ subtree (same convention as the iPhone shot):
#
#   dark   -> website/media/status-portal.png
#   light  -> website/media/light/status-portal.png
#
# Prerequisites:
#   - Demo gateway NOT already running (this script starts/stops it).
#   - Playwright chromium installed (npx playwright install chromium).

set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"

APPEARANCES=()
while [ $# -gt 0 ]; do
    case "$1" in
        --dark) APPEARANCES+=("dark"); shift ;;
        --light) APPEARANCES+=("light"); shift ;;
        *) echo "Unknown arg: $1 (expected --dark or --light)" >&2; exit 1 ;;
    esac
done
if [ ${#APPEARANCES[@]} -eq 0 ]; then
    APPEARANCES=(dark light)
fi

GATEWAY_PORT="${OMNESIS_GATEWAY_PORT:-27600}"
DEMO_CONFIG_DIR="/tmp/omnesis-agent-demo"
ASSET_WIDTH=1650   # match the existing showcase asset width
PORTAL_ZOOM="${PORTAL_ZOOM:-1.5}"   # page-zoom for the capture (re-render, not pixel scale)

cleanup() {
    echo "Cleaning up..."
    bash scripts/start-demo-gateway.sh stop 2>/dev/null || true
}
trap cleanup EXIT

# ── Step 1: Start demo gateway ────────────────────────────────────
echo "==> Starting demo gateway..."
bash scripts/start-demo-gateway.sh start

for _i in $(seq 1 30); do
    if curl -sfk "https://localhost:$GATEWAY_PORT/health" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
echo "==> Demo gateway healthy."

TOKEN=$(cat "$DEMO_CONFIG_DIR/token")

# ── Step 2: Wait for indexing to complete ─────────────────────────
# So the Sources rows read "100% indexed" with real chunk counts.
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
    if [ "$READY" = "1" ]; then
        echo "==> Indexing complete."
        break
    fi
    sleep 2
done

# ── Step 3: Capture each appearance, scale into the landing asset ──
npx playwright install chromium >/dev/null 2>&1 || true

for appearance in "${APPEARANCES[@]}"; do
    echo ""
    echo "==> Capturing portal Sources page ($appearance, Add-source modal open)..."
    RAW_OUT="/tmp/omnesis-portal-screenshot-${appearance}.png"
    case "$appearance" in
        dark) asset="website/media/status-portal.png" ;;
        light) asset="website/media/light/status-portal.png" ;;
    esac
    rm -f "$RAW_OUT"

    PORTAL_URL="https://localhost:$GATEWAY_PORT" \
    PORTAL_TOKEN="$TOKEN" \
    PORTAL_OUT="$RAW_OUT" \
    PORTAL_APPEARANCE="$appearance" \
    PORTAL_ZOOM="$PORTAL_ZOOM" \
        node scripts/capture-portal.mjs

    if [ ! -f "$RAW_OUT" ]; then
        echo "  ✗ Capture failed — no $RAW_OUT" >&2
        exit 1
    fi

    mkdir -p "$(dirname "$asset")"
    ffmpeg -y -i "$RAW_OUT" \
        -vf "scale=${ASSET_WIDTH}:-2:flags=lanczos,unsharp=3:3:0.6:3:3:0.0" \
        "$asset" 2>/dev/null
    echo "  -> $asset ($(du -h "$asset" | cut -f1))"
done

echo "==> Done."
