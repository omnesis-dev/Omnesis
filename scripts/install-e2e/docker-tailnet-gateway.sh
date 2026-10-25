#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
# T3: locally built gateway image, real native macOS collector over the tailnet.
set -euo pipefail
: "${E2E_WORK:?set E2E_WORK}" "${E2E_FIXTURE_DIR:?set E2E_FIXTURE_DIR}"
E2E_T3_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
node "$E2E_T3_ROOT/scripts/install-e2e/docker-tailnet-host.mjs" guard linux "$E2E_WORK" "$E2E_T3_ROOT"
. "$(dirname "$0")/lib.sh"
. "$(dirname "$0")/tailnet.sh"
[ "${GITHUB_ACTIONS:-}" = true ] || die "Docker tailnet lane requires a disposable GitHub-hosted runner"
[ "${RUNNER_OS:-}" = Linux ] || die "Docker gateway requires Linux"
E2E_WORK="$(cd "$E2E_WORK" && pwd -P)"
E2E_RUNNER_TEMP="$(cd "${RUNNER_TEMP:?}" && pwd -P)"
case "$E2E_WORK" in "$E2E_RUNNER_TEMP/"*) ;; *) die "scratch must be under RUNNER_TEMP";; esac
umask 077
OWNER="omnesis-t3-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
LABEL="dev.omnesis.install-e2e=$OWNER"
NAME="$OWNER-gateway"
VOLUME="$OWNER-state"
IMAGE="$OWNER:local"
MAILBOX_PID=""
MAILBOX=""
cleanup() {
  local status=$? ids id
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ] && [ -n "$MAILBOX" ]; then
    mailbox put --url "$MAILBOX" --key abort --value "Docker gateway lane failed" >/dev/null 2>&1 || true
    timeout 15 docker logs --tail 160 "$NAME" 2>&1 | redact || true
    sleep 3
  fi
  # All helpers and runtime containers carry the exact invocation label.
  ids="$(timeout 15 docker ps -aq --filter "label=$LABEL" 2>/dev/null)" || { ids=""; status=1; }
  for id in $ids; do timeout 30 docker rm -f "$id" >/dev/null 2>&1 || status=1; done
  if timeout 10 docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    if [ "$(timeout 10 docker volume inspect -f '{{index .Labels "dev.omnesis.install-e2e"}}' "$VOLUME")" = "$OWNER" ]; then
      timeout 20 docker volume rm "$VOLUME" >/dev/null 2>&1 || status=1
    else status=1; fi
  fi
  if timeout 10 docker image inspect "$IMAGE" >/dev/null 2>&1; then
    if [ "$(timeout 10 docker image inspect -f '{{index .Config.Labels "dev.omnesis.install-e2e"}}' "$IMAGE")" = "$OWNER" ]; then
      timeout 20 docker image rm "$IMAGE" >/dev/null 2>&1 || status=1
    else status=1; fi
  fi
  if [ -n "$MAILBOX_PID" ]; then
    if [ -s "$E2E_WORK/mailbox-process.json" ]; then
      if node "$E2E_DIR/docker-tailnet-host.mjs" stop-mailbox "$E2E_WORK/mailbox-process.json"; then
        wait "$MAILBOX_PID" 2>/dev/null || true
      else status=1; fi
    else status=1; fi
  fi
  sudo rm -rf -- "$E2E_WORK/tls"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
wait_for() { mailbox wait --url "$MAILBOX" --key "$1" --timeout "${2:-1800}"; }

version="$(json_get "$E2E_FIXTURE_DIR/fixture.json" 'j.candidateVersion')"
expect_shape "candidate version" "$VERSION_SHAPE" "$version"
group "Tailnet and local image"
ts_register
ts_check_internet
FQDN="$(ts_field 'j.Self.DNSName.replace(/\.$/, "")')"
ts_wait_resolves "$FQDN" 120
GATEWAY_URL="https://$FQDN:7600"
printf '%s\n' "$GATEWAY_URL" >"$E2E_WORK/gateway-url"
MAILBOX="http://$TS_SELF_IP:$MAILBOX_PORT"
printf '%s\n' "$MAILBOX" >"$E2E_WORK/mailbox-url"
node "$E2E_DIR/mailbox.mjs" serve --host "$TS_SELF_IP" --port "$MAILBOX_PORT" >"$E2E_WORK/mailbox.log" 2>&1 &
MAILBOX_PID=$!
node "$E2E_DIR/update-fault.mjs" record-process "$MAILBOX_PID" "$$" >"$E2E_WORK/mailbox-process.json"
for attempt in $(seq 1 30); do
  if mailbox put --url "$MAILBOX" --key starting --value docker-build >/dev/null 2>&1; then break; fi
  kill -0 "$MAILBOX_PID" 2>/dev/null || die "mailbox exited"
  [ "$attempt" -lt 30 ] || die "mailbox did not become ready"
  sleep 1
