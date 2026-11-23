#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Trim the Gradle user home to what spares a later CI run its downloads, just
# before a workflow saves it as an Actions cache entry, and print what it holds.
#
# Usage: scripts/ci/gradle-cache-trim.sh
#
# Kept: the downloaded dependencies (caches/modules-2), the Gradle distribution
# (wrapper/dists), and Gradle's per-version caches of compiled build scripts and
# generated API jars, which a build would otherwise spend its configuration
# time recreating.
#
# Removed: the local build cache (task outputs) and the artifact transforms
# (unpacked, jetified and dexed dependencies). They are most of the bytes, they
# grow with every revision an entry is saved from, and a build recreates them
# from modules-2 without the network. Also removed, as the actions/cache Gradle
# example does: the lock file and GC state Gradle left in modules-2.
#
# The repository's Actions caches share a 10 GB limit, and an entry over it
# evicts the least recently used one. A smaller entry keeps main's Gradle
# entry, the one every Android run restores, from being evicted; a run that
# finds no entry downloads every dependency again, which Maven Central answers
# with HTTP 429 when a shared runner address has asked too often.
set -euo pipefail

home="${GRADLE_USER_HOME:-$HOME/.gradle}"

# Every entry one level down in caches/ and wrapper/dists/, with Gradle's
# per-version cache directories broken down one level further, largest first,
# in MiB. Each is measured on its own: du counts a directory once per call, so
# one call would leave a per-version directory's children out.
sizes() {
  local entry
  for entry in "$home"/caches/* "$home"/caches/[0-9]*.*/* "$home"/wrapper/dists/*; do
    [[ -e "$entry" ]] || continue
    [[ "$entry" =~ /caches/[0-9]+\.[^/]*$ ]] && continue
    du -sk "$entry"
  done | sort -rn | awk -v home="$home/" '
    { sub(home, "", $2); printf "%8d MiB  %s\n", $1 / 1024, $2 }'
}

total() {
  du -sk "$home/caches" "$home/wrapper" 2>/dev/null | awk '{ s += $1 } END { printf "%d MiB", s / 1024 }'
}

if [[ ! -d "$home/caches" ]]; then
  echo "No Gradle cache at $home/caches: nothing to trim."
  exit 0
fi

echo "The Gradle user home before trimming ($(total)):"
sizes

rm -rf "$home"/caches/build-cache-* "$home"/caches/transforms-* "$home"/caches/[0-9]*.*/transforms
rm -f "$home/caches/modules-2/modules-2.lock" "$home/caches/modules-2/gc.properties"

echo "Saved after trimming ($(total)):"
sizes
