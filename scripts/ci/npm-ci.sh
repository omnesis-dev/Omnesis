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
exec npm ci "$@"
