#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Resolve a Swift package's dependencies with SwiftPM before a lane builds it,
# retrying only when the git host turned a clone or fetch away.
#
# Usage: scripts/ci/resolve-swift-packages.sh <package directory>
#
# SwiftPM clones every dependency anonymously from its git host, and a hosted
# runner's anonymous git traffic is now and then refused with HTTP 403 or 429,
# or meets a 5xx, before any project code runs. The workflow first restores
# the package's resolved state from a cache: .build/repositories,
# .build/checkouts, .build/workspace-state.json and Package.resolved. With all
# four present and matching the manifest, SwiftPM resolves without the network.
# Otherwise it resolves online, and when its output names one of those HTTP
# statuses this tries again after a pause: one retry for each value of
# OMNESIS_SWIFTPM_RETRY_DELAYS, in seconds (default "20 60 120"). Any other
# failure, such as a manifest error or a version that does not exist, fails at
# once with SwiftPM's output.
#
# Build or test the package afterwards with --disable-automatic-resolution, so
# the lane itself never goes back to the network.
set -uo pipefail

dir="${1:?usage: resolve-swift-packages.sh <package directory>}"
read -r -a delays <<<"${OMNESIS_SWIFTPM_RETRY_DELAYS:-20 60 120}"
attempts=$((${#delays[@]} + 1))
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

for ((attempt = 1; ; attempt++)); do
  swift package resolve --package-path "$dir" 2>&1 | tee "$log"
  status="${PIPESTATUS[0]}"
  if ((status == 0)); then
    echo "Swift packages in $dir resolved (attempt $attempt of $attempts)."
    exit 0
  fi
  code="$(grep -oE 'The requested URL returned error: (403|429|5[0-9][0-9])' "$log" | head -n 1 | grep -oE '[0-9]+$')"
  if [[ -z "$code" ]]; then
    echo "::error::SwiftPM could not resolve the packages in $dir; its output is above."
    exit "$status"
  fi
  if ((attempt == attempts)); then
    echo "::error::The git host still answered HTTP $code after $attempts attempts to resolve the packages in $dir."
    exit "$status"
  fi
  delay="${delays[$((attempt - 1))]}"
  echo "::warning::The git host answered HTTP $code while SwiftPM resolved $dir (attempt $attempt of $attempts); retrying in ${delay} s."
  sleep "$delay"
done
