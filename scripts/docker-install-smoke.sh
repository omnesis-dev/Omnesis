#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# The Docker role, end to end: the REAL installer puts a gateway and a
# collector on this host as containers, and the REAL `omnesis update` moves
# them across two image tags and back again when the new gateway does not come
# back healthy.
#
#   scripts/docker-install-smoke.sh
#
# Nothing published is involved. A throwaway registry container serves three
# tags built from this checkout: the product's own version, a version above it,
# and one whose gateway never answers `/health` — which is what makes the
# revert observable rather than asserted from a unit test.
#
# Every host-wide name this script claims derives from one prefix, and the
# compose project the installer creates derives from the config directory,
# which is a fresh mktemp — so a concurrent run needs only
#   OMNESIS_DOCKER_SMOKE_PREFIX=mine scripts/docker-install-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"

PREFIX="${OMNESIS_DOCKER_SMOKE_PREFIX:-omnesis-docker-smoke}"
REGISTRY_CONTAINER="$PREFIX-registry"
WORK="$(mktemp -d "/tmp/$PREFIX-XXXXXX")"
HOME_DIR="$WORK/home"
# Deliberately not $HOME/.config/omnesis: the installer gives the default
# directory the plain compose project name `omnesis`, and this lane must not be
# able to name — or tear down — an operator's own install.
CONFIG_DIR="$WORK/config"
COMPOSE_FILE="$CONFIG_DIR/docker-compose.yml"
# A second install on this host, with a certificate the operator supplies.
TLS_CONFIG_DIR="$WORK/config-tls"
TLS_COMPOSE_FILE="$TLS_CONFIG_DIR/docker-compose.yml"
TLS_NAME="omnesis-smoke.example"
OMNESIS="$HOME_DIR/.local/bin/omnesis"
# A native collector installed beside the Docker install, from a bare remote
# of this checkout: its own command and config directory.
NATIVE="$HOME_DIR/.local/bin/omnesis-collector"
NATIVE_DIR="$HOME_DIR/.config/omnesis-collector"
SOURCE_REMOTE="$WORK/source.git"
NATIVE_PID=""

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()'
}
REGISTRY_PORT="$(free_port)"
GATEWAY_PORT="$(free_port)"
IMAGE_REPO="localhost:$REGISTRY_PORT"

BASE_VERSION="$(node -p "require('$REPO/packages/gateway/package.json').version")"
# Three tags on one line of ancestry: the version this checkout carries, the
# one an update moves to, and the one it has to come back from.
TAG_A="$BASE_VERSION"
TAG_B="$(node -e "const [a,b,c]='$BASE_VERSION'.split('.'); process.stdout.write([a,b,Number(c)+1].join('.'))")"
TAG_C="$(node -e "const [a,b,c]='$BASE_VERSION'.split('.'); process.stdout.write([a,b,Number(c)+2].join('.'))")"

SERVICES=(gateway collector updater)
declare -A TARGET=([gateway]=gateway-runtime [collector]=collector-runtime [updater]=updater)

step()   { echo; echo "==> $*"; }
ok()     { echo "  ok: $*"; }
die() {
  echo "  FAILED: $*" >&2
  # What the installation looked like when it went wrong, since the working
  # directory this run owns is removed on the way out.
  if [[ -f "$COMPOSE_FILE" ]]; then
    {
      echo "--- .env ---"; cat "$CONFIG_DIR/.env" || true
      echo "--- resolved images ---"
      docker compose -f "$COMPOSE_FILE" --profile update config --images || true
      echo "--- containers ---"
      docker compose -f "$COMPOSE_FILE" ps -a --format '{{.Name}} {{.Image}} {{.Status}}' || true
      echo "--- health ---"; curl -sk "https://localhost:$GATEWAY_PORT/health" | head -c 200 || true; echo
      echo "--- gateway log tail ---"
      docker compose -f "$COMPOSE_FILE" logs --tail 25 gateway || true
      echo "--- collector log tail ---"
      docker compose -f "$COMPOSE_FILE" logs --tail 25 collector || true
    } >&2
  fi
  [[ ! -f "$WORK/native.log" ]] || { echo "--- native collector log tail ---"; tail -n 40 "$WORK/native.log"; } >&2
  if [[ -f "$TLS_COMPOSE_FILE" ]]; then
    {
      echo "--- tls install .env ---"; cat "$TLS_CONFIG_DIR/.env" || true
      echo "--- tls gateway log tail ---"
      docker compose -f "$TLS_COMPOSE_FILE" logs --tail 25 gateway || true
      echo "--- tls collector log tail ---"
      docker compose -f "$TLS_COMPOSE_FILE" logs --tail 25 collector || true
    } >&2
  fi
  exit 1
}

