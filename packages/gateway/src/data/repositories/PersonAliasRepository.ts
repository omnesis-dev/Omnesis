// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { randomUUID } from "node:crypto";

/**
 * Writing an identifier and recording who vouches for it, as one act.
 *
 * `person_aliases` is `INSERT OR IGNORE` on `(alias_type, alias, person_id)`,
 * so its `source_id` column records only the FIRST source to see an
 * identifier and cannot record a second. `person_alias_assertions` is the
 * ledger that can, and removing a source withdraws that source's assertions
 * and drops only the identifiers nothing else vouches for.
 *
 * Which makes an alias written without an assertion invisible to that
 * bookkeeping in the worst possible direction: an address the operator
 * configured, or a device reported, is inserted first and never vouched for,
 * so when a mail source that also asserts it is removed, the withdrawal finds
 * no other voucher and takes it. The operator's own identifier disappears
 * because they removed an unrelated source.
 *
 * So the insert and the assertion live in one place, and every writer goes
 * through it. Statements are prepared once per writer because the resolver
 * calls this per mention on the single writer thread.
 */
export interface AliasWriter {
  /**
   * Insert the identifier if it is new to this person, and record that this
   * source vouches for it either way — the insert being ignored is exactly
   * the case the assertion exists for.
   *
   * Returns whether the person gained an identifier they did not have, which
   * is a different question from whether this source now vouches for one.
   */
  claim(personId: string, aliasType: string, alias: string): boolean;
  /**
   * Record the vouch for an identifier a caller's own statement inserted.
   * For a writer that needs its own INSERT (the name path keeps an occurrence
   * tally), so that it still lands in the ledger.
   */
  vouch(personId: string, aliasType: string, alias: string): void;
}

/** Statements for one source's alias writes, at one instant. */
export function aliasWriter(db: Db, sourceId: string, at: string): AliasWriter {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // Selected by the alias's unique key rather than by the id the insert would
  // have used, because on a conflict that id was never written.
  //
  // A re-observation writes nothing. What this table answers is whether a
  // source vouches for an identifier, and that does not change on seeing it
  // again — while people resolution runs this per identifier per mention per
  // document, so an UPDATE here would dirty a page and a WAL frame on the
  // single writer for every one of them, on a bootstrap measured in millions.
  const assert = db.prepare(
    `INSERT INTO person_alias_assertions (alias_id, source_id, first_seen, last_seen)
     SELECT id, ?, ?, ? FROM person_aliases
      WHERE alias_type = ? AND alias = ? AND person_id = ?
     ON CONFLICT(alias_id, source_id) DO NOTHING`,
  );
  const vouch = (personId: string, aliasType: string, alias: string): void => {
    assert.run(sourceId, at, at, aliasType, alias, personId);
  };
  return {
    claim(personId, aliasType, alias) {
      const inserted =
        insert.run(randomUUID(), personId, alias, aliasType, sourceId, at).changes > 0;
      vouch(personId, aliasType, alias);
      return inserted;
    },
    vouch,
  };
}

/**
 * Withdraw one source's claim on the identifiers it vouched for, and drop the
 * ones nothing else vouches for any more.
 *
 * What makes this two statements rather than one delete is that the ledger is
 * both the thing being withdrawn and the evidence for keeping a row. The
 * orphans are removed first, while this source's own assertions are still
 * there to name them; the `!= ?` is what stops a source's own vouch counting
 * as the other voucher that would save the row. Deleting a `person_aliases`
 * row cascades to every assertion on it, so the second statement clears what
 * the first left: this source's vouches for identifiers other sources keep
 * alive.
 *
 * Both statements are index seeks on `source_id` and on the assertions'
 * `(alias_id, …)` key, so the wipe costs the source's own identifier count and
 * not the size of the person graph. It runs as one op on the writer thread,
 * where nothing else can interleave between the two.
 */
export function retractAliasAssertions(db: Db, sourceId: string): void {
  db.prepare(
    `DELETE FROM person_aliases
      WHERE id IN (SELECT alias_id FROM person_alias_assertions WHERE source_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM person_alias_assertions a
           WHERE a.alias_id = person_aliases.id AND a.source_id != ?
        )`,
  ).run(sourceId, sourceId);
  db.prepare("DELETE FROM person_alias_assertions WHERE source_id = ?").run(sourceId);
}
