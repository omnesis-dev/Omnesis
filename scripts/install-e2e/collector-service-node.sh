#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# A fleet update sent to a collector whose service runs a Node with no npm
# beside it, and a collector started over an update that did not finish.
#
#   E2E_WORK=<scratch dir> scripts/install-e2e/collector-service-node.sh
#
# Two installs on one disposable machine stand in for two machines: a gateway
# under its own home directory, started by hand, and a collector under this
# account's real service manager (launchd on a Mac), paired to it. They are
# separate checkouts, so the gateway host's update leaves the collector behind
# and the gateway commands it over its socket, as it would a second machine.
#
#   1. The collector's service is registered again by a Node copied to a
#      directory of its own, which is how an operator keeps a Full Disk Access
#      grant across Node upgrades. The service PATH then has no npm.
#   2. vN+1 is published and the gateway fans it out. The collector must
#      refuse before its checkout moves, say why to the gateway, and keep
#      running: found later, a missing npm is an install and then a rollback
#      that cannot start, and an installation no daemon starts from.
#   3. npm is linked beside that Node, the fix the refusal names, and the same
#      fan-out lands vN+1 with the service manager restarting the collector.
#   4. The collector's update record is left as a failed rollback leaves it,
#      with the checkout on another release, and its service is restarted.
#      The service must restore the last completed release itself and
#      reconnect, with no one running `omnesis update` on the machine.
#
# E2E_OBSERVE=1 reports each expectation that does not hold and carries on, to
# show what a build without the fixes does.
#
# Runs on a disposable CI machine: it installs into $HOME and registers real
# user services. Do not run it on a machine you use.
set -euo pipefail

E2E_WORK="${E2E_WORK:?set E2E_WORK}"
# shellcheck source=scripts/install-e2e/lib.sh
. "$(dirname "$0")/lib.sh"

[ -n "${CI:-}" ] || die "collector-service-node.sh installs into \$HOME and registers services; it runs on CI machines only"
[ "$(uname -s)" = Darwin ] || die "this lane drives launchd; it runs on a Mac"
[ ! -e "$HOME/omnesis" ] && [ ! -e "$CONFIG_DIR" ] && [ ! -e "$OMNESIS" ] ||
  die "this machine already has an Omnesis installation"

OBSERVE="${E2E_OBSERVE:-0}"
# A build without the recovery never recovers; an observation does not wait long for it.
if [ "$OBSERVE" = 1 ]; then RECOVERY_WAIT=420; else RECOVERY_WAIT=1500; fi
UNMET=0
# expect <what must hold> <command...>
expect() {
  local what="$1"
  shift
  if "$@"; then
    log "ok: $what"
  elif [ "$OBSERVE" = 1 ]; then
    UNMET=$((UNMET + 1))
    printf '::warning::NOT MET: %s\n' "$what"
  else
    die "$what"
  fi
}

GATEWAY_URL=https://localhost:7600
FIXTURE_DIR="$E2E_WORK/fixture"
REMOTE="$FIXTURE_DIR/omnesis.git"
GW_HOME="$E2E_WORK/gateway-home"
GW_OMNESIS="$GW_HOME/.local/bin/omnesis"
GW_PID=
SOURCE_DIR="$HOME/omnesis"
PLIST=
STANDALONE="$HOME/omnesis-node"
NPM_CACHE="$(npm config get cache)"
REAL_NPM="$(command -v npm)"
mkdir -p "$GW_HOME"