cleanup() {
  local status=$?
  step "tearing down"
  [[ -z "$NATIVE_PID" ]] || kill "$NATIVE_PID" >/dev/null 2>&1 || true
  # No --remove-orphans: it acts on the whole compose project and can only
  # remove containers this run did not create.
  if [[ -f "$COMPOSE_FILE" ]]; then
    docker compose -f "$COMPOSE_FILE" --profile update down --volumes >/dev/null 2>&1 || true
  fi
  if [[ -f "$TLS_COMPOSE_FILE" ]]; then
    docker compose -f "$TLS_COMPOSE_FILE" --profile update down --volumes >/dev/null 2>&1 || true
  fi
  # The registry container is this run's; the image behind it is the host's,
  # and a concurrent run is using it.
  docker rm -f "$REGISTRY_CONTAINER" >/dev/null 2>&1 || true
  local svc tag
  for svc in "${SERVICES[@]}"; do
    for tag in "$TAG_A" "$TAG_B" "$TAG_C"; do
      docker image rm -f "$IMAGE_REPO/omnesis-$svc:$tag" >/dev/null 2>&1 || true
    done
  done
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT INT TERM

# ── the fixture registry ────────────────────────────────────────────────────

step "starting a throwaway registry on $IMAGE_REPO"
docker rm -f "$REGISTRY_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$REGISTRY_CONTAINER" -p "127.0.0.1:$REGISTRY_PORT:5000" registry:2 >/dev/null
for _ in $(seq 1 30); do
  curl -sf "http://$IMAGE_REPO/v2/" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://$IMAGE_REPO/v2/" >/dev/null || die "the fixture registry never answered"
ok "registry is serving"

step "building $TAG_A from this checkout"
for svc in "${SERVICES[@]}"; do
  docker build --target "${TARGET[$svc]}" -t "$IMAGE_REPO/omnesis-$svc:$TAG_A" "$REPO"
  docker push -q "$IMAGE_REPO/omnesis-$svc:$TAG_A"
done
ok "pushed $TAG_A"

# A release above it. The images are one cheap layer on the ones just built —
# only the version each package reports changes, which is precisely what the
# update's health wait demands before it lets the collector reconnect.
#
# Every workspace manifest is rewritten rather than a named few: the version a
# process reports is the first package.json above its own entry point, and
# which file that is belongs to the staging layout rather than to this script.
# Every @omnesis/* package carries one lockstep version anyway.
restamp() {
  local from="$1" to="$2" version="$3"
  docker build -q -t "$to" - >/dev/null <<DOCKERFILE
FROM $from
USER 0:0
RUN find /app/packages -name package.json -exec \
      sed -i 's/"version": *"[^"]*"/"version": "$version"/' {} +
USER 10001:10001
DOCKERFILE
  # A rewrite that matched nothing would leave the health wait demanding a
  # version no image reports, and the whole update would fail for a reason
  # that has nothing to do with the code under test.
  local reported
  reported="$(docker run --rm --entrypoint omnesis "$to" --version | tr -d '\r\n')"
  [[ "$reported" == "$version" ]] || die "restamped $to reports $reported, not $version"
}

step "building $TAG_B (a release above it)"
for svc in "${SERVICES[@]}"; do
  restamp "$IMAGE_REPO/omnesis-$svc:$TAG_A" "$IMAGE_REPO/omnesis-$svc:$TAG_B" "$TAG_B"
  docker push -q "$IMAGE_REPO/omnesis-$svc:$TAG_B"
done
ok "pushed $TAG_B"

step "building $TAG_C (a gateway that never serves)"
for svc in collector updater; do
  restamp "$IMAGE_REPO/omnesis-$svc:$TAG_B" "$IMAGE_REPO/omnesis-$svc:$TAG_C" "$TAG_C"
  docker push -q "$IMAGE_REPO/omnesis-$svc:$TAG_C"
done
# The container starts and stays up, so the restart succeeds and only the
# health wait fails — the arm of the rollback worth proving, because it is the
# one where the store may already have been migrated.
docker build -q -t "$IMAGE_REPO/omnesis-gateway:$TAG_C" - >/dev/null <<DOCKERFILE
FROM $IMAGE_REPO/omnesis-gateway:$TAG_B
ENTRYPOINT []
CMD ["sleep", "900"]
DOCKERFILE
docker push -q "$IMAGE_REPO/omnesis-gateway:$TAG_C"
ok "pushed $TAG_C"

# ── the install ─────────────────────────────────────────────────────────────

mkdir -p "$HOME_DIR"
# The installer reads a dozen OMNESIS_* variables, so a developer who exports
# one would change what this lane tests. Drop every one this shell carries,
# then set exactly the ones the run needs.
omnesis_env=(env)
while IFS='=' read -r name _; do
  case "$name" in OMNESIS_*) omnesis_env+=(-u "$name") ;; esac
done < <(env)
omnesis_env+=(
  HOME="$HOME_DIR"
  PATH="$PATH"
  SHELL=/bin/bash
  OMNESIS_IMAGE_REPO="$IMAGE_REPO"
  OMNESIS_GATEWAY_WAIT_SECONDS=240
  # This host never completes an OAuth flow, and the callback ports it would
  # otherwise claim are exactly the ones a developer machine or a CI runner is
  # most likely to have taken.
  OMNESIS_OAUTH_HOST_PORTS=ephemeral
  OMNESIS_CONFIG_DIR="$CONFIG_DIR"
)

