#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
# Real updater faults on a disposable GitHub-hosted Linux runner only.
# E2E_WORK="$RUNNER_TEMP/update-interruption" scripts/install-e2e/update-interruption.sh
set -euo pipefail
: "${E2E_WORK:?set E2E_WORK}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/update-fault.mjs" guard "$E2E_WORK" "$(cd "$SCRIPT_DIR/../.." && pwd)" >/dev/null || exit 2
export OMNESIS_CONFIG_DIR="$HOME/.config/omnesis"
[ ! -e "$HOME/omnesis" ] && [ ! -e "$OMNESIS_CONFIG_DIR" ] && [ ! -e "$HOME/.local/bin/omnesis" ] || {
  printf "Refusing a runner with an existing Omnesis installation.\n" >&2; exit 2;
}
. "$(dirname "$0")/lib.sh"
GATEWAY_URL=https://localhost:7600
FIXTURE_DIR="$E2E_WORK/fixture"
REMOTE="$FIXTURE_DIR/omnesis.git"
SOURCE_DIR="$HOME/omnesis"
FAULT_BIN="$E2E_WORK/fault-bin"
UPDATE_REAL_NPM="$(command -v npm)"
UPDATE_REAL_GIT="$(command -v git)"
export UPDATE_REAL_NPM UPDATE_REAL_GIT
DAEMON_PID=
DAEMON_START=
UPDATE_START=
export UPDATE_FAULT_HELPER="$E2E_DIR/update-fault.mjs"
export UPDATE_FAULT_SOURCE="$SOURCE_DIR"
MOUNTED=0
UPDATE_PID=
PHASE=install
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ -n "$UPDATE_PID" ]; then node "$UPDATE_FAULT_HELPER" signal-process "$UPDATE_PID" "$UPDATE_START" >/dev/null 2>&1 || true; wait "$UPDATE_PID" || true; fi
  if [ -n "$DAEMON_PID" ]; then node "$UPDATE_FAULT_HELPER" signal-process "$DAEMON_PID" "$DAEMON_START" >/dev/null 2>&1 || true; wait "$DAEMON_PID" || true; fi
  if [ "$MOUNTED" = 1 ]; then
    if ! sudo -n umount -- "$CONFIG_DIR/backups"; then status=1; fi
  fi
  set +e
  E2E_FAULT_STATUS="$status" E2E_FAULT_PHASE="$PHASE" node - "$E2E_WORK" <<'JS'
const fs=require("fs"),path=require("path"),dir=process.argv[2];
if(!fs.existsSync(path.join(dir,"result.json")) || Number(process.env.E2E_FAULT_STATUS)!==0) {
  const cases=["interruption","network","disk"].flatMap(name=>{
    const file=path.join(dir,`${name}.result.json`);return fs.existsSync(file)?[JSON.parse(fs.readFileSync(file))]:[];
  });
  fs.writeFileSync(path.join(dir,"result.json"),JSON.stringify({passed:false,exitCode:Number(process.env.E2E_FAULT_STATUS),failedPhase:process.env.E2E_FAULT_PHASE,cases},null,2)+"\n");
}
JS
  summary_status=$?
  if [ "$summary_status" -ne 0 ] && [ "$status" = 0 ]; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$FAULT_BIN"
new_passphrase_file
export OMNESIS_KEYRING_PASSPHRASE_FILE="$PASSPHRASE_FILE"

fixture init --source "$E2E_ROOT" --out "$FIXTURE_DIR" >"$E2E_WORK/fixture-init.json"
CURRENT="$(json_get "$FIXTURE_DIR/fixture.json" 'j.candidateVersion')"
OMNESIS_REPO_URL="file://$REMOTE" redacted timeout --signal=TERM --kill-after=60s 1800 sh "$E2E_ROOT/scripts/install.sh" \
  --source-dir "$SOURCE_DIR" --no-model --no-tls --no-prompt --no-modify-path \
  --keyring-passphrase-file "$PASSPHRASE_FILE"
export NODE_EXTRA_CA_CERTS="$CONFIG_DIR/tls/cert.pem"
probe health --url "$GATEWAY_URL" --expect-version "$CURRENT" --timeout 180 >/dev/null
mint_probe_token
COLLECTOR="$(live_collector_name "$GATEWAY_URL" 180)"
make_vault "$E2E_WORK/vault"
SOURCE_ID="$(add_vault "$COLLECTOR" "$E2E_WORK/vault")"
redacted "$OMNESIS" sources sync "$SOURCE_ID" --wait --timeout 300
snapshot_with_hit initial "$GATEWAY_URL"
[ "$(json_get "$E2E_WORK/initial.json" 'j.docTotal')" = 3 ] || die "expected exactly three invented documents"
[ "$(json_get "$E2E_WORK/initial.json" '["gateway","collector"].every(component => j.services.some(s => s.component === component && s.state === "running" && Number(s.pid) > 0))')" = true ] || die "initial supervisor records missing"
node "$E2E_DIR/update-fault.mjs" identity "$CONFIG_DIR" >"$E2E_WORK/identity.json"
node "$E2E_DIR/update-fault.mjs" documents "$GATEWAY_URL" "$TOKEN_FILE" >"$E2E_WORK/documents.json"

