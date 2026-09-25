// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/**
 * Pairing redemption receipts serve every device kind, not only agent
 * integrations: a client whose one-time code was consumed but whose response
 * was lost replays the same request with the same idempotency key and gets the
 * identical credentials back. The table keeps its columns and gains a name
 * that says so.
 */
export function renamePairingRedemptionReceipts(db: Db): void {
  const legacy = hasTable(db, "agent_pairing_redemption_receipts");
  const current = hasTable(db, "pairing_redemption_receipts");
  if (legacy && !current) {
    db.exec(`
      DROP INDEX IF EXISTS idx_agent_pairing_redemption_receipts_expiry;
      ALTER TABLE agent_pairing_redemption_receipts RENAME TO pairing_redemption_receipts;
    `);
  } else if (!current) {
    db.exec(`
      CREATE TABLE pairing_redemption_receipts (
        idempotency_key_hash TEXT PRIMARY KEY,
        pairing_code_hash TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        sealed_response TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pairing_redemption_receipts_expiry
      ON pairing_redemption_receipts(expires_at, idempotency_key_hash);
  `);
}

function hasTable(db: Db, name: string): boolean {
  return (
    db
      .prepare<
        [string],
        { present: number }
      >("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}
