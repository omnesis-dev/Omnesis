// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The corpus reads behind a recording's suggestions: who a name heard in the
 * transcript is, and who was invited to a calendar event.
 */

import { PERSON_NAME_ALIAS_INDEX } from "../data/migration-218-person-name-alias-index.js";
import type { NameResolution } from "./suggestions.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** More people than this by one name and the name is offered on its own. */
const MAX_NAMESAKES = 1;

/**
 * Who a given name heard in a conversation is: the one person, the owner left
 * out, whose name is it or starts with it ("Jamie" for "Jamie Rowe"). Merged
 * people resolve to whom they were merged into. Several people, or nobody, and
 * the name stands on its own.
 */
export function resolveGivenName(db: Db, name: string): NameResolution {
  const lower = name.toLowerCase();
  // One range on the lowercased-name index: from "jamie" up to "jamie!", the
  // byte after the space, holds "jamie" and "jamie rowe" but not "jamieson".
  // The planner prefers the covering (alias_type, alias) index without
  // statistics, so the name index is named, as migration 218 asks.
  const rows = db
    .prepare<{ from: string; to: string }, { id: string; name: string }>(
      `WITH RECURSIVE
         hit(person_id) AS (
           SELECT person_id FROM person_aliases INDEXED BY ${PERSON_NAME_ALIAS_INDEX}
            WHERE alias_type = 'name' AND LOWER(alias) >= @from AND LOWER(alias) < @to
         ),
         canonical(person_id) AS (
           SELECT person_id FROM hit
           UNION
           SELECT p.merged_into FROM canonical c JOIN people p ON p.id = c.person_id
            WHERE p.merged_into IS NOT NULL
         )
       SELECT p.id, p.canonical_name AS name
         FROM people p JOIN canonical c ON c.person_id = p.id
        WHERE p.merged_into IS NULL AND COALESCE(p.is_self, 0) = 0
        LIMIT ${MAX_NAMESAKES + 1}`,
    )
    .all({ from: lower, to: `${lower}!` });
  if (rows.length !== 1) return { kind: "name" };
  const row = rows[0]!;
  return { kind: "person", personId: row.id, name: row.name || name };
}

/** Who a document names as invited to it (attendees and organizer), the owner left out. */
export function eventAttendees(
  db: Db,
  documentId: string,
): Array<{ personId: string; name: string }> {
  return db
    .prepare<[string], { personId: string; name: string }>(
      `SELECT DISTINCT p.id AS personId, p.canonical_name AS name
         FROM document_people dp
         JOIN people p ON p.id = dp.person_id
        WHERE dp.document_id = ?
          AND dp.role IN ('attendee', 'author', 'organizer')
          AND p.merged_into IS NULL
          AND COALESCE(p.is_self, 0) = 0
        ORDER BY p.canonical_name`,
    )
    .all(documentId)
    .filter((row) => row.name);
}
