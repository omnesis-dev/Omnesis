#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# A Docker gateway and a native collector on one host, end to end: the REAL
# installer puts a combined gateway+collector container on this host, then the
# REAL installer puts a native collector beside it from a source checkout of
# this revision — the setup the Docker banner recommends on a Mac. What it
# proves is identity: the Docker launcher and config directory are untouched,
# each collector holds its own token, and after the gateway container restarts
# both reconnect as two distinct devices that stay online.
#
#   scripts/docker-native-beside-smoke.sh
#
# Nothing published is involved: a throwaway registry serves images built from
# this checkout, and the source install clones a bare remote of it. Every
# host-wide name derives from one prefix, and the compose project from a fresh
# mktemp config directory, so a concurrent run needs only
#   OMNESIS_DOCKER_BESIDE_PREFIX=mine scripts/docker-native-beside-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"

PREFIX="${OMNESIS_DOCKER_BESIDE_PREFIX:-omnesis-docker-beside}"
REGISTRY_CONTAINER="$PREFIX-registry"
WORK="$(mktemp -d "/tmp/$PREFIX-XXXXXX")"
HOME_DIR="$WORK/home"
# Not $HOME/.config/omnesis: the default directory gets the plain compose
# project name `omnesis`, which this lane must not be able to name.
CONFIG_DIR="$WORK/config"
COMPOSE_FILE="$CONFIG_DIR/docker-compose.yml"
NATIVE_DIR="$HOME_DIR/.config/omnesis-collector"
OMNESIS="$HOME_DIR/.local/bin/omnesis"
NATIVE="$HOME_DIR/.local/bin/omnesis-collector"
SOURCE_REMOTE="$WORK/source.git"
NATIVE_PID=""

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()'
}
REGISTRY_PORT="$(free_port)"
GATEWAY_PORT="$(free_port)"
IMAGE_REPO="localhost:$REGISTRY_PORT"
TAG="$(node -p "require('$REPO/packages/gateway/package.json').version")"
SHA="$(git -C "$REPO" rev-parse HEAD)"

step() { echo; echo "==> $*"; }
ok()   { echo "  ok: $*"; }
die() {
  echo "  FAILED: $*" >&2
  if [[ -f "$COMPOSE_FILE" ]]; then
    {
      echo "--- containers ---"
      docker compose -f "$COMPOSE_FILE" ps -a --format '{{.Name}} {{.Image}} {{.Status}}' || true
      echo "--- gateway log tail ---"
      docker compose -f "$COMPOSE_FILE" logs --tail 40 gateway || true
    } >&2
  fi
  [[ ! -f "$WORK/native.log" ]] || { echo "--- native collector log tail ---"; tail -n 40 "$WORK/native.log"; } >&2
  exit 1
}

cleanup() {
  local status=$?
  step "tearing down"
  [[ -z "$NATIVE_PID" ]] || kill "$NATIVE_PID" >/dev/null 2>&1 || true
  if [[ -f "$COMPOSE_FILE" ]]; then
    docker compose -f "$COMPOSE_FILE" --profile update down --volumes >/dev/null 2>&1 || true
  fi
  docker rm -f "$REGISTRY_CONTAINER" >/dev/null 2>&1 || true
  local svc
  for svc in combined updater; do
    docker image rm -f "$IMAGE_REPO/omnesis-$svc:$TAG" >/dev/null 2>&1 || true
  done
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT INT TERM

step "starting a throwaway registry on $IMAGE_REPO"
docker rm -f "$REGISTRY_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$REGISTRY_CONTAINER" -p "127.0.0.1:$REGISTRY_PORT:5000" registry:2 >/dev/null
for _ in $(seq 1 30); do
  curl -sf "http://$IMAGE_REPO/v2/" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://$IMAGE_REPO/v2/" >/dev/null || die "the fixture registry never answered"

step "building $TAG (combined and updater) from this checkout"
docker build --target combined-runtime -t "$IMAGE_REPO/omnesis-combined:$TAG" "$REPO"
docker build --target updater -t "$IMAGE_REPO/omnesis-updater:$TAG" "$REPO"
docker push -q "$IMAGE_REPO/omnesis-combined:$TAG"
docker push -q "$IMAGE_REPO/omnesis-updater:$TAG"
ok "pushed $TAG"

mkdir -p "$HOME_DIR"
# Every OMNESIS_* variable this shell carries is dropped, then exactly the ones
# a run needs are set.
base_env=(env)
while IFS='=' read -r name _; do
  case "$name" in OMNESIS_*) base_env+=(-u "$name") ;; esac
done < <(env)
base_env+=(HOME="$HOME_DIR" PATH="$PATH" SHELL=/bin/bash OMNESIS_OAUTH_HOST_PORTS=ephemeral)
docker_env=("${base_env[@]}" OMNESIS_IMAGE_REPO="$IMAGE_REPO" OMNESIS_GATEWAY_WAIT_SECONDS=240 OMNESIS_CONFIG_DIR="$CONFIG_DIR")

step "install.sh --docker --combined"
"${docker_env[@]}" sh "$REPO/scripts/install.sh" \
  --docker --combined --no-model --no-keyring --version "$TAG" --port "$GATEWAY_PORT"
[[ -f "$COMPOSE_FILE" ]] || die "no compose file at $COMPOSE_FILE"

