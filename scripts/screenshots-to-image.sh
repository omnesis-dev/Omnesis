#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# screenshots-to-image.sh — Scale raw demo-app screenshots into the
# landing page's "Manage from anywhere" showcase assets.
#
# Usage:
#   scripts/screenshots-to-image.sh                 # both appearances
#   scripts/screenshots-to-image.sh dark            # dark only
#   scripts/screenshots-to-image.sh dark light
#
# Reads the raw full-resolution captures written by record-screenshots.sh
# (/tmp/omnesis-screenshot-<appearance>.png) and scales each to the asset
# width, writing the dark asset at the showcase root and the light asset
# under a parallel light/ subtree — the same convention the carousel uses
# for its demos/light/ recordings:
#
#   dark   -> website/media/status-ios.png
#   light  -> website/media/light/status-ios.png
#
# The full device screen is kept (status bar, content, tab bar); the
# landing page frames it with the CSS device bezel and rounds the corners,
# so no chrome is cropped here. The capture is just downscaled — these are
# <img>s, which browsers resample with a high-quality filter, so a high
# asset resolution stays crisp when the page shrinks it into the showcase.

set -euo pipefail
cd "$(dirname "$0")/.."

APPEARANCES=("$@")
if [ ${#APPEARANCES[@]} -eq 0 ]; then
    APPEARANCES=(dark light)
fi

# ~3x the 240px desktop showcase width: high enough to stay sharp on retina
# and when the mobile breakpoints scale it, small enough to keep the PNG
# light. A gentle luma unsharp restores edge contrast on the small UI text
# the downscale softens (same recipe as the carousel posters).
ASSET_WIDTH=720
FILT="scale=${ASSET_WIDTH}:-2:flags=lanczos,unsharp=3:3:0.8:3:3:0.0"

for appearance in "${APPEARANCES[@]}"; do
    src="/tmp/omnesis-screenshot-${appearance}.png"
    if [ ! -f "$src" ]; then
        echo "  skip $appearance (no $src)"
        continue
    fi

    case "$appearance" in
        dark) out="website/media/status-ios.png" ;;
        light) out="website/media/light/status-ios.png" ;;
        *) echo "Unknown appearance: $appearance" >&2; exit 1 ;;
    esac

    mkdir -p "$(dirname "$out")"
    ffmpeg -y -i "$src" -vf "$FILT" "$out" 2>/dev/null

    size=$(du -h "$out" | cut -f1)
    echo "  -> $out ($size)"
done

echo ""
echo "Landing screenshots ready:"
ls -lh website/media/status-ios.png website/media/light/status-ios.png 2>/dev/null || true