# Everything the gateway host does runs with its own home and no setting of
# this account's installation.
gw() { (
  unset OMNESIS_CONFIG_DIR
  export HOME="$GW_HOME" NPM_CONFIG_CACHE="$NPM_CACHE"
  "$@"
); }
start_gateway() {
  env -u OMNESIS_CONFIG_DIR HOME="$GW_HOME" "$GW_OMNESIS" gateway serve >>"$E2E_WORK/gateway.log" 2>&1 &
  GW_PID=$!
}
stop_gateway() {
  [ -n "$GW_PID" ] || return 0
  kill -TERM "$GW_PID" 2>/dev/null || true
  wait "$GW_PID" 2>/dev/null || true
  GW_PID=
}
gateway_version() {
  curl -ksf --max-time 10 "$GATEWAY_URL/health" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => process.stdout.write(JSON.parse(s).version || ""));'
}
wait_gateway() {
  local want="$1" deadline=$(($(date +%s) + 240))
  until [ "$(gateway_version 2>/dev/null)" = "$want" ]; do
    [ "$(date +%s)" -lt "$deadline" ] || die "the gateway is not serving $want"
    sleep 3
  done
}
# The collector's row in the gateway's device list.
collector_row() { gw "$GW_OMNESIS" devices list 2>/dev/null | grep -E '[[:space:]]collector[[:space:]]' || true; }
collector_live() { collector_row | grep -qw yes; }
wait_collector() {
  local deadline=$(($(date +%s) + ${1:-240}))
  until collector_live; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 3
  done
}
collector_service() { "$OMNESIS" service status --json 2>/dev/null >"$E2E_WORK/service.json" || true; }
collector_pid() {
  collector_service
  json_get "$E2E_WORK/service.json" '(j.items.find((s) => s.component === "collector") || {}).pid' 2>/dev/null || echo none
}
collector_running() {
  collector_service
  [ "$(json_get "$E2E_WORK/service.json" '(j.items.find((s) => s.component === "collector") || {}).state' 2>/dev/null)" = running ]
}
# Restart the collector the way launchd does, not through the CLI: the
# launcher refuses `service` commands over an unfinished update, and what is
# in question is what the service itself does when it starts.
restart_by_launchd() {
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  local deadline=$(($(date +%s) + 60))
  while collector_live && [ "$(date +%s)" -lt "$deadline" ]; do sleep 2; done
}
record() { json_get "$CONFIG_DIR/update-state.json" "$1" 2>/dev/null || echo none; }
head_commit() { git -C "$SOURCE_DIR" rev-parse HEAD; }
# One fan-out from the gateway host; its output is kept and its status returned.
fan_out() {
  local out="$1" status
  set +e
  gw "$GW_OMNESIS" update --yes --fleet >"$out" 2>&1
  status=$?
  set -e
  redact <"$out"
  return "$status"
}
report() {
  local status=$?
  trap - EXIT
  set +e
  group "State at exit (status $status)"
  log "update record: $(cat "$CONFIG_DIR/update-state.json" 2>/dev/null)"
  log "checkout: $(head_commit 2>/dev/null)"
  collector_row | redact
  "$OMNESIS" service status --json 2>&1 | redact
  local out="" err=""
  if [ -n "${PLIST:-}" ]; then
    out="$(plutil -extract StandardOutPath raw "$PLIST" 2>/dev/null)"
    err="$(plutil -extract StandardErrorPath raw "$PLIST" 2>/dev/null)"
  fi
  for file in "$out" "$err" "$E2E_WORK/gateway.log"; do
    [ -f "$file" ] || continue
    log "tail of $file"
    tail -40 "$file" | redact
  done
  endgroup
  stop_gateway
  exit "$status"
}
trap report EXIT

group "Fixture: the candidate as release vN"
fixture init --source "$E2E_ROOT" --out "$FIXTURE_DIR" >"$E2E_WORK/fixture-init.json"
V_N="$(json_get "$FIXTURE_DIR/fixture.json" 'j.candidateVersion')"
log "candidate is v$V_N"
endgroup

group "Gateway host: install v$V_N under its own home, started by hand"
OMNESIS_REPO_URL="file://$REMOTE" gw redacted sh "$E2E_ROOT/scripts/install.sh" \
  --source-dir "$GW_HOME/omnesis" --no-service --no-model --no-tls --no-keyring --no-prompt --no-modify-path ||
  die "the gateway install failed"
start_gateway
wait_gateway "$V_N"
endgroup

group "Collector: install v$V_N under this account's service manager, paired to it"
CODE="$(gw "$GW_OMNESIS" devices pair --kind collector --json | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const match = s.match(/"pairingCode"\s*:\s*"([A-F0-9]+)"/i);
    if (!match) process.exit(1);
    process.stdout.write(match[1]);
  });')" || die "the gateway minted no pairing code"
secret "$CODE"
FINGERPRINT="$(openssl x509 -in "$GW_HOME/.config/omnesis/tls/cert.pem" -outform DER | shasum -a 256 | cut -d' ' -f1)"
[ -n "$FINGERPRINT" ] || die "the gateway certificate has no fingerprint"
OMNESIS_REPO_URL="file://$REMOTE" redacted sh "$E2E_ROOT/scripts/install.sh" \
  --collector --gateway-url "$GATEWAY_URL" --code "$CODE" --trust-fingerprint "sha256:$FINGERPRINT" \
  --source-dir "$SOURCE_DIR" --no-model --no-prompt --no-modify-path ||
  die "the collector install failed"
wait_collector || die "the collector never connected to the gateway"
collector_running || die "the collector is not running under the service manager"
N_COMMIT="$(head_commit)"
[ "$(record 'j.phase')" = complete ] || die "the fresh install recorded no completed build"
endgroup

group "Register the collector's service with a Node that has no npm beside it"
mkdir -p "$STANDALONE"
cp "$(command -v node)" "$STANDALONE/node"
PATH="$STANDALONE:$PATH" "$OMNESIS" service install collector --exec "$OMNESIS" \
  --env "OMNESIS_GATEWAY_URL=$GATEWAY_URL" 2>&1 | redact
