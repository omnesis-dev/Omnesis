// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;

const RECANONICALIZE_FINGERPRINT_KEY = "recanonicalize_source_url_fingerprint";

/** Create the generic key/value store used by URL canonicalization maintenance. */
export function createCanonicalizationStateTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS canonicalization_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

/** Read the spec-set fingerprint the last full source-URL recompute used. */
export function getRecanonicalizeFingerprint(db: Db): string | null {
  const row = db
    .prepare<[string], { value: string }>("SELECT value FROM canonicalization_state WHERE key = ?")
    .get(RECANONICALIZE_FINGERPRINT_KEY);
  return row?.value ?? null;
}

/** Record the spec-set fingerprint a full source-URL recompute just completed. */
export function setRecanonicalizeFingerprint(db: Db, fingerprint: string): void {
  const now = new Date().toISOString();
  db.prepare<unknown[]>(
    `INSERT INTO canonicalization_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(RECANONICALIZE_FINGERPRINT_KEY, fingerprint, now);
}
