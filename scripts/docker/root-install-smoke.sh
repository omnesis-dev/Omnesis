#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
# Real root-run installer coverage for Linux appliance/container hosts.
set -euo pipefail
if [ "$(uname -s)" != Linux ]; then
  echo 'SKIP: root Docker installer smoke requires Linux'
  exit 0
fi
root=()
if [ "$(id -u)" != 0 ]; then
  if ! command -v sudo >/dev/null || ! sudo -n true 2>/dev/null; then
    echo 'SKIP: root Docker installer smoke needs root or passwordless sudo (no permission changes attempted)'
    exit 0
  fi
  root=(sudo -n)
fi
repo=$(cd "$(dirname "$0")/../.." && pwd)
version=$(node -p 'require(process.argv[1]).version' "$repo/packages/gateway/package.json")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
case "$endpoint" in unix://*) ;; *) echo 'Root installer smoke requires a local Unix Docker socket' >&2; exit 1;; esac
work=$(mktemp -d /tmp/omnesis-root-install-XXXXXX)
home_dir="$work/home"
config_dir="$work/config"
compose="$config_dir/docker-compose.yml"
image_repo="omnesis-root-install-$(basename "$work" | tr '[:upper:]' '[:lower:]')"
root_env() {
  "${root[@]}" env -i HOME="$home_dir" PATH="$PATH" DOCKER_HOST="$endpoint" "$@"
}
cleanup() {
  local status=$?
  if root_env test -f "$compose"; then
    root_env docker compose -f "$compose" --profile update down --timeout 120 >/dev/null 2>&1 || status=1
  fi
  # Remove only this invocation's aliases; shared build caches remain intact.
  root_env docker image rm "$image_repo/omnesis-combined:$version" "$image_repo/omnesis-updater:$version" >/dev/null 2>&1 || true
  "${root[@]}" rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
root_env mkdir -p "$home_dir" "$config_dir"
root_env chmod 700 "$work" "$home_dir" "$config_dir"
# Start with root-owned installer inputs; the installer must grant only its
# daemon files to UID 10001, including files it rewrites after keyring setup.
root_env node -e '
  const fs=require("node:fs"); const dir=process.argv[1];
  fs.writeFileSync(`${dir}/keyring.pass`,require("node:crypto").randomBytes(48).toString("hex"),{mode:0o600});
  fs.writeFileSync(`${dir}/.env`,"OMNESIS_MDNS_DISABLE=1\n",{mode:0o600});
' "$config_dir"
port=$(node --input-type=module -e '
  import {createServer} from "node:net";
  const server=createServer(); server.listen(0,"127.0.0.1",()=>{
    process.stdout.write(String(server.address().port)); server.close();
  });
')
[ "$port" -gt 1024 ] && [ "$port" != 7600 ]
echo 'Running the real installer as root with disposable encrypted combined state'
# The installer prints a recovery code. Capture it in private fixture storage
# and never reproduce that log in CI output, including on failure.
if ! root_env env OMNESIS_CONFIG_DIR="$config_dir" OMNESIS_NO_PROMPT=1 \
  OMNESIS_IMAGE_REPO="$image_repo" OMNESIS_DOCKER_BUILD_CONTEXT="$repo" \
  OMNESIS_OAUTH_HOST_PORTS=ephemeral sh "$repo/scripts/install.sh" \
  --docker --combined --build --version "$version" --port "$port" --no-model \
  --keyring-passphrase-file "$config_dir/keyring.pass" \
  > "$work/installer.log" 2>&1; then
  echo 'Root Docker installation failed; private installer output was withheld because it contains recovery material' >&2
  exit 1
fi
root_env docker compose -f "$compose" config --format json | node --input-type=module -e '
  import assert from "node:assert/strict";
  let text="";for await(const part of process.stdin)text+=part;
  const config=JSON.parse(text); assert.equal(config.services.gateway.user,"10001:10001");
  assert(!config.services.collector,"combined installation must have one daemon container");
'
container=$(root_env docker compose -f "$compose" ps -q gateway)
[ -n "$container" ]
[ "$(root_env docker exec "$container" id -u)" = 10001 ]
[ "$(root_env docker exec "$container" id -g)" = 10001 ]
for attempt in $(seq 1 60); do
  if root_env "$home_dir/.local/bin/omnesis" devices list --json | node --input-type=module -e '
    let text="";for await(const part of process.stdin)text+=part;
    const body=JSON.parse(text);const items=Array.isArray(body)?body:body.items??[];
    process.exit(items.some(device=>device.kind==="collector"&&device.online)?0:1);
  '; then break; fi
  [ "$attempt" != 60 ] || { echo 'Root-installed combined collector never became online' >&2; exit 1; }
  sleep 2
done
root_env "$home_dir/.local/bin/omnesis" keyring status --json | node --input-type=module -e '
  import assert from "node:assert/strict";
  let text="";for await(const part of process.stdin)text+=part;
  const status=JSON.parse(text);assert.equal(status.store.backend,"passphrase");assert.equal(status.valid,true);
'
root_env docker exec "$container" node -e '
  const assert=require("node:assert/strict");const fs=require("node:fs");const dir=process.argv[1];
  for(const file of [".env","keyring.pass","omnesis.db","index.db","token","tls/cert.pem"]){
    const stat=fs.statSync(`${dir}/${file}`);assert.equal(stat.uid,10001,`${file} owner`);
    assert.equal(stat.gid,10001,`${file} group`);
  }
  assert.equal(fs.statSync(`${dir}/keyring.pass`).mode&0o777,0o600);
  for(const file of ["omnesis.db","index.db"]){
    const bytes=fs.readFileSync(`${dir}/${file}`);assert(bytes.length>=16);
    assert.notEqual(bytes.subarray(0,15).toString(),"SQLite format 3");
  }
' "$config_dir"
root_env docker compose -f "$compose" stop --timeout 120 gateway >/dev/null
[ "$(root_env docker inspect -f '{{.State.ExitCode}}' "$container")" = 0 ]
echo 'PASS: actual root installer runs both daemons as UID/GID 10001, preserves private unlock access, and creates encrypted daemon-owned state'
