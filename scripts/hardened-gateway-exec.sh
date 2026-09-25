#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# Runs the omnesis CLI from the release directory this file belongs to. The
# dedicated-account gateway's unit starts it through /opt/omnesis-gateway/current,
# so each start runs whichever release that link names at the time; a running
# gateway keeps the release it started with until it restarts.

set -eu

RELEASE="$(cd "$(dirname "$0")/.." && pwd -P)"
exec "$RELEASE/node_modules/.bin/tsx" "$RELEASE/packages/cli/src/index.ts" "$@"
