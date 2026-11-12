#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# `npm ci` for CI jobs, building native modules against the running Node's own
# headers. Without a node directory, node-gyp downloads the headers into one
# shared cache directory for each native module it builds, and npm builds them
# in parallel: one build can read the headers while another is still writing
# them, and fails on a half-written common.gypi. Node's release builds ship
# those headers under <prefix>/include/node.
#
# node-gyp reads its options from `npm_package_config_node_gyp_<option>`, which
# npm passes through to install scripts untouched. The older
# `npm_config_nodedir` also reaches node-gyp, but npm 11 warns that it is not an
# npm option and will stop accepting it.
set -eu
npm_package_config_node_gyp_nodedir="$(node -p 'require("node:path").resolve(process.execPath, "../..")')"
export npm_package_config_node_gyp_nodedir

# A stalled registry connection (EIDLETIMEOUT, ECONNRESET) fails the whole
# install; retry a few times so a transient network hiccup doesn't redden CI.
# See #740 — flaky npm registry idle timeout in the Docker image build.
attempt=1
max_attempts="${NPM_CI_ATTEMPTS:-3}"
retry_seconds="${NPM_CI_RETRY_SECONDS:-10}"

# When an optional package fails to install, because its tarball could not be
# fetched or its install script failed, npm removes it and still exits 0. The
# only record is a "failed optional dependency <path>" line in npm's debug log.
# The packages that carry a platform's native binary are optional (DuckDB's
# @duckdb/node-bindings-<platform> holds duckdb.node), and so is ffmpeg-static,
# whose install script downloads ffmpeg, so one failed request leaves a tree
# that installed cleanly and fails when it runs. Optional packages for other
# platforms, or left out with --omit=optional, are never attempted and never
# recorded. npm writes its debug log into a directory of this script's own,
# emptied before each attempt, and the names of the dropped packages are read
# from there.
logs="$(mktemp -d)"
trap 'rm -rf "$logs"' EXIT

dropped_packages() {
  cat "$logs"/*.log 2>/dev/null |
    sed -n 's|.* failed optional dependency .*node_modules/||p' |
    LC_ALL=C sort -u |
    tr '\n' ' ' |
    sed 's/ $//'
}

while :; do
  rm -f "$logs"/*
  if npm ci --logs-dir "$logs" "$@"; then
    dropped="$(dropped_packages)"
    [ -z "$dropped" ] && break
    problem="npm ci dropped optional packages that failed to install: $dropped"
    if [ "$attempt" -ge "$max_attempts" ]; then
      # A published image, or one a test lane runs, must hold every package its
      # platform selects, and its build can simply run again:
      # NPM_CI_REQUIRE_OPTIONAL=1 fails it here. Anywhere else this is not
      # fatal: a job that never loads the package passes, and one that does
      # fails on its own. This line says why it did.
      if [ "${NPM_CI_REQUIRE_OPTIONAL:-0}" = 1 ]; then
        echo "$problem, after $attempt attempts, and this build requires them" >&2
        exit 1
      fi
      echo "::warning::$problem, after $attempt attempts; this tree lacks them" >&2
      break
    fi
  else
    problem="npm ci failed"
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "npm ci failed after $attempt attempts" >&2
      exit 1
    fi
  fi
  echo "$problem (attempt $attempt of $max_attempts); retrying in $((attempt * retry_seconds))s" >&2
  sleep "$((attempt * retry_seconds))"
  attempt=$((attempt + 1))
done
