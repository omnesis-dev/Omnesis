#!/usr/bin/env bash
# Gateway-boot auto-migration of an EXISTING plaintext corpus, and its crash
# safety. A user who enables at-rest encryption on a running install hits this
# exact path once: seed a plaintext corpus + a durable token row, arm encryption
# (keyring init + storage-init) while the corpus is still plaintext, then let the
# gateway migrate the live SQLite stores in place on boot.
#
# The migration copies to a temp sibling, rekeys the copy, fsyncs, and atomically
# renames it over the original — so a kill -9 at any point leaves either the
# original plaintext file or the finished encrypted file, never a corrupt half.
# We hard-kill mid-boot (catching the `.encrypting-*` temp when we can), prove the
# row is never lost, and prove a final clean boot finishes encrypted.
source "$(dirname "$0")/../lib.sh"
export OMNESIS_SECRET_STORE=file

echo "== 06 boot migration crash-safety =="

# 1. Seed a plaintext corpus with a durable row.
boot_gateway
wait_health
use_gateway_tls
omnesis tokens create --name migration-probe --scopes read --device bootstrap >/dev/null
stop_gateway
assert "corpus starts plaintext" sqlite_is_plaintext "$OMNESIS_CONFIG_DIR/omnesis.db"

# 2. Arm at-rest encryption while the corpus is still plaintext. The next boot
#    opens the stores with a key, which migrates the plaintext files in place.
omnesis keyring init >/dev/null
omnesis keyring storage-init >/dev/null
assert "corpus still plaintext before the migrating boot" sqlite_is_plaintext "$OMNESIS_CONFIG_DIR/omnesis.db"

# 3. Crash injection: boot, hard-kill the process group mid-boot (catching the
#    migration temp when the race allows), and prove the corpus is never lost.
#    Two rounds exercise the interrupted-then-retried path.
for attempt in 1 2; do
  boot_gateway
  caught_temp=0
  for _ in $(seq 1 100); do
    if ls "$OMNESIS_CONFIG_DIR"/omnesis.db.encrypting-* >/dev/null 2>&1; then
      caught_temp=1
      break
    fi
    curl -ksf "$OMNESIS_GATEWAY_URL/health" >/dev/null 2>&1 && break
    kill -0 "$GATEWAY_PID" 2>/dev/null || break
    sleep 0.02
  done
  kill -KILL "-$GATEWAY_PID" 2>/dev/null || true
  pkill -9 -f "tsx packages/gateway/src/index.ts" 2>/dev/null || true
  stop_gateway
  echo "  attempt $attempt: caught-migration-temp=$caught_temp"
  # The atomic rename guarantees a whole file survives an interrupted migration.
  assert "corpus file survives the interrupted migration" test -s "$OMNESIS_CONFIG_DIR/omnesis.db"
done

# 4. Final clean boot: the migration retries and finishes.
boot_gateway
wait_health
use_gateway_tls
assert_not "corpus is encrypted after the migration completes" sqlite_is_plaintext "$OMNESIS_CONFIG_DIR/omnesis.db"
assert_token_present migration-probe
assert_not "no orphaned .encrypting- temp remains" ls "$OMNESIS_CONFIG_DIR"/omnesis.db.encrypting-*
stop_gateway
echo "== 06 PASSED =="
