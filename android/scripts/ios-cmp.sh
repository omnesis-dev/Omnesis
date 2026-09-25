#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Side-by-side comparison for the iOS-parity rebuild: stitches an Android Roborazzi render
# next to its iOS reference into ONE labelled image, so an agent reads a single
# high-signal picture per check instead of two full-screen PNGs (saves image budget and
# aligns the two for an easier comparison).
#
# Usage:
#   scripts/ios-cmp.sh <android-render.png> <ios-ref.png> [out.png] [height]
# where <android-render.png> is a name under app/build/outputs/roborazzi/ (or an abs path)
# and <ios-ref.png> is a name under /tmp/ios-snapshots/ (or an abs path).
# Default height 1100px/side, output /tmp/cmp/cmp.png. Prints the output path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RZ="$ROOT/app/build/outputs/roborazzi"
IOS="/tmp/ios-snapshots"
OUTDIR="/tmp/cmp"; mkdir -p "$OUTDIR"

resolve() { case "$1" in /*) printf '%s' "$1";; *) [ -f "$RZ/$1" ] && printf '%s' "$RZ/$1" || printf '%s' "$IOS/$1";; esac; }

A="$(resolve "$1")"
B="$(resolve "$2")"
OUT="${3:-$OUTDIR/cmp.png}"
H="${4:-1100}"

[ -f "$A" ] || { echo "android render not found: $1 (looked in $RZ)" >&2; exit 1; }
[ -f "$B" ] || { echo "ios ref not found: $2 (looked in $IOS)" >&2; exit 1; }

# Resize both to the same height, then append with a bright divider. Left = ANDROID,
# right = iOS (no text labels — macOS ImageMagick has no default font; the order is fixed).
magick "$A" -resize "x${H}" /tmp/cmp/_a.png
magick "$B" -resize "x${H}" /tmp/cmp/_b.png
magick /tmp/cmp/_a.png \( -size "4x${H}" xc:'#f85149' \) /tmp/cmp/_b.png +append \
  -bordercolor '#30363d' -border 8 "$OUT"
echo "$OUT"