PLIST="$(grep -l "$STANDALONE" "$HOME"/Library/LaunchAgents/*.plist | head -1)"
[ -n "$PLIST" ] || die "no launchd agent names the standalone Node's directory"
SERVICE_PATH="$(plutil -extract EnvironmentVariables.PATH raw "$PLIST")"
LABEL="$(plutil -extract Label raw "$PLIST")"
log "service PATH: $SERVICE_PATH"
case "$SERVICE_PATH" in "$STANDALONE":*) ;; *) die "the service PATH does not start with the standalone Node's directory" ;; esac
# A disposable machine may carry an npm in a system directory, which a Mac
# whose Node comes from Homebrew's own prefix does not. It is set aside.
while hidden="$(env PATH="$SERVICE_PATH" sh -c 'command -v npm')"; do
  log "setting aside $hidden so the service PATH has no npm"
  sudo -n mv "$hidden" "$hidden.set-aside"
done
env PATH="$SERVICE_PATH" sh -c 'node --version >/dev/null' || die "the service PATH has no Node"
wait_collector || die "the collector did not reconnect under the standalone Node"
endgroup

group "Publish vN+1 and move the gateway host to it"
V_N1="$(fixture next-version --remote "$REMOTE")"
fixture release --remote "$REMOTE" --version "$V_N1" >"$E2E_WORK/release-n1.json"
N1_COMMIT="$(json_get "$E2E_WORK/release-n1.json" 'j.commit')"
# The first run moves this host and refuses to fan out past the gateway that
# is still serving vN; restarted by hand, it serves vN+1.
fan_out "$E2E_WORK/fleet-host.log" || true
stop_gateway
start_gateway
wait_gateway "$V_N1"
wait_collector || die "the collector did not reconnect to the restarted gateway"
endgroup

group "Fan out v$V_N1 to a collector whose service PATH has no npm"
if fan_out "$E2E_WORK/fleet-refused.log"; then
  expect "the fan-out fails while the collector cannot update" false
fi
expect "the gateway is told npm does not run on the collector" \
  grep -q "does not run on this PATH" "$E2E_WORK/fleet-refused.log"
expect "and which directory to put it in" grep -qF "$STANDALONE" "$E2E_WORK/fleet-refused.log"
expect "the collector's update record is still complete" test "$(record 'j.phase')" = complete
expect "and still names v$V_N" test "$(record 'j.commit')" = "$N_COMMIT"
expect "the collector's checkout did not move" test "$(head_commit)" = "$N_COMMIT"
# What a host left mid-rollback cannot do: start again when its service does.
restart_by_launchd
expect "the collector comes back when its service restarts" wait_collector 120
expect "and runs under the service manager" collector_running
endgroup

if [ "$(record 'j.phase')" = complete ]; then
  group "Link npm beside the service's Node, as the refusal says, and fan out again"
  ln -s "$REAL_NPM" "$STANDALONE/npm"
  env PATH="$SERVICE_PATH" sh -c 'npm --version >/dev/null' || die "the linked npm does not run on the service PATH"
  PID_BEFORE="$(collector_pid)"
  expect "the fan-out lands v$V_N1" fan_out "$E2E_WORK/fleet-landed.log"
  expect "the collector's record names v$V_N1" test "$(record 'j.commit')" = "$N1_COMMIT"
  expect "the collector reconnects on v$V_N1" wait_collector 240
  expect "its service was restarted by the service manager" test "$(collector_pid)" != "$PID_BEFORE"
  endgroup
  COMPLETED="$N1_COMMIT"
  OTHER="$N_COMMIT"
else
  # Without the refusal the fan-out above has already left the record
  # unfinished; npm is linked so that only the recovery is in question.
  ln -s "$REAL_NPM" "$STANDALONE/npm"
  COMPLETED="$(record 'j.lastCompletedCommit')"
  OTHER="$N1_COMMIT"
fi

group "Start the collector's service over an update that did not finish"
# As a failed rollback leaves it: the record at rolling-back and the tree on
# the other release.
git -C "$SOURCE_DIR" fetch -q --no-tags origin "$OTHER" 2>/dev/null || true
git -C "$SOURCE_DIR" checkout -q --detach "$OTHER"
node -e '
  const [path, rootDir, targetCommit, lastCompletedCommit] = process.argv.slice(1);
  require("fs").writeFileSync(path, JSON.stringify({
    version: 1, method: "source", rootDir, phase: "rolling-back", targetCommit, lastCompletedCommit,
  }) + "\n");
' "$CONFIG_DIR/update-state.json" "$SOURCE_DIR" "$OTHER" "$COMPLETED"
rm -f "$CONFIG_DIR/update-recovery-attempt"
restart_by_launchd
recovered() {
  local deadline=$(($(date +%s) + RECOVERY_WAIT))
  until [ "$(record 'j.phase')" = complete ] && collector_live; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 5
  done
}
expect "the collector restores its last completed release and reconnects on its own" recovered
expect "the record names the release that had completed" test "$(record 'j.commit')" = "$COMPLETED"
expect "the checkout is back on it" test "$(head_commit)" = "$COMPLETED"
expect "the collector runs under the service manager" collector_running
endgroup

if [ "$UNMET" -gt 0 ]; then
  log "$UNMET expectation(s) not met (observation run)"
  exit 1
fi
log "a collector whose service Node has no npm refused, updated once npm was linked, and recovered an unfinished update by itself"
