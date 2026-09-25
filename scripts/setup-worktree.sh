#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

#
# setup-worktree.sh — wire up node_modules in a secondary git worktree so that
# cross-workspace package resolution points at THIS worktree's source, not the
# primary's.
#
# Why this exists:
#
#   `npm install` in a fresh worktree currently fails on a dedup quirk
#   (`Invalid Version:` from @clack/prompts resolution). The historical
#   workaround — symlinking the whole `node_modules` to the primary worktree —
#   is subtly broken: inside a hoisted npm workspace, `node_modules/@omnesis/<pkg>`
#   are themselves symlinks of the form `../../packages/<pkg>`. Resolved relative
#   to the PRIMARY's node_modules they land in the PRIMARY's `packages/<pkg>`,
#   so edits to a shared workspace package in your worktree are invisible to
#   every other package in the same worktree (imports read the primary's copy).
#   Tests then hard-fail with bogus "no exported member X" errors, or — worse —
#   pass green against stale code.
#
# The fix is a symlink FARM rather than a single symlink: mirror every top-level
# entry from the primary's node_modules (so all third-party deps stay shared and
# we never re-download), but give `@omnesis`, the unscoped `omnesis` entry
# package, and `.bin/omnesis` LOCAL links whose relative targets resolve into
# the CURRENT worktree. Per-package `packages/*/node_modules` (esbuild,
# whatsapp, …) are symlinked straight to the primary's: their nested
# `@omnesis` dirs are empty and never shadow the root farm.
#
# Idempotent: safe to re-run. Refuses to run in the primary worktree.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

# Current worktree root and the primary worktree (first entry of `worktree list`).
worktree="$(git rev-parse --show-toplevel)"
# Print the first `worktree` line's path but DON'T `exit` early: awk exiting closes
# the pipe while `git` is still writing, which under `set -o pipefail` aborts the
# script with SIGPIPE (141) once there are enough worktrees to fill the pipe buffer.
primary="$(git worktree list --porcelain | awk '/^worktree / && !f {print $2; f=1}')"

if [ "$worktree" = "$primary" ]; then
  echo "Refusing to run: this IS the primary worktree ($primary)." >&2
  echo "setup-worktree.sh is only for secondary worktrees created via 'git worktree add'." >&2
  exit 1
fi

if [ ! -d "$primary/node_modules" ]; then
  echo "Primary worktree has no node_modules at $primary/node_modules." >&2
  echo "Run 'npm install' in the primary worktree first." >&2
  exit 1
fi

echo "Primary:  $primary"
echo "Worktree: $worktree"

# --- Root node_modules symlink farm ------------------------------------------
# Rebuild from scratch each run. Only ever touch a plain symlink or a farm WE
# created (marked by a sentinel file); never clobber a real npm install.
farm_marker=".omnesis-worktree-farm"
if [ -L node_modules ]; then
  rm -f node_modules
elif [ -d node_modules ]; then
  if [ -f "node_modules/$farm_marker" ]; then
    rm -rf node_modules
  else
    echo "node_modules exists and is not a worktree farm — refusing to delete." >&2
    echo "If this is a stale npm install, remove it by hand and re-run." >&2
    exit 1
  fi
fi

mkdir -p node_modules node_modules/@omnesis node_modules/.bin
: > "node_modules/$farm_marker"

# Mirror every top-level entry from primary EXCEPT workspace links and .bin,
# which are handled below. Skip per-worktree caches and lockfile/junk so each
# worktree keeps its own.
for entry in "$primary"/node_modules/* "$primary"/node_modules/.bin; do
  [ -e "$entry" ] || continue
  name="$(basename "$entry")"
  case "$name" in
    @omnesis | omnesis | .bin | .cache | .vite | .package-lock.json | .DS_Store) continue ;;
  esac
  ln -sfn "$entry" "node_modules/$name"
done

# Keep tool binaries shared, but make the product binary resolve through the
# local unscoped workspace link rather than back into the primary checkout.
for entry in "$primary"/node_modules/.bin/*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  name="$(basename "$entry")"
  [ "$name" = "omnesis" ] && continue
  ln -sfn "$entry" "node_modules/.bin/$name"
done
ln -sfn ../omnesis/src/index.ts node_modules/.bin/omnesis

# Recreate @omnesis with the SAME relative targets the primary uses, so each
# `../../packages/<pkg>` resolves into THIS worktree.
for entry in "$primary"/node_modules/@omnesis/*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  ln -sfn "$(readlink "$entry")" "node_modules/@omnesis/$(basename "$entry")"
done

# The product entry package is deliberately unscoped. Its workspace location
# is stable even before the primary checkout has refreshed node_modules for the
# rename, so wire it directly into this worktree.
ln -sfn ../packages/cli node_modules/omnesis

# --- Per-package node_modules ------------------------------------------------
# Symlink each per-package node_modules straight to the primary's. Their nested
# @omnesis dirs are empty, so they never shadow the root farm; this just makes
# package-local third-party deps (esbuild, whatsapp, …) available.
for pdir in "$primary"/packages/*/; do
  pkg="$(basename "$pdir")"
  src="$pdir/node_modules"
  # Skip if primary has no real node_modules there (e.g. nothing installed, or a
  # broken/circular symlink — the historical packages/core/node_modules junk).
  [ -d "$src" ] || continue
  [ -e "$src/." ] || continue
  ln -sfn "$src" "packages/$pkg/node_modules"
done

echo ""
echo "Done. Verifying cross-package resolution:"
# `cd … && pwd -P` resolves all symlinks to a physical path using only POSIX
# builtins — portable to BSD/macOS, unlike GNU-only `readlink -f`.
resolved="$(cd node_modules/@omnesis/core 2>/dev/null && pwd -P || true)"
echo "  node_modules/@omnesis/core -> $resolved"
case "$resolved" in
  "$worktree"/*) echo "  ✓ resolves into THIS worktree" ;;
  *) echo "  ✗ WARNING: does not resolve into this worktree — check the setup" >&2 ;;
esac
resolved_cli="$(cd node_modules/omnesis 2>/dev/null && pwd -P || true)"
resolved_bin="$(cd node_modules/.bin 2>/dev/null && cd "$(dirname "$(readlink omnesis)")" 2>/dev/null && pwd -P || true)"
echo "  node_modules/omnesis -> $resolved_cli"
echo "  node_modules/.bin/omnesis -> $resolved_bin"
case "$resolved_cli:$resolved_bin" in
  "$worktree"/*:"$worktree"/*) echo "  ✓ product package and binary resolve into THIS worktree" ;;
  *) echo "  ✗ WARNING: product package or binary does not resolve into this worktree" >&2 ;;
esac

echo ""
echo "Next (not done by this script — see CLAUDE.md § worktree):"
echo "  • symlink the embedding model into your test config dir"
echo "  • export OMNESIS_CONFIG_DIR / ports before spawning your own gateway"
