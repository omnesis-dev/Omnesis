#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
set -euo pipefail

probe_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
probe_classpath="$(python3 "$probe_dir/prepare.py" "$@")"
exec java -Dfile.encoding=UTF-8 -cp "$probe_classpath" LuceneProbe
