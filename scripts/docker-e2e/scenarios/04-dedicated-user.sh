#!/usr/bin/env bash
# Dedicated-user isolation, proven with real Unix users (no systemd in the
# container): the gateway runs as its own account with an 0700 state dir; a
# different non-root account cannot read the corpus. Then the documented
# same-host topology: root administers that gateway through its state
# directory, a login account's collector pairs with a code and syncs a folder
# it owns, and neither account can read the other's files. Also exercises the
# hardened installer's non-root staging path end-to-end.
source "$(dirname "$0")/../lib.sh"
export OMNESIS_SECRET_STORE=file

echo "== 04 dedicated user =="
useradd --system --create-home omnesis-gw 2>/dev/null || true
useradd --create-home bystander 2>/dev/null || true

STATE=/var/lib/omnesis-gateway-e2e
mkdir -p "$STATE" && chown omnesis-gw:omnesis-gw "$STATE" && chmod 0700 "$STATE"
chmod 0755 /repo || true

su omnesis-gw -s /bin/bash -c "
  set -e
  cd /repo
  export OMNESIS_CONFIG_DIR='$STATE' OMNESIS_GATEWAY_PORT=$OMNESIS_GATEWAY_PORT OMNESIS_SECRET_STORE=file OMNESIS_LLAMA_GPU=false
  export OMNESIS_DB_PATH='$STATE/omnesis.db' OMNESIS_INDEX_DB_PATH='$STATE/index.db' OMNESIS_ANALYTICS_DB_PATH='$STATE/analytics.db'
  export OMNESIS_LOG_FILE='$STATE/logs/gateway.log'
  mkdir -p '$STATE/logs'
  npx tsx packages/cli/src/index.ts keyring init
  nohup npx tsx packages/gateway/src/index.ts >'$STATE/logs/gateway.stdout.log' 2>&1 </dev/null &
  echo \$! >'$STATE/gateway.pid'
"
GATEWAY_PID="$(cat "$STATE/gateway.pid")"
wait_health

# The isolation property itself: a different user cannot read the corpus.
assert_not "bystander cannot read the corpus DB" su bystander -s /bin/bash -c "head -c 1 '$STATE/omnesis.db' >/dev/null 2>&1"
assert_not "bystander cannot list the state dir" su bystander -s /bin/bash -c "ls '$STATE' >/dev/null 2>&1"
assert "the gateway process runs as omnesis-gw" bash -c "ps -o user= -p $GATEWAY_PID | grep -q omnesis-gw"

# ── A login account's collector through the dedicated gateway ──────────────
# The collector stays with the account whose files it reads. It cannot read
# the gateway's admin token to pair itself, so root mints a code through the
# gateway's state directory, the collector redeems it as itself, and its
# folder keeps the owner-only permissions it had.
useradd --create-home maya 2>/dev/null || true
chmod 0700 /home/maya
MAYA_CONFIG=/home/maya/.config/omnesis
VAULT=/home/maya/vault
NOTE="$VAULT/quarterly-plan.md"
su maya -s /bin/bash -c "
  set -e
  umask 077
  mkdir -p '$MAYA_CONFIG' '$VAULT/.obsidian'
  printf '# Quarterly plan\n\nReview the studio budget before the offsite.\n' > '$NOTE'
"

# Root, pointing the CLI at the gateway's state directory, as the docs say.
as_gateway_admin() {
  (cd "$REPO" && OMNESIS_CONFIG_DIR="$STATE" NODE_EXTRA_CA_CERTS="$STATE/tls/cert.pem" \
     npx tsx packages/cli/src/index.ts "$@")
}
PAIR_OUT="$(as_gateway_admin devices pair --kind collector 2>&1)" || { echo "$PAIR_OUT" >&2; exit 1; }
CODE="$(printf '%s\n' "$PAIR_OUT" | sed 's/\x1b\[[0-9;]*m//g' | sed -n 's/^Pairing code: *//p' | head -1 | tr -d '[:space:]')"
assert "root minted a collector code against the dedicated gateway" test -n "$CODE"

FINGERPRINT="$(node -e 'const { X509Certificate } = require("node:crypto"); const cert = new X509Certificate(require("node:fs").readFileSync(process.argv[1])); process.stdout.write(cert.fingerprint256.replace(/:/g, "").toLowerCase())' "$STATE/tls/cert.pem")"
su maya -s /bin/bash -c "
  set -e
  cd /repo
  export OMNESIS_CONFIG_DIR='$MAYA_CONFIG'
  npx tsx packages/cli/src/index.ts pair '$CODE' --gateway-url '$OMNESIS_GATEWAY_URL' \
    --trust-fingerprint 'sha256:$FINGERPRINT' --save '$MAYA_CONFIG/collector-token'
"
assert "the collector's token belongs to its own account" test "$(stat -c %U "$MAYA_CONFIG/collector-token")" = maya

su maya -s /bin/bash -c "
  cd /repo
  export OMNESIS_CONFIG_DIR='$MAYA_CONFIG' OMNESIS_GATEWAY_URL='$OMNESIS_GATEWAY_URL' OMNESIS_LLAMA_GPU=false OMNESIS_LOG_LEVEL=info
  setsid nohup npx tsx packages/cli/src/index.ts collector run >'$MAYA_CONFIG/collector.log' 2>&1 </dev/null &
  echo \$! >'$MAYA_CONFIG/collector.pid'