preserved() {
  local name="$1" version="$2"
  probe health --url "$GATEWAY_URL" --expect-version "$version" --timeout 180 >/dev/null
  wait_collector_live "$GATEWAY_URL" "$COLLECTOR"
  local commit
  commit="$(git -C "$SOURCE_DIR" rev-parse "v$version")"
  [ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$commit" ] || die "checkout did not recover during $name"
  [ "$(json_get "$CONFIG_DIR/update-state.json" 'j.phase')" = complete ] || die "incomplete apply state during $name"
  [ "$(json_get "$CONFIG_DIR/update-state.json" 'j.commit')" = "$commit" ] || die "apply state names wrong commit during $name"
  snapshot_with_hit "$name" "$GATEWAY_URL"
  probe compare --before "$E2E_WORK/initial.json" --after "$E2E_WORK/$name.json" \
    --expect-version "$version" --expect-title "$SEARCH_TITLE"
  node "$E2E_DIR/update-fault.mjs" identity "$CONFIG_DIR" >"$E2E_WORK/$name.identity.json"
  cmp "$E2E_WORK/identity.json" "$E2E_WORK/$name.identity.json" || die "encrypted identity changed during $name"
  node "$E2E_DIR/update-fault.mjs" documents "$GATEWAY_URL" "$TOKEN_FILE" >"$E2E_WORK/$name.documents.json"
  cmp "$E2E_WORK/documents.json" "$E2E_WORK/$name.documents.json" || die "document identities or content changed during $name"
}
new_release() {
  TARGET="$(fixture next-version --remote "$REMOTE")"
  fixture release --remote "$REMOTE" --version "$TARGET" --base "v$CURRENT" >"$E2E_WORK/release-$TARGET.json"
}
retry() {
  local name="$1"
  snapshot "$name-before-retry" "$GATEWAY_URL"
  redacted timeout --signal=TERM --kill-after=60s 1800 "$OMNESIS" update --yes || die "$name retry failed"
  node "$E2E_DIR/update-fault.mjs" verify-dependency "$SOURCE_DIR" "$E2E_WORK/interruption/damage.json" >/dev/null
  preserved "$name-repaired" "$TARGET"
  probe compare --before "$E2E_WORK/$name-before-retry.json" --after "$E2E_WORK/$name-repaired.json" \
    --expect-version "$TARGET" --expect-restart gateway,collector --expect-title "$SEARCH_TITLE"
  node "$E2E_DIR/update-fault.mjs" verify-new-backup \
    "$E2E_WORK/$name-before-retry.backups.json" "$E2E_WORK/$name-repaired.backups.json" >/dev/null
  [ "$(json_get "$CONFIG_DIR/update-state.json" 'j.phase')" = complete ] || die "retry state incomplete"
  [ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$(json_get "$E2E_WORK/release-$TARGET.json" 'j.commit')" ] || die "retry landed wrong commit"
  CURRENT="$TARGET"
  node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({case:process.argv[2],repaired:true,version:process.argv[3],encryptedIdentityPreserved:true,threeDocumentIdentitiesAndContentPreserved:true,updateState:"complete",targetCommitVerified:true,newPreUpdateBackupVerified:true})+"\n")' "$E2E_WORK/$name.result.json" "$name" "$TARGET"
}

# The updater has already checked out the target and published its apply state
# when its first actual npm-ci subprocess reaches this external gate.
PHASE=interruption
group 'Interrupt the updater during npm ci'
new_release
export UPDATE_FAULT_DIR="$E2E_WORK/interruption"
mkdir "$UPDATE_FAULT_DIR"
ln -s "$E2E_DIR/update-fault-command.sh" "$FAULT_BIN/npm"
set +e
PATH="$FAULT_BIN:$PATH" node "$E2E_DIR/update-fault.mjs" interrupt "$OMNESIS" "$CONFIG_DIR" "$(json_get "$E2E_WORK/release-$TARGET.json" 'j.commit')" \
  >"$E2E_WORK/interruption.log" 2>&1 &
UPDATE_PID=$!
node "$UPDATE_FAULT_HELPER" record-process "$UPDATE_PID" "$$" >"$E2E_WORK/update-process.json"
UPDATE_START="$(json_get "$E2E_WORK/update-process.json" 'j.started')"
wait "$UPDATE_PID"
status=$?
UPDATE_PID=
set -e
redact <"$E2E_WORK/interruption.log"
[ "$status" = 0 ] || die 'controlled interruption did not recover'
grep -q 'Update interrupted by SIGTERM' "$E2E_WORK/interruption.log" || die 'wrong interruption phase'
grep -q 'Rolled back to' "$E2E_WORK/interruption.log" || die 'interruption did not roll back'
rm "$FAULT_BIN/npm"
node "$E2E_DIR/update-fault.mjs" verify-dependency "$SOURCE_DIR" "$UPDATE_FAULT_DIR/damage.json" >/dev/null
preserved interrupted "$CURRENT"
[ "$(json_get "$CONFIG_DIR/update-state.json" 'j.phase')" = complete ] || die 'rollback state incomplete'
retry interruption
endgroup

# Resolve tags successfully against a real loopback Git server, disconnect
# precisely as the actual fetch starts, then let real Git report the failure.
PHASE=network
group 'Disconnect the release server at git fetch'
new_release
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
NETWORK_REMOTE="git://127.0.0.1:$PORT/omnesis.git"
start_daemon() {
  git daemon --reuseaddr --export-all --base-path="$FIXTURE_DIR" --listen=127.0.0.1 --port="$PORT" \
    >>"$E2E_WORK/git-daemon.log" 2>&1 &
  DAEMON_PID=$!
  node "$UPDATE_FAULT_HELPER" record-process "$DAEMON_PID" "$$" >"$E2E_WORK/git-process.json"
  DAEMON_START="$(json_get "$E2E_WORK/git-process.json" 'j.started')"
  for _attempt in $(seq 1 50); do
    if timeout 2 git ls-remote "$NETWORK_REMOTE" >"$E2E_WORK/network-tags" 2>/dev/null; then break; fi
    sleep .1
  done
  grep -Fq "refs/tags/v$TARGET" "$E2E_WORK/network-tags" || die 'Git server did not publish the target'
}
start_daemon
git -C "$SOURCE_DIR" remote set-url origin "$NETWORK_REMOTE"
export UPDATE_FAULT_DIR="$E2E_WORK/network" UPDATE_GIT_DAEMON_PID="$DAEMON_PID" UPDATE_GIT_DAEMON_START="$DAEMON_START"
mkdir "$UPDATE_FAULT_DIR"
ln -s "$E2E_DIR/update-fault-command.sh" "$FAULT_BIN/git"
set +e
PATH="$FAULT_BIN:$PATH" timeout --signal=TERM --kill-after=60s 600 "$OMNESIS" update --yes >"$E2E_WORK/network.log" 2>&1
status=$?
set -e
redact <"$E2E_WORK/network.log"
[ "$status" -ne 0 ] && [ -d "$UPDATE_FAULT_DIR/fetch-entered" ] || die 'network fault did not reach fetch'
grep -Eq 'Connection refused|unable to connect' "$E2E_WORK/network.log" || die 'no actual network refusal'
grep -Eq 'git fetch.*failed' "$E2E_WORK/network.log" || die 'failure was not the fetch phase'
wait "$DAEMON_PID" || true
DAEMON_PID=
rm "$FAULT_BIN/git"
preserved disconnected "$CURRENT"
start_daemon
retry network
node "$UPDATE_FAULT_HELPER" signal-process "$DAEMON_PID" "$DAEMON_START" >/dev/null
wait "$DAEMON_PID" || true
DAEMON_PID=
git -C "$SOURCE_DIR" remote set-url origin "file://$REMOTE"
endgroup

# The host filesystem is never filled: the only writable fault surface is
# this 8 MiB mount, obscuring (not deleting) any existing backup directories.
PHASE=disk
group 'Exhaust a bounded backup filesystem'
new_release
mkdir -p "$CONFIG_DIR/backups"
sudo -n mount -t tmpfs -o "size=8m,mode=0700,uid=$(id -u),gid=$(id -g),nosuid,nodev,noexec" \
  tmpfs "$CONFIG_DIR/backups"
MOUNTED=1
node "$E2E_DIR/update-fault.mjs" fill "$CONFIG_DIR/backups" >"$E2E_WORK/disk-fault.json"
set +e
timeout --signal=TERM --kill-after=60s 600 "$OMNESIS" update --yes >"$E2E_WORK/disk.log" 2>&1
status=$?
set -e
redact <"$E2E_WORK/disk.log"
[ "$status" -ne 0 ] || die 'full backup filesystem reported success'
grep -q 'Not enough free disk space for a backup' "$E2E_WORK/disk.log" || die 'failure was not backup disk preflight'
sudo -n umount -- "$CONFIG_DIR/backups"
MOUNTED=0
preserved disk-full "$CURRENT"
retry disk
endgroup
node - "$E2E_WORK" <<'JS'
const fs = require("fs"), path = require("path"), dir = process.argv[2];
const cases = ["interruption", "network", "disk"].map(name => JSON.parse(fs.readFileSync(path.join(dir, `${name}.result.json`))));
cases[0].fault = {phase:"external partial dependency-tree damage at npm-ci boundary",signal:"SIGTERM",exitCode:143,rollbackObserved:true,childRetired:true,compilerEntryRestored:true,damage:JSON.parse(fs.readFileSync(path.join(dir,"interruption/damage.json")))};
cases[1].fault = {phase:"git fetch",transport:"loopback git daemon",disconnectObserved:true,sameServerReconnected:true};
cases[2].fault = {phase:"pre-update backup",...JSON.parse(fs.readFileSync(path.join(dir,"disk-fault.json")))};
fs.writeFileSync(path.join(dir,"result.json"),JSON.stringify({passed:true,cases},null,2)+"\n");
JS
log 'interruption, disconnected fetch, and exhausted isolated backup filesystem all repaired'
