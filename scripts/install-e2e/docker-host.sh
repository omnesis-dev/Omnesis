#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# Single-host Docker journey, on the host's real Docker daemon.
#
#   E2E_WORK=<scratch dir> scripts/install-e2e/docker-host.sh linux|mac
#
# Both scenarios run this checkout's installer and Docker launcher as an
# account with a group-writable umask (Ubuntu's 002), then:
#   1. install the newest published release's images (--docker --combined);
#   2. capture a note and read the collector's device id;
#   3. re-run the installer: on linux with --build, so the images become this
#      checkout's (the upgrade a re-run makes); on mac over the published ones;
#   4. check what the run must leave: a healthy gateway, the note and the same
#      device, the one-line keyring report, owner-only files, and a doctor
#      whose permission check passes (twice: every command rewrites the
#      launcher's host records) and that reads the Docker host's disk;
#   5. back up, then `backup list` lists without backing up, and a word the
#      command does not take is refused;
#   6. linux only: a sudo install beside this one is refused before it writes
#      anything, and this install keeps serving;
#   7. uninstall: no container of the project is left, the data stays;
#   8. linux only: a fresh sudo install runs its daemons as the account the
#      installer gives them, owns its host records to it, and passes the
#      doctor's permission check; then it is uninstalled.
#
# Runs on a disposable CI machine: it installs into $HOME (and /root) and
# drives the machine's Docker daemon. Do not run it on a machine you use.
set -euo pipefail

E2E_WORK="${E2E_WORK:?set E2E_WORK}"
# shellcheck source=scripts/install-e2e/lib.sh
. "$(dirname "$0")/lib.sh"

[ -n "${CI:-}" ] || die "docker-host.sh installs into \$HOME and drives the Docker daemon; it runs on CI machines only"
SCENARIO="${1:-}"
case "$SCENARIO" in linux | mac) ;; *) die "usage: docker-host.sh linux|mac" ;; esac

umask 002
COMMON=(--docker --combined --no-tls --no-model)
INSTALL_LOG="$E2E_WORK/install.log"

installer() {
  set +e
  sh "$E2E_ROOT/scripts/install.sh" "${COMMON[@]}" "$@" </dev/null 2>&1 | redact | tee "$INSTALL_LOG"
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

mode_of() {
  if [ "$(uname -s)" = Darwin ]; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi
}

expect_mode() {
  local want="$1" path
  shift
  for path in "$@"; do
    [ -e "$path" ] || die "$path is missing"
    [ "$(mode_of "$path")" = "$want" ] || die "$path is mode $(mode_of "$path"), expected $want"
  done
}

serving() {
  local attempt
  for attempt in $(seq 1 24); do
    "$OMNESIS" status --json >/dev/null 2>&1 && return 0
    sleep 5
  done
  die "the gateway does not answer omnesis status"
}

check_of() { json_get "$1" 'j.checks.find((c) => c.id === a)' "$2" 2>/dev/null || true; }

# The doctor's verdicts this journey owns; the rest (no embedding model,
# no sources) are the install's choices.
check_doctor() {
  local file="$E2E_WORK/doctor-$1.json" check
  doctor_json "$file"
  check="$(check_of "$file" security.permissions)"
  [ -n "$check" ] || die "the doctor reported no security.permissions check"
  [ "$(json_get "$file" 'j.checks.find((c) => c.id === a).status' security.permissions)" = pass ] ||
    die "doctor security.permissions: $(json_get "$file" 'j.checks.find((c) => c.id === a).message' security.permissions)"
  json_get "$file" 'j.checks.find((c) => c.id === a).message' security.full-disk-encryption | grep -q "On the Docker host" ||
    die "doctor security.full-disk-encryption does not read the Docker host's disk: $(json_get "$file" 'j.checks.find((c) => c.id === a).message' security.full-disk-encryption || echo absent)"
  if json_get "$file" 'j.checks.filter((c) => c.id === a && c.status !== "pass").map((c) => c.message).join(" ")' security.service-hardening | grep -qi "service unit"; then
    die "doctor warns about service units on a Docker install"
  fi
  log "doctor ($1): permissions pass, disk read on the Docker host"
}

collector_id() {
  "$OMNESIS" devices list --json >"$E2E_WORK/devices.json" 2>/dev/null || die "omnesis devices list failed"
  json_get "$E2E_WORK/devices.json" '(Array.isArray(j) ? j : j.items ?? j.devices).filter((d) => d.kind === "collector").map((d) => d.id).sort().join(",")'
}

NOTE_TEXT="ci docker lantern note"
note_present() {
  "$OMNESIS" note --list --day "$NOTE_DAY" --json >"$E2E_WORK/notes.json" 2>/dev/null || return 1
  [ "$(json_get "$E2E_WORK/notes.json" 'JSON.stringify(j).includes(a)' "$NOTE_TEXT")" = true ]
}

backup_count() {
  "$OMNESIS" backup --list --json >"$E2E_WORK/backups.json" 2>/dev/null || die "omnesis backup --list failed"
  json_get "$E2E_WORK/backups.json" 'String(j.backups.length)'
}

project_containers() {
  docker ps -a --filter "label=com.docker.compose.project=$1" -q
}

group "Install the newest published release (Docker, combined)"
installer || die "the published install failed"
endgroup
serving
PUBLISHED_TAG="$(sed -n 's/^OMNESIS_IMAGE_TAG=//p' "$CONFIG_DIR/.env")"
log "installed image tag $PUBLISHED_TAG"

group "Capture a note and read the collector's device"
NOTE_DAY="$(date -u +%F)"
"$OMNESIS" note "$NOTE_TEXT" >/dev/null || die "omnesis note failed"
note_present || die "the captured note is not listed"
DEVICE_BEFORE="$(collector_id)"
[ -n "$DEVICE_BEFORE" ] || die "no collector device is paired"
endgroup

group "Re-run the installer"
if [ "$SCENARIO" = linux ]; then
  installer --build || die "the re-run with --build failed"
  case "$(sed -n 's/^OMNESIS_IMAGE_TAG=//p' "$CONFIG_DIR/.env")" in
    *-local) ;;
    *) die "the --build re-run did not move the install onto this checkout's images" ;;
  esac
