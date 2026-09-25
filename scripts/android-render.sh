#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Bridge the Android Roborazzi screenshot loop from this (Linux) box to a
# configured macOS build host over ssh, then pull the rendered PNGs back so the
# agent can `Read` them — the same visual self-critique loop the Android guide
# mandates, across the ssh boundary. This MIRRORS scripts/ios-snapshot.sh.
#
# Why this exists: the Android SDK + AGP-downloaded aapt2 ship only for
# linux-x86_64 and macOS — there is NO linux-aarch64 build, so even
# `./gradlew test` fails its resource transform on this (aarch64 Linux) box.
# This script codifies the offload recipe into one reusable, generic,
# env-configured command: rsync the WORKING TREE (uncommitted edits included),
# render the Roborazzi PNGs on the host, and rsync them back: always to a
# local scratch dir to be Read, and in record mode also into the tracked
# goldens under android/<module>/src/test/roborazzi/.
#
# By default it RECORDS the goldens (`recordRoborazziPlayDebug` for the app,
# `recordRoborazziDebug` for libraries) so the agent can
# Read + self-critique a first capture before committing it (a golden only
# catches DRIFT from its first capture — an already-wrong first render would
# lock the bug in). Pass `--verify` to run the CI-style compare task
# (`verifyRoborazziDebug`) against the already-committed goldens instead.
#
# It NEVER pushes, commits, or opens PRs on the host (all git mutations stay
# with the caller), and it refuses to rsync onto live state: the macOS host is
# used freely for building/testing, but ONLY in a dedicated scratch checkout —
# it hard-fails if the resolved target path is the operator's primary checkout
# or a CI runner clone (a `_work` path).
#
# Usage:
#   scripts/android-render.sh                 # record all goldens (every module that owns some)
#   scripts/android-render.sh --verify        # CI-style compare against tracked goldens
#   scripts/android-render.sh --module :app   # restrict to one Gradle module
#   scripts/android-render.sh --tests dev.omnesis.android.screenshots.ScreensScreenshotTest
#
# Configuration (all optional except the host; generic defaults — nothing
# operator-private is committed: the host alias / paths are read at runtime):
#   OMNESIS_EPIC_MACOS_HOST          ssh alias/host of the macOS build machine.
#                                    REQUIRED — unset is a hard, loud error (this
#                                    script never guesses a personal alias).
#   OMNESIS_EPIC_MACOS_ANDROID_WORKTREE  absolute path to a DEDICATED scratch
#                                    checkout on the host (default:
#                                    ~/omnesis-android-render, expanded on the
#                                    host). Must NOT resolve into the host's
#                                    primary checkout or a `_work` runner clone.
#   OMNESIS_ANDROID_RENDER_OUT       local dir the PNGs are rsynced back to
#                                    (default: /tmp/omnesis-android-shots)
#   OMNESIS_ANDROID_JAVA_HOME        JDK 17 home on the host
#                                    (default: /opt/homebrew/opt/openjdk@17)
#   OMNESIS_ANDROID_SDK_HOME         Android SDK root on the host
#                                    (default: $HOME/Library/Android/sdk, on host)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- Arguments. ----------------------------------------------------------------
# --verify           run the matching verifyRoborazzi task instead of record.
# --module <m>       restrict to a single Gradle module (default: both modules).
# --tests <filter>   pass a --tests filter through to gradle (one or many).
MODE="record"
MODULE=""
TESTS_FILTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify) MODE="verify"; shift ;;
    --record) MODE="record"; shift ;;
    --module) shift; [[ -n "${1:-}" ]] || { echo "android-render: --module needs a value" >&2; exit 64; }; MODULE="$1"; shift ;;
    --tests)  shift; [[ -n "${1:-}" ]] || { echo "android-render: --tests needs a value" >&2; exit 64; }; TESTS_FILTER="$1"; shift ;;
    *) echo "android-render: unknown argument '$1'" >&2; exit 64 ;;
  esac
done

# --- Configuration (generic env, fail-loud on the host). -----------------------
HOST="${OMNESIS_EPIC_MACOS_HOST:-}"
if [[ -z "$HOST" ]]; then
  cat >&2 <<'EOF'
android-render: OMNESIS_EPIC_MACOS_HOST is not set.

This script bridges the Android Roborazzi screenshot suite to a macOS build host
over ssh — the Android SDK does not run on this (aarch64 Linux) box. Set the ssh
alias/host of your macOS build machine and re-run, e.g.:

    export OMNESIS_EPIC_MACOS_HOST=<your-macos-ssh-alias>
    scripts/android-render.sh

(See android/AGENTS.md → "Bridging the screenshot loop from a non-macOS box".)
EOF
  exit 78  # EX_CONFIG — a required config value is missing.
fi

