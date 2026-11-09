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

# ffmpeg-static downloads its binary in an install script. It is an optional
# dependency, so when that download fails (GitHub's release host answering 504)
# npm removes the package and exits 0, and audio decoding is simply gone from
# the tree. Only an install that runs scripts and keeps optional packages can
# have it, and only if the lockfile lists it.
wants_ffmpeg() {
  for arg in "$@"; do
    case "$arg" in
      --ignore-scripts | --omit=optional | --no-optional) return 1 ;;
    esac
  done
  [ -f package-lock.json ] && grep -q '"node_modules/ffmpeg-static"' package-lock.json
}

while :; do
  if npm ci "$@"; then
    if ! wants_ffmpeg "$@" || [ -e node_modules/ffmpeg-static/package.json ]; then
      break
    fi
    problem="npm ci dropped ffmpeg-static, whose binary download failed"
    if [ "$attempt" -ge "$max_attempts" ]; then
      # Not fatal: most jobs never decode audio, and the ones that do fail on
      # their own. This line says why they did.
      echo "::warning::$problem after $attempt attempts; audio decoding will not work in this tree" >&2
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
