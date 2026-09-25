#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# Build the fixture release repositories this lane installs and updates from.
#
# The installer and the updater both resolve "the newest stable tag" from a
# real remote, so proving them needs a remote that actually carries ordered
# release tags. This builds one from the CURRENT checkout: `git archive` of
# HEAD becomes a single base commit (no history, so the repository stays small
# and hermetic), and each release tag is that tree with every workspace
# manifest and the lockfile bumped by npm itself.
#
# Two repositories are produced:
#   omnesis.git         v9.9.0, v9.9.1, v9.9.2    — install, update, fleet update
#   omnesis-broken.git  v9.9.0 … v9.9.3          — its v9.9.3 fails `npm run build`
#
# Three good tags because the lane needs two forward moves: one per host, and
# one driven across the fleet from the gateway.
#
# The broken tag lives in its own repository because both the installer and
# the updater target the NEWEST tag they can see: a broken tag in the main
# fixture would poison every other scenario.
#
# Usage: fixtures.sh <output-dir>   (the directory a git daemon then serves)
set -euo pipefail

OUT="${1:?usage: fixtures.sh <output-dir>}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# A fixture commit is not authored by whoever runs the lane, and the identity
# it does carry is deliberately not shaped like a person's name.
export GIT_AUTHOR_NAME="omnesis-topology-fixture"
export GIT_AUTHOR_EMAIL="fixture@example.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

mkdir -p "$OUT"
SRC="$OUT/.src"
rm -rf "$SRC"
mkdir -p "$SRC"

echo "==> exporting the current checkout into a fixture working tree"
# `git archive` carries tracked files only, so node_modules and every local
# artifact stay out without needing an ignore list.
git -C "$REPO_ROOT" archive HEAD | tar -x -C "$SRC"

cd "$SRC"
# A throwaway fixture repository must not inherit the developer's git hooks:
# they would run this repo's pre-commit checks against a tree that is
# deliberately unbuildable on one tag.
git init -q .
git config core.hooksPath /dev/null
# Each `tag_release` commits the whole tree, which is enough loose objects to
# trip `git gc --auto`. That gc runs in the background and writes into `.git`,
# so it races the `rm -rf` of this scratch directory below and leaves it
# non-empty — which, under `set -e`, fails the whole lane after the fixtures
# it was building have already been published successfully.
git config gc.auto 0
git add -A
git commit -qm "Omnesis topology fixture base"

# Bump every workspace manifest AND the lockfile the way a release does. The
# installer refuses a tag whose CLI manifest disagrees with the tag name, and
# `npm ci` refuses a lockfile that disagrees with the manifests, so this has
# to be npm's own bump rather than a hand-edit of one file.
tag_release() {
  local version="$1"
  npm version "$version" --workspaces --no-git-tag-version --allow-same-version >/dev/null
  git add -A
  git commit -qm "Omnesis ${version}"
  git tag -a "v${version}" -m "Omnesis ${version}"
  echo "    tagged v${version}"
}

echo "==> building release tags"
tag_release 9.9.0
tag_release 9.9.1
tag_release 9.9.2

echo "==> publishing omnesis.git"
rm -rf "$OUT/omnesis.git"
git clone -q --bare . "$OUT/omnesis.git"

# The broken tag is a type error in a leaf package, so `tsc --build` fails and
# the installer's (and the updater's) build step exits non-zero. It is a
# deliberately unbuildable release, not a runtime failure: the update must be
# refused before anything is swapped in.
echo "==> building the unbuildable tag"
cat > packages/types/src/topology-fixture-broken.ts <<'BROKEN'
// A deliberate type error. The container topology lane serves this file only
// on its v9.9.3 fixture tag, to prove that a release which cannot build is
// refused rather than half-applied.
export const unbuildable: number = "this release does not compile";
BROKEN
git add -A
git commit -qm "Omnesis topology fixture: unbuildable tree"
# The broken repository's newest tag has to outrank the good ones it inherits,
# so the rollback scenario's host targets it by default.
tag_release 9.9.3

echo "==> publishing omnesis-broken.git"
rm -rf "$OUT/omnesis-broken.git"
git clone -q --bare . "$OUT/omnesis-broken.git"

cd "$OUT"
rm -rf "$SRC"

# A developer umask of 077 would leave these repositories readable only by the
# account that built them, and the git daemon serves them from inside a
# container under a different uid. Publishing them means making them readable.
chmod -R a+rX "$OUT"

echo "==> fixtures ready in $OUT"
ls -d "$OUT"/*.git
