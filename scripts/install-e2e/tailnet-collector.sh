#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# The collector (Mac) side of the two-machine tailnet lane.
#
#   E2E_WORK=<scratch> E2E_MODE=fresh|upgrade E2E_FIXTURE_DIR=<fixture> \
#     E2E_GATEWAY_HOST=<gateway node name> scripts/install-e2e/tailnet-collector.sh
#
# Reaches the gateway by its MagicDNS name, reads the join URL, fingerprint
# and a pairing code from the gateway's mailbox, and runs the `--collector`
# line the gateway's installer printed, from the same release the gateway
# runs. Then it holds an invented Obsidian vault for the gateway to add and
# sync. In upgrade mode it waits for the gateway's fleet update and checks,
# on this machine, that its collector really moved and restarted.
set -euo pipefail

E2E_WORK="${E2E_WORK:?set E2E_WORK}"
MODE="${E2E_MODE:?set E2E_MODE to fresh or upgrade}"
FIXTURE_DIR="${E2E_FIXTURE_DIR:?set E2E_FIXTURE_DIR}"
GATEWAY_HOST="${E2E_GATEWAY_HOST:?set E2E_GATEWAY_HOST}"
# shellcheck source=scripts/install-e2e/lib.sh
. "$(dirname "$0")/lib.sh"
# shellcheck source=scripts/install-e2e/tailnet.sh
. "$(dirname "$0")/tailnet.sh"

[ -n "${CI:-}" ] || die "tailnet-collector.sh installs into \$HOME and registers services; it runs on CI machines only"

REMOTE="$FIXTURE_DIR/omnesis.git"
WAIT_PEER_SECONDS="${E2E_WAIT_PEER_SECONDS:-2700}"
case "$MODE" in
  fresh) INSTALL_SH="$E2E_ROOT/scripts/install.sh" ;;
  upgrade) INSTALL_SH="$FIXTURE_DIR/release-install.sh" ;;
  *) die "unknown E2E_MODE $MODE" ;;
esac

group "Tailnet"
ts_register
GATEWAY_FQDN="$GATEWAY_HOST.$TS_SUFFIX"
ts_wait_peer "$GATEWAY_HOST" "$WAIT_PEER_SECONDS"
ts_wait_resolves "$GATEWAY_FQDN" 120
MAILBOX="http://$GATEWAY_FQDN:$MAILBOX_PORT"
# Where the workflow's failure step posts `abort`.
echo "$MAILBOX" >"$E2E_WORK/mailbox-url"
endgroup

wait_for() {
  mailbox wait --url "$MAILBOX" --key "$1" --timeout "${2:-$WAIT_PEER_SECONDS}" --gone-after 300
}

group "Offer a vault and ask for a pairing code"
# Outside the folders macOS guards with privacy prompts, which a daemon
# without Full Disk Access could not read.
VAULT="$HOME/omnesis-e2e-vault"
make_vault "$VAULT"
mailbox put --url "$MAILBOX" --key vault-path --value "$VAULT" ||
  die "the gateway's mailbox is not reachable over MagicDNS"
mailbox put --url "$MAILBOX" --key collector-up --value 1
CODE="$(wait_for code)" || die "no pairing code arrived from the gateway"
secret "$CODE"
JOIN_URL="$(mailbox get --url "$MAILBOX" --key join-url)"
FINGERPRINT="$(mailbox get --url "$MAILBOX" --key fingerprint || true)"
START_VERSION="$(mailbox get --url "$MAILBOX" --key expect-version)"
[ "$JOIN_URL" = "https://$GATEWAY_FQDN:7600" ] || die "the join URL does not name the gateway's MagicDNS name"
endgroup

group "Run the printed --collector line (v$START_VERSION)"
set -- --collector --gateway-url "$JOIN_URL" --code "$CODE" \
  --source-dir "$HOME/omnesis" --no-prompt --no-modify-path
[ -z "$FINGERPRINT" ] || set -- "$@" --trust-fingerprint "$FINGERPRINT"
[ "$MODE" = fresh ] || set -- "$@" --version "$START_VERSION"
# Streamed (redacted) as it runs, and kept for the lines parsed below.
set +e
OMNESIS_REPO_URL="file://$REMOTE" sh "$INSTALL_SH" "$@" 2>&1 | tee "$E2E_WORK/install.log" | redact
status=${PIPESTATUS[0]}
set -e
[ "$status" -eq 0 ] || die "the collector install failed (exit $status)"
# Trusted without -k: the gateway's certificate is a real one for its name.
served="$(curl -fsS --max-time 20 "$JOIN_URL/health" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => process.stdout.write(JSON.parse(s).version || ""));')" ||
  die "curl could not verify the gateway's certificate from the collector"
[ "$served" = "$START_VERSION" ] || die "the gateway serves $served, expected $START_VERSION"
[ "$("$OMNESIS" --version)" = "$START_VERSION" ] || die "this machine's CLI is not on $START_VERSION"
DEVICE_NAME="$(json_get "$CONFIG_DIR/collector-pairing-state.json" 'j.deviceName')" ||
  die "the collector recorded no pairing"
"$OMNESIS" service status --json >"$E2E_WORK/services-before.json"
[ "$(json_get "$E2E_WORK/services-before.json" "(j.items.find((s) => s.component === 'collector') || {}).state")" = running ] ||
  die "the collector is not running under launchd"
mailbox put --url "$MAILBOX" --key collector-installed --value "$DEVICE_NAME"
endgroup

if [ "$MODE" = upgrade ]; then
  group "Wait for the gateway's fleet update"
  NEXT_VERSION="$(wait_for fleet-done)" || die "the gateway never finished its fleet update"
  verdict=ok
  deadline=$(($(date +%s) + 300))
  until [ "$("$OMNESIS" --version 2>/dev/null)" = "$NEXT_VERSION" ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      verdict="the collector's CLI is not on $NEXT_VERSION"
      break
    fi
    sleep 5
  done
  "$OMNESIS" service status --json >"$E2E_WORK/services-after.json" || true
  before_pid="$(json_get "$E2E_WORK/services-before.json" "(j.items.find((s) => s.component === 'collector') || {}).pid")"
  after_state="$(json_get "$E2E_WORK/services-after.json" "(j.items.find((s) => s.component === 'collector') || {}).state" || echo missing)"
  after_pid="$(json_get "$E2E_WORK/services-after.json" "(j.items.find((s) => s.component === 'collector') || {}).pid" || echo none)"
  if [ "$verdict" = ok ] && [ "$after_state" != running ]; then verdict="the collector is $after_state under launchd"; fi
  if [ "$verdict" = ok ] && [ "$after_pid" = "$before_pid" ]; then verdict="the collector was not restarted (pid $after_pid)"; fi
  if [ "$verdict" = ok ] && [ "$(json_get "$CONFIG_DIR/update-state.json" 'j.phase')" != complete ]; then
    verdict="the collector's update record is not complete"
  fi
  log "collector verdict after the fleet update: $verdict"
  mailbox put --url "$MAILBOX" --key collector-verified --value "$verdict"
  [ "$verdict" = ok ] || die "$verdict"
  endgroup
fi

wait_for finished 1800 >/dev/null || die "the gateway did not finish"
log "$MODE lane held on the collector"
