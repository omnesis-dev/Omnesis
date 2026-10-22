#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
# Exercise the documented, checked-in Compose installation with a local image.
set -euo pipefail
image=${1:?combined image required}
repo=$(cd "$(dirname "$0")/../.." && pwd)
project="omnesis-compose-smoke-$$-$RANDOM"
tag="compose-smoke-$$-$RANDOM"
alias="ghcr.io/omnesis-dev/omnesis-combined:$tag"
scratch=$(mktemp -d)
chmod 0700 "$scratch"
export OMNESIS_TLS_EXTRA_NAMES=localhost
export OMNESIS_IMAGE_TAG="$tag"
export OMNESIS_PASSPHRASE_PATH="$scratch/keyring.pass"
: > "$scratch/compose.env"
compose=(docker compose --project-name "$project" --env-file "$scratch/compose.env" -f "$repo/compose.yaml" -f "$scratch/override.yaml")
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    "${compose[@]}" logs --no-color --tail 40 gateway >&2 || true
  fi
  "${compose[@]}" down --volumes --timeout 120 >/dev/null 2>&1 || true
  docker image rm "$alias" >/dev/null 2>&1 || true
  rm -rf "$scratch"
  exit "$status"
}
trap cleanup EXIT
cat > "$scratch/override.yaml" <<'YAML'
services:
  gateway:
    restart: "no"
    ports: !override
      - "127.0.0.1::7600"
      - "127.0.0.1::3000"
      - "127.0.0.1::3001"
      - "127.0.0.1::3002"
      - "127.0.0.1::3003"
YAML
docker tag "$image" "$alias"
# Compose file secrets are bind mounts, so their host ownership matters. Only
# this disposable fixture is mounted into the root helper. The parent stays
# private to the invoking host account; the runtime's group can read the file.
docker run --rm --user 0:0 --entrypoint node \
  --mount "type=bind,source=$scratch,target=/fixture" \
  -e "FIXTURE_OWNER=$(id -u)" "$image" -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  for (const name of ["keyring.pass", "wrong.pass"]) {
    const path = `/fixture/${name}`;
    fs.writeFileSync(path, crypto.randomBytes(48).toString("hex"), {mode:0o640});
    fs.chownSync(path, Number(process.env.FIXTURE_OWNER), 10001);
    fs.chmodSync(path, 0o640);
  }
'
"${compose[@]}" config --quiet
"${compose[@]}" run --rm --no-deps --entrypoint omnesis gateway keyring init --backend passphrase >/dev/null
# Export recovery exactly as the guide instructs, without printing unlock
# material into public CI logs or retaining it after this disposable fixture.
(umask 077; "${compose[@]}" run --rm --no-deps --entrypoint omnesis gateway \
  keyring export-recovery --backend passphrase > "$scratch/recovery")
[ -s "$scratch/recovery" ]
container_id() { "${compose[@]}" ps --all --quiet gateway; }
wait_ready() {
  local id
  id=$(container_id)
  [ -n "$id" ]
  for attempt in $(seq 1 120); do
    if docker exec "$id" curl --fail --silent --insecure https://localhost:7600/health >/dev/null 2>&1; then return; fi
    [ "$(docker inspect -f '{{.State.Running}}' "$id")" = true ] || break
    sleep 2
  done
  echo 'Standalone Compose gateway did not become healthy' >&2
  return 1
}
check_collector() {
  for attempt in $(seq 1 60); do
    if "${compose[@]}" exec -T gateway omnesis devices list --json | python3 -c '
import json,sys
body=json.load(sys.stdin)
items=body if isinstance(body,list) else body.get("items",[])
sys.exit(0 if any(d.get("kind")=="collector" and d.get("online") for d in items) else 1)
'; then return; fi
    sleep 2
  done
  echo 'Standalone Compose collector did not authenticate' >&2
  return 1
}
identity() {
  "${compose[@]}" exec -T gateway sha256sum /var/lib/omnesis/token /var/lib/omnesis/tls/cert.pem
}
check_encryption() {
  "${compose[@]}" exec -T gateway node -e '
    const fs=require("node:fs");
    for (const name of ["omnesis.db", "index.db"]) {
      const data=fs.readFileSync(`/var/lib/omnesis/${name}`);
      if (data.length < 16 || data.subarray(0,15).toString() === "SQLite format 3") {
        throw new Error(`${name} is empty or plaintext`);
      }
    }
  '
}
"${compose[@]}" up --detach --pull never
wait_ready
check_collector
check_encryption
original_identity=$(identity)
"${compose[@]}" down --timeout 120
"${compose[@]}" up --detach --pull never
wait_ready
check_collector
check_encryption
[ "$(identity)" = "$original_identity" ]
"${compose[@]}" down --timeout 120
# Replacing a Compose file secret must fail closed, then recover when its
# original contents return. Recreate the container each time to remount it.
cp "$scratch/keyring.pass" "$scratch/correct.pass"
cat "$scratch/wrong.pass" > "$scratch/keyring.pass"
"${compose[@]}" up --detach --pull never
id=$(container_id)
for attempt in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Running}}' "$id")" = true ] || break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Running}}' "$id")" = false ]
[ "$(docker inspect -f '{{.State.ExitCode}}' "$id")" != 0 ]
"${compose[@]}" down --timeout 120
cat "$scratch/correct.pass" > "$scratch/keyring.pass"
"${compose[@]}" up --detach --pull never
wait_ready
check_collector
check_encryption
[ "$(identity)" = "$original_identity" ]
echo 'Passed standalone Compose initialization, recovery export, encrypted state persistence, collector authentication and wrong-passphrase recovery'
