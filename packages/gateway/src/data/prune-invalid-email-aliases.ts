// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Remove `email` person-aliases whose domain ends in a non-existent top-level
 * domain — parser artifacts, not real addresses.
 *
 * Upstream extraction can glue stray text onto an address, producing aliases
 * whose domain is extended past its true TLD (a real local part followed by a
 * domain ending in a label that is not a real TLD). These pollute the people
 * graph: they become spurious identity
 * aliases, show as garbage chips on the person card, and act as false match
 * magnets in merge detection.
 *
 * Alias creation now rejects these at the source (`hasValidEmailTld` gates the
 * resolver and the candidate detector), so no new ones appear. This one-time
 * sweep removes the ones recorded before that gate landed. Idempotent — a replay
 * finds none. Conservative: it deletes only `email` aliases whose final domain
 * label is not a real IANA TLD (or a reserved test TLD); every well-formed
 * address is left untouched. Document attribution keys on `person_id`, not on
 * the alias, so removing a bad alias never orphans a document.
 */

import { hasValidEmailTld } from "@omnesis/core";
import type { Db } from "./types.js";

/** Returns the number of invalid-TLD email aliases removed. */
export function pruneInvalidEmailAliases(db: Db): number {
  const rows = db
    .prepare<
      [],
      { id: string; alias: string }
    >(`SELECT id, alias FROM person_aliases WHERE alias_type = 'email'`)
    .all();
  const del = db.prepare(`DELETE FROM person_aliases WHERE id = ?`);
  let removed = 0;
  for (const r of rows) {
    if (!hasValidEmailTld(r.alias)) {
      del.run(r.id);
      removed += 1;
    }
  }
  return removed;
}
