#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Shift-left the iOS PURE-LOGIC feedback loop to a configured macOS build host
# over ssh — WITHOUT a simulator build. This runs the SwiftPM `swift test`
# lane (the reducer / model / timing tests that need no UIKit, no simulator and
# no Xcode project), so the agent gets a fast deterministic signal on a logic
# change before reaching for the slow `scripts/ios-snapshot.sh` simulator render.
#
# Why this exists: Xcode and the iOS simulator are macOS-only, and even on the
# Mac a full `xcodebuild test` for the simulator (what ios-snapshot.sh drives)
# is minutes. But the bulk of the iOS test suite is pure logic — the agent
# timeline/turn builders, health normalizer/cursor, schemas, offline buffer,
# markdown streaming, sync-reminder timing. Those compile and run natively for
# macOS via `swift test` against `ios/Package.swift` (the iOS-only UI is
# `#if canImport(UIKit)`-compiled-out there), in SECONDS — no device build.
#
# This MIRRORS scripts/ios-snapshot.sh's shape (env-host + path-guard +
# rsync-up), but runs the FAST sim-less logic target instead of a sim render,
# and keeps the macOS scratch checkout WARM (a persistent dir + reused
# `.build` SwiftPM cache) so a repeat run skips recompilation.
#
# It NEVER pushes, commits, or opens PRs on the host (all git mutations stay
# with the caller), and it refuses to rsync onto live state: the macOS host is
# used freely for building/testing, but ONLY in a dedicated scratch checkout —
# it hard-fails if the resolved target path is the operator's primary checkout
# or a CI runner clone (a `_work` path).
#
# Usage:
#   scripts/ios-logic.sh                                # the whole logic suite
#   scripts/ios-logic.sh AgentTurnBuilderTests          # one XCTest class (filter)
#   scripts/ios-logic.sh --filter HealthNormalizer      # a substring filter
#
# Configuration (all optional except the host; generic defaults — nothing
# operator-private is committed: the host alias / paths are read at runtime):
#   OMNESIS_EPIC_MACOS_HOST            ssh alias/host of the macOS build machine.
#                                      REQUIRED — unset is a hard, loud error
#                                      (this script never guesses a personal
#                                      alias).
#   OMNESIS_EPIC_MACOS_IOS_LOGIC_WORKTREE  absolute path to a DEDICATED, WARM
#                                      scratch checkout on the host (default:
#                                      ~/omnesis-ios-logic, expanded on the
#                                      host). It is NOT wiped between runs so the
#                                      SwiftPM `.build` cache survives — that is
#                                      the warm-checkout speedup. Must NOT
#                                      resolve into the host's primary checkout
#                                      or a `_work` runner clone — guarded below.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- Argument: an optional `swift test --filter` value. ------------------------
# Accept either a bare filter argument or an explicit `--filter <value>`.
FILTER=""
if [[ "${1:-}" == "--filter" ]]; then
  shift
  [[ -n "${1:-}" ]] || { echo "ios-logic: --filter needs a value" >&2; exit 64; }
  FILTER="$1"
elif [[ -n "${1:-}" ]]; then
  FILTER="$1"
fi

# --- Configuration (generic env, fail-loud on the host). -----------------------
HOST="${OMNESIS_EPIC_MACOS_HOST:-}"
if [[ -z "$HOST" ]]; then
  cat >&2 <<'EOF'
ios-logic: OMNESIS_EPIC_MACOS_HOST is not set.

This script bridges the iOS pure-logic `swift test` lane to a macOS build host
over ssh — Swift's iOS toolchain does not run on this (Linux) box. Set the ssh
alias/host of your macOS build machine and re-run, e.g.:

    export OMNESIS_EPIC_MACOS_HOST=<your-macos-ssh-alias>
    scripts/ios-logic.sh

(See ios/AGENTS.md → "Fast inner loops (native lanes)".)
EOF
  exit 78  # EX_CONFIG — a required config value is missing.
fi

# Persistent (WARM) scratch checkout path on the host. Default is a clearly
# dedicated dir under the host's HOME; the operator may point it elsewhere
# (still must be dedicated). It is deliberately NOT deleted between runs so the
# SwiftPM `.build` cache survives and repeat runs are fast.
REMOTE_WORKTREE="${OMNESIS_EPIC_MACOS_IOS_LOGIC_WORKTREE:-\$HOME/omnesis-ios-logic}"

fail() { echo "ios-logic: $*" >&2; exit 1; }