else
  installer || die "the re-run failed"
fi
endgroup
serving
grep -q "already encrypted; nothing to migrate" "$INSTALL_LOG" ||
  die "the re-run did not report the already-encrypted secrets in one line"
note_present || die "the note did not survive the re-run"
[ "$(collector_id)" = "$DEVICE_BEFORE" ] || die "the collector came back as another device"

group "Owner-only files and the doctor"
expect_mode 600 "$CONFIG_DIR/docker-compose.yml" "$CONFIG_DIR/install-method" "$CONFIG_DIR/.env" \
  "$CONFIG_DIR/host-network" "$CONFIG_DIR/host-disk-encryption" "$CONFIG_DIR/keyring.pass"
expect_mode 700 "$CONFIG_DIR" "$CONFIG_DIR/tls"
check_doctor first
"$OMNESIS" status >/dev/null 2>&1 || true
check_doctor again
endgroup

group "Back up, list the backups, refuse an unknown word"
BACKUPS="$(backup_count)"
"$OMNESIS" backup >/dev/null || die "omnesis backup failed"
[ "$(backup_count)" = $((BACKUPS + 1)) ] || die "omnesis backup did not add a backup"
"$OMNESIS" backup list >/dev/null || die "omnesis backup list failed"
[ "$(backup_count)" = $((BACKUPS + 1)) ] || die "omnesis backup list took a backup"
set +e
"$OMNESIS" backup lsit >"$E2E_WORK/backup-lsit.log" 2>&1
LSIT_STATUS=$?
set -e
[ "$LSIT_STATUS" = 2 ] || die "omnesis backup lsit exited $LSIT_STATUS, expected 2"
grep -q "takes no arguments" "$E2E_WORK/backup-lsit.log" || die "omnesis backup lsit did not say why it refused"
endgroup

if [ "$SCENARIO" = linux ]; then
  group "A sudo install beside this one is refused"
  set +e
  sudo env HOME=/root sh "$E2E_ROOT/scripts/install.sh" "${COMMON[@]}" --port 7700 --build </dev/null 2>&1 | redact >"$E2E_WORK/sudo-beside.log"
  BESIDE_STATUS=${PIPESTATUS[0]}
  set -e
  [ "$BESIDE_STATUS" != 0 ] || die "a sudo install beside this one was not refused"
  grep -q "Another Omnesis install already runs on this Docker daemon" "$E2E_WORK/sudo-beside.log" ||
    die "the refused sudo install did not name the install it met"
  ! sudo test -e /root/.config/omnesis/docker-compose.yml || die "the refused sudo install wrote a compose file"
  serving
  endgroup
fi

group "Uninstall, keeping the data"
redacted "$OMNESIS" uninstall --yes </dev/null || die "omnesis uninstall failed"
[ -z "$(project_containers omnesis)" ] || die "containers of the project survived the uninstall"
[ -f "$CONFIG_DIR/omnesis.db" ] || die "the uninstall removed the data"
endgroup

if [ "$SCENARIO" = linux ]; then
  group "A fresh sudo install"
  sudo env HOME=/root sh "$E2E_ROOT/scripts/install.sh" "${COMMON[@]}" --build </dev/null 2>&1 | redact ||
    die "the sudo install failed"
  ROOT_CONFIG=/root/.config/omnesis
  for RECORD in host-network host-disk-encryption; do
    [ "$(sudo stat -c '%a %u:%g' "$ROOT_CONFIG/$RECORD")" = "600 10001:10001" ] ||
      die "$ROOT_CONFIG/$RECORD is $(sudo stat -c '%a %u:%g' "$ROOT_CONFIG/$RECORD"), expected 600 10001:10001"
  done
  sudo env HOME=/root /root/.local/bin/omnesis doctor --json >"$E2E_WORK/doctor-root.json" 2>/dev/null || true
  [ "$(json_get "$E2E_WORK/doctor-root.json" 'j.checks.find((c) => c.id === a).status' security.permissions)" = pass ] ||
    die "doctor security.permissions on the sudo install: $(json_get "$E2E_WORK/doctor-root.json" 'j.checks.find((c) => c.id === a).message' security.permissions || echo absent)"
  sudo env HOME=/root /root/.local/bin/omnesis uninstall --yes </dev/null 2>&1 | redact || die "the sudo uninstall failed"
  [ -z "$(project_containers omnesis)" ] || die "containers of the sudo install survived its uninstall"
  endgroup
fi

log "Docker journey ($SCENARIO) passed"
