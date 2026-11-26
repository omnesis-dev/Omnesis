// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The corpus read behind a recording's suggestions: who was invited to a
 * calendar event.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

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
