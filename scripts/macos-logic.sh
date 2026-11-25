#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
set -euo pipefail
exec node "$(dirname "$0")/desktop/native-check.mjs" logic "$@"
