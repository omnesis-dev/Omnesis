#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# demos-to-video.sh — Encode demo MP4 masters into web-ready video for the
# landing page carousel.
#
# Usage:
#   scripts/demos-to-video.sh                          # all phone demos
#   scripts/demos-to-video.sh birthday_gifts swim_progress   # specific ones
#   scripts/demos-to-video.sh --variant ipad           # all iPad demos
#   scripts/demos-to-video.sh --variant ipad swim_progress
#   scripts/demos-to-video.sh --light                  # light-mode phone demos
#   scripts/demos-to-video.sh --variant ipad --light   # light-mode iPad demos
#
# Two form variants, each reading its own master dir and writing its own
# landing asset dir:
#   phone (default)  demos/<s>.mp4        -> website/demos/<s>.{mp4,png}
#   ipad             demos/ipad/<s>.mp4   -> website/demos/ipad/<s>.{mp4,png}
#
# Crossed with two appearances. Light masters/assets live under a parallel
# light/ subtree; the crop/scale knobs are appearance-independent:
#   dark (default)  demos[/ipad]/<s>.mp4       -> website/demos[/ipad]/<s>.{mp4,png}
#   --light         demos/light[/ipad]/<s>.mp4 -> website/demos/light[/ipad]/<s>.{mp4,png}
#
# The phone master is a portrait iPhone capture; the iPad master is a
# landscape iPad capture (wider frame, different chrome to crop). The
# carousel picks the variant by viewport — phones get the portrait
# videos, desktops the landscape ones (see website/index.html).
#
# Per scenario we write two assets:
#   <scenario>.mp4   H.264, plays reliably everywhere (incl. iOS Safari)
#   <scenario>.png   poster frame shown before autoplay / on inactive cards
#
# Encoding straight from the native master (not from a GIF) preserves full
# colour depth and density. Video is scaled to ~2x the carousel's CSS
# display width so it stays crisp on 1x/2x displays; the poster is kept
# high-res (see POSTER_WIDTH). Runs standalone or as the tail of
# record-demos.sh.
#
# Requires: ffmpeg (video + PNG poster) and cwebp (WebP poster; `brew install
# webp`).

set -euo pipefail
cd "$(dirname "$0")/.."

# Parse the --variant (form) and --appearance flags out of the args;
# everything else is a scenario name.
VARIANT="phone"
APPEARANCE="dark"
POSITIONAL=()
while [ $# -gt 0 ]; do
    case "$1" in
        --variant) VARIANT="$2"; shift 2 ;;
        --variant=*) VARIANT="${1#--variant=}"; shift ;;
        --ipad) VARIANT="ipad"; shift ;;
        --phone) VARIANT="phone"; shift ;;
        --appearance) APPEARANCE="$2"; shift 2 ;;
        --appearance=*) APPEARANCE="${1#--appearance=}"; shift ;;
        --light) APPEARANCE="light"; shift ;;
        --dark) APPEARANCE="dark"; shift ;;
        *) POSITIONAL+=("$1"); shift ;;
    esac
done
set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

# Shared encode knobs.
FPS=30             # Down from the ~36fps native capture; invisible here.
CRF_H264=18        # Lower = sharper; extra bitrate for streaming text.
SPLASH_TRIM=2.5    # Seconds of app-launch splash to skip.
HOLD_LAST=4        # Seconds to hold on the last frame before looping.

# Per-variant profile. WIDTH is ~2x the carousel's CSS display width for
# that variant: browsers downscale <video> with cheap GPU bilinear
# filtering (unlike <img>), so an oversized video reads *softer*, not
# sharper, on a 1x display — 2x gives a clean 2:1 shrink on 1x and a
# pixel-perfect 1:1 on 2x (retina). Posters are <img>s and follow the
# opposite rule (browsers resample <img> with a high-quality filter), so
# POSTER_WIDTH stays high and lets the browser shrink it crisply.
#
# CROP_* strip the device chrome (status bar, composer, home indicator)
# so the carousel frames the app content, not the OS furniture.
case "$VARIANT" in
    ipad)
        INPUT_DIR="demos/ipad"
        OUTPUT_DIR="website/demos/ipad"
        # simctl records the iPad's PHYSICAL (portrait) framebuffer, so a
        # landscape capture lands as a 2064x2752 portrait file with the UI
        # rotated 90° inside it. transpose=2 (90° CCW) rights it to a
        # 2752x2064 landscape frame BEFORE the crop/scale run.
        ROTATE="transpose=2,"
        WIDTH=1500
        POSTER_WIDTH=2200
        # Crop just below the landscape status bar (at 2x) so the app's own
        # top padding is preserved — cropping deeper shaved that padding and
        # left the header (≡ / Timeline) flush against the device bezel.
        CROP_TOP=50
        CROP_BOT=40        # Home-indicator strip at 2x, post-rotate.
        CROP_LEFT=0
        CROP_RIGHT=0
        ;;
    phone)
        INPUT_DIR="demos"
        OUTPUT_DIR="website/demos"
        ROTATE=""          # iPhone records portrait upright already.
        # 2x the 280px .demo-phone-frame CSS width.
        WIDTH=560
        POSTER_WIDTH=1000
        # Crop the OS chrome but preserve a balanced, equal margin above the
        # header and below the composer (~25px logical = 75px at 3x). The top
        # is capped by the Dynamic Island (its bottom is ~153px in), so the
        # bottom is matched to that for symmetry. These are baked into the
        # encode and shown verbatim (object-fit: fill), so the framing is
        # identical on every browser/device.
        CROP_TOP=155
        CROP_BOT=75
        CROP_LEFT=0
        CROP_RIGHT=0
        ;;
    *)
        echo "Unknown variant: $VARIANT (expected 'phone' or 'ipad')" >&2
        exit 1
        ;;
