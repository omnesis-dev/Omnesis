#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Shift-left the Android PURE-LOGIC feedback loop to a configured macOS build
# host over ssh — WITHOUT an emulator. This runs the JVM-only
# `testDebugUnitTest` lane on the pure-logic Gradle modules (the transport
# decoders, pairing, reducers / models / timing), so the agent gets a fast
# deterministic signal on a logic change before reaching for the slow
# `scripts/android-render.sh` Roborazzi render.
#
# Why this exists: the Android SDK + AGP-downloaded aapt2 ship only for
# linux-x86_64 and macOS — there is NO linux-aarch64 build, so even
# `./gradlew test` fails its resource transform on this (aarch64 Linux) box.
# But the logic modules' unit tests run on the plain JVM (no aapt2 resource
# transform on the hot path, no emulator, no Robolectric Compose render), in
# about a second once the Gradle cache is warm. This bridges that lane to the
# macOS host and keeps the scratch checkout WARM (a persistent dir + reused
# Gradle build/configuration cache) so repeat runs are fast.
#
# This MIRRORS scripts/android-render.sh's shape (env-host + path-guard +
# rsync-up), but runs the FAST emulator-less JVM logic lane instead of the
# Roborazzi screenshot lane.
#
# It NEVER pushes, commits, or opens PRs on the host (all git mutations stay
# with the caller), and it refuses to rsync onto live state: the macOS host is
# used freely for building/testing, but ONLY in a dedicated scratch checkout —
# it hard-fails if the resolved target path is the operator's primary checkout
# or a CI runner clone (a `_work` path).
#
# Usage:
#   scripts/android-logic.sh                       # the pure-logic JVM lane (core modules)
#   scripts/android-logic.sh --module :feature-health   # one module's testDebugUnitTest
#   scripts/android-logic.sh --tests dev.omnesis.android.transport.dto.DtoDecodeTest
#
# Configuration (all optional except the host; generic defaults — nothing
# operator-private is committed: the host alias / paths are read at runtime):
#   OMNESIS_EPIC_MACOS_HOST              ssh alias/host of the macOS build
#                                        machine. REQUIRED — unset is a hard,
#                                        loud error (never a guessed alias).
#   OMNESIS_EPIC_MACOS_ANDROID_LOGIC_WORKTREE  absolute path to a DEDICATED,
#                                        WARM scratch checkout on the host
#                                        (default: ~/omnesis-android-logic,
#                                        expanded on the host). It is NOT wiped
#                                        between runs so the Gradle build/config
#                                        cache survives — that is the warm-
#                                        checkout speedup. Must NOT resolve into
#                                        the host's primary checkout or a `_work`
#                                        runner clone — guarded below.
#   OMNESIS_ANDROID_JAVA_HOME            JDK 17 home on the host
#                                        (default: /opt/homebrew/opt/openjdk@17)
#   OMNESIS_ANDROID_SDK_HOME             Android SDK root on the host
#                                        (default: $HOME/Library/Android/sdk)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- Arguments. ----------------------------------------------------------------
# --module <m>       restrict to a single Gradle module's testDebugUnitTest.
# --tests <filter>   pass a --tests filter through to gradle.
MODULE=""
TESTS_FILTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --module) shift; [[ -n "${1:-}" ]] || { echo "android-logic: --module needs a value" >&2; exit 64; }; MODULE="$1"; shift ;;
    --tests)  shift; [[ -n "${1:-}" ]] || { echo "android-logic: --tests needs a value" >&2; exit 64; }; TESTS_FILTER="$1"; shift ;;
    *) echo "android-logic: unknown argument '$1'" >&2; exit 64 ;;
  esac
done

# --- Configuration (generic env, fail-loud on the host). -----------------------
HOST="${OMNESIS_EPIC_MACOS_HOST:-}"
if [[ -z "$HOST" ]]; then
  cat >&2 <<'EOF'
android-logic: OMNESIS_EPIC_MACOS_HOST is not set.

