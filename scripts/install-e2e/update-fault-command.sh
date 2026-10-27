#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
# External process boundary: every non-faulted invocation executes the real tool.
set -euo pipefail
case "$(basename "$0")" in
  npm)
    if [ "${1:-}" = ci ] && mkdir "$UPDATE_FAULT_DIR/entered" 2>/dev/null; then
      # exec keeps the published PID and leaves no sleeping grandchildren.
      exec "${UPDATE_REAL_NODE:-node}" "${UPDATE_FAULT_HELPER:?}" gate "${UPDATE_FAULT_SOURCE:?}"

    fi
    exec "$UPDATE_REAL_NPM" "$@"
    ;;
  git)
    if [ "${1:-}" = fetch ] && mkdir "$UPDATE_FAULT_DIR/fetch-entered" 2>/dev/null; then
      # This PID belongs to this lane's foreground git daemon, never a host service.
      node "${UPDATE_FAULT_HELPER:?}" signal-process "${UPDATE_GIT_DAEMON_PID:?}" "${UPDATE_GIT_DAEMON_START:?}" >"$UPDATE_FAULT_DIR/disconnect.json"
      node -e 'if(!JSON.parse(require("fs").readFileSync(process.argv[1])).signaled)process.exit(1)' "$UPDATE_FAULT_DIR/disconnect.json"
      sleep 1
    fi
    exec "$UPDATE_REAL_GIT" "$@"
    ;;
  *) printf 'unexpected fault command\n' >&2; exit 2 ;;
esac
