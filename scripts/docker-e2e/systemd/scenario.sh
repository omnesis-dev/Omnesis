#!/usr/bin/env bash
# The dedicated-account gateway, installed and administered by the real
# scripts/hardened-gateway.sh under systemd, from the local repository the image
# holds (lane-a, lane-b, lane-c whose gateway exits as it starts, lane-d). The
# operator is the login account maya, running the admin command through sudo.
# Runs as root inside the container run.sh boots.
set -euo pipefail

SCRIPT=/src/scripts/hardened-gateway.sh
ADMIN=/usr/local/sbin/omnesis-gateway-admin
REPO=file:///srv/omnesis.git
UNIT=omnesis-gateway.service
UNIT_FILE=/etc/systemd/system/$UNIT
STATE=/var/lib/private/omnesis-gateway
PASS=/etc/omnesis-gateway/keyring.pass
SEED=/var/cache/omnesis-npm-seed
export OMNESIS_HARDENED_NPM_CACHE_SEED=$SEED

assert() {
  local msg="$1"; shift
  if "$@"; then echo "  ok: $msg"; else echo "  FAILED: $msg" >&2; exit 1; fi
}
assert_not() {
  local msg="$1"; shift
  if "$@"; then echo "  FAILED (expected false): $msg" >&2; exit 1; else echo "  ok: $msg"; fi
}
healthy() { curl -ksf https://127.0.0.1:7600/health >/dev/null 2>&1; }
wait_healthy() {
  local deadline=$((SECONDS + ${1:-180}))
  until healthy; do
    ((SECONDS < deadline)) || return 1
    sleep 2
  done
}
release_of() { basename "$(readlink -f "/opt/omnesis-gateway/$1")"; }
as_maya() { su maya -s /bin/bash -c "$1"; }
# maya's own sudo, the way an operator runs the admin command.
maya_sudo() { as_maya "sudo OMNESIS_HARDENED_NPM_CACHE_SEED=$SEED $1"; }
plaintext_sqlite() { [[ "$(head -c 15 "$1" 2>/dev/null)" == "SQLite format 3" ]]; }
# The release the gateway process runs: the launcher resolves `current` to the
# release directory before it hands over to node.
serving_release() {
  local pid
  pid="$(systemctl show -p MainPID --value "$UNIT")"
  [[ "$pid" != 0 ]] && tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q "/opt/omnesis-gateway/releases/$1-"
}

echo "== an operator whose home is closed to other accounts =="
useradd --create-home maya
chmod 0750 /home/maya
printf 'maya ALL=(ALL) NOPASSWD: ALL\n' >/etc/sudoers.d/maya
chmod 0440 /etc/sudoers.d/maya

echo "== a first install whose gateway will not start is stopped, and can be run again =="
assert_not "installing lane-c fails, since its gateway exits as it starts" \
  maya_sudo "sh $SCRIPT install --ref lane-c --repo-url $REPO"
assert_not "the failed install left the service stopped" systemctl is-active --quiet "$UNIT"

echo "== install through sudo -E, with an environment that tries to steer root =="
as_maya "
  set -e
  printf 'require(\"fs\").writeFileSync(\"/tmp/preload-ran-as-root\", \"\")\n' > ~/preload.js
  printf '[url \"file:///nowhere.git\"]\n\tinsteadOf = $REPO\n' > ~/.gitconfig
"
as_maya "
  export NODE_OPTIONS='--require /home/maya/preload.js' GIT_CONFIG_GLOBAL=/home/maya/.gitconfig
  sudo -E OMNESIS_HARDENED_NPM_CACHE_SEED=$SEED sh $SCRIPT install --ref lane-a --repo-url $REPO
"
assert_not "root never loaded the account's node preload" test -e /tmp/preload-ran-as-root
assert "the gateway answers" wait_healthy
assert "the service is active" systemctl is-active --quiet "$UNIT"
assert "the admin command is linked" test -x "$ADMIN"
assert "it serves lane-a" serving_release lane-a
assert_not "the failed first install is not kept to roll back to" test -e /opt/omnesis-gateway/previous
assert "status names no previous release" bash -c "su maya -s /bin/bash -c 'sudo $ADMIN status' | grep -q '^Previous:  none$'"

echo "== what the gateway runs, and as whom =="
MAIN_PID="$(systemctl show -p MainPID --value "$UNIT")"
GATEWAY_USER="$(ps -o user= -p "$MAIN_PID" | tr -d ' ')"
assert "the gateway runs as its own account ($GATEWAY_USER)" \
  bash -c "[[ '$GATEWAY_USER' != root && '$GATEWAY_USER' != maya ]]"
assert "the unit starts the root-owned release" \
  grep -q "^ExecStart=/opt/omnesis-gateway/current/scripts/hardened-gateway-exec.sh gateway serve$" "$UNIT_FILE"
assert "the unit hides home directories" grep -q "^ProtectHome=yes$" "$UNIT_FILE"
assert "the unit points HOME at the state directory" grep -q "^Environment=HOME=/var/lib/omnesis-gateway$" "$UNIT_FILE"
assert "the unit reads its passphrase as a credential from /etc" grep -q "^LoadCredential=.*:$PASS$" "$UNIT_FILE"
assert_not "nothing under the release is writable by the login account" \
  as_maya "find /opt/omnesis-gateway/ -writable -print -quit | grep -q ."
assert "the release is root's" test "$(stat -c %U "/opt/omnesis-gateway/releases/$(release_of current)")" = root
assert "the passphrase is readable by root alone" test "$(stat -c '%U %a' "$PASS")" = "root 600"
assert_not "the login account cannot read the passphrase" as_maya "cat $PASS >/dev/null 2>&1"
assert_not "the login account cannot list the gateway's state" as_maya "ls /var/lib/omnesis-gateway >/dev/null 2>&1"
assert "the keyring exists in the state" test -d "$STATE/keyring"
assert "the corpus store exists" test -s "$STATE/omnesis.db"
assert_not "the corpus store is not plaintext" plaintext_sqlite "$STATE/omnesis.db"

echo "== root administers it without loading anything another account planted =="
as_maya "mkdir -p /tmp/tsx-0 && chmod 1777 /tmp/tsx-0"
PAIR_OUT="$(maya_sudo "$ADMIN cli devices pair --kind collector" 2>&1)" || { echo "$PAIR_OUT" >&2; exit 1; }
assert "root's CLI wrote nothing to a cache directory the login account made" \
  bash -c '[[ -z "$(ls -A /tmp/tsx-0)" ]]'
CODE="$(printf '%s\n' "$PAIR_OUT" | sed 's/\x1b\[[0-9;]*m//g' | sed -n 's/^Pairing code: *//p' | head -1 | tr -d '[:space:]')"
assert "root minted a collector code" test -n "$CODE"
STATE_UID="$(stat -c %u "$STATE")"
assert "root's commands leave the state owned by the gateway's account" \
  bash -c "[[ -z \"\$(find '$STATE' ! -uid '$STATE_UID' -print -quit)\" ]]"
FINGERPRINT="$(node -e 'const { X509Certificate } = require("node:crypto"); const cert = new X509Certificate(require("node:fs").readFileSync(process.argv[1])); process.stdout.write(cert.fingerprint256.replace(/:/g, "").toLowerCase())' "$STATE/tls/cert.pem")"
as_maya "
  set -e
  mkdir -p ~/.config/omnesis && chmod 700 ~/.config/omnesis
  cd /src
  npx tsx packages/cli/src/index.ts pair '$CODE' --gateway-url https://localhost:7600 \
    --trust-fingerprint 'sha256:$FINGERPRINT' --save ~/.config/omnesis/collector-token
"
assert "the collector's token belongs to the login account" \
  test "$(stat -c %U /home/maya/.config/omnesis/collector-token)" = maya
assert "the gateway still answers after root's commands" healthy

echo "== the hand-over option cannot point root at another account's checkout =="
as_maya "mkdir -p ~/checkout"
HANDOVER_OUT="$(maya_sudo "$ADMIN update --from-checkout /home/maya/checkout --ref lane-a" 2>&1 || true)"
assert "the update refuses a checkout it did not fetch" \
  grep -q "takes only the directory this script fetched" <<<"$HANDOVER_OUT"
assert "it still serves lane-a" serving_release lane-a

echo "== an update interrupted while it builds stops promptly and changes nothing =="
"$ADMIN" update --ref lane-d &
UPDATE_PID=$!
deadline=$((SECONDS + 300))
until systemctl is-active --quiet "omnesis-gateway-build-$UPDATE_PID.service"; do
  ((SECONDS < deadline)) || { echo "the build never started" >&2; exit 1; }
  sleep 1
done
kill -TERM "$UPDATE_PID"
assert "the update exits within a minute of the signal" timeout 60 tail --pid="$UPDATE_PID" -f /dev/null
assert_not "the build unit is no longer running" systemctl is-active --quiet "omnesis-gateway-build-$UPDATE_PID.service"
assert "it still serves lane-a" serving_release lane-a
assert_not "no fetch or staging directory is left behind" \
  bash -c "ls -d /opt/omnesis-gateway/.fetch-* /opt/omnesis-gateway/releases/.staging-* >/dev/null 2>&1"
assert "the gateway still answers" healthy

echo "== update to lane-b through sudo =="
maya_sudo "$ADMIN update --ref lane-b"
assert "current names lane-b" bash -c "[[ $(release_of current) == lane-b-* ]]"
assert "lane-a is kept as the previous release" bash -c "[[ $(release_of previous) == lane-a-* ]]"
assert "the gateway answers" wait_healthy
assert "it serves lane-b" serving_release lane-b
assert "the update took a backup first" bash -c "ls -A '$STATE/backups' | grep -q ."

echo "== an update whose gateway will not start switches back =="
assert_not "the update to lane-c fails" maya_sudo "$ADMIN update --ref lane-c"
assert "current names lane-b again" bash -c "[[ $(release_of current) == lane-b-* ]]"
assert "lane-a is still the previous release" bash -c "[[ $(release_of previous) == lane-a-* ]]"
assert "the gateway answers" wait_healthy
assert "it serves lane-b" serving_release lane-b

echo "== rollback =="
maya_sudo "$ADMIN rollback"
assert "the gateway answers" wait_healthy
assert "it serves lane-a" serving_release lane-a

echo "== systemd brings a killed gateway back =="
systemctl kill -s KILL "$UNIT"
sleep 3
assert "the gateway answers again" wait_healthy

echo "== a missing passphrase stops the start instead of running unencrypted =="
mv "$PASS" "$PASS.aside"
SINCE="$(date '+%Y-%m-%d %H:%M:%S')"
systemctl restart "$UNIT" || true
sleep 20
# systemd keeps retrying and resets the unit's result at each attempt, so the
# refusal is read from what each attempt logged.
assert "systemd refused to start the gateway without its credential" \
  bash -c "journalctl -u $UNIT --since '$SINCE' --no-pager | grep -q 'status=243/CREDENTIALS'"
assert_not "the unit is not active" systemctl is-active --quiet "$UNIT"
assert_not "the gateway does not answer without its passphrase" healthy
assert_not "the corpus store is still not plaintext" plaintext_sqlite "$STATE/omnesis.db"
mv "$PASS.aside" "$PASS"
systemctl reset-failed "$UNIT" || true
systemctl restart "$UNIT"
assert "with the passphrase back, the gateway answers" wait_healthy

echo "== uninstall keeps the state and its passphrase =="
maya_sudo "$ADMIN uninstall"
assert_not "the unit is gone" test -f "$UNIT_FILE"
assert_not "the releases are gone" test -d /opt/omnesis-gateway
assert_not "the admin command is gone" test -e "$ADMIN"
assert "the state is kept" test -f "$STATE/omnesis.db"
assert "the passphrase is kept" test -f "$PASS"

echo "== a passphrase file given as a link to a root file is refused =="
as_maya "ln -s /etc/shadow ~/pass-link"
PASS_SUM="$(sha256sum "$PASS")"
assert_not "the install refuses the link" \
  maya_sudo "sh $SCRIPT install --ref lane-b --repo-url $REPO --keyring-passphrase-file /home/maya/pass-link"
assert "the passphrase in /etc is unchanged" bash -c "[[ \"\$(sha256sum $PASS)\" == '$PASS_SUM' ]]"

echo "== installing again opens the kept state =="
maya_sudo "sh $SCRIPT install --ref lane-b --repo-url $REPO"
assert "the gateway answers" wait_healthy
assert "it serves lane-b" serving_release lane-b
assert "the collector paired before is still known" \
  bash -c "'$ADMIN' cli devices list 2>/dev/null | grep -qi collector"

echo "== hardened systemd scenario PASSED =="