devices_json() { "${docker_env[@]}" "$OMNESIS" devices list --json 2>/dev/null </dev/null; }
# The ids of the collector devices the gateway reports online, sorted.
online_collectors() {
  devices_json | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    const ids = JSON.parse(s).items.filter((d) => d.kind === "collector" && d.online && !d.revokedAt).map((d) => d.id);
    process.stdout.write(ids.sort().join("\n"));
  } catch {}
});'
}
wait_online() {
  local want="$1" deadline=$((SECONDS + ${2:-300}))
  while ((SECONDS < deadline)); do
    [[ "$(online_collectors | grep -c . || true)" -ge "$want" ]] && return 0
    sleep 3
  done
  return 1
}

wait_online 1 || die "the combined container's collector never came online"
CONTAINER_ID="$(online_collectors)"
CONTAINER_TOKEN="$(sha256sum "$CONFIG_DIR/collector-token" | cut -d' ' -f1)"
LAUNCHER_BEFORE="$(sha256sum "$OMNESIS" | cut -d' ' -f1)"
ok "the container's collector is online as $CONTAINER_ID"

step "a bare source remote of $SHA"
git init -q --bare "$SOURCE_REMOTE"
git --git-dir="$SOURCE_REMOTE" fetch -q --update-shallow --no-tags "$REPO" "$SHA:refs/heads/main"

step "minting a collector code with the Docker gateway"
CODE="$("${docker_env[@]}" "$OMNESIS" devices pair --kind collector --json </dev/null \
  | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d));process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).pairingCode))')"
[[ -n "$CODE" ]] || die "no pairing code was minted"
ok "minted a code"

# No --gateway-url: beside a Docker gateway on this host, the installer dials
# it at localhost and pins its own certificate.
step "install.sh --collector beside it"
"${base_env[@]}" NPM_CONFIG_CACHE="$(npm config get cache)" OMNESIS_REPO_URL="file://$SOURCE_REMOTE" \
  sh "$REPO/scripts/install.sh" --collector --commit "$SHA" --no-keyring --no-service --code "$CODE" \
  | tee "$WORK/native-install.out"

[[ "$(sha256sum "$OMNESIS" | cut -d' ' -f1)" == "$LAUNCHER_BEFORE" ]] || die "the native install changed the Docker launcher"
[[ "$(cat "$CONFIG_DIR/install-method")" == docker ]] || die "the Docker install's marker was lost"
[[ "$(sha256sum "$CONFIG_DIR/collector-token" | cut -d' ' -f1)" == "$CONTAINER_TOKEN" ]] \
  || die "the native install changed the container collector's token"
[[ -x "$NATIVE" ]] || die "no omnesis-collector command at $NATIVE"
[[ -s "$NATIVE_DIR/collector-token" ]] || die "the native collector's token is not in $NATIVE_DIR"
cmp -s "$NATIVE_DIR/collector-token" "$CONFIG_DIR/collector-token" && die "the two collectors share one token"
grep -q "omnesis-collector" "$WORK/native-install.out" || die "the banner does not name omnesis-collector"
ok "own command, own config directory, own token; the Docker install is untouched"

step "running the native collector"
GATEWAY_URL="$(sed -n 's/^  Gateway:  //p' "$WORK/native-install.out" | head -n 1)"
[[ "$GATEWAY_URL" == "https://localhost:$GATEWAY_PORT" ]] || die "the native collector dials $GATEWAY_URL, not the local gateway"
"${base_env[@]}" OMNESIS_GATEWAY_URL="$GATEWAY_URL" "$NATIVE" collector run > "$WORK/native.log" 2>&1 &
NATIVE_PID=$!
wait_online 2 || die "the native collector never came online beside the container's"
BOTH="$(online_collectors)"
[[ "$(printf '%s\n' "$BOTH" | sort -u | grep -c .)" == 2 ]] || die "expected two distinct collector devices, got: $BOTH"
printf '%s\n' "$BOTH" | grep -qx "$CONTAINER_ID" || die "the container's collector lost its device"
ok "two distinct collector devices are online"

step "restarting the gateway container"
docker compose -f "$COMPOSE_FILE" restart gateway >/dev/null
sleep 5
wait_online 2 360 || die "both collectors did not come back after the restart (online: $(online_collectors | tr '\n' ' '))"
[[ "$(online_collectors)" == "$BOTH" ]] || die "after the restart the online collectors are $(online_collectors | tr '\n' ' '), not $BOTH"
ok "both reconnected as the same two devices"

step "omnesis-collector uninstall leaves the Docker install"
"${base_env[@]}" "$NATIVE" uninstall --yes --purge
kill "$NATIVE_PID" >/dev/null 2>&1 || true
NATIVE_PID=""
[[ ! -e "$NATIVE" && ! -e "$NATIVE_DIR" ]] || die "the native collector was not removed"
[[ "$(sha256sum "$OMNESIS" | cut -d' ' -f1)" == "$LAUNCHER_BEFORE" ]] || die "uninstalling the native collector changed the Docker launcher"
"${docker_env[@]}" "$OMNESIS" tokens list >/dev/null || die "the Docker install stopped answering"
ok "the Docker install still answers"

echo
echo "docker native-beside smoke: all checks passed"