# Scratch checkout path on the host. Default is a clearly-dedicated dir under
# the host's HOME; the operator may point it elsewhere (still must be dedicated).
REMOTE_WORKTREE="${OMNESIS_EPIC_MACOS_ANDROID_WORKTREE:-\$HOME/omnesis-android-render}"
OUT_DIR="${OMNESIS_ANDROID_RENDER_OUT:-/tmp/omnesis-android-shots}"
# Android toolchain locations on the host (generic Homebrew/SDK defaults; the
# operator overrides if their layout differs). The Android SDK home is resolved
# on the HOST so $HOME expands there, not on this box.
REMOTE_JAVA_HOME="${OMNESIS_ANDROID_JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
REMOTE_SDK_HOME="${OMNESIS_ANDROID_SDK_HOME:-\$HOME/Library/Android/sdk}"

fail() { echo "android-render: $*" >&2; exit 1; }

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
    fail "refusing to use '$RESOLVED_TARGET' — it resolves into a CI runner clone (_work). Point OMNESIS_EPIC_MACOS_ANDROID_WORKTREE at a dedicated scratch checkout."
    ;;
esac

if ssh "$HOST" "test -e \"$RESOLVED_TARGET/.omnesis-primary\"" 2>/dev/null; then
  fail "refusing to use '$RESOLVED_TARGET' — it is marked as the primary checkout (.omnesis-primary sentinel). Use a dedicated scratch checkout."
fi
HOST_HOME="$(ssh "$HOST" 'printf %s "$HOME"' 2>/dev/null)" || fail "could not read \$HOME on '$HOST'"
if [[ -n "$HOST_HOME" && "$RESOLVED_TARGET" == "$HOST_HOME" ]]; then
  fail "refusing to use '$RESOLVED_TARGET' — that is the host's HOME, not a dedicated scratch checkout."
fi

# --- Pick the Gradle tasks to run. ---------------------------------------------
# Default covers every module that owns screenshot goldens, so the local lane
# sees exactly what CI's verify step sees; --module narrows it to one.
# Keep GOLDEN_MODULES in step with the verify step in .github/workflows/android.yml
# and with `find android -type d -name roborazzi -not -path '*/build/*'`.
GOLDEN_MODULES=(app feature-health feature-call-log feature-app-usage feature-activity-segments feature-photos)
if [[ "$MODE" == "verify" ]]; then
  TASK_SUFFIX="verifyRoborazziDebug"
  APP_TASK_SUFFIX="verifyRoborazziPlayDebug"
else
  TASK_SUFFIX="recordRoborazziDebug"
  APP_TASK_SUFFIX="recordRoborazziPlayDebug"
fi
if [[ -n "$MODULE" ]]; then
  if [[ "$MODULE" == ":app" || "$MODULE" == "app" ]]; then
    GRADLE_TASKS=":app:$APP_TASK_SUFFIX"
  else
    GRADLE_TASKS="$MODULE:$TASK_SUFFIX"
  fi
else
  GRADLE_TASKS=":app:$APP_TASK_SUFFIX"
  for m in "${GOLDEN_MODULES[@]:1}"; do GRADLE_TASKS="$GRADLE_TASKS :$m:$TASK_SUFFIX"; done
fi
# The host-side gather step reads the goldens straight out of each module's
# committed dir, so it always covers every golden-owning module regardless of
# which subset this run rendered.
GATHER_DIRS=""
for m in "${GOLDEN_MODULES[@]}"; do GATHER_DIRS="$GATHER_DIRS $m/src/test/roborazzi"; done
GATHER_DIRS="${GATHER_DIRS# }"
GRADLE_EXTRA=""
[[ -n "$TESTS_FILTER" ]] && GRADLE_EXTRA="--tests $TESTS_FILTER"

echo "→ macOS host:        $HOST"
echo "→ scratch checkout:  $RESOLVED_TARGET"
echo "→ mode/tasks:        $MODE / $GRADLE_TASKS"
echo "→ PNGs land in:      $OUT_DIR (local)"

# --- Ensure the scratch dir exists on the host. --------------------------------
ssh "$HOST" "mkdir -p \"$RESOLVED_TARGET/android\"" \
  || fail "could not create the scratch dir on '$HOST'"

# --- 1. rsync the UNCOMMITTED android/ working tree up. ------------------------
# Trailing slashes copy the contents of android/ into the scratch android/. We
# exclude build artefacts + the machine-local SDK pointer so the transfer is
# small and never clobbers the host's Gradle caches / DerivedData with the box's.
echo "→ rsync android/ → $HOST:$RESOLVED_TARGET/android/ …"
rsync -az --delete \
  --exclude '.gradle' \
  --exclude 'build' \
  --exclude '**/build' \
  --exclude 'local.properties' \
  --exclude '.kotlin' \
  "$ROOT/android/" "$HOST:$RESOLVED_TARGET/android/" \
  || fail "rsync of the android/ working tree to '$HOST' failed"

# The :app screenshot suite reads synthetic-corpus fixtures from the repo root,
# not from android/, so a scratch checkout that only ever received android/
# fails the render with "could not locate evals/universes/…". Ship them too.
echo "→ rsync evals/universes/ → $HOST:$RESOLVED_TARGET/evals/universes/ …"
rsync -az --delete \
  "$ROOT/evals/universes/" "$HOST:$RESOLVED_TARGET/evals/universes/" \
  || fail "rsync of evals/universes/ to '$HOST' failed"

