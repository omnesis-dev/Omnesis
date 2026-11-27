#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# Runs the omnesis CLI from the release directory this file belongs to. The
# dedicated-account gateway's unit starts it through /opt/omnesis-gateway/current,
# so each start runs whichever release that link names at the time; a running
# gateway keeps the release it started with until it restarts.

set -eu

# Installed releases are production; retain a service's explicit test override.
OMNESIS_RUNTIME_MODE="${OMNESIS_RUNTIME_MODE-production}"
export OMNESIS_RUNTIME_MODE

RELEASE="$(cd "$(dirname "$0")/.." && pwd -P)"
exec "$RELEASE/node_modules/.bin/tsx" "$RELEASE/packages/cli/src/index.ts" "$@"
