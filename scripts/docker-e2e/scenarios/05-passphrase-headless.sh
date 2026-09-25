#!/usr/bin/env bash
# Headless passphrase keyring: init + boot with a boot-time passphrase (no
# Secret Service anywhere in the container), corpus born encrypted; a WRONG
# passphrase at boot refuses to run rather than serving plaintext.
source "$(dirname "$0")/../lib.sh"
export OMNESIS_SECRET_STORE=passphrase
export OMNESIS_KEYRING_PASSPHRASE="drill passphrase for the container"

echo "== 05 passphrase headless =="
omnesis keyring init
omnesis keyring storage-init
boot_gateway
wait_health
use_gateway_tls
omnesis tokens create --name headless-probe --scopes read --device bootstrap >/dev/null
assert_not "corpus is encrypted under the passphrase keyring" sqlite_is_plaintext "$OMNESIS_CONFIG_DIR/omnesis.db"
assert "no plaintext root key on disk" bash -c "! grep -rq omn_root_v1_ '$OMNESIS_CONFIG_DIR/keyring/passphrase/'"
stop_gateway

export OMNESIS_KEYRING_PASSPHRASE="wrong passphrase entirely"
boot_gateway
expect_boot_refusal "cannot be read"

export OMNESIS_KEYRING_PASSPHRASE="drill passphrase for the container"
boot_gateway
wait_health
assert_token_present headless-probe
echo "== 05 PASSED =="