This script bridges the Android JVM-only logic test lane to a macOS build host
over ssh — the Android SDK does not run on this (aarch64 Linux) box. Set the ssh
alias/host of your macOS build machine and re-run, e.g.:

    export OMNESIS_EPIC_MACOS_HOST=<your-macos-ssh-alias>
    scripts/android-logic.sh

(See android/AGENTS.md → "Fast inner loops (native lanes)".)
EOF
  exit 78  # EX_CONFIG — a required config value is missing.
fi

# Persistent (WARM) scratch checkout path on the host. Default is a clearly
# dedicated dir under the host's HOME; the operator may point it elsewhere
# (still must be dedicated). It is deliberately NOT deleted between runs so the
# Gradle build/configuration cache survives and repeat runs are fast.
REMOTE_WORKTREE="${OMNESIS_EPIC_MACOS_ANDROID_LOGIC_WORKTREE:-\$HOME/omnesis-android-logic}"
# Android toolchain locations on the host (generic Homebrew/SDK defaults; the
# operator overrides if their layout differs). The SDK home is resolved on the
# HOST so $HOME expands there, not on this box.
REMOTE_JAVA_HOME="${OMNESIS_ANDROID_JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
REMOTE_SDK_HOME="${OMNESIS_ANDROID_SDK_HOME:-\$HOME/Library/Android/sdk}"

fail() { echo "android-logic: $*" >&2; exit 1; }

# --- Guard: refuse to rsync onto live state on the host. -----------------------
# Resolve the scratch path ON THE HOST, then refuse it if it is the operator's
# primary checkout (a `.omnesis-primary` sentinel), a CI runner clone (a `_work`
# segment), or the host's HOME root. Path-based + conservative so the guard is
# deterministic — mirrors android-render.sh.
RESOLVED_TARGET="$(ssh "$HOST" "printf '%s' \"$REMOTE_WORKTREE\"" 2>/dev/null)" \
  || fail "could not ssh to '$HOST' to resolve the scratch path — is the host reachable?"
[[ -n "$RESOLVED_TARGET" ]] || fail "resolved an empty scratch path on '$HOST'"

case "$RESOLVED_TARGET" in
  */_work/*|*/_work)
    fail "refusing to use '$RESOLVED_TARGET' — it resolves into a CI runner clone (_work). Point OMNESIS_EPIC_MACOS_ANDROID_LOGIC_WORKTREE at a dedicated scratch checkout."
    ;;
esac

if ssh "$HOST" "test -e \"$RESOLVED_TARGET/.omnesis-primary\"" 2>/dev/null; then
  fail "refusing to use '$RESOLVED_TARGET' — it is marked as the primary checkout (.omnesis-primary sentinel). Use a dedicated scratch checkout."
fi
HOST_HOME="$(ssh "$HOST" 'printf %s "$HOME"' 2>/dev/null)" || fail "could not read \$HOME on '$HOST'"
if [[ -n "$HOST_HOME" && "$RESOLVED_TARGET" == "$HOST_HOME" ]]; then
  fail "refusing to use '$RESOLVED_TARGET' — that is the host's HOME, not a dedicated scratch checkout."
fi

# --- Pick the Gradle tasks. ----------------------------------------------------
# Default = the pure-logic JVM modules whose testDebugUnitTest needs NO emulator
# and NO Robolectric Compose render: the transport decoders/clients, pairing,
# the design-system markdown logic, and the phone setup flow engine. (The :app and :feature-health modules
# also have logic tests, but they share a module with the slow Roborazzi
# screenshot lane — narrow to them with --module + --tests when needed.)
if [[ -n "$MODULE" ]]; then
  if [[ "$MODULE" == ":app" || "$MODULE" == "app" ]]; then
    GRADLE_TASKS=":app:testPlayDebugUnitTest"
  else
    GRADLE_TASKS="$MODULE:testDebugUnitTest"
  fi
