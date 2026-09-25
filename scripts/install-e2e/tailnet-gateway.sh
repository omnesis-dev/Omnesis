#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# The gateway side of the two-machine tailnet lane.
#
#   E2E_WORK=<scratch> E2E_MODE=fresh|upgrade E2E_FIXTURE_DIR=<fixture> \
#     scripts/install-e2e/tailnet-gateway.sh
#
# fresh:   the candidate is installed with its own install.sh. The tailnet
#          has HTTPS certificates, so the installer takes the Tailscale branch
#          and the gateway serves a publicly trusted certificate for its
#          MagicDNS name.
# upgrade: the newest real release is installed with that release's own
#          install.sh; after the collector has paired and synced,
#          `omnesis update --fleet --yes` moves this host and the collector to
#          the candidate, published in the fixture as the next version.
#
# The collector job runs tailnet-collector.sh. The two talk through the
# mailbox this script serves on its tailnet address; see mailbox.mjs.
set -euo pipefail

E2E_WORK="${E2E_WORK:?set E2E_WORK}"
MODE="${E2E_MODE:?set E2E_MODE to fresh or upgrade}"
FIXTURE_DIR="${E2E_FIXTURE_DIR:?set E2E_FIXTURE_DIR}"
# shellcheck source=scripts/install-e2e/lib.sh
. "$(dirname "$0")/lib.sh"
# shellcheck source=scripts/install-e2e/tailnet.sh
. "$(dirname "$0")/tailnet.sh"

[ -n "${CI:-}" ] || die "tailnet-gateway.sh installs into \$HOME and registers services; it runs on CI machines only"

REMOTE="$FIXTURE_DIR/omnesis.git"
FIXTURE_JSON="$FIXTURE_DIR/fixture.json"
# Each wait on the collector is bounded well inside the job's timeout: its
# install clones, installs dependencies and builds, which a slow macOS runner
# finishes in about fifteen minutes.
WAIT_PEER_SECONDS="${E2E_WAIT_PEER_SECONDS:-1800}"

case "$MODE" in
  fresh)
    INSTALL_SH="$E2E_ROOT/scripts/install.sh"
    START_VERSION="$(json_get "$FIXTURE_JSON" 'j.candidateVersion')"
    ;;
  upgrade)
    INSTALL_SH="$FIXTURE_DIR/release-install.sh"
    START_VERSION="$(json_get "$FIXTURE_JSON" 'j.startRelease.slice(1)')" || die "the fixture names no release to start from"
    NEXT_VERSION="$(json_get "$FIXTURE_JSON" 'j.next.version')" || die "the fixture made no next release"
    ;;
  *) die "unknown E2E_MODE $MODE" ;;
esac

group "Tailnet"
ts_register
FQDN="$(ts_field 'j.Self.DNSName.replace(/\.$/, "")')" || die "this node has no MagicDNS name"
ts_wait_resolves "$FQDN" 120
GATEWAY_URL="https://$FQDN:7600"
# For the diagnostics step.
echo "$GATEWAY_URL" >"$E2E_WORK/gateway-url"
MAILBOX="http://$TS_SELF_IP:$MAILBOX_PORT"
# Where the workflow's failure step posts `abort`.
echo "$MAILBOX" >"$E2E_WORK/mailbox-url"
nohup node "$E2E_DIR/mailbox.mjs" serve --host "$TS_SELF_IP" --port "$MAILBOX_PORT" \
  >"$E2E_WORK/mailbox.log" 2>&1 &
MAILBOX_PID=$!
tries=0
until mailbox put --url "$MAILBOX" --key phase --value gateway-starting 2>/dev/null; do
  tries=$((tries + 1))
  if ! kill -0 "$MAILBOX_PID" 2>/dev/null || [ "$tries" -ge 30 ]; then
    redact <"$E2E_WORK/mailbox.log"
    die "the mailbox did not start"
  fi
  sleep 1
done
log "mailbox up; gateway node ready"
endgroup

# wait_for <key> [timeout seconds] → the value. Non-zero when the collector
# aborted or never sent it; call as `X="$(wait_for k)" || die …`.
wait_for() {
  mailbox wait --url "$MAILBOX" --key "$1" --timeout "${2:-$WAIT_PEER_SECONDS}"
}

group "Install v$START_VERSION ($MODE)"
new_passphrase_file
set -- --source-dir "$HOME/omnesis" --no-model --no-prompt --no-modify-path --keyring-passphrase-file "$PASSPHRASE_FILE"
[ "$MODE" = fresh ] || set -- "$@" --version "$START_VERSION"
# Streamed (redacted) as it runs, and kept for the lines parsed below.
set +e
OMNESIS_REPO_URL="file://$REMOTE" sh "$INSTALL_SH" "$@" 2>&1 | tee "$E2E_WORK/install.log" | redact
status=${PIPESTATUS[0]}
set -e
[ "$status" -eq 0 ] || die "the gateway install failed (exit $status)"
# A Tailscale certificate is publicly trusted: no -k, no CA override.
curl -fsS --max-time 20 "$GATEWAY_URL/health" >/dev/null ||
  die "the gateway does not serve a trusted certificate for its MagicDNS name"