step "install.sh --docker"
"${omnesis_env[@]}" sh "$REPO/scripts/install.sh" \
  --docker --no-model --no-keyring --version "$TAG_A" --port "$GATEWAY_PORT"

[[ -f "$COMPOSE_FILE" ]] || die "no compose file at $COMPOSE_FILE"
[[ "$(cat "$CONFIG_DIR/install-method")" == docker ]] || die "the install method was not recorded"
grep -q "OMNESIS_IMAGE_TAG=$TAG_A" "$CONFIG_DIR/.env" || die "the image tag was not recorded"
ok "compose file, marker and image tag are on disk"

served_version() {
  curl -sfk "https://localhost:$GATEWAY_PORT/health" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => { try { process.stdout.write(String(JSON.parse(s).version ?? "")); } catch {} });'
}

wait_served() {
  local want="$1" deadline=$((SECONDS + ${2:-240}))
  while ((SECONDS < deadline)); do
    [[ "$(served_version)" == "$want" ]] && return 0
    sleep 3
  done
  return 1
}

wait_served "$TAG_A" || die "the gateway never served $TAG_A (got '$(served_version)')"
ok "the gateway serves $TAG_A"

# The wrapper is the CLI on this host: it has to reach the corpus the gateway
# is serving, not a throwaway container with a different config directory.
"${omnesis_env[@]}" "$OMNESIS" tokens list >/dev/null || die "the CLI wrapper could not reach the gateway"
ok "the CLI wrapper runs in the gateway container"

# Generous, because the collector only starts once compose sees the gateway
# healthy, and a loaded host — three image builds just finished on this one —
# can take the gateway most of that window to boot.
for _ in $(seq 1 80); do
  docker compose -f "$COMPOSE_FILE" logs collector 2>/dev/null \
    | grep "WebSocket authenticated with gateway" >/dev/null && break
  sleep 3
done
docker compose -f "$COMPOSE_FILE" logs collector 2>/dev/null \
  | grep "WebSocket authenticated with gateway" >/dev/null || die "the collector never authenticated"
ok "the collector paired itself and authenticated"

# ── a native collector beside the Docker install ────────────────────────────

