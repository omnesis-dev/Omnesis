#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# What a failed install/update lane prints about its host, redacted.
#
#   E2E_WORK=<scratch dir> scripts/install-e2e/diagnostics.sh
#
# Service state, the update record, and the tail of each daemon's log. Every
# line passes through redact.mjs: Actions logs are public. Nothing here reads
# the config directory's secrets, tokens or keyring.
set -uo pipefail

E2E_WORK="${E2E_WORK:?set E2E_WORK}"
# shellcheck source=scripts/install-e2e/lib.sh
. "$(dirname "$0")/lib.sh"

section() {
  group "$1"
  shift
  "$@" 2>&1 | redact
  endgroup
}

if [ ! -x "$OMNESIS" ]; then
  log "no omnesis launcher at $OMNESIS; the install never got that far"
  exit 0
fi

section "omnesis --version" "$OMNESIS" --version
section "service status" "$OMNESIS" service status --json
section "update record" cat "$CONFIG_DIR/update-state.json"
section "health" curl -sS --max-time 10 --cacert "$CONFIG_DIR/tls/cert.pem" "${E2E_GATEWAY_URL:-https://localhost:7600}/health"
section "gateway log" "$OMNESIS" service logs gateway --lines 200
section "collector log" "$OMNESIS" service logs collector --lines 120
case "$(uname -s)" in
  Linux) section "systemd user units" systemctl --user list-units 'omnesis*' --all --no-pager ;;
  Darwin) section "launchd jobs" sh -c 'launchctl list | grep -i omnesis' ;;
esac
exit 0