# --- Guard: refuse to rsync onto live state on the host. -----------------------
# Resolve the scratch path ON THE HOST (so ~ / $HOME / symlinks expand there),
# then refuse it if it is the operator's primary checkout or a CI runner clone.
# A runner clone always contains a `_work` path segment; the primary checkout is
# identified by a `.omnesis-primary` sentinel the operator drops there (the real
# primary-checkout path is not knowable generically). We also refuse the host's
# HOME root outright (never rsync a whole HOME). Path-based + conservative so the
# guard is deterministic.
RESOLVED_TARGET="$(ssh "$HOST" "printf '%s' \"$REMOTE_WORKTREE\"" 2>/dev/null)" \
  || fail "could not ssh to '$HOST' to resolve the scratch path — is the host reachable?"
[[ -n "$RESOLVED_TARGET" ]] || fail "resolved an empty scratch path on '$HOST'"

case "$RESOLVED_TARGET" in
  */_work/*|*/_work)
    fail "refusing to use '$RESOLVED_TARGET' — it resolves into a CI runner clone (_work). Point OMNESIS_EPIC_MACOS_IOS_LOGIC_WORKTREE at a dedicated scratch checkout."
    ;;
esac

if ssh "$HOST" "test -e \"$RESOLVED_TARGET/.omnesis-primary\"" 2>/dev/null; then
  fail "refusing to use '$RESOLVED_TARGET' — it is marked as the primary checkout (.omnesis-primary sentinel). Use a dedicated scratch checkout."
fi
HOST_HOME="$(ssh "$HOST" 'printf %s "$HOME"' 2>/dev/null)" || fail "could not read \$HOME on '$HOST'"
if [[ -n "$HOST_HOME" && "$RESOLVED_TARGET" == "$HOST_HOME" ]]; then
  fail "refusing to use '$RESOLVED_TARGET' — that is the host's HOME, not a dedicated scratch checkout."
fi

SWIFT_FILTER_DESC="${FILTER:-<all logic tests>}"
echo "→ macOS host:        $HOST"
echo "→ warm scratch:      $RESOLVED_TARGET (persistent — .build cache reused)"
echo "→ swift test filter: $SWIFT_FILTER_DESC"

# --- Ensure the WARM scratch dir exists on the host (never wiped). -------------
ssh "$HOST" "mkdir -p \"$RESOLVED_TARGET/ios\"" \
  || fail "could not create the scratch dir on '$HOST'"

# --- 1. rsync the UNCOMMITTED ios/ working tree up. ----------------------------
# Trailing slashes copy the contents of ios/ into the scratch ios/. We EXCLUDE
# the SwiftPM `.build` dir from the transfer (so the warm cache on the host is
# preserved, not clobbered by the box's empty one) and the generated Xcode
# project + DerivedData (irrelevant to `swift test`). Crucially we do NOT pass
# `--delete` for `.build` — that is what keeps the host's build cache warm.
echo "→ rsync ios/ → $HOST:$RESOLVED_TARGET/ios/ (preserving .build cache) …"
rsync -az --delete \
  --exclude '.build' \
  --exclude 'Omnesis.xcodeproj' \
  --exclude 'DerivedData' \
  --exclude '*.xcuserstate' \
  "$ROOT/ios/" "$HOST:$RESOLVED_TARGET/ios/" \
  || fail "rsync of the ios/ working tree to '$HOST' failed"

# --- 2. run the pure-logic `swift test` over ssh (NO simulator). ---------------
# `swift test` builds + runs the SwiftPM `OmnesisTests` target natively for
# macOS — the iOS-only UI/snapshot tests are `exclude`d from that target in
# Package.swift, and the iOS-only sources are `#if canImport(UIKit)`-compiled
# out, so there is no simulator, no Xcode project, no device build. Pure logic.
SWIFT_FILTER_ARG=""
[[ -n "$FILTER" ]] && SWIFT_FILTER_ARG="--filter $FILTER"
echo "→ ssh $HOST: swift test (sim-less, logic only) …"
ssh "$HOST" "bash -lc '
  set -euo pipefail
  cd \"$RESOLVED_TARGET/ios\"
  command -v swift >/dev/null || { echo \"swift not found on \$(hostname)\" >&2; exit 1; }
  swift test $SWIFT_FILTER_ARG
'" || fail "the iOS pure-logic swift test lane failed on '$HOST' (compile or test failure)"

echo "✓ iOS pure-logic swift test lane passed on $HOST — sim-less, fast feedback."
