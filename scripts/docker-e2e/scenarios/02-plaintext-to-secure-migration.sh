#!/usr/bin/env bash
# The `omnesis secure` wizard on an EXISTING plaintext install: boot plaintext,
# write data, stop, run the wizard offline (snapshot + key + escrow + storage
# keys), restart -> databases encrypted in place, data intact, and the
# pre-migration snapshot supports --rollback.
source "$(dirname "$0")/../lib.sh"
export OMNESIS_SECRET_STORE=file

echo "== 02 plaintext -> secure migration =="
boot_gateway
wait_health
use_gateway_tls
omnesis tokens create --name pre-migration-probe --scopes read --device bootstrap >/dev/null
stop_gateway

assert "corpus starts plaintext" sqlite_is_plaintext "$OMNESIS_CONFIG_DIR/omnesis.db"

# Wizard (offline path; gateway stopped). Capture the recovery code.
SECURE_OUT="$(omnesis secure --json)"
RECOVERY_CODE="$(printf '%s' "$SECURE_OUT" | npx tsx -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).recoveryCode)})')"
[[ -n "$RECOVERY_CODE" && "$RECOVERY_CODE" != "undefined" ]] || { echo "no recovery code in wizard output" >&2; exit 1; }
export RECOVERY_CODE
assert "recovery envelope written" test -f "$OMNESIS_CONFIG_DIR/keyring/recovery-envelope.json"
assert "pre-secure snapshot recorded" test -f "$OMNESIS_CONFIG_DIR/keyring/secure-wizard.json"

boot_gateway
wait_health
assert_not "corpus is encrypted after the migration restart" sqlite_is_plaintext "$OMNESIS_CONFIG_DIR/omnesis.db"
assert_token_present pre-migration-probe

# Marker tamper: corrupt the MAC-bound marker -> next boot refuses.
stop_gateway
sed -i 's/^mac=/mac=AAAA/' "$OMNESIS_CONFIG_DIR/keyring/storage-encryption-required"
boot_gateway
expect_boot_refusal "failed integrity verification"
# Repair by restoring a valid marker via storage-init, then prove recovery.
omnesis keyring storage-init >/dev/null
boot_gateway
wait_health
echo "$RECOVERY_CODE" > /e2e/recovery-code   # handed to scenario 03
cp -r "$OMNESIS_CONFIG_DIR" /e2e/secured-config-snapshot
stop_gateway
echo "== 02 PASSED =="
