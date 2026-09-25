#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# Host-side helpers for the container topology lane. Unlike the security E2E
# scenarios, which each run INSIDE one container, these run on the host and
# drive two containers that stand in for two machines, so a scenario can watch
# one host react to something done on the other.
set -euo pipefail

# Every host-wide name this lane claims — the network, the three containers
# and the directory the fixture repositories are published to — derives from
# one prefix. Two lanes running at once on the same machine would otherwise
# share a bind-mounted fixture directory, and the second one rebuilding it
# replaces the repositories out from under the first one's git daemon: the
# containers keep running and every clone starts failing. `OMNESIS_TOPO_PREFIX`
# gives a run its own set.
TOPO_PREFIX="${OMNESIS_TOPO_PREFIX:-omnesis-topo}"
NET="$TOPO_PREFIX"
GW="$TOPO_PREFIX-gateway"
COL="$TOPO_PREFIX-collector"
GIT="$TOPO_PREFIX-git"
# The image is content-addressed by the Dockerfile and the repository, so
# concurrent runs may share it; override it too when they must not.
IMAGE="${OMNESIS_TOPO_IMAGE:-omnesis-topology-host}"
# The gateway's auto-generated certificate carries `DNS:gateway`, so the
# collector can verify the name it dials. That SAN is why these containers
# take network aliases rather than being addressed by container name.
GATEWAY_URL="https://gateway:7600"
FIXTURE_URL="git://gitsrv/omnesis.git"
FIXTURE_BROKEN_URL="git://gitsrv/omnesis-broken.git"
# Where the installer clones to on a host, as a literal for `bash -lc` to
# expand inside the container.
CHECKOUT='~/omnesis'


REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_DIR="${OMNESIS_TOPO_FIXTURES:-/tmp/$TOPO_PREFIX-fixtures}"

# ── assertions ──────────────────────────────────────────────────────────────

assert() {
  local msg="$1"; shift
  if "$@"; then echo "  ok: $msg"; else echo "  FAILED: $msg" >&2; exit 1; fi
}

assert_eq() {
  local msg="$1" want="$2" got="$3"
  if [[ "$want" == "$got" ]]; then
    echo "  ok: $msg ($got)"
  else
    echo "  FAILED: $msg — wanted '$want', got '$got'" >&2
    exit 1
  fi
}

assert_contains() {
  local msg="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  ok: $msg"
  else
    echo "  FAILED: $msg — '$needle' not found in:" >&2
    echo "$haystack" >&2
    exit 1
  fi
}

assert_not_contains() {
  local msg="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "  ok: $msg"
  else
    echo "  FAILED: $msg — '$needle' was not supposed to appear in:" >&2
    echo "$haystack" >&2
    exit 1
  fi
}

# ── running commands on a host ──────────────────────────────────────────────

# on <gateway|collector> <shell snippet> — runs as the unprivileged account,
# through a login shell so the installer's PATH advice is exercised the way a
# real operator would experience it.
on() {
  local host="$1"; shift
  local container
  container="$(container_for "$host")"
  docker exec -u omnesis -w /home/omnesis "$container" bash -lc "$*"
}

# Same, detached: for the daemons, which never return.
on_detached() {
  local host="$1"; shift
  local container
  container="$(container_for "$host")"
  docker exec -d -u omnesis -w /home/omnesis "$container" bash -lc "$*"
}

container_for() {
  case "$1" in
    gateway) echo "$GW" ;;
    collector) echo "$COL" ;;
    *) echo "unknown topology host: $1" >&2; return 1 ;;
  esac
}

# ── the topology ────────────────────────────────────────────────────────────

