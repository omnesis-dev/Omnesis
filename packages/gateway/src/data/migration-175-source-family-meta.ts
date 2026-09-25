// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/**
 * Migration 175 — a source family's display identity, declared rather than
 * inferred from one of its accounts.
 *
 * `sync_state` holds one row per source, and its display columns are that
 * source's own: for an accounted source they are whatever its instance chose,
 * which for a source that labels each connection by institution is the
 * institution's name and logo. Clients that show a source by family read
 * through the type. Assembling that entry from account rows names the family
 * after whichever member a scan reaches first, which for such a source is one
 * institution's name and logo standing for all of them.
 *
 * The family is its own fact, so it gets its own row. `source_type` is the
 * key, and there is deliberately no foreign key to `sources`: the declaration
 * arrives with the collector's meta push and is meaningful before any account
 * of that type has synced.
 */
export function addSourceFamilyMeta(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_family_meta (
      source_type TEXT PRIMARY KEY,
      icon TEXT,
      label TEXT,
      bg_color TEXT,
      accent_color TEXT,
      updated_at TEXT NOT NULL
    )
  `);
}
