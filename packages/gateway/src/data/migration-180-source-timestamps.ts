// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/**
 * Migration 180 — a source's timestamps are milliseconds, as every reader of
 * them assumes.
 *
 * `sources.created_at` and `sources.updated_at` are epoch milliseconds: the
 * number the gateway orders rows by, and the number the iOS and Android
 * clients decode as a 64-bit integer when they read `/admin/sources`. SQLite
 * stores what a binding holds rather than what the column declares, so a
 * writer that passed an ISO-8601 string did not fail — it left rows whose
 * timestamp is text. One such row fails the clients' decode of the entire
 * page, which costs them every source on it, and no numeric comparison ever
 * orders it.
 *
 * Each text timestamp is parsed back to milliseconds. A value that parses as
 * neither a date nor a number falls back to the row's other timestamp, and
 * then to this run's clock, so every row ends decodable rather than some being
 * left behind for the same decode to trip over. Rows already holding an
 * integer are left untouched, which is also what makes a re-run a no-op.
 */
export function normalizeSourceTimestamps(db: Db): void {
  const damaged = db
    .prepare<[], { id: string; created_at: unknown; updated_at: unknown }>(
      `SELECT id, created_at, updated_at FROM sources
        WHERE typeof(created_at) <> 'integer' OR typeof(updated_at) <> 'integer'`,
    )
    .all();
  if (damaged.length === 0) return;
  const fallback = Date.now();
  const repair = db.prepare("UPDATE sources SET created_at = ?, updated_at = ? WHERE id = ?");
  for (const row of damaged) {
    const created = millis(row.created_at);
    const updated = millis(row.updated_at);
    repair.run(created ?? updated ?? fallback, updated ?? created ?? fallback, row.id);
  }
}

/** Epoch milliseconds for a stored timestamp, or null when it says nothing. */
function millis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}