topo_down() {
  docker rm -f "$GW" "$COL" "$GIT" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

topo_up() {
  topo_down
  docker network create "$NET" >/dev/null

  # The fixture release server. It serves the bare repositories read-only over
  # the git protocol, which is all the installer and the updater need.
  # Root inside the container, so serving is never blocked by whatever uid
  # owns the fixture files on the host; `safe.directory` because git refuses
  # to operate on a repository owned by another user without being told.
  docker run -d --name "$GIT" --network "$NET" --network-alias gitsrv \
    --user 0:0 \
    -v "$FIXTURE_DIR:/srv:ro" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    --entrypoint git "$IMAGE" \
    daemon --base-path=/srv --export-all --reuseaddr --listen=0.0.0.0 --port=9418 \
    >/dev/null

  # Two machines, carrying nothing of Omnesis: the installer is expected to
  # put the rest there itself.
  # `tsc --build` across the whole workspace needs more than the ~2 GB heap
  # Node sizes itself to inside a memory-limited container, and the installer
  # builds from source on every host. See the heap-limit issue tracked against
  # the installer: until it sets this itself, the lane has to.
  local common=(--network "$NET" --memory "${OMNESIS_TOPO_MEMORY:-10g}"
    --cpus "${OMNESIS_TOPO_CPUS:-4}"
    -e OMNESIS_LLAMA_GPU=false -e OMNESIS_LOG_LEVEL=info
    -e NODE_OPTIONS=--max-old-space-size=6144
    -e "OMNESIS_REPO_URL=$FIXTURE_URL")

  docker run -d --name "$GW" --hostname gateway --network-alias gateway \
    "${common[@]}" "$IMAGE" sleep infinity >/dev/null
  docker run -d --name "$COL" --hostname collector --network-alias collector \
    "${common[@]}" "$IMAGE" sleep infinity >/dev/null

  # The installer under test is copied in rather than mounted: a developer
  # umask of 077 would make a bind-mounted script unreadable to the container
  # account, and the lane would fail for a reason that has nothing to do with
  # the code under test.
  local c
  for c in "$GW" "$COL"; do
    docker cp "$REPO_ROOT/scripts/install.sh" "$c:/opt/install.sh" >/dev/null
    docker exec --user 0:0 "$c" chmod 0755 /opt/install.sh
  done

  # git daemon needs a moment before the first clone.
  local deadline=$((SECONDS + 30))
  while ((SECONDS < deadline)); do
    if on gateway "git ls-remote --tags $FIXTURE_URL >/dev/null 2>&1"; then return 0; fi
    sleep 1
  done
  echo "fixture git daemon never answered" >&2
  docker logs "$GIT" 2>&1 | tail -20 >&2
  return 1
}

# ── the installer under test ────────────────────────────────────────────────

# install_on <host> <extra installer flags...>
#
# TLS, the keyring and the embedding model are switched off deliberately: the
# security E2E lane already drills those against a real keyring, and this lane
# is about roles, pairing and updates. Services are switched off because a
# container has no user service manager; the native supervisors are smoke
# tested on the self-hosted runners instead.
install_on() {
  local host="$1"; shift
  on "$host" "sh /opt/install.sh --no-service --no-model --no-tls --no-keyring $*"
}

# The installed product version, as the CLI itself reports it. `--version`
# also best-effort probes a gateway and warns on skew, so only stdout's first
# semver token is the answer.
installed_version() {
  on "$1" '~/.local/bin/omnesis --version 2>/dev/null | grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1 | tr -d "\r\n"'
}

# ── daemons ─────────────────────────────────────────────────────────────────

# The daemons run IN-PROCESS under the CLI entry point: `omnesis gateway
# serve` imports the gateway rather than spawning it, so no process command
# line ever mentions the gateway's own entry file. Killing them by that name
# silently matches nothing and leaves the old build serving. Record the pid
# instead, and signal the whole process group `setsid` created (npm/tsx/node
# worker threads all hang off it).
start_gateway() {
  on_detached gateway 'setsid ~/.local/bin/omnesis gateway serve >~/gateway.log 2>&1 </dev/null & echo $! >~/gateway.pid'
}

stop_gateway() {
  on gateway 'pid="$(cat ~/gateway.pid 2>/dev/null || true)"; [ -n "$pid" ] && { kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null; }; true'
  local deadline=$((SECONDS + 45))
  while ((SECONDS < deadline)); do
    if ! on gateway 'curl -ksf https://localhost:7600/health >/dev/null 2>&1'; then
      on gateway 'rm -f ~/gateway.pid'
      return 0
    fi
    sleep 1
  done
  on gateway 'pid="$(cat ~/gateway.pid 2>/dev/null || true)"; [ -n "$pid" ] && kill -KILL -"$pid" 2>/dev/null; true'
  sleep 2
  if on gateway 'curl -ksf https://localhost:7600/health >/dev/null 2>&1'; then
    echo "the gateway would not stop; the port is still answering" >&2
    return 1
  fi
  on gateway 'rm -f ~/gateway.pid'
}

start_collector() {
  on_detached collector \
    "setsid env OMNESIS_GATEWAY_URL=$GATEWAY_URL ~/.local/bin/omnesis collector run >~/collector.log 2>&1 </dev/null & echo \$! >~/collector.pid"
}

stop_collector() {
  on collector 'pid="$(cat ~/collector.pid 2>/dev/null || true)"; [ -n "$pid" ] && { kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null; }; rm -f ~/collector.pid; true'
}

wait_gateway_health() {
  local deadline=$((SECONDS + ${1:-180}))
  while ((SECONDS < deadline)); do
    if on gateway 'curl -ksf https://localhost:7600/health >/dev/null 2>&1'; then return 0; fi
    sleep 2
  done
  echo "gateway did not become healthy in time" >&2
  on gateway 'tail -40 ~/gateway.log' >&2 || true
  return 1
}

gateway_health_json() {
  on gateway 'curl -ksf https://localhost:7600/health'
}

# The gateway's certificate fingerprint, so the collector can verify rather
# than trust on first sight — the same value the installer's role modes are
# meant to print for an operator to paste.
gateway_fingerprint() {
  on gateway "openssl x509 -in ~/.config/omnesis/tls/cert.pem -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1 | tr -d '\r\n'"
}

# Wait for the collector daemon to finish authenticating its socket.
#
# Waiting on the gateway's device list is NOT a reconnection signal: after the
# first pairing the row is already there, so a list check returns instantly and
# races the daemon it is meant to be waiting for. The collector's own log is
# the only place that says the socket came up, and it is truncated on every
# start, so anything found in it belongs to this run.
wait_collector_connected() {
  local deadline=$((SECONDS + ${1:-120}))
  while ((SECONDS < deadline)); do
    if on collector 'grep -aq "WebSocket authenticated with gateway" ~/collector.log'; then
      return 0
    fi
    sleep 2
  done
  echo "the collector never authenticated its socket" >&2
  on collector 'tail -40 ~/collector.log' >&2 || true
  return 1
}

# Wait for a device of the given name to hold a live connection.
#
# The row exists from the moment the device first paired, so matching the name
# alone answers instantly and says nothing about the socket. What this waits
# for is the LIVE column on that row — the gateway reporting a socket it can
# send a command on.
wait_device_online() {
  local name="$1" deadline=$((SECONDS + ${2:-120}))
  while ((SECONDS < deadline)); do
    if on gateway "~/.local/bin/omnesis devices list 2>/dev/null | grep '$name' | grep -qw yes"; then
      return 0
    fi
    sleep 2
  done
  echo "device '$name' never appeared in the gateway's device list" >&2
  on gateway '~/.local/bin/omnesis devices list' >&2 || true
  on collector 'tail -40 ~/collector.log' >&2 || true
  return 1
}

# Wait for the gateway's cached device inventory to reflect a collector hello.
# Socket authentication happens before the device-version writer and its cache
# refresh complete, so a devices-list read immediately after authentication can
# still report the previous build for a short time.
wait_device_version() {
  local name="$1" expected="$2" deadline=$((SECONDS + ${3:-60}))
  local row=""
  while ((SECONDS < deadline)); do
    row="$(on gateway "~/.local/bin/omnesis devices list 2>/dev/null | grep '$name' || true")"
    if [[ "$row" == *"$expected"* ]]; then
      return 0
    fi
    sleep 2
  done
  echo "device '$name' never reported version '$expected'" >&2
  printf '%s\n' "$row" >&2
  on collector 'tail -40 ~/collector.log' >&2 || true
  return 1
}
