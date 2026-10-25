# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
# Sourced only by tailnet-collector.sh's explicit Docker profile.

docker_native_preflight() {
  local pin="$1" url="$2"
  [ -n "$pin" ] || die "Docker gateway requires an explicit certificate pin"
  node "$E2E_DIR/docker-tailnet-probe.mjs" peer --url "$url" --fingerprint "$pin"
  node "$E2E_DIR/docker-tailnet-probe.mjs" reject-pin --url "$url" \
    --fingerprint sha256:0000000000000000000000000000000000000000000000000000000000000000
}

docker_native_negatives() {
  local code
  code="$(wait_for negative-code 300)" || die "no separate negative-control code arrived"
  expect_shape "negative pairing control code" "$CODE_SHAPE" "$code"
  secret "$code"
  printf '%s\n' "$code" >"$E2E_WORK/negative-code"
  node "$E2E_DIR/docker-tailnet-probe.mjs" product-negative --cli "$OMNESIS" \
    --root "$E2E_WORK/negative-configs" --url "$JOIN_URL" --fingerprint "$FINGERPRINT" --code-file "$E2E_WORK/negative-code"
  mailbox put --url "$MAILBOX" --key collector-negative-probes --value ok
}

docker_native_restart() {
  cp "$PAIRING_STATE" "$E2E_WORK/pairing-before.json"
  wait_for restart-collector 1800 >/dev/null || die "the Docker gateway never requested the native restart"
  redacted "$OMNESIS" service restart collector || die "native collector restart failed"
  local deadline=$(($(date +%s) + 180))
  while :; do
    "$OMNESIS" service status --json >"$E2E_WORK/services-restarted.json"
    cp "$PAIRING_STATE" "$E2E_WORK/pairing-restarted.json"
    if node "$E2E_DIR/docker-tailnet-probe.mjs" native \
      --before-services "$E2E_WORK/services-before.json" --after-services "$E2E_WORK/services-restarted.json" \
      --before-pairing "$E2E_WORK/pairing-before.json" --after-pairing "$E2E_WORK/pairing-restarted.json"; then break; fi
    [ "$(date +%s)" -lt "$deadline" ] || die "native restart did not retain its credential and replace its service PID"
    sleep 3
  done
  local prior
  prior="$(json_get "$PAIRING_STATE" 'j.lastAuthenticatedAt')"
  mailbox put --url "$MAILBOX" --key collector-restarted --value ok
  wait_for gateway-restarted 600 >/dev/null || die "the Docker gateway never restarted"
  # Wait for a fresh real authentication after the gateway restart, not just a
  # stale paired marker left by the previous connection.
  deadline=$(($(date +%s) + 180))
  until [ "$(json_get "$PAIRING_STATE" 'j.state')" = paired ] && \
    [ "$(json_get "$PAIRING_STATE" 'j.lastAuthenticatedAt > Number(a)' "$prior")" = true ]; do
    [ "$(date +%s)" -lt "$deadline" ] || die "native collector did not authenticate again after Docker restart"
    sleep 3
  done
  mailbox put --url "$MAILBOX" --key collector-reconnected --value ok
}

# Stop only the collector installed by this explicit T3 invocation. Hosted
# macOS has no GNU timeout, so bound the exact CLI child with Node instead.
docker_native_cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ "${T3_COLLECTOR_OWNED:-0}" = 1 ] && [ -x "$OMNESIS" ]; then
    set +e
    node -e '
      const {spawnSync}=require("node:child_process");
      const child=spawnSync(process.argv[1],["service","stop","collector"],{encoding:"utf8",timeout:20000});
      process.stdout.write((child.stdout||"")+(child.stderr||""));
      process.exit(child.status===0&&!child.error?0:1);
    ' "$OMNESIS" 2>&1 | redact
    [ "${PIPESTATUS[0]}" -eq 0 ] || status=1
    set -e
  fi
  exit "$status"
}
