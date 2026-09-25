#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Bridge the iOS SwiftUI preview-snapshot loop from this (Linux) box to a
# configured macOS build host over ssh, then pull the rendered PNGs back so the
# agent can `Read` them — the same visual self-critique loop the iOS guide
# mandates, across the ssh boundary.
#
# Why this exists: Xcode is macOS-only, so the snapshot suite cannot run on the
# Linux dev box where the agent lives. This script codifies the offload recipe
# into one reusable, generic, env-configured command: rsync the WORKING TREE
# (uncommitted edits included), run the snapshot tests with code-signing
# disabled (a simulator render needs none), and rsync the PNGs back.
#
# It NEVER pushes, commits, or opens PRs on the host (all git mutations stay
# with the caller), and it refuses to rsync onto live state: the macOS host is
# used freely for building/testing, but ONLY in a dedicated scratch checkout —
# it hard-fails if the resolved target path is the operator's primary checkout
# or a CI runner clone (a `_work` path).
#
# Usage:
#   scripts/ios-snapshot.sh                                  # the default snapshot suite
#   scripts/ios-snapshot.sh OmnesisTests/PreviewSnapshotTests/testPersonDetail   # one case
#   scripts/ios-snapshot.sh --only OmnesisTests/PreviewSnapshotTests             # a filter
#
# Configuration (all optional except the host; generic defaults — nothing
# operator-private is committed: the host alias / paths are read at runtime):
#   OMNESIS_EPIC_MACOS_HOST       ssh alias/host of the macOS build machine.
#                                 REQUIRED — unset is a hard, loud error (this
#                                 script never guesses a personal alias).
#   OMNESIS_EPIC_MACOS_WORKTREE   absolute path to a DEDICATED scratch checkout
#                                 on the host (default: ~/omnesis-ios-snapshot,
#                                 expanded on the host). Must NOT resolve into
#                                 the host's primary checkout or a `_work`
#                                 runner clone — guarded below.
#   OMNESIS_IOS_SNAPSHOT_DEST     simulator destination
#                                 (default: 'platform=iOS Simulator,name=iPhone 17')
#   OMNESIS_IOS_SNAPSHOT_OUT      local dir the PNGs are rsynced back to
#                                 (default: /tmp/omnesis-snapshots)
#   OMNESIS_IOS_SNAPSHOT_SCHEME   xcodebuild scheme (default: Omnesis)
#   OMNESIS_IOS_SNAPSHOT_BUNDLE_ID app bundle built and removed from the
#                                 simulator before the test (default: dev.omnesis.ios)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- Argument: the test target / scheme / filter to run. -----------------------
# Accept either a bare `-only-testing` argument or an explicit `--only <id>`.
ONLY_TESTING="OmnesisTests/PreviewSnapshotTests"
if [[ "${1:-}" == "--only" ]]; then
  shift
  [[ -n "${1:-}" ]] || { echo "ios-snapshot: --only needs a test identifier" >&2; exit 64; }
  ONLY_TESTING="$1"
elif [[ -n "${1:-}" ]]; then
  ONLY_TESTING="$1"
fi

# --- Configuration (generic env, fail-loud on the host). -----------------------
HOST="${OMNESIS_EPIC_MACOS_HOST:-}"
if [[ -z "$HOST" ]]; then
  cat >&2 <<'EOF'
ios-snapshot: OMNESIS_EPIC_MACOS_HOST is not set.

This script bridges the iOS snapshot suite to a macOS build host over ssh —
Xcode does not run on this (Linux) box. Set the ssh alias/host of your macOS
build machine and re-run, e.g.:

    export OMNESIS_EPIC_MACOS_HOST=<your-macos-ssh-alias>
    scripts/ios-snapshot.sh

(See ios/AGENTS.md → "Bridging the snapshot loop from a non-macOS box".)
EOF
  exit 78  # EX_CONFIG — a required config value is missing.
fi