esac

# Route light-mode assets through a parallel light/ subtree (the crop/scale
# knobs above are appearance-independent). Replacing the first "demos"
# segment maps demos -> demos/light and demos/ipad -> demos/light/ipad on
# both the master and landing paths.
case "$APPEARANCE" in
    light)
        INPUT_DIR="${INPUT_DIR/demos/demos/light}"
        OUTPUT_DIR="${OUTPUT_DIR/demos/demos/light}"
        ;;
    dark) ;;
    *)
        echo "Unknown appearance: $APPEARANCE (expected 'dark' or 'light')" >&2
        exit 1
        ;;
esac

# The subset of scenarios used in the landing page carousel (same set for
# both variants so the phone/desktop carousels stay in lock-step).
LANDING_SCENARIOS=(
    birthday_gifts
    swim_progress
    marathon_prep
    url_lookup
    vendor_eval
    trip_spending
    sleep_recovery
    tenancy_deposit
    person_catchup
)

if [ $# -gt 0 ]; then
    SCENARIOS=("$@")
else
    SCENARIOS=("${LANDING_SCENARIOS[@]}")
fi

echo "==> Variant: $VARIANT  ·  Appearance: $APPEARANCE  ·  $INPUT_DIR/ -> $OUTPUT_DIR/  ·  width ${WIDTH}px"

# Crop expression shared by the video + poster filters: trim the chrome
# from all four edges (CROP_LEFT/RIGHT default to 0). Runs AFTER the
# per-variant ${ROTATE}, so in_w/in_h are the upright dimensions.
CROP="crop=in_w-${CROP_LEFT}-${CROP_RIGHT}:in_h-${CROP_TOP}-${CROP_BOT}:${CROP_LEFT}:${CROP_TOP}"
# Video filter: right the orientation (iPad), crop chrome, resample fps,
# scale (even height for yuv420p), then clone the final frame for
# HOLD_LAST seconds so the loop pauses on the answer.
FILT="${ROTATE}${CROP},fps=${FPS},scale=${WIDTH}:-2:flags=lanczos,tpad=stop_mode=clone:stop_duration=${HOLD_LAST}"
# Poster filter: same rotate + crop, high-resolution (see POSTER_WIDTH),
# single frame, no fps/pad. The light luma unsharp mask restores edge
# contrast on the small UI text: downscaling a full screen to a small card
# softens fine strokes, and sharpening counters that so neighbour cards
# read crisply.
POSTER_FILT="${ROTATE}${CROP},scale=${POSTER_WIDTH}:-2:flags=lanczos,unsharp=3:3:1.0:3:3:0.0"

mkdir -p "$OUTPUT_DIR"

for scenario in "${SCENARIOS[@]}"; do
    src="$INPUT_DIR/${scenario}.mp4"

    if [ ! -f "$src" ]; then
        echo "  skip $scenario (no $src)"
        continue
    fi

    duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src" | cut -d. -f1)

    duration_flag=""
    # Per-scenario overrides for outliers with heavy animation.
    case "$scenario" in
        swim_progress) duration_flag="-t 15" ;;
    esac

    mp4="$OUTPUT_DIR/${scenario}.mp4"
    poster="$OUTPUT_DIR/${scenario}.png"
    poster_webp="$OUTPUT_DIR/${scenario}.webp"

    echo "  Encoding $scenario (${duration}s src -> ${WIDTH}px, ${FPS}fps)..."

    # H.264/MP4 only. iOS Safari's VP9/WebM playback is unreliable (it can
    # stall a second or two in), and at these settings H.264 is no larger
    # than VP9 anyway — so a single, universally-supported MP4 is both
    # simpler and more robust than offering a WebM alternative.
    # shellcheck disable=SC2086
    ffmpeg -y -ss "$SPLASH_TRIM" $duration_flag -i "$src" \
        -vf "$FILT" \
        -c:v libx264 -crf "$CRF_H264" -preset slow -pix_fmt yuv420p \
        -an -movflags +faststart "$mp4" 2>/dev/null

    # Poster frame from the middle of the (post-splash) video. We write both a
    # PNG and a WebP: the page serves the WebP by default (it's ~half the size
    # for these screenshot frames) and falls back to the PNG where WebP isn't
    # supported (see the <picture> elements in website/index.html).
    mid=$(echo "($duration / 2) + $SPLASH_TRIM" | bc)
    ffmpeg -y -ss "$mid" -i "$src" -frames:v 1 -vf "$POSTER_FILT" "$poster" 2>/dev/null
    cwebp -quiet -q 80 "$poster" -o "$poster_webp"

    mp4_size=$(du -h "$mp4" | cut -f1)
    echo "  -> $mp4 ($mp4_size) + poster (png + webp)"
done

echo ""
echo "Landing videos ready in $OUTPUT_DIR/:"
ls -lhS "$OUTPUT_DIR"/*.mp4 2>/dev/null || echo "(none)"
