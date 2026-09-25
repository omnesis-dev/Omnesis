// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 173 — an alias records every source that vouches for it, not only
 * the first one that happened to see it.
 *
 * `person_aliases` carries a single `source_id`, and every insert into that
 * table is `INSERT OR IGNORE`, so the column records whichever source observed
 * the identifier first and nothing about the ones that observed it after.
 * Removing a source then deletes on that column:
 *
 *     DELETE FROM person_aliases WHERE source_id = ?
 *
 * An address first seen in a mail header, later also asserted by a contact
 * card and by a message thread, is therefore destroyed when the mail source is
 * removed — while two live sources still assert it. If it was that person's
 * last alias, the orphan sweep that follows takes the person too, and
 * `document_people` cascades, so documents from the sources that remain lose
 * their attribution to a person the removed source merely mentioned first.
 *
 * That is most of a frequently-contacted graph, not an edge case: a contact
 * card and a mail header assert the same address by construction.
 *
 * The fix is a set rather than a column. This table is the authority for
 * deletion; `person_aliases.source_id` keeps its value and stops being asked a
 * question it cannot answer — it is the first asserter, which is all it ever
 * was.
 *
 * The backfill preserves the recorded asserter and existing document
 * provenance. Historical document-person links do not retain which alias
 * resolved the person, so their sources conservatively retain that person's
 * aliases. An incremental source may never replay those old documents.
 *
 * `COALESCE(source_id, '')` because the column is nullable and a null was
 * never matched by the removal delete either. Preserving that means the
 * assertion is equally unmatchable, which is the same behaviour by a different
 * route. The rows tagged `config` and `device:<id>` — which are not source ids
 * at all — are carried across unchanged for the same reason.
 */

import type { Db } from "./types.js";

export function addPersonAliasAssertions(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_alias_assertions (
      alias_id   TEXT NOT NULL REFERENCES person_aliases(id) ON DELETE CASCADE,
      source_id  TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL,
      PRIMARY KEY (alias_id, source_id)
    )
  `);
  // Removal keys on the source, so that is the lookup this table must serve
  // without scanning: the work has to be proportional to the source being
  // removed rather than to the size of the person graph.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_person_alias_assertions_source
       ON person_alias_assertions(source_id)`,
  );

  // An install that has not created the aliases table yet has nothing to
  // carry across; the CREATE above is all it needs.
  const aliasTable = db
    .prepare<
      [],
      { name: string }
    >("SELECT name FROM sqlite_master WHERE type='table' AND name='person_aliases'")
    .all();
  if (aliasTable.length === 0) return;

  db.exec(`
    INSERT OR IGNORE INTO person_alias_assertions (alias_id, source_id, first_seen, last_seen)
    SELECT id, COALESCE(source_id, ''), created_at, created_at FROM person_aliases
  `);

  const provenanceTables = db
    .prepare<
      [],
      { n: number }
    >("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('documents', 'document_people')")
    .get();
  if (provenanceTables?.n !== 2) return;
  db.exec(`
    INSERT OR IGNORE INTO person_alias_assertions (alias_id, source_id, first_seen, last_seen)
    SELECT a.id, provenance.source_id, a.created_at, a.created_at
      FROM person_aliases a
      JOIN (
        SELECT DISTINCT dp.person_id, d.source_id
          FROM document_people dp JOIN documents d ON d.id = dp.document_id
      ) provenance ON provenance.person_id = a.person_id
     WHERE provenance.source_id != ''
  `);
}