# Scratch checkout path on the host. Default is a clearly-dedicated dir under
# the host's HOME; the operator may point it elsewhere (still must be dedicated).
REMOTE_WORKTREE="${OMNESIS_EPIC_MACOS_WORKTREE:-\$HOME/omnesis-ios-snapshot}"
DEST="${OMNESIS_IOS_SNAPSHOT_DEST:-platform=iOS Simulator,name=iPhone 17}"
SCHEME="${OMNESIS_IOS_SNAPSHOT_SCHEME:-Omnesis}"
BUNDLE_ID="${OMNESIS_IOS_SNAPSHOT_BUNDLE_ID:-dev.omnesis.ios}"
OUT_DIR="${OMNESIS_IOS_SNAPSHOT_OUT:-/tmp/omnesis-snapshots}"

fail() { echo "ios-snapshot: $*" >&2; exit 1; }

case ",$DEST," in
  *,id=*)
    SIMULATOR_SELECTOR="${DEST#*id=}"
    SIMULATOR_SELECTOR="${SIMULATOR_SELECTOR%%,*}"
    ;;
  *,name=*)
    SIMULATOR_SELECTOR="${DEST#*name=}"
    SIMULATOR_SELECTOR="${SIMULATOR_SELECTOR%%,*}"
    ;;
  *) fail "simulator destination must contain a name= or id= selector: $DEST" ;;
esac
[[ "$SIMULATOR_SELECTOR" =~ ^[A-Za-z0-9._[:space:]-]+$ ]] \
  || fail "simulator destination contains an unsafe selector: $SIMULATOR_SELECTOR"
[[ "$BUNDLE_ID" =~ ^[A-Za-z0-9.-]+$ ]] \
  || fail "snapshot bundle id contains unsafe characters: $BUNDLE_ID"

# --- Guard: refuse to rsync onto live state on the host. -----------------------
# We resolve the scratch path ON THE HOST (so ~ / $HOME / symlinks expand there),
# then refuse it if it is the operator's primary checkout or a CI runner clone.
# A runner clone always contains an `actions-runner`/`_work` path segment; the
# primary checkout is identified by carrying a live config dir signature
# (.git + the live `~/.config/omnesis` is NOT inside a checkout, so instead we
# refuse the two well-known live roots: anything containing `/_work/` — the
# Actions runner layout — and an exact match against a primary checkout the
# operator marks with a `.omnesis-primary` sentinel file). The scratch dir must
# also NOT be an existing non-empty git checkout whose remote we don't control,
# but we keep the guard conservative + path-based so it is deterministic.
RESOLVED_TARGET="$(ssh "$HOST" "printf '%s' \"$REMOTE_WORKTREE\"" 2>/dev/null)" \
  || fail "could not ssh to '$HOST' to resolve the scratch path — is the host reachable?"
[[ -n "$RESOLVED_TARGET" ]] || fail "resolved an empty scratch path on '$HOST'"

case "$RESOLVED_TARGET" in
  */_work/*|*/_work)
    fail "refusing to use '$RESOLVED_TARGET' — it resolves into a CI runner clone (_work). Point OMNESIS_EPIC_MACOS_WORKTREE at a dedicated scratch checkout."
    ;;
esac

# Refuse a target the host marks as its primary checkout (sentinel file), and
# refuse the live config dir / HOME root outright (never rsync a whole HOME).
if ssh "$HOST" "test -e \"$RESOLVED_TARGET/.omnesis-primary\"" 2>/dev/null; then
  fail "refusing to use '$RESOLVED_TARGET' — it is marked as the primary checkout (.omnesis-primary sentinel). Use a dedicated scratch checkout."
fi
HOST_HOME="$(ssh "$HOST" 'printf %s "$HOME"' 2>/dev/null)" || fail "could not read \$HOME on '$HOST'"
if [[ -n "$HOST_HOME" && "$RESOLVED_TARGET" == "$HOST_HOME" ]]; then
  fail "refusing to use '$RESOLVED_TARGET' — that is the host's HOME, not a dedicated scratch checkout."
fi

echo "→ macOS host:        $HOST"
echo "→ scratch checkout:  $RESOLVED_TARGET"
echo "→ scheme/only:       $SCHEME / $ONLY_TESTING"
echo "→ destination:       $DEST"
echo "→ PNGs land in:      $OUT_DIR (local)"

# --- Ensure the scratch dir exists on the host. --------------------------------
ssh "$HOST" "mkdir -p \"$RESOLVED_TARGET/ios\"" \
  || fail "could not create the scratch dir on '$HOST'"

