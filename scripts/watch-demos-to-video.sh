#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# watch-demos-to-video.sh — Turn Apple Watch capture masters into
# web-ready assets: an H.264 MP4 plus a poster in PNG and WebP.
#
# Usage:
#   scripts/watch-demos-to-video.sh [scenario ...]
#
# Input:  demos/watch/<scenario>.mp4   (from record-watch-demos.sh)
# Output: demos/watch/web/<scenario>.{mp4,png,webp}
#
# Two things differ from the phone/iPad encoder:
#
#   - No crop. A watch capture is the whole 416×496 display; there is no
#     Dynamic Island or composer chrome to trim, and the clock in the
#     corner is part of what makes it read as a watch.
#   - No scale, and no light variant. 416×496 is the panel's true pixel
#     resolution, so upscaling would add weight without detail — the page
#     renders it at roughly half that in CSS for a 2× effective density.
#     watchOS has no light appearance, so the dark clip is the only one
#     that exists.

set -euo pipefail
cd "$(dirname "$0")/.."

SRC_DIR="demos/watch"
OUT_DIR="demos/watch/web"

FPS=30
CRF_H264=18
# Clone the final frame so the answer stays readable after the read-along
# highlight finishes, instead of snapping back to the start of the loop.
HOLD_LAST=1.5

ALL_SCENARIOS=(eurostar last_call wifi)
if [ $# -gt 0 ]; then
    SCENARIOS=("$@")
else
    SCENARIOS=("${ALL_SCENARIOS[@]}")
fi

command -v ffmpeg >/dev/null || { echo "error: ffmpeg not found" >&2; exit 1; }
command -v cwebp >/dev/null || { echo "error: cwebp not found (brew install webp)" >&2; exit 1; }

mkdir -p "$OUT_DIR"

for scenario in "${SCENARIOS[@]}"; do
    SRC="$SRC_DIR/${scenario}.mp4"
    if [ ! -f "$SRC" ]; then
        echo "warning: no master at $SRC — skipping" >&2
        continue
    fi

    MP4="$OUT_DIR/${scenario}.mp4"
    PNG="$OUT_DIR/${scenario}.png"
    WEBP="$OUT_DIR/${scenario}.webp"

    echo "==> $scenario"
    ffmpeg -y -loglevel error -i "$SRC" \
        -vf "fps=${FPS},tpad=stop_mode=clone:stop_duration=${HOLD_LAST}" \
        -c:v libx264 -crf "$CRF_H264" -preset slow -pix_fmt yuv420p -an \
        -movflags +faststart "$MP4"

    # Poster from the mid-point: far enough in that the activity card is
    # populated, so a page that never plays the video still shows the
    # thing the clip is about.
    DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SRC")
    MID=$(python3 -c "print(max(0.1, float('$DURATION') / 2))")
    ffmpeg -y -loglevel error -ss "$MID" -i "$SRC" -frames:v 1 "$PNG"
    cwebp -quiet -q 80 "$PNG" -o "$WEBP"

    echo "    $(basename "$MP4") $(du -h "$MP4" | cut -f1)  ·  poster $(du -h "$WEBP" | cut -f1)"
done

echo "✓ Web assets in $OUT_DIR/"
