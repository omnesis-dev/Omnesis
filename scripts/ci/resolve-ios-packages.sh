#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Resolve the iOS project's Swift packages once, with retries, before any
# build or test step runs.
#
# Usage: scripts/ci/resolve-ios-packages.sh <scheme>
#
# The packages are fetched from GitHub, and a fetch that fails once on a
# hosted runner otherwise fails the whole lane with nothing but "Could not
# resolve package dependencies". This resolves up to three times, backing off
# between attempts, into OMNESIS_IOS_PACKAGES_DIR (default ios/build/packages,
# a directory CI caches). After it succeeds, each later xcodebuild call passes
#   -clonedSourcePackagesDirPath "$OMNESIS_IOS_PACKAGES_DIR" -disableAutomaticPackageResolution
# so it reads the resolved checkouts and never fetches again. A resolution that
# fails every attempt fails loudly with the last attempt's output.
#
# Run it after `xcodegen generate`: it resolves ios/Omnesis.xcodeproj.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGES_DIR="${OMNESIS_IOS_PACKAGES_DIR:-$ROOT/ios/build/packages}"

SCHEME="${1:?usage: resolve-ios-packages.sh <scheme>}"
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
mkdir -p "$PACKAGES_DIR"

delays=(0 15 45)
for attempt in 1 2 3; do
  sleep "${delays[$((attempt - 1))]}"
  if xcodebuild -resolvePackageDependencies \
    -project "$ROOT/ios/Omnesis.xcodeproj" \
    -scheme "$SCHEME" \
    -clonedSourcePackagesDirPath "$PACKAGES_DIR" >"$LOG" 2>&1; then
    echo "→ Swift packages resolved (attempt $attempt) into $PACKAGES_DIR."
    exit 0
  fi
  echo "Swift package resolution failed (attempt $attempt of 3)." >&2
done

tail -40 "$LOG" >&2
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  echo "::error::The iOS project's Swift packages could not be resolved after 3 attempts; see the output above."
fi
exit 1