probe health --url "$GATEWAY_URL" --expect-version "$START_VERSION" --timeout 120 >/dev/null
endgroup

group "The join line the installer printed"
# The first --gateway-url / --trust-fingerprint pair belongs to the collector
# line of the "Add another machine" section.
JOIN_URL="$(sed -n 's/^ *--gateway-url \([^ ]*\).*/\1/p' "$E2E_WORK/install.log" | head -1)"
FINGERPRINT="$(sed -n 's/^ *--trust-fingerprint \(sha256:[0-9a-f]*\).*/\1/p' "$E2E_WORK/install.log" | head -1)"
[ -n "$JOIN_URL" ] || die "the installer printed no --collector join line"
[ "$JOIN_URL" = "$GATEWAY_URL" ] ||
  die "the join line names $JOIN_URL, not this gateway's MagicDNS name; the Tailscale certificate branch was not taken"
log "join line: --gateway-url $JOIN_URL${FINGERPRINT:+ --trust-fingerprint $FINGERPRINT}"
endgroup

group "Pair the collector"
mint_probe_token
# The collector is recognized by device id: the one collector the gateway
# lists that did not exist before its pairing code was minted. (Its name on
# the gateway and the name in its own pairing record are spelled differently.)
probe snapshot --url "$GATEWAY_URL" --token-file "$TOKEN_FILE" >"$E2E_WORK/devices-before-pairing.json" ||
  die "could not list the gateway's devices"
wait_for collector-up >/dev/null || die "the collector never came up"
# An hour, not the CLI's default: the collector redeems the code only after
# its install has cloned and built.
CODE="$(probe pair --url "$GATEWAY_URL" --token-file "$TOKEN_FILE" --kind collector --ttl 3600)" ||
  die "could not mint a collector pairing code"
secret "$CODE"
mailbox put --url "$MAILBOX" --key join-url --value "$JOIN_URL"
mailbox put --url "$MAILBOX" --key fingerprint --value "$FINGERPRINT"
mailbox put --url "$MAILBOX" --key expect-version --value "$START_VERSION"
mailbox put --url "$MAILBOX" --key code --value "$CODE"
REPORTED="$(wait_for collector-installed)" || die "the collector install did not finish"
expect_shape "the collector's device name" "$NAME_SHAPE" "$REPORTED"
log "the collector reports it paired as $REPORTED"
deadline=$(($(date +%s) + 180))
until probe snapshot --url "$GATEWAY_URL" --token-file "$TOKEN_FILE" >"$E2E_WORK/devices.json" &&
  COLLECTOR="$(json_get "$E2E_WORK/devices.json" '(j.devices.find((d) => d.kind === "collector" && d.online &&
      !JSON.parse(require("fs").readFileSync(a, "utf8")).devices.some((b) => b.id === d.id)) || {}).name' \
    "$E2E_WORK/devices-before-pairing.json")"; do
  [ "$(date +%s)" -lt "$deadline" ] || die "no newly paired collector is live on the gateway"
  sleep 3
done
log "the gateway lists the new collector $COLLECTOR as paired and live"
endgroup

group "Sync an invented vault from the collector"
VAULT="$(wait_for vault-path)" || die "the collector sent no vault"
expect_shape "the collector's vault path" '/[A-Za-z0-9._/-]+' "$VAULT"
SOURCE_ID="$(add_vault "$COLLECTOR" "$VAULT")"
redacted "$OMNESIS" sources sync "$SOURCE_ID" --wait --timeout 300 || die "the collector's vault did not sync"
snapshot_with_hit before "$GATEWAY_URL"
endgroup

if [ "$MODE" = upgrade ]; then
  group "Fleet update to v$NEXT_VERSION"
  mailbox put --url "$MAILBOX" --key phase --value fleet-updating
  redacted "$OMNESIS" update --fleet --yes || die "omnesis update --fleet did not finish"
  probe health --url "$GATEWAY_URL" --expect-version "$NEXT_VERSION" --timeout 180 >/dev/null
  wait_collector_live "$GATEWAY_URL" "$COLLECTOR" 600
  redacted "$OMNESIS" sources sync "$SOURCE_ID" --wait --timeout 300 || die "the vault did not sync after the fleet update"
  snapshot_with_hit updated "$GATEWAY_URL" --fleet
  probe compare --before "$E2E_WORK/before.json" --after "$E2E_WORK/updated.json" \
    --expect-version "$NEXT_VERSION" --expect-restart gateway,collector --expect-backup \
    --expect-title "$SEARCH_TITLE" --expect-fleet-current
  mailbox put --url "$MAILBOX" --key fleet-done --value "$NEXT_VERSION"
  verdict="$(wait_for collector-verified 900)" || die "the collector did not report after the fleet update"
  [ "$verdict" = ok ] || die "the collector's own checks after the fleet update failed; its job log says which"
  endgroup
fi

mailbox put --url "$MAILBOX" --key finished --value ok
# The mailbox ends with this job: keep it up until the collector has read
# `finished`. Its own job reports its own verdict, so a missing
# acknowledgement is not this job's failure.
wait_for collector-done 300 >/dev/null || log "the collector did not acknowledge the end of the lane"
log "$MODE lane held on the gateway"
