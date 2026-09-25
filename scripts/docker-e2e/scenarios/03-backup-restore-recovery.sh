#!/usr/bin/env bash
# Disaster recovery: take an ONLINE encrypted backup from a secured gateway,
# then reconstitute the install on a "fresh machine" (empty config dir, empty
# keyring) from the backup + the printed recovery code alone, and prove the
# corpus data serves again.
source "$(dirname "$0")/../lib.sh"
export OMNESIS_SECRET_STORE=file

echo "== 03 backup -> restore with recovery code =="
omnesis keyring init
omnesis keyring storage-init
boot_gateway
wait_health
use_gateway_tls
omnesis tokens create --name disaster-probe --scopes read --device bootstrap >/dev/null
omnesis keyring export-recovery --json > /e2e/escrow.json
RECOVERY_CODE="$(npx tsx -e 'console.log(JSON.parse(require("fs").readFileSync("/e2e/escrow.json","utf8")).recoveryCode)')"

omnesis backup --note disaster-drill
BACKUP_DIR="$(ls -d "$OMNESIS_CONFIG_DIR"/backups/*/ | head -1)"
assert "backup produced encrypted artifacts" test -f "$BACKUP_DIR/omnesis.db.enc"
assert "backup bundles the recovery envelope" test -f "$BACKUP_DIR/keyring/recovery-envelope.json"
stop_gateway

# "Fresh machine": new config dir, and no reusable file-backend keyring.
FRESH=/e2e/fresh-config
export OMNESIS_CONFIG_DIR="$FRESH"
echo "$RECOVERY_CODE" | omnesis restore "$BACKUP_DIR" --target "$FRESH"

boot_gateway
wait_health
use_gateway_tls
assert_token_present disaster-probe
assert_not "recovered corpus re-encrypted on boot" sqlite_is_plaintext "$FRESH/omnesis.db"
stop_gateway

# Wrong code must fail and leave nothing behind.
FRESH2=/e2e/fresh-config-2
if echo "0000-0000-0000-0000-0000-0000-0000-0000" | omnesis restore "$BACKUP_DIR" --target "$FRESH2" 2>/dev/null; then
  echo "restore accepted a wrong recovery code" >&2; exit 1
fi
assert_not "wrong code left no corpus behind" test -f "$FRESH2/omnesis.db"
echo "== 03 PASSED =="
