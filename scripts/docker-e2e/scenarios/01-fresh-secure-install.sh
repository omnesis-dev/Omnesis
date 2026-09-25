#!/usr/bin/env bash
# Fresh secure install on headless Linux: keyring init (file backend) before
# first boot -> the corpus databases are BORN encrypted, markers are armed,
# and data written through the API survives a restart.
source "$(dirname "$0")/../lib.sh"
export OMNESIS_SECRET_STORE=file

echo "== 01 fresh secure install =="
omnesis keyring init
omnesis keyring storage-init

boot_gateway
wait_health
use_gateway_tls

# Real corpus-DB write through the API.
omnesis tokens create --name e2e-probe --scopes read --device bootstrap >/dev/null

assert_not "omnesis.db is not plaintext on disk" sqlite_is_plaintext "$OMNESIS_CONFIG_DIR/omnesis.db"
assert_not "index.db is not plaintext on disk" sqlite_is_plaintext "$OMNESIS_CONFIG_DIR/index.db"
assert "storage marker is armed" test -f "$OMNESIS_CONFIG_DIR/keyring/storage-encryption-required"
assert "wrapped main-db key exists" test -f "$OMNESIS_CONFIG_DIR/keyring/storage-keys/main-db.json"

stop_gateway
boot_gateway
wait_health
assert_token_present e2e-probe
echo "== 01 PASSED =="