else
  GRADLE_TASKS=":core-transport:testDebugUnitTest :core-pairing:testDebugUnitTest :core-designsystem:testDebugUnitTest :core-setup:testDebugUnitTest"
fi
GRADLE_EXTRA=""
[[ -n "$TESTS_FILTER" ]] && GRADLE_EXTRA="--tests $TESTS_FILTER"

echo "→ macOS host:        $HOST"
echo "→ warm scratch:      $RESOLVED_TARGET (persistent — Gradle cache reused)"
echo "→ JVM logic tasks:   $GRADLE_TASKS"

# --- Ensure the WARM scratch dir exists on the host (never wiped). -------------
ssh "$HOST" "mkdir -p \"$RESOLVED_TARGET/android\"" \
  || fail "could not create the scratch dir on '$HOST'"

# --- 1. rsync the UNCOMMITTED android/ working tree up. ------------------------
# Trailing slashes copy the contents of android/ into the scratch android/. We
# EXCLUDE the Gradle caches + build dirs from the transfer so the host's WARM
# caches are preserved (not clobbered by the box's), and the machine-local SDK
# pointer. Keeping `.gradle` and `build` on the host is the warm-cache speedup.
echo "→ rsync android/ → $HOST:$RESOLVED_TARGET/android/ (preserving Gradle cache) …"
rsync -az --delete \
  --exclude '.gradle' \
  --exclude 'build' \
  --exclude '**/build' \
  --exclude 'local.properties' \
  --exclude '.kotlin' \
  "$ROOT/android/" "$HOST:$RESOLVED_TARGET/android/" \
  || fail "rsync of the android/ working tree to '$HOST' failed"

# --- 1b. rsync the synthetic-corpus universe data up. -------------------------
# Tests that drive a canonical cassette through the real decode+reduce pipeline
# (the deep-research cassette test) read it from `evals/universes/<name>/`. The
# scratch otherwise carries only `android/`, so resolve the universe data too.
ssh "$HOST" "mkdir -p \"$RESOLVED_TARGET/evals/universes\"" || true
rsync -az --delete \
  "$ROOT/evals/universes/" "$HOST:$RESOLVED_TARGET/evals/universes/" \
  || fail "rsync of evals/universes to '$HOST' failed"

# --- 2. run the JVM-only logic lane over ssh (NO emulator). --------------------
# The Android toolchain is NOT on the default ssh PATH, so we export it inline
# (the recipe android/AGENTS.md documents). `--build-cache` reuses the warm
# Gradle build cache in the persistent scratch dir, and we opt INTO Gradle's
# configuration cache for this fast lane via `--configuration-cache` (a
# lane-local flag — gradle.properties keeps it off globally so the Roborazzi /
# CI lanes are unaffected; the warm scratch dir persists the cached config so a
# repeat run skips the configuration phase entirely). No `--rerun-tasks` here:
# for the FAST lane we WANT Gradle to skip UP-TO-DATE work — that is the whole
# point of shift-left.
echo "→ ssh $HOST: gradle $GRADLE_TASKS (JVM only, no emulator) …"
ssh "$HOST" "bash -lc '
  set -euo pipefail
  cd \"$RESOLVED_TARGET/android\"
  export JAVA_HOME=\"$REMOTE_JAVA_HOME\"
  export ANDROID_HOME=\"$REMOTE_SDK_HOME\"
  export ANDROID_SDK_ROOT=\"\$ANDROID_HOME\"
  export PATH=\"\$JAVA_HOME/bin:\$PATH\"
  [ -x ./gradlew ] || { echo \"./gradlew not found in \$(pwd)\" >&2; exit 1; }
  ./gradlew $GRADLE_TASKS $GRADLE_EXTRA --build-cache --configuration-cache
'" || fail "the Android JVM-only logic lane failed on '$HOST' (compile or test failure)"

echo "✓ Android pure-logic JVM test lane passed on $HOST — emulator-less, fast feedback."