# --- 2. run the Roborazzi suite over ssh. --------------------------------------
# The Android toolchain is NOT on the default ssh PATH, so we export it inline
# (the recipe android/AGENTS.md documents). Roborazzi renders Compose to PNGs
# off-emulator (Robolectric native graphics), so NO emulator/AVD is needed.
#
# record  → writes goldens to android/<module>/src/test/roborazzi/*.png (tracked).
# verify  → compares a fresh render against those tracked goldens; diffs go to
#           the gitignored build/outputs/roborazzi-compare dir.
#
# Either way the rendered/golden PNGs we want back live under
# <module>/src/test/roborazzi/, which we gather into a per-run host scratch dir.
REMOTE_OUT="$RESOLVED_TARGET/.omnesis-android-shots"
echo "→ ssh $HOST: gradle $GRADLE_TASKS ($MODE) …"
ssh "$HOST" "bash -lc '
  set -euo pipefail
  cd \"$RESOLVED_TARGET/android\"
  export JAVA_HOME=\"$REMOTE_JAVA_HOME\"
  export ANDROID_HOME=\"$REMOTE_SDK_HOME\"
  export ANDROID_SDK_ROOT=\"\$ANDROID_HOME\"
  export PATH=\"\$JAVA_HOME/bin:\$PATH\"
  [ -x ./gradlew ] || { echo \"./gradlew not found in \$(pwd)\" >&2; exit 1; }
  # --rerun-tasks so a cached UP-TO-DATE task still re-renders (android/AGENTS.md
  # gotcha: an UP-TO-DATE Roborazzi task writes no PNGs).
  ./gradlew $GRADLE_TASKS $GRADLE_EXTRA --rerun-tasks
  rm -rf \"$REMOTE_OUT\"
  mkdir -p \"$REMOTE_OUT\"
  # Gather every committed-path golden from each module into the scratch dir.
  found=0
  for d in $GATHER_DIRS; do
    if [ -d \"\$d\" ]; then
      cp -f \"\$d\"/*.png \"$REMOTE_OUT\"/ 2>/dev/null || true
    fi
  done
  count=\$(ls \"$REMOTE_OUT\"/*.png 2>/dev/null | wc -l | tr -d \" \")
  if [ \"\$count\" -eq 0 ]; then
    echo \"Roborazzi run produced no PNGs under */src/test/roborazzi/\" >&2
    exit 1
  fi
  echo \"  rendered/compared \$count PNG(s) on the host.\"
'" || fail "the Android Roborazzi suite failed on '$HOST' (build error, verify mismatch, or no PNGs produced)"

# --- 3. rsync the PNGs back to a local dir the agent can Read. ------------------
mkdir -p "$OUT_DIR"
echo "→ rsync $HOST:$REMOTE_OUT/ → $OUT_DIR/ …"
rsync -az "$HOST:$REMOTE_OUT/" "$OUT_DIR/" \
  || fail "rsync of the rendered PNGs back from '$HOST' failed"

LOCAL_COUNT="$(find "$OUT_DIR" -maxdepth 1 -name '*.png' | wc -l | tr -d ' ')"
if [[ "$LOCAL_COUNT" -eq 0 ]]; then
  fail "no PNGs landed in $OUT_DIR after the round-trip — refusing a silent empty success"
fi

# --- 4. record: write the regenerated goldens back into the working tree. ------
# Gradle wrote them on the host, into the scratch checkout's own copy of the
# repo. Without this step `--record` leaves the local goldens untouched, so the
# next verify — and CI — still compare against the stale PNGs and the recording
# reads as a silent no-op. Copies per module so a golden only ever lands in the
# directory it was rendered from; no --delete, so removing a golden stays a
# deliberate local act rather than a side effect of a render.
if [[ "$MODE" == "record" ]]; then
  WROTE_BACK=0
  for m in "${GOLDEN_MODULES[@]}"; do
    [[ -n "$MODULE" && "${MODULE#:}" != "$m" ]] && continue
    if rsync -az "$HOST:$RESOLVED_TARGET/android/$m/src/test/roborazzi/" \
                 "$ROOT/android/$m/src/test/roborazzi/" 2>/dev/null; then
      WROTE_BACK=$((WROTE_BACK + 1))
    fi
  done
  if [[ "$WROTE_BACK" -eq 0 ]]; then
    fail "recorded goldens were rendered but none could be written back into android/ — refusing a silent no-op"
  fi
  echo "✓ goldens written back into $WROTE_BACK module(s) under android/*/src/test/roborazzi/."
fi

echo "✓ $LOCAL_COUNT Roborazzi PNG(s) in $OUT_DIR — Read them and self-critique."
# `head` closes the pipe early, which under `pipefail` would surface as exit
# 141 (SIGPIPE) and make a successful run look like a failure to any caller
# reading the status. Print the sample without a pipeline.
find "$OUT_DIR" -maxdepth 1 -name '*.png' | sort | head -40 || true
