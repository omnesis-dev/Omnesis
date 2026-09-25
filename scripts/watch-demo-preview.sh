#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# watch-demo-preview.sh — Assemble a standalone review page for the Apple
# Watch clips and serve it on the local network.
#
# Usage:
#   scripts/watch-demo-preview.sh [--port N] [--no-serve]
#
# This is a review surface, not a deliverable: it exists so the clips can
# be judged at their real size, in a watch bezel, before anything is wired
# into the landing page. It reads whatever `watch-demos-to-video.sh` last
# produced and copies it into a self-contained directory.

set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8971
SERVE=1
while [ $# -gt 0 ]; do
    case "$1" in
        --port) PORT="$2"; shift 2 ;;
        --no-serve) SERVE=0; shift ;;
        *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
done

SRC="demos/watch/web"
DEST="/tmp/omnesis-watch-preview"

[ -d "$SRC" ] || { echo "error: no web assets at $SRC — run scripts/record-watch-demos.sh first" >&2; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$SRC"/*.mp4 "$SRC"/*.png "$SRC"/*.webp "$DEST"/ 2>/dev/null || true

# One card per clip, in the order they tell a story: the trip question
# that spans several sources, the one-source lookup, the four-second
# answer.
CARDS=""
emit_card() {
    local slug="$1" question="$2" note="$3"
    [ -f "$DEST/${slug}.mp4" ] || return 0
    CARDS="$CARDS
      <figure class=\"clip\">
        <p class=\"question\">&ldquo;${question}&rdquo;</p>
        <div class=\"watch\">
          <div class=\"crown\"></div>
          <div class=\"side-button\"></div>
          <div class=\"screen\">
            <video src=\"${slug}.mp4\" poster=\"${slug}.png\" muted loop autoplay playsinline></video>
          </div>
        </div>
        <figcaption>${note}</figcaption>
      </figure>"
}

emit_card "eurostar" "Remind me if I booked my Eurostar to Paris for the triathlon?" \
    "Two searches &mdash; the triathlon context across Gmail and WhatsApp, then the booking across Gmail and Calendar &mdash; before opening the confirmation."
emit_card "last_call" "When did I last call my sister?" \
    "One source: the call log."
emit_card "wifi" "Hey, what&rsquo;s the wifi password for the Airbnb?" \
    "The short one. Search, read, answer &mdash; from a host&rsquo;s welcome email."

cat > "$DEST/index.html" <<HTML
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Omnesis &mdash; Apple Watch clips (review)</title>
    <style>
      :root {
        --bg: #0a0d12;
        --text: #e8ecf2;
        --text-dim: #8b95a5;
        --frame-bezel: #1b212b;
        --frame-bezel-hi: #2b323d;
        --frame-glass-edge: #0b0e13;
        /* Rendered at roughly 0.58x the 416x496 capture, so the panel is
           still comfortably over 1x on a retina display. */
        --screen-w: 242px;
        --screen-h: 288px;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 56px 24px 80px;
        background: var(--bg);
        color: var(--text);
        font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      header { max-width: 720px; margin: 0 auto 56px; text-align: center; }
      h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; letter-spacing: -0.01em; }
      header p { color: var(--text-dim); margin: 0; font-size: 14px; }
      .clips {
        display: flex;
        flex-wrap: wrap;
        gap: 56px 48px;
        justify-content: center;
        align-items: flex-start;
        max-width: 1100px;
        margin: 0 auto;
      }
      .clip { margin: 0; width: var(--screen-w); }
      .question {
        margin: 0 0 18px;
        font-size: 14px;
        line-height: 1.45;
        color: var(--text);
        text-align: center;
        min-height: 62px;
      }
      /* The watch body: the screen plus its bezel rings, with a crown and
         side button riding the right edge. Nothing is baked into the
         video &mdash; the capture is the bare 416x496 panel. */
      .watch { position: relative; width: var(--screen-w); height: var(--screen-h); margin: 0 auto; }
      .screen {
        position: absolute;
        inset: 0;
        border-radius: 26%/22%;
        overflow: hidden;
        background: #000;
        box-shadow:
          0 0 0 1px var(--frame-glass-edge),
          0 0 0 9px var(--frame-bezel),
          0 0 0 10px var(--frame-bezel-hi),
          0 18px 40px rgba(0, 0, 0, 0.55);
      }
      .screen video { display: block; width: 100%; height: 100%; object-fit: fill; }
      .crown, .side-button {
        position: absolute;
        left: calc(100% + 9px);
        background: linear-gradient(180deg, var(--frame-bezel-hi), var(--frame-bezel));
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
      }
      .crown { top: 30%; width: 7px; height: 34px; border-radius: 3px; }
      .side-button { top: 52%; width: 5px; height: 46px; border-radius: 3px; }
      figcaption {
        margin-top: 22px;
        font-size: 12.5px;
        line-height: 1.5;
        color: var(--text-dim);
        text-align: center;
      }
      footer {
        max-width: 720px;
        margin: 72px auto 0;
        text-align: center;
        color: var(--text-dim);
        font-size: 12.5px;
        line-height: 1.65;
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Apple Watch &mdash; &ldquo;Ask Omnesis&rdquo;</h1>
      <p>
        Recorded on a watchOS simulator against a synthetic gateway. The watch relays the
        question to a paired iPhone, which answers it through the replay agent &mdash; the
        activity card, source icons, counters and spoken read-along are all live.
      </p>
    </header>
    <div class="clips">$CARDS
    </div>
    <footer>
      Every name, booking, address and password here is invented.
      watchOS has no light appearance, so there is only a dark clip.
    </footer>
  </body>
</html>
HTML

echo "==> Preview assembled at $DEST"
ls -1 "$DEST"

if [ "$SERVE" = "1" ]; then
    # Bind all interfaces so the page is reachable over the tailnet, not
    # just from this machine.
    IP=$(ipconfig getifaddr en0 2>/dev/null || echo "")
    TS_IP=$(/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4 2>/dev/null \
        || tailscale ip -4 2>/dev/null || echo "")
    echo ""
    echo "==> Serving on port $PORT"
    [ -n "$TS_IP" ] && echo "    http://$TS_IP:$PORT/"
    [ -n "$IP" ] && echo "    http://$IP:$PORT/"
    echo "    http://localhost:$PORT/"
    echo ""
    cd "$DEST" && exec python3 -m http.server "$PORT" --bind 0.0.0.0
fi