done
# No credentials or TLS keys enter the build context, and nothing is published.
redacted timeout 1800 docker build --target gateway-runtime --label "$LABEL" -t "$IMAGE" "$E2E_ROOT"
[ "$(docker image inspect -f '{{.Config.User}}' "$IMAGE")" = 10001:10001 ] || die "gateway image is not unprivileged"
mkdir -p "$E2E_WORK/tls"
redacted timeout 120 sudo tailscale cert --cert-file "$E2E_WORK/tls/cert.pem" --key-file "$E2E_WORK/tls/key.pem" "$FQDN"
sudo chown -R 10001:10001 "$E2E_WORK/tls"
sudo chmod 700 "$E2E_WORK/tls"
sudo chmod 400 "$E2E_WORK/tls/key.pem"
sudo chmod 444 "$E2E_WORK/tls/cert.pem"
docker volume create --label "$LABEL" "$VOLUME" >/dev/null
# Generate unlock material only in the owned private volume; never print it.
docker run --rm --label "$LABEL" --mount "type=volume,source=$VOLUME,target=/var/lib/omnesis" \
  --entrypoint node "$IMAGE" -e 'require("node:fs").writeFileSync("/var/lib/omnesis/keyring.pass",require("node:crypto").randomBytes(48).toString("hex"),{mode:0o600})'
keyring=(-e OMNESIS_SECRET_STORE=passphrase -e OMNESIS_KEYRING_PASSPHRASE_FILE=/var/lib/omnesis/keyring.pass)
docker run --rm --label "$LABEL" --mount "type=volume,source=$VOLUME,target=/var/lib/omnesis" \
  "${keyring[@]}" --entrypoint omnesis "$IMAGE" keyring init --backend passphrase >/dev/null
# Only this disposable runner's namespace is used. Host networking exposes the
# gateway through its real tailnet interface and preserves MagicDNS resolution.
docker run -d --name "$NAME" --label "$LABEL" --network host --memory 3g --cpus 2 \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=volume,source=$VOLUME,target=/var/lib/omnesis" \
  --mount "type=bind,source=$E2E_WORK/tls,target=/run/t3-tls,readonly" \
  "${keyring[@]}" -e OMNESIS_MDNS_DISABLE=1 -e "OMNESIS_GATEWAY_URL=$GATEWAY_URL" \
  -e OMNESIS_TLS_CERT=/run/t3-tls/cert.pem -e OMNESIS_TLS_KEY=/run/t3-tls/key.pem "$IMAGE" >/dev/null
# A wrapper for shared mint/source helpers: the complete real CLI is in-image.
cat >"$E2E_WORK/omnesis" <<WRAPPER
#!/bin/sh
exec docker exec '$NAME' omnesis "\$@"
WRAPPER
chmod 700 "$E2E_WORK/omnesis"
OMNESIS="$E2E_WORK/omnesis"
probe health --url "$GATEWAY_URL" --expect-version "$version" --timeout 180 >/dev/null
pin="sha256:$(docker exec "$NAME" node -e 'console.log(new(require("node:crypto").X509Certificate)(require("node:fs").readFileSync("/run/t3-tls/cert.pem")).fingerprint256.replaceAll(":","").toLowerCase())')"
node "$E2E_DIR/docker-tailnet-probe.mjs" peer --url "$GATEWAY_URL" --fingerprint "$pin"
# State is actually encrypted, and only hashes of private identity files leave.
identity() {
  docker exec -i "$NAME" node --input-type=module - "$pin" <"$E2E_DIR/docker-tailnet-identity.mjs"
}
mint_probe_token
identity >"$E2E_WORK/identity-before"
mailbox put --url "$MAILBOX" --key phase --value docker-ready
endgroup