# The setup the Docker banner recommends on a Mac: the same machine runs a
# native collector for the Apple sources. Installed by the REAL installer from
# a source checkout of this revision, it has to leave the Docker launcher and
# config directory alone, hold a token of its own, and, after the gateway
# container restarts, reconnect beside the container's collector as a second,
# distinct device.
online_collectors() {
  "${omnesis_env[@]}" "$OMNESIS" devices list --json 2>/dev/null </dev/null | node -e '
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

step "a native collector beside the Docker install"
wait_online 1 || die "the gateway does not list the container's collector as online"
CONTAINER_COLLECTOR="$(online_collectors)"
container_token="$(sha256sum "$CONFIG_DIR/collector-token" | cut -d' ' -f1)"
docker_launcher="$(sha256sum "$OMNESIS" | cut -d' ' -f1)"
SHA="$(git -C "$REPO" rev-parse HEAD)"
git init -q --bare "$SOURCE_REMOTE"
git --git-dir="$SOURCE_REMOTE" fetch -q --update-shallow --no-tags "$REPO" "$SHA:refs/heads/main"
CODE="$("${omnesis_env[@]}" "$OMNESIS" devices pair --kind collector --json </dev/null \
  | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d));process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).pairingCode))')"
[[ -n "$CODE" ]] || die "the Docker gateway minted no pairing code"
# Without OMNESIS_CONFIG_DIR, and without --gateway-url: beside a Docker gateway
# on this host the installer picks its own directory and dials the gateway at
# localhost, pinning its certificate.
native_env=()
for word in "${omnesis_env[@]}"; do
  [[ "$word" == OMNESIS_CONFIG_DIR=* ]] || native_env+=("$word")
done
"${native_env[@]}" NPM_CONFIG_CACHE="$(npm config get cache)" OMNESIS_REPO_URL="file://$SOURCE_REMOTE" \
  sh "$REPO/scripts/install.sh" --collector --commit "$SHA" --no-keyring --no-service --code "$CODE" \
  > "$WORK/native-install.out" 2>&1 || { cat "$WORK/native-install.out" >&2; die "the native collector install failed"; }
cat "$WORK/native-install.out"
[[ "$(sha256sum "$OMNESIS" | cut -d' ' -f1)" == "$docker_launcher" ]] || die "the native install changed the Docker launcher"
[[ "$(cat "$CONFIG_DIR/install-method")" == docker ]] || die "the native install removed the Docker install's marker"
[[ "$(sha256sum "$CONFIG_DIR/collector-token" | cut -d' ' -f1)" == "$container_token" ]] \
  || die "the native install changed the container collector's token"
[[ -x "$NATIVE" ]] || die "no omnesis-collector command at $NATIVE"
[[ -s "$NATIVE_DIR/collector-token" ]] || die "the native collector's token is not in $NATIVE_DIR"
cmp -s "$NATIVE_DIR/collector-token" "$CONFIG_DIR/collector-token" && die "the two collectors share one token"
native_gateway="$(sed -n 's/^  Gateway:  //p' "$WORK/native-install.out" | head -n 1)"
[[ "$native_gateway" == "https://localhost:$GATEWAY_PORT" ]] || die "the native collector dials '$native_gateway', not this host's gateway"
ok "its own command, config directory and token; the Docker install is untouched"

"${native_env[@]}" OMNESIS_GATEWAY_URL="$native_gateway" "$NATIVE" collector run > "$WORK/native.log" 2>&1 &
NATIVE_PID=$!
wait_online 2 || die "the native collector never came online beside the container's"
both="$(online_collectors)"
[[ "$(printf '%s\n' "$both" | grep -c .)" == 2 ]] || die "expected two collector devices, got: $both"
printf '%s\n' "$both" | grep -qx "$CONTAINER_COLLECTOR" || die "the container's collector lost its device"
docker compose -f "$COMPOSE_FILE" restart gateway >/dev/null
sleep 5
wait_online 2 360 || die "both collectors did not come back after the gateway restarted (online: $(online_collectors | tr '\n' ' '))"
[[ "$(online_collectors)" == "$both" ]] || die "after the restart the online collectors are $(online_collectors | tr '\n' ' '), not $both"
ok "two distinct collector devices, both back online after the gateway restarted"

"${native_env[@]}" "$NATIVE" uninstall --yes --purge || die "omnesis-collector uninstall failed"
kill "$NATIVE_PID" >/dev/null 2>&1 || true
NATIVE_PID=""
[[ ! -e "$NATIVE" && ! -e "$NATIVE_DIR" ]] || die "omnesis-collector uninstall left the collector behind"
[[ "$(sha256sum "$OMNESIS" | cut -d' ' -f1)" == "$docker_launcher" ]] || die "removing the native collector changed the Docker launcher"
"${omnesis_env[@]}" "$OMNESIS" tokens list >/dev/null || die "the Docker install stopped answering"
ok "removing the native collector leaves the Docker install answering"

# ── an update killed during the pull ────────────────────────────────────────

# The footprint a kill during the pull leaves: the tag on file already names
# the target, the completion record still says the apply began from the tag
# the containers serve, and the gateway serves that older tag. The next run
# has to see through the tag rather than report "already up to date".
step "an update to $TAG_B killed during its pull, then re-run"
sed -i.bak "s/^OMNESIS_IMAGE_TAG=.*/OMNESIS_IMAGE_TAG=$TAG_B/" "$CONFIG_DIR/.env" && rm -f "$CONFIG_DIR/.env.bak"
printf '{"version":1,"method":"docker","projectDir":"%s","phase":"applying","targetTag":"%s","lastCompletedTag":"%s"}\n' \
  "$CONFIG_DIR" "$TAG_B" "$TAG_A" > "$CONFIG_DIR/update-state.json"
[[ "$(served_version)" == "$TAG_A" ]] || die "the gateway should still serve $TAG_A before the re-run"
"${omnesis_env[@]}" "$OMNESIS" update --yes --target-version "$TAG_B" --no-backup --health-timeout 300 \
  > "$WORK/rerun.out" 2>&1 || { cat "$WORK/rerun.out" >&2; die "the re-run after the killed update failed"; }
grep -q "did not finish" "$WORK/rerun.out" || die "the re-run did not recognise the unfinished update: $(cat "$WORK/rerun.out")"
grep -q "Already up to date" "$WORK/rerun.out" && die "the re-run trusted the tag on file"
wait_served "$TAG_B" 60 || die "the re-run did not bring $TAG_B up"
grep -q '"phase":"complete"' "$CONFIG_DIR/update-state.json" || die "the re-run did not record its completion"
grep -q "\"tag\":\"$TAG_B\"" "$CONFIG_DIR/update-state.json" || die "the completion record names the wrong tag"
ok "the unfinished update was detected and reapplied without --force"

# Back to $TAG_A for the update lane below, through the same command.
"${omnesis_env[@]}" "$OMNESIS" update --yes --target-version "$TAG_A" --force --no-backup --health-timeout 300 \
  || die "returning to $TAG_A failed"
wait_served "$TAG_A" 60 || die "the gateway did not return to $TAG_A"
ok "returned to $TAG_A"

# ── the update ──────────────────────────────────────────────────────────────

# The backup runs for real here: it is taken through the gateway's API from
# inside the updater container, which is the one step that proves that
# container can authenticate against the gateway beside it.
# The launcher on this host is the one part of the install no image carries,
# so an update brings it up to the release the containers land on. Left as an
# older release wrote it, a command that needs the host's help — `secure`
# restarting the containers — would run new code behind an old launcher.
step "omnesis update to $TAG_B"
expected_launcher="$(sh "$REPO/scripts/install.sh" --print-docker-launcher "$COMPOSE_FILE" gateway)"
[[ "$(cat "$OMNESIS")" == "$expected_launcher" ]] || die "the installer's launcher is not what it renders"
printf '# left by an older release\n' >> "$OMNESIS"
"${omnesis_env[@]}" "$OMNESIS" update --yes --target-version "$TAG_B" --health-timeout 300 \
  > "$WORK/update-b.out" 2>&1 || { cat "$WORK/update-b.out" >&2; die "the update to $TAG_B failed"; }
cat "$WORK/update-b.out"
[[ "$(cat "$OMNESIS")" == "$expected_launcher" ]] || die "the update did not refresh the launcher on this host"
[[ -x "$OMNESIS" ]] || die "the refreshed launcher is not executable"
grep -q "Refreshed the omnesis command at $OMNESIS" "$WORK/update-b.out" || die "the update did not say it refreshed the launcher"
ok "the update brought the host launcher up to $TAG_B's"
ls "$CONFIG_DIR"/backups/* >/dev/null 2>&1 || die "the pre-update backup was not taken"
ok "the pre-update backup was taken through the gateway API"
grep -q "OMNESIS_IMAGE_TAG=$TAG_B" "$CONFIG_DIR/.env" || die "the recorded tag did not move to $TAG_B"
wait_served "$TAG_B" 60 || die "the gateway did not come back on $TAG_B"
ok "the gateway serves $TAG_B and the recorded tag moved with it"

step "omnesis update to $TAG_C, which never serves"
if "${omnesis_env[@]}" "$OMNESIS" update --yes --target-version "$TAG_C" --no-backup \
     --health-timeout 60; then
  die "the update to a gateway that never serves was reported as a success"
fi
ok "the update failed loudly"
grep -q "OMNESIS_IMAGE_TAG=$TAG_B" "$CONFIG_DIR/.env" \
  || die "the recorded tag was left at the release that does not serve"
wait_served "$TAG_B" 120 || die "the rollback did not bring $TAG_B back"
ok "the recorded tag and the running gateway are both back on $TAG_B"

# Automatic discovery must use the container registry, even when npm has no
# matching release. Only the one-shot updater needs host networking to reach
# this fixture's loopback-only registry; the running daemons stay bridged.
step "automatic registry discovery selects $TAG_C and rolls back its failed gateway"
node - "$COMPOSE_FILE" "$GATEWAY_PORT" <<'NODE'
const fs = require('node:fs');
const [path, port] = process.argv.slice(2);
const text = fs.readFileSync(path, 'utf8');
const split = text.indexOf('  updater:\n');
if (split < 0) throw new Error('Missing updater service');
const service = text.slice(split)
  .replace('    profiles:', '    network_mode: host\n    profiles:')
  .replace('- OMNESIS_GATEWAY_URL=https://gateway:7600', `- OMNESIS_GATEWAY_URL=https://localhost:${port}`);
fs.writeFileSync(path, text.slice(0, split) + service);
NODE
if "${omnesis_env[@]}" "$OMNESIS" update --yes --no-backup --health-timeout 60 > "$WORK/automatic.out" 2>&1; then
  die "the automatically selected broken release was reported successful"
fi
grep -Fq "$TAG_B → $TAG_C" "$WORK/automatic.out" \
  || { cat "$WORK/automatic.out" >&2; die "registry discovery did not select the newest shared image tag"; }
grep -Fq "Rolled back to $TAG_B" "$WORK/automatic.out" \
  || { cat "$WORK/automatic.out" >&2; die "automatic update did not recover the prior image"; }
wait_served "$TAG_B" 120 || die "the automatic update rollback did not restore the gateway"
ok "registry-based automatic release discovery and rollback"

# ── encryption at rest, after the fact ──────────────────────────────────────

# The install above declined encryption (--no-keyring). `omnesis secure`,
# typed on this host, has to finish the job end to end: generate and record
# the passphrase the containers read, seal every secret file, restart both
# containers from the host — which no container can do to itself — and verify
# that the gateway came back with encrypted databases.
step "omnesis secure on the host encrypts the running install"
printf '{"installed":{"client_id":"fictional-smoke-client"}}\n' > "$CONFIG_DIR/example-credentials.json"
chmod 600 "$CONFIG_DIR/example-credentials.json"
[[ "$(head -c 15 "$CONFIG_DIR/omnesis.db")" == "SQLite format 3" ]] || die "the corpus should start plaintext"

"${omnesis_env[@]}" "$OMNESIS" secure --dry-run > "$WORK/secure-dry.out" 2>&1 \
  || { cat "$WORK/secure-dry.out" >&2; die "secure --dry-run failed"; }
grep -q "generate $CONFIG_DIR/keyring.pass (owner-only)" "$WORK/secure-dry.out" \
  || { cat "$WORK/secure-dry.out" >&2; die "the dry run did not plan the passphrase file"; }
grep -q "restart gateway and collector from this machine" "$WORK/secure-dry.out" \
  || { cat "$WORK/secure-dry.out" >&2; die "the dry run did not plan the host restart"; }
[[ ! -e "$CONFIG_DIR/keyring.pass" ]] || die "the dry run wrote a passphrase file"
ok "the dry run plans the passphrase file and the host restart, and writes nothing"

authenticated_before="$(docker compose -f "$COMPOSE_FILE" logs collector 2>/dev/null | grep -c "WebSocket authenticated with gateway" || true)"
# The log is public: the recovery code is a throwaway install's, but it is
# still withheld from it.
redacted() { sed -E 's/("recoveryCode": ")[^"]*"/\1<withheld>"/' "$1"; }
"${omnesis_env[@]}" "$OMNESIS" secure < /dev/null > "$WORK/secure.out" 2>&1 \
  || { redacted "$WORK/secure.out" >&2; die "omnesis secure failed"; }
redacted "$WORK/secure.out"
# Captured rather than on a terminal, the CLI answers in JSON: the wizard's
# summary, then the verification the launcher runs after its restart.
grep -q '"recoveryCode": "' "$WORK/secure.out" || die "no recovery code was printed"
grep -q "Restarting gateway collector from this machine" "$WORK/secure.out" || die "the launcher did not restart the containers"
grep -q '"verified": true' "$WORK/secure.out" || die "the restarted install was not verified"
[[ "$(stat -c '%a' "$CONFIG_DIR/keyring.pass")" == 600 ]] || die "the passphrase file is not owner-only"
grep -qx "OMNESIS_SECRET_STORE=passphrase" "$CONFIG_DIR/.env" || die "the secret store was not recorded"
grep -qx "OMNESIS_KEYRING_PASSPHRASE_FILE=$CONFIG_DIR/keyring.pass" "$CONFIG_DIR/.env" || die "the passphrase file was not recorded"
[[ "$(head -c 15 "$CONFIG_DIR/omnesis.db")" != "SQLite format 3" ]] || die "the gateway database is still plaintext"
grep -q "fictional-smoke-client" "$CONFIG_DIR/example-credentials.json" && die "the credential file is still plaintext"
[[ ! -e "$CONFIG_DIR/secure-restart" ]] || die "the restart request was left behind"
ok "passphrase recorded, secrets sealed, containers restarted, databases encrypted"

for _ in $(seq 1 80); do
  [[ "$(docker compose -f "$COMPOSE_FILE" logs collector 2>/dev/null | grep -c "WebSocket authenticated with gateway" || true)" -gt "$authenticated_before" ]] && break
  sleep 3
done
[[ "$(docker compose -f "$COMPOSE_FILE" logs collector 2>/dev/null | grep -c "WebSocket authenticated with gateway" || true)" -gt "$authenticated_before" ]] \
  || die "the restarted collector never authenticated with its sealed token"
"${omnesis_env[@]}" "$OMNESIS" tokens list >/dev/null || die "the CLI could not use the sealed admin token"
"${omnesis_env[@]}" "$OMNESIS" secure --verify >/dev/null || die "secure --verify failed on the secured install"
"${omnesis_env[@]}" "$OMNESIS" secure < /dev/null > "$WORK/secure-again.out" 2>&1 \
  || { cat "$WORK/secure-again.out" >&2; die "a second omnesis secure failed"; }
grep -q "encryption at rest is already in effect" "$WORK/secure-again.out" || die "a second run restarted the containers again"
grep -q "Restarting" "$WORK/secure-again.out" && die "a second run restarted the containers again"
ok "the collector re-authenticated, the CLI reads its sealed token, and a re-run changes nothing"

# ── a certificate the operator supplies ─────────────────────────────────────

# The second topology this lane proves: a certificate issued on the host,
# chained to a private CA, served by the gateway container and verified — name
# and chain, no bypass — by the collector container on the compose network and
# by a client on the host. Then the certificate is replaced in place and the
# running gateway serves the replacement without a restart.
step "issuing a fixture CA and a certificate for $TLS_NAME"
echo "  $(docker --version); $(openssl version)"
TLS_PORT="$(free_port)"
mkdir -p "$TLS_CONFIG_DIR/tls"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=omnesis smoke CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" \
  -keyout "$WORK/ca.key" -out "$TLS_CONFIG_DIR/tls/rootCA.pem" 2>/dev/null
issue_leaf() {
  # $1: output prefix. Every leaf covers the name the collector dials, and
  # localhost for a client on the host that dials that way.
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$TLS_NAME" \
    -addext "subjectAltName=DNS:$TLS_NAME,DNS:localhost" \
    -keyout "$1.key" -out "$1.csr" 2>/dev/null
  openssl x509 -req -in "$1.csr" -CA "$TLS_CONFIG_DIR/tls/rootCA.pem" -CAkey "$WORK/ca.key" \
    -CAcreateserial -days 2 -copy_extensions copy -out "$1.crt" 2>/dev/null
}
issue_leaf "$WORK/leaf-1"
cp "$WORK/leaf-1.crt" "$TLS_CONFIG_DIR/tls/gateway.crt"
cp "$WORK/leaf-1.key" "$TLS_CONFIG_DIR/tls/gateway.key"
leaf_fingerprint() {
  openssl x509 -in "$1" -noout -fingerprint -sha256 | sed 's/^.*=//; s/://g' | tr 'A-F' 'a-f'
}
served_fingerprint() {
  openssl s_client -connect "127.0.0.1:$TLS_PORT" -servername "$TLS_NAME" </dev/null 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//; s/://g' | tr 'A-F' 'a-f'
}
ok "issued leaf $(leaf_fingerprint "$WORK/leaf-1.crt")"

step "install.sh --docker refuses a certificate the containers could not see"
if "${omnesis_env[@]}" OMNESIS_CONFIG_DIR="$TLS_CONFIG_DIR" sh "$REPO/scripts/install.sh" \
     --docker --no-model --no-keyring --version "$TAG_B" --port "$TLS_PORT" \
     --tls-cert "$WORK/leaf-1.crt" --tls-key "$TLS_CONFIG_DIR/tls/gateway.key" 2>"$WORK/refusal.err"; then
  die "a certificate outside the config directory was accepted"
fi
grep -q "is outside $TLS_CONFIG_DIR" "$WORK/refusal.err" || die "the refusal did not say why: $(cat "$WORK/refusal.err")"
[[ ! -f "$TLS_COMPOSE_FILE" ]] || die "the refused run wrote a compose file"
ok "refused, and wrote nothing"

step "install.sh --docker with the supplied certificate and its CA, on a terminal"
# On a terminal the closing banner carries a one-time portal login code, which
# the host wrapper mints in the gateway container. The output is kept in the
# scratch directory and never echoed: the code is a credential until used.
TLS_INSTALL_COMMAND="$(printf '%q ' "${omnesis_env[@]}" OMNESIS_CONFIG_DIR="$TLS_CONFIG_DIR" sh "$REPO/scripts/install.sh" \
  --docker --no-model --no-keyring --version "$TAG_B" --port "$TLS_PORT" \
  --tls-cert "$TLS_CONFIG_DIR/tls/gateway.crt" --tls-key "$TLS_CONFIG_DIR/tls/gateway.key" \
  --tls-ca "$TLS_CONFIG_DIR/tls/rootCA.pem")"
script -qec "$TLS_INSTALL_COMMAND" /dev/null </dev/null >"$WORK/tls-install.out" 2>&1 \
  || die "the install on a terminal failed: $(grep -v 'token=' "$WORK/tls-install.out" | tail -n 20)"
grep -q "OMNESIS_TLS_CERT=$TLS_CONFIG_DIR/tls/gateway.crt" "$TLS_CONFIG_DIR/.env" || die "the certificate was not recorded"
grep -q "OMNESIS_GATEWAY_URL=https://$TLS_NAME:7600" "$TLS_CONFIG_DIR/.env" || die "the gateway URL was not recorded"
grep -q "OMNESIS_GATEWAY_URL=https://$TLS_NAME:7600" "$TLS_COMPOSE_FILE" || die "the collector does not dial the certificate's name"
grep -q -- "- $TLS_NAME" "$TLS_COMPOSE_FILE" || die "the gateway does not answer to the certificate's name"
ok "compose file dials https://$TLS_NAME:7600 through the gateway's alias"

# The host client: chain verified against the fixture CA, name verified
# against the certificate, no -k anywhere.
tls_health() {
  curl -sf --cacert "$TLS_CONFIG_DIR/tls/rootCA.pem" --resolve "$TLS_NAME:$TLS_PORT:127.0.0.1" \
    "https://$TLS_NAME:$TLS_PORT/health" >/dev/null
}
for _ in $(seq 1 80); do
  tls_health && break
  sleep 3
done
tls_health || die "the gateway never answered with a certificate the fixture CA verifies for $TLS_NAME"
[[ "$(served_fingerprint)" == "$(leaf_fingerprint "$WORK/leaf-1.crt")" ]] \
  || die "the gateway serves $(served_fingerprint), not the supplied certificate"
ok "a host client verifies the chain and the name without any bypass"

# The link signs a browser in once: the code redeems through the portal's own
# login, and is refused the second time.
PORTAL_CODE="$(grep -o 'portal/?token=[0-9A-Fa-f]\{10\}' "$WORK/tls-install.out" | head -n 1 | sed 's/^.*=//')"
[[ -n "$PORTAL_CODE" ]] || die "the banner on a terminal carried no portal login link"
grep -q "signs you in once" "$WORK/tls-install.out" || die "the banner did not say the link works once"
portal_login() {
  curl -s -o /dev/null -w '%{http_code}' --cacert "$TLS_CONFIG_DIR/tls/rootCA.pem" \
    --resolve "$TLS_NAME:$TLS_PORT:127.0.0.1" -H 'Content-Type: application/json' \
    --data "{\"token\":\"$PORTAL_CODE\"}" "https://$TLS_NAME:$TLS_PORT/portal/api/login"
}
[[ "$(portal_login)" == 200 ]] || die "the portal did not accept the one-time code from the banner"
[[ "$(portal_login)" == 401 ]] || die "the portal accepted the banner's code a second time"
ok "the banner's portal link signs in once, then is spent"

for _ in $(seq 1 80); do
  docker compose -f "$TLS_COMPOSE_FILE" logs collector 2>/dev/null \
    | grep "WebSocket authenticated with gateway" >/dev/null && break
  sleep 3
done
docker compose -f "$TLS_COMPOSE_FILE" logs collector 2>/dev/null \
  | grep "WebSocket authenticated with gateway" >/dev/null || die "the collector never authenticated over the supplied certificate"
docker compose -f "$TLS_COMPOSE_FILE" logs collector 2>/dev/null | grep "OMNESIS_INSECURE_TLS" >/dev/null \
  && die "the collector connected with verification off"
ok "the collector container dialled https://$TLS_NAME:7600 and verified it"

# The wrapper runs the CLI in the gateway container, which reads the same
# .env and trusts the CA the compose file names.
TLS_STATUS="$("${omnesis_env[@]}" "$OMNESIS" tls status --json)" || die "omnesis tls status failed in the container"
node -e '
const s = JSON.parse(process.argv[1]);
if (s.ownership !== "external") throw new Error(`ownership ${s.ownership}`);
if (s.served.fingerprintSha256 !== process.argv[2]) throw new Error(`served ${s.served.fingerprintSha256}`);
if (s.renewal.mode !== "external") throw new Error(`renewal ${s.renewal.mode}`);
' "$TLS_STATUS" "$(leaf_fingerprint "$WORK/leaf-1.crt")" || die "tls status did not describe the supplied certificate: $TLS_STATUS"
ok "omnesis tls status reports the supplied certificate as operator-managed"

step "replacing the certificate in place and reloading the running gateway"
GATEWAY_CONTAINER="$(docker compose -f "$TLS_COMPOSE_FILE" ps -q gateway)"
STARTED_BEFORE="$(docker inspect --format '{{.State.StartedAt}}' "$GATEWAY_CONTAINER")"
issue_leaf "$WORK/leaf-2"
# Written the way a renewal tool writes: a temporary file, then a rename.
cp "$WORK/leaf-2.key" "$TLS_CONFIG_DIR/tls/gateway.key.new" && mv "$TLS_CONFIG_DIR/tls/gateway.key.new" "$TLS_CONFIG_DIR/tls/gateway.key"
cp "$WORK/leaf-2.crt" "$TLS_CONFIG_DIR/tls/gateway.crt.new" && mv "$TLS_CONFIG_DIR/tls/gateway.crt.new" "$TLS_CONFIG_DIR/tls/gateway.crt"
"${omnesis_env[@]}" "$OMNESIS" tls reload >/dev/null || die "omnesis tls reload failed"
[[ "$(served_fingerprint)" == "$(leaf_fingerprint "$WORK/leaf-2.crt")" ]] \
  || die "after reload the gateway serves $(served_fingerprint), not the replacement"
[[ "$(docker inspect --format '{{.State.StartedAt}}' "$GATEWAY_CONTAINER")" == "$STARTED_BEFORE" ]] \
  || die "the gateway container was restarted to activate the replacement"
tls_health || die "the host client no longer verifies the gateway after the replacement"
ok "the replacement is served by the same container, verified end to end"

echo
echo "images under test:"
docker compose -f "$TLS_COMPOSE_FILE" --profile update config --images | while read -r image; do
  echo "  $image $(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || echo '(id unavailable)')"
done

step "omnesis uninstall --purge removes the second install from this host"
# The first install shares these images; take its containers down first so
# the second install's `--rmi all` is not refused an image still in use.
docker compose -f "$COMPOSE_FILE" --profile update down >/dev/null 2>&1 || true
TLS_IMAGES="$(docker compose -f "$TLS_COMPOSE_FILE" --profile update config --images)"
TLS_PROJECT="$(docker compose -f "$TLS_COMPOSE_FILE" config --format json | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).name)')"
"${omnesis_env[@]}" "$OMNESIS" uninstall --dry-run >/dev/null || die "omnesis uninstall --dry-run failed"
[[ -f "$TLS_COMPOSE_FILE" && -x "$OMNESIS" ]] || die "the dry run changed something"
"${omnesis_env[@]}" "$OMNESIS" uninstall --yes --purge || die "omnesis uninstall --purge failed"
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$TLS_PROJECT")" ]] \
  || die "containers of $TLS_PROJECT are still there after the uninstall"
while read -r image; do
  [[ -z "$image" ]] && continue
  docker image inspect "$image" >/dev/null 2>&1 && die "$image is still on this host after the uninstall"
done <<<"$TLS_IMAGES"
[[ ! -e "$TLS_CONFIG_DIR" ]] || die "$TLS_CONFIG_DIR is still there after --purge"
[[ ! -e "$OMNESIS" ]] || die "the launcher $OMNESIS is still there"
if [[ -f "$HOME_DIR/.bashrc" ]] && grep -qxF "# Added by the Omnesis installer" "$HOME_DIR/.bashrc"; then
  die "the installer's PATH line is still in $HOME_DIR/.bashrc"
fi
ok "the containers, images, config directory, launcher and PATH line are gone"

echo
echo "docker-install-smoke: passed"