# --- 1. rsync the UNCOMMITTED ios/ working tree up. ----------------------------
# Trailing slashes copy the contents of ios/ into the scratch ios/. We exclude
# build artefacts so the transfer is small and never clobbers the host's
# DerivedData / generated project state with the box's (empty) one.
echo "→ rsync ios/ → $HOST:$RESOLVED_TARGET/ios/ …"
rsync -az --delete \
  --exclude 'Omnesis.xcodeproj' \
  --exclude 'Local.xcconfig' \
  --exclude 'DerivedData' \
  --exclude '*.xcuserstate' \
  --exclude '.build' \
  "$ROOT/ios/" "$HOST:$RESOLVED_TARGET/ios/" \
  || fail "rsync of the ios/ working tree to '$HOST' failed"

# Universe data (synthetic-corpus cassettes/fixtures) for tests that drive a
# canonical cassette through the real decode pipeline (the deep-research
# cassette test). The scratch otherwise carries only `ios/`.
ssh "$HOST" "mkdir -p \"$RESOLVED_TARGET/evals/universes\"" || true
rsync -az --delete \
  "$ROOT/evals/universes/" "$HOST:$RESOLVED_TARGET/evals/universes/" \
  || fail "rsync of evals/universes to '$HOST' failed"

# --- 2. run the snapshot suite over ssh, code-signing disabled. ----------------
# A simulator render needs no signing, so we disable it (the scratch checkout
# carries no Local.xcconfig team). `xcodegen generate` first so the project is
# current for the rsynced sources. PNGs are written to a host-side dir we then
# pull back; we run xcodebuild from inside ios/ so relative project paths hold.
# The PreviewSnapshotTests suite writes its PNGs to /tmp/omnesis-snapshots on
# whichever host runs them (the path is fixed in the Swift test). We render on
# the host, then gather that dir into a per-run scratch dir so the pull-back is
# clean even if the host's /tmp has stale PNGs from another run.
REMOTE_OUT="$RESOLVED_TARGET/.omnesis-snapshots"
# A failing assertion is a reason to LOOK at the pictures, not a reason to hide
# them: the screenshot-and-self-critique loop the iOS guide makes mandatory is
# most useful on exactly the run that went wrong. So the remote block captures
# xcodebuild's status instead of aborting on it, gathers whatever rendered, and
# reports the status last — after the PNGs have been collected and pulled back.
REMOTE_LOG="$REMOTE_OUT/xcodebuild.log"
echo "→ ssh $HOST: xcodegen generate + xcodebuild snapshot suite (code-signing disabled) …"
set +e
ssh "$HOST" "bash -lc '
  set -uo pipefail
  cd \"$RESOLVED_TARGET/ios\" || exit 1
  rm -f Local.xcconfig
  command -v xcodegen >/dev/null || { echo \"xcodegen not found on \$(hostname)\" >&2; exit 1; }
  xcodegen generate >/dev/null || exit 1
  rm -rf \"$REMOTE_OUT\" /tmp/omnesis-snapshots
  mkdir -p \"$REMOTE_OUT\"
  # The host reservation makes this simulator exclusive to the lane. Resolve
  # every simulator command through the same full Xcode as xcodebuild, boot it
  # explicitly, and wait for SpringBoard before installing the test runner.
  # Clearing the prior app prevents stale LaunchServices state from turning a
  # completed install into a Busy preflight refusal.
  developer_dir=\"\${DEVELOPER_DIR:-\$(xcode-select -p)}\"
  export DEVELOPER_DIR=\"\$developer_dir\"
  simctl=\$(xcrun --find simctl) || { echo \"simctl not found under \$DEVELOPER_DIR\" >&2; exit 1; }
  \"\$simctl\" boot \"$SIMULATOR_SELECTOR\" >/dev/null 2>&1 || true
  \"\$simctl\" bootstatus \"$SIMULATOR_SELECTOR\" -b \
    || { echo \"simulator $SIMULATOR_SELECTOR did not become ready\" >&2; exit 1; }
  \"\$simctl\" terminate \"$SIMULATOR_SELECTOR\" \"$BUNDLE_ID\" >/dev/null 2>&1 || true
  \"\$simctl\" uninstall \"$SIMULATOR_SELECTOR\" \"$BUNDLE_ID\" >/dev/null 2>&1 || true
  # Keep build output inside this scratch so it can be retired without
  # touching the shared DerivedData on the host.
  # Simulator render needs no signing — disable it so the scratch checkout
  # builds with no provisioning team.
  xcodebuild test \
    -project Omnesis.xcodeproj \
    -scheme \"$SCHEME\" \
    -destination \"$DEST\" \
    -derivedDataPath \"$RESOLVED_TARGET/DerivedData\" \
    -only-testing:$ONLY_TESTING \
    OMNESIS_BUNDLE_ID=\"$BUNDLE_ID\" \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=\"\" \
    >\"$REMOTE_LOG\" 2>&1
  rc=\$?
  if [ \"\$rc\" -eq 0 ] && [ \"$SCHEME\" = Omnesis ]; then
    python3 scripts/verify-built-identities.py \
      \"$RESOLVED_TARGET/DerivedData/Build/Products/Debug-iphonesimulator\" \
      \"$BUNDLE_ID\" || rc=1
  fi
  # Kept whatever xcodebuild rendered, however it exited. A build that never
  # launched the simulator leaves none, which the caller reports as the failure
  # it is.
  if [ -d /tmp/omnesis-snapshots ]; then cp -f /tmp/omnesis-snapshots/*.png \"$REMOTE_OUT\"/ 2>/dev/null || true; fi
  rm -rf /tmp/omnesis-snapshots
  count=\$(ls \"$REMOTE_OUT\"/*.png 2>/dev/null | wc -l | tr -d \" \")
  echo \"  rendered \$count PNG(s) on the host.\"
  # The failing cases, named, so finding out which view broke does not need a
  # second run. Broad on purpose: a build that never reached the tests fails
  # with none of the XCTest markers, and a pattern that matched only those
  # would report a compile error as silence.
  if [ \"\$rc\" -ne 0 ]; then
    grep -E \"(\\*\\* (TEST|BUILD) FAILED \\*\\*|Testing failed|error:|XCTAssert|failed \\(|Command .* failed)\" \"$REMOTE_LOG\" | head -40 >&2 || true
  fi
  exit \$rc
'"
SUITE_RC=$?
set -e

# --- 3. rsync the PNGs back to a local dir the agent can Read. ------------------
# Whatever the verdict, and MIRRORED rather than merged. Without `--delete` a
# run that rendered nothing leaves the previous run's PNGs sitting in the out
# dir, the count guard below passes on them, and the agent reads last hour's
# pictures believing they are this run's — a failure with no symptom at all.
mkdir -p "$OUT_DIR"
echo "→ rsync $HOST:$REMOTE_OUT/ → $OUT_DIR/ …"
rsync -az --delete "$HOST:$REMOTE_OUT/" "$OUT_DIR/" \
  || fail "rsync of the rendered PNGs back from '$HOST' failed"

LOCAL_COUNT="$(find "$OUT_DIR" -maxdepth 1 -name '*.png' | wc -l | tr -d ' ')"
if [[ "$LOCAL_COUNT" -eq 0 ]]; then
  # No pictures either way, so there is nothing to look at and the only useful
  # thing left is why. The remote log came back with the (empty) mirror.
  fail "the iOS snapshot run produced no PNGs on '$HOST' (exit $SUITE_RC) — see $OUT_DIR/xcodebuild.log"
fi

if [[ "$SUITE_RC" -ne 0 ]]; then
  # Non-zero, because the suite is red — but the pictures are here first, and
  # they are how the red gets diagnosed. Not a "✓": the run failed, and a tick
  # above a failure is the kind of thing an eye skips over.
  echo "⚠ $LOCAL_COUNT snapshot PNG(s) in $OUT_DIR — Read them; the suite is RED."
  ls -1 "$OUT_DIR"/*.png
  fail "the iOS snapshot suite is RED on '$HOST' (exit $SUITE_RC) — the PNGs above are still yours to read; full output in $OUT_DIR/xcodebuild.log"
fi

echo "✓ $LOCAL_COUNT snapshot PNG(s) in $OUT_DIR — Read them and self-critique."
ls -1 "$OUT_DIR"/*.png