group "Native Mac pairing and invented vault"
wait_for collector-up >/dev/null || die "native collector did not join the lane"
CODE="$(probe pair --url "$GATEWAY_URL" --token-file "$TOKEN_FILE" --kind collector --ttl 3600)"
secret "$CODE"
mailbox put --url "$MAILBOX" --key join-url --value "$GATEWAY_URL"
mailbox put --url "$MAILBOX" --key fingerprint --value "$pin"
mailbox put --url "$MAILBOX" --key expect-version --value "$version"
mailbox put --url "$MAILBOX" --key code --value "$CODE"
REPORTED="$(wait_for collector-installed)" || die "native collector install failed"
expect_shape "native device name" "$NAME_SHAPE" "$REPORTED"
NEGATIVE_CODE="$(probe pair --url "$GATEWAY_URL" --token-file "$TOKEN_FILE" --kind collector --ttl 600)"
secret "$NEGATIVE_CODE"
printf '%s\n' "$NEGATIVE_CODE" >"$E2E_WORK/negative-code"
mailbox put --url "$MAILBOX" --key negative-code --value "$NEGATIVE_CODE"
[ "$(wait_for collector-negative-probes 180)" = ok ] || die "product CLI negative pairing controls failed"
node "$E2E_DIR/docker-tailnet-probe.mjs" revoke-unused --url "$GATEWAY_URL" --token-file "$TOKEN_FILE" --code-file "$E2E_WORK/negative-code"
VAULT="$(wait_for vault-path)"
expect_shape "invented native vault path" '/[A-Za-z0-9._/-]+' "$VAULT"
COLLECTOR="$(live_collector_name "$GATEWAY_URL" 180)" || die "native collector did not connect"
SOURCE_ID="$(add_vault "$COLLECTOR" "$VAULT")"
redacted "$OMNESIS" sources sync "$SOURCE_ID" --wait --timeout 300
capture() {
  local name="$1" deadline=$(($(date +%s) + 180))
  until node "$E2E_DIR/docker-tailnet-probe.mjs" capture --url "$GATEWAY_URL" --token-file "$TOKEN_FILE" \
    --query "$SEARCH_WORD" --title "$SEARCH_TITLE" --version "$version" --out "$E2E_WORK/$name.json"; do
    [ "$(date +%s)" -lt "$deadline" ] || die "exact native corpus/device did not settle"
    sleep 3
  done
}
capture before
endgroup

group "Native service restart"
mailbox put --url "$MAILBOX" --key restart-collector --value now
[ "$(wait_for collector-restarted 300)" = ok ] || die "native service restart failed"
capture native-restarted
node "$E2E_DIR/docker-tailnet-probe.mjs" compare --before "$E2E_WORK/before.json" --after "$E2E_WORK/native-restarted.json"
endgroup

group "Docker gateway restart"
docker stop --time 60 "$NAME" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" = 0 ] || die "gateway did not stop cleanly"
docker start "$NAME" >/dev/null
probe health --url "$GATEWAY_URL" --expect-version "$version" --timeout 180 >/dev/null
node "$E2E_DIR/docker-tailnet-probe.mjs" peer --url "$GATEWAY_URL" --fingerprint "$pin"
identity >"$E2E_WORK/identity-after"
cmp "$E2E_WORK/identity-before" "$E2E_WORK/identity-after" || die "encrypted gateway identity changed"
mailbox put --url "$MAILBOX" --key gateway-restarted --value ok
[ "$(wait_for collector-reconnected 300)" = ok ] || die "native collector did not reconnect"
capture gateway-restarted
node "$E2E_DIR/docker-tailnet-probe.mjs" compare --before "$E2E_WORK/before.json" --after "$E2E_WORK/gateway-restarted.json"
endgroup
mailbox put --url "$MAILBOX" --key finished --value ok
[ "$(wait_for collector-done 300)" = ok ] || die "native collector did not finish"
log "Docker gateway/native Mac collector identities and invented corpus survived both restarts"
