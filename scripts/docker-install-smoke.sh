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
docker run -d --name "$REGISTRY_CONTAINER" -p "$REGISTRY_PORT:5000" registry:2 >/dev/null
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
    | grep -q "WebSocket authenticated with gateway" && break
  sleep 3
done
docker compose -f "$COMPOSE_FILE" logs collector 2>/dev/null \
  | grep -q "WebSocket authenticated with gateway" || die "the collector never authenticated"
ok "the collector paired itself and authenticated"

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
step "omnesis update to $TAG_B"
"${omnesis_env[@]}" "$OMNESIS" update --yes --target-version "$TAG_B" --health-timeout 300 \
  || die "the update to $TAG_B failed"
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

step "install.sh --docker with the supplied certificate and its CA"
"${omnesis_env[@]}" OMNESIS_CONFIG_DIR="$TLS_CONFIG_DIR" sh "$REPO/scripts/install.sh" \
  --docker --no-model --no-keyring --version "$TAG_B" --port "$TLS_PORT" \
  --tls-cert "$TLS_CONFIG_DIR/tls/gateway.crt" --tls-key "$TLS_CONFIG_DIR/tls/gateway.key" \
  --tls-ca "$TLS_CONFIG_DIR/tls/rootCA.pem"
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

for _ in $(seq 1 80); do
  docker compose -f "$TLS_COMPOSE_FILE" logs collector 2>/dev/null \
    | grep -q "WebSocket authenticated with gateway" && break
  sleep 3
done
docker compose -f "$TLS_COMPOSE_FILE" logs collector 2>/dev/null \
  | grep -q "WebSocket authenticated with gateway" || die "the collector never authenticated over the supplied certificate"
docker compose -f "$TLS_COMPOSE_FILE" logs collector 2>/dev/null | grep -q "OMNESIS_INSECURE_TLS" \
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

echo
echo "docker-install-smoke: passed"