"
COLLECTOR_PID="$(cat "$MAYA_CONFIG/collector.pid")"
stop_collector() {
  kill -TERM "-$COLLECTOR_PID" 2>/dev/null || kill -TERM "$COLLECTOR_PID" 2>/dev/null || true
  pkill -f "index.ts collector run" 2>/dev/null || true
}
trap 'stop_collector; stop_gateway; rm -f /repo/.e2e-admin-token.mts' EXIT

# The test's own reads of the gateway go through its admin API, with the token
# the CLI would use; the admin commands above are what an operator types.
cat >/repo/.e2e-admin-token.mts <<'TS'
import { resolveToken } from "@omnesis/core";
process.stdout.write(resolveToken(process.argv[2]) ?? "");
TS
ADMIN_TOKEN="$(cd "$REPO" && npx tsx .e2e-admin-token.mts "$STATE")"
assert "the dedicated gateway's admin token is readable by root" test -n "$ADMIN_TOKEN"
api() { curl -ksf -H "Authorization: Bearer $ADMIN_TOKEN" "$OMNESIS_GATEWAY_URL$1" "${@:2}"; }
json_field() { node -e "let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => { const j = JSON.parse(s); process.stdout.write(String(($1)(j) ?? '')); });"; }

COLLECTOR_ID=""
for _ in $(seq 1 90); do
  COLLECTOR_ID="$(api /admin/devices | json_field '(j) => j.items.find((d) => d.kind === "collector" && d.online)?.id')" || true
  [[ -n "$COLLECTOR_ID" ]] && break
  sleep 1
done
if [[ -z "$COLLECTOR_ID" ]]; then tail -40 "$MAYA_CONFIG/collector.log" >&2 || true; fi
assert "the collector running as maya is online" test -n "$COLLECTOR_ID"

# A vault's account id is derived from its canonical path on the collector's
# host, so it is resolved there first, the way the portal's Add Source does.
ACCOUNT_ID="$(api /admin/sources/resolve-account -X POST -H 'Content-Type: application/json' \
  -d "{\"deviceId\":\"$COLLECTOR_ID\",\"descriptorId\":\"obsidian-notes\",\"params\":{\"vaultPath\":\"$VAULT\"}}" |
  json_field '(j) => j.accountId')"
assert "maya's collector resolved the vault's account" test -n "$ACCOUNT_ID"
ADD_BODY="{\"deviceId\":\"$COLLECTOR_ID\",\"descriptorId\":\"obsidian-notes\",\"accountIds\":[\"$ACCOUNT_ID\"],\"params\":{\"vaultPath\":\"$VAULT\"}}"
if ! api /admin/sources/add -X POST -H 'Content-Type: application/json' -d "$ADD_BODY" >/e2e/add-source.json; then
  curl -ks -H "Authorization: Bearer $ADMIN_TOKEN" -X POST -H 'Content-Type: application/json' \
    -d "$ADD_BODY" -w '\nHTTP %{http_code}\n' "$OMNESIS_GATEWAY_URL/admin/sources/add" >&2 || true
  echo "  FAILED: the gateway accepted the source on maya's collector" >&2
  exit 1
fi

DOCS=0
for _ in $(seq 1 120); do
  DOCS="$(api /status | json_field '(j) => Object.entries(j.documents?.bySource ?? {}).filter(([id]) => id.startsWith("obsidian-notes")).reduce((n, [, c]) => n + c, 0)')" || DOCS=0
  [[ "${DOCS:-0}" -ge 1 ]] && break
  sleep 1
done
if [[ "${DOCS:-0}" -lt 1 ]]; then tail -60 "$MAYA_CONFIG/collector.log" >&2 || true; fi
assert "the note reached the dedicated gateway through maya's collector" test "${DOCS:-0}" -ge 1

assert "the note is still readable by maya alone" test "$(stat -c '%a %U' "$NOTE")" = "600 maya"
assert "maya's home is still closed to other accounts" test "$(stat -c '%a' /home/maya)" = "700"
assert_not "the gateway account cannot read maya's note" su omnesis-gw -s /bin/bash -c "head -c 1 '$NOTE' >/dev/null 2>&1"
assert_not "maya cannot list the dedicated gateway's state" su maya -s /bin/bash -c "ls '$STATE' >/dev/null 2>&1"
assert "the collector runs as maya" bash -c "ps -o user= -p $COLLECTOR_PID | grep -q maya"
stop_collector
stop_gateway

# A normal account's `service install gateway --hardened` writes no unit: it
# prints the one root command that installs a release root fetches and owns.
# That command runs for real, under systemd, in scripts/docker-e2e/systemd.
su bystander -s /bin/bash -c "cd /repo && npx tsx packages/cli/src/index.ts service install gateway --hardened" > /e2e/hardened-out.txt 2>&1 || true
assert "prints the root install command" grep -q "hardened-gateway.sh | sudo" /e2e/hardened-out.txt
assert "names a release to install" grep -qE -- "install --(version|ref) " /e2e/hardened-out.txt
assert_not "stages no unit file" bash -c "ls /tmp/omnesis-hardened-* >/dev/null 2>&1"
assert_not "nothing was written to /etc/systemd" test -f /etc/systemd/system/omnesis-gateway.service
echo "== 04 PASSED =="
