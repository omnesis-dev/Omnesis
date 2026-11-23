#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# Docker for the D2 lane: Colima on a hosted Intel Mac.
#
#   E2E_WORK=<scratch dir> scripts/install-e2e/colima-up.sh install|start
#
# install: pinned release binaries, each checked against its SHA-256: the
#   Docker CLI in /usr/local/bin (where Homebrew links it on an Intel Mac),
#   the Compose plugin in ~/.docker/cli-plugins, Lima under /usr/local, and
#   Colima. Homebrew builds no bottles for Intel Macs any more, so installing
#   these from it compiles Go, the Docker CLI, Compose and Buildx from source:
#   about fifteen minutes with every core busy, before the VM even starts.
#
# start: starts Colima's VM with one CPU and 4 GiB less than the Mac has, so
#   the four virtual CPUs of a VM sized to the whole machine do not leave
#   macOS, the hypervisor's own threads and the Actions runner without a core.
#   Colima's first start provisions Docker and then restarts the VM, and Lima
#   gives each boot ten minutes. A start that fails prints why (Colima's
#   status, the host agent's log and the VM's serial console), deletes the
#   instance and starts once more; a second failure ends the lane. Then it
#   waits for Docker to answer through Colima's socket, and says whether the
#   host's resolver configuration changed while Colima started.
#
# Runs on a disposable CI machine: it installs into /usr/local with sudo and
# starts a VM. Do not run it on a machine you use.
set -euo pipefail

E2E_WORK="${E2E_WORK:?set E2E_WORK}"
# shellcheck source=scripts/install-e2e/lib.sh
. "$(dirname "$0")/lib.sh"

[ -n "${CI:-}" ] || die "colima-up.sh installs into /usr/local and starts a VM; it runs on CI machines only"
# Hosted Apple Silicon runners have no nested virtualization; Colima's VM
# starts only on the Intel ones.
[ "$(uname -m)" = x86_64 ] || die "colima-up.sh needs an Intel Mac (nested virtualization); this one is $(uname -m)"

DOCKER_VERSION=29.10.0
DOCKER_SHA256=18fd600a2fc0bc2e62f34f66b0fd717dc2a774aa533bf3cef98011b9d37e0459
COMPOSE_VERSION=5.8.0
COMPOSE_SHA256=5c41cd573c549dc66abb03c5b29d6d4dfaae206b2e79848d1c32482bb2a3b416
LIMA_VERSION=2.3.0
LIMA_SHA256=d58bc7d6b8158d638720d8c8fdb17eb58527dfead6a29a5b60f48a35ee4a65a6
COLIMA_VERSION=0.10.3
COLIMA_SHA256=3082737fe8a98afda11cba7d9a20b6e56fe80c6153464beda04bec630758770b

START_ATTEMPTS=2

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else sha256sum "$1"; fi | awk '{ print $1 }'
}

# fetch <url> <sha256> <file>: download, and refuse anything but the pinned bytes.
fetch() {
  local got
  curl -fsSL --retry 4 --retry-delay 5 --retry-all-errors -o "$3" "$1" || die "could not download $1"
  got="$(sha256_of "$3")"
  [ "$got" = "$2" ] || die "$1 has SHA-256 $got, expected $2"
}

install_tools() {
  local dl="$E2E_WORK/colima-downloads"
  mkdir -p "$dl"
  group "Download Docker $DOCKER_VERSION, Compose $COMPOSE_VERSION, Lima $LIMA_VERSION and Colima $COLIMA_VERSION"
  fetch "https://download.docker.com/mac/static/stable/x86_64/docker-$DOCKER_VERSION.tgz" "$DOCKER_SHA256" "$dl/docker.tgz"
  fetch "https://github.com/docker/compose/releases/download/v$COMPOSE_VERSION/docker-compose-darwin-x86_64" \
    "$COMPOSE_SHA256" "$dl/docker-compose"
  fetch "https://github.com/lima-vm/lima/releases/download/v$LIMA_VERSION/lima-$LIMA_VERSION-Darwin-x86_64.tar.gz" \
    "$LIMA_SHA256" "$dl/lima.tar.gz"
  fetch "https://github.com/abiosoft/colima/releases/download/v$COLIMA_VERSION/colima-Darwin-x86_64" \
    "$COLIMA_SHA256" "$dl/colima"
  endgroup

  group "Install them"
  tar -xzf "$dl/docker.tgz" -C "$dl"
  sudo mkdir -p /usr/local/bin
  sudo install -m 0755 "$dl/docker/docker" /usr/local/bin/docker
  mkdir -p "$HOME/.docker/cli-plugins"
  install -m 0755 "$dl/docker-compose" "$HOME/.docker/cli-plugins/docker-compose"
  sudo tar -C /usr/local -xzf "$dl/lima.tar.gz"
  sudo install -m 0755 "$dl/colima" /usr/local/bin/colima
  docker --version
  docker compose version
  limactl --version
  colima version
  endgroup
}

# What a failed start leaves behind, for the next reader of the log.
colima_diagnostics() {
  local dir="$HOME/.colima/_lima/colima" file
  group "Colima after a failed start"
  {
    colima status || true
    limactl list || true
    for file in "$dir/ha.stderr.log" "$dir"/serial*.log; do
      [ -f "$file" ] || continue
      printf -- '--- the last lines of %s\n' "${file##*/}"
      tail -n 80 "$file"
    done
  } 2>&1 | redact
  endgroup
}

start_colima() {
  local cpus mem_gib attempt=1 answered=0
  cpus=$(($(sysctl -n hw.ncpu) - 1))
  [ "$cpus" -ge 2 ] || cpus=2
  mem_gib=$(($(sysctl -n hw.memsize) / 1073741824 - 4))
  [ "$mem_gib" -ge 4 ] || mem_gib=4
  local args=(--runtime docker --arch x86_64 --vm-type vz --mount-type virtiofs --cpus "$cpus" --memory "$mem_gib")

  resolver_config >"$RESOLVER_BEFORE_COLIMA"
  while :; do
    group "Start Colima, attempt $attempt of $START_ATTEMPTS: ${args[*]}"
    if colima start "${args[@]}"; then
      endgroup
      break
    fi
    endgroup
    colima_diagnostics
    [ "$attempt" -lt "$START_ATTEMPTS" ] || die "Colima's VM failed to start in $START_ATTEMPTS attempts; what it left is printed above"
    log "Colima's VM failed to start; deleting the instance and starting it once more"
    colima delete --force --data || true
    attempt=$((attempt + 1))
  done

  # `colima start` returns once the VM's Docker is up; its socket can take a
  # moment longer to reach the host.
  for _ in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      answered=1
      break
    fi
    sleep 2
  done
  if [ "$answered" != 1 ]; then
    colima_diagnostics
    die "Colima started, but Docker does not answer through its socket"
  fi
  log "Docker answers through Colima (context $(docker context show), ${cpus} CPUs, ${mem_gib} GiB)"
  report_resolver_change
}

# Whether starting Colima changed the host's resolver configuration, which the
# installer's registry lookups on this host go through.
report_resolver_change() {
  if resolver_config | diff -u "$RESOLVER_BEFORE_COLIMA" - >"$E2E_WORK/resolver-diff"; then
    log "the host's resolver configuration is as it was before Colima started"
  else
    group "Colima changed the host's resolver configuration"
    redact <"$E2E_WORK/resolver-diff"
    endgroup
  fi
  group "Listening on port 53 with Colima up"
  port_53_listeners | redact
  endgroup
}

case "${1:-}" in
  install) install_tools ;;
  start) start_colima ;;
  *) die "usage: colima-up.sh install|start" ;;
esac
