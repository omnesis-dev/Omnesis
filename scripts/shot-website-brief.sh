#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Refresh the brief still on the website's Brain page from the app itself.
#
# The page shows a phone with a brief open. Rather than a drawing of one, the
# image is a render of the real SwiftUI view against a real BriefRecord — the
# `briefHealthRecovery` fixture in PreviewMocks — so the site cannot drift into
# showing a screen the app does not produce. This runs the one snapshot case
# that renders it and copies both appearances into website/media/.
#
# It is a thin wrapper over scripts/ios-snapshot.sh, which does the real work:
# rsync the working tree to the configured macOS build host, run the case in a
# simulator, rsync the PNG back. Everything that script requires applies here,
# most importantly OMNESIS_EPIC_MACOS_HOST.
#
#   scripts/shot-website-brief.sh              # re-render and update the stills
#   scripts/shot-website-brief.sh --check      # fail if either still would change
#
# Re-run it whenever the brief fixture, BriefDetailSheet, or the app's theme
# changes; the committed PNG is the published artefact, not a build output.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASE="OmnesisTests/PreviewSnapshotTests/testBriefDetailHealthTrend"
OUT_DIR="${OMNESIS_IOS_SNAPSHOT_OUT:-/tmp/omnesis-snapshots}"
# The suite renders both appearances; the page swaps them on its theme toggle,
# the way the landing page swaps its device shots.
RENDERED_DARK="140-brief-detail-health-trend.png"
RENDERED_LIGHT="140-brief-detail-health-trend-light.png"
TARGET_DARK="$REPO_ROOT/website/media/brief-health-trend.png"
TARGET_LIGHT="$REPO_ROOT/website/media/light/brief-health-trend.png"

check_only=0
[[ "${1:-}" == "--check" ]] && check_only=1

echo "==> Rendering $CASE on ${OMNESIS_EPIC_MACOS_HOST:-<OMNESIS_EPIC_MACOS_HOST unset>}"
"$REPO_ROOT/scripts/ios-snapshot.sh" "$CASE"

stale=0
for pair in "$RENDERED_DARK:$TARGET_DARK" "$RENDERED_LIGHT:$TARGET_LIGHT"; do
  rendered="$OUT_DIR/${pair%%:*}"
  target="${pair#*:}"

  if [[ ! -f "$rendered" ]]; then
    echo "error: the snapshot lane produced no $(basename "$rendered") in $OUT_DIR" >&2
    echo "       (a green run that renders nothing is a failure, not a no-op)" >&2
    exit 1
  fi

  # A PNG that decoded to nothing would sail through a byte comparison, so the
  # size is checked before the file is allowed to become a published asset.
  bytes=$(wc -c <"$rendered")
  if (( bytes < 20000 )); then
    echo "error: $rendered is only ${bytes}B — too small to be a rendered screen" >&2
    exit 1
  fi

  if (( check_only )); then
    cmp -s "$rendered" "$target" || { echo "stale: ${target#"$REPO_ROOT/"}" >&2; stale=1; }
    continue
  fi

  mkdir -p "$(dirname "$target")"
  cp "$rendered" "$target"
  echo "==> Updated ${target#"$REPO_ROOT/"} (${bytes}B)"
done

if (( check_only )); then
  if (( stale )); then
    echo "       refresh with: scripts/shot-website-brief.sh" >&2
    exit 1
  fi
  echo "==> the committed stills match what the app renders today"
fi
