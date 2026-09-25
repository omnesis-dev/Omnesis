// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import type { DocumentPersonLink, PeopleBaseStats } from "../../people.js";

/**
 * Lightweight bulk variant of `getDocumentPeople` used by portal list
 * views (search results, source-recent, person-detail docs) to render
 * overlapping people-bubbles. Returns a slim shape per doc — no
 * aliases — and caps the per-doc list at `perDocLimit` while still
 * reporting the full count so the UI can render a "+N" overflow chip.
 *
 * One SQL pass over `document_people` for the whole batch (DISTINCT
 * canonical per doc). Documents with no resolved people get `[]`.
 */
export interface DocumentPeopleSummary {
  people: Array<{
    personId: string;
    canonicalName: string;
    role: string;
    isSelf: boolean;
  }>;
  total: number;
}

export interface PersonDocumentEntry {
  id: string;
  roles: string[];
}

export function getDocumentPeople(db: Db, docId: string): DocumentPersonLink[] {
  // Dereference dp.person_id to its canonical via the (collapsed)
  // merged_into chain. Without this, a document attributed to a
  // logically-merged loser would silently drop from the result —
  // because the loser's row has merged_into != NULL, the old
  // `WHERE p.merged_into IS NULL` filter would exclude them.
  //
  // Two-hop join handles both already-canonical (loser_id has
  // merged_into = NULL → COALESCE = self) and merged-via-rule cases.
  // Chain depth is capped at 1 by the eval pass's transitive collapse,
  // so a single deref is sufficient.
  //
  // Roles for the same canonical from multiple original person rows
  // (e.g. the loser was both `sender` AND the winner was `recipient`
  // on the same doc) are merged via DISTINCT — keep both roles.
  const rows = db
    .prepare<
      [string],
      {
        canonical_id: string;
        canonical_name: string;
        role: string;
        is_self: number;
      }
    >(
      `SELECT DISTINCT
              canonical.id AS canonical_id,
              canonical.canonical_name,
              dp.role,
              canonical.is_self
       FROM document_people dp
       JOIN people p ON p.id = dp.person_id
       JOIN people canonical
         ON canonical.id = COALESCE(p.merged_into, p.id)
        AND canonical.merged_into IS NULL
       WHERE dp.document_id = ?
       ORDER BY dp.role, canonical.canonical_name`,
    )
    .all(docId);

  return rows.map((r) => {
    // Aliases for the canonical: union across every person in the
    // equivalence class (canonical itself + everyone with
    // merged_into = canonical_id). Mirrors the logical-merge invariant
    // that the canonical owns ALL aliases of its merged losers from a
    // user's perspective.
    const aliases = db
      .prepare<
        [string, string],
        { id: string; alias_type: string; alias: string; source_id: string | null }
      >(
        `SELECT pa.id, pa.alias_type, pa.alias, pa.source_id
         FROM person_aliases pa
         WHERE pa.person_id = ?
            OR pa.person_id IN (SELECT id FROM people WHERE merged_into = ?)
         ORDER BY pa.alias_type, pa.alias`,
      )
      .all(r.canonical_id, r.canonical_id)
      .map((a) => ({
        id: a.id,
        aliasType: a.alias_type,
        alias: a.alias,
        sourceId: a.source_id,
      }));

    return {
      personId: r.canonical_id,
      canonicalName: r.canonical_name,
      role: r.role,
      isSelf: !!r.is_self,
      aliases,
    };
  });
}

export function getDocumentsPeopleSummary(
  db: Db,
  docIds: string[],
  perDocLimit = 8,
): Record<string, DocumentPeopleSummary> {
  const result: Record<string, DocumentPeopleSummary> = {};
  if (docIds.length === 0) return result;
  for (const id of docIds) result[id] = { people: [], total: 0 };

  const placeholders = docIds.map(() => "?").join(",");
  const rows = db
    .prepare<
      string[],
      {
        document_id: string;
        canonical_id: string;
        canonical_name: string;
        role: string;
        is_self: number;
      }
    >(
      `SELECT DISTINCT
              dp.document_id,
              canonical.id AS canonical_id,
              canonical.canonical_name,
              dp.role,
              canonical.is_self
       FROM document_people dp
       JOIN people p ON p.id = dp.person_id
       JOIN people canonical
         ON canonical.id = COALESCE(p.merged_into, p.id)
        AND canonical.merged_into IS NULL
       WHERE dp.document_id IN (${placeholders})
       ORDER BY dp.document_id, canonical.is_self DESC, dp.role, canonical.canonical_name`,
    )
    .all(...docIds);

  // Group by document, collapse duplicate canonicals (same person can
  // appear under multiple roles), keep first role encountered.
  const seenPerDoc: Record<string, Set<string>> = {};
  for (const r of rows) {
    const bucket = result[r.document_id];
    if (!bucket) continue;
    const seen = (seenPerDoc[r.document_id] ??= new Set());
    if (seen.has(r.canonical_id)) continue;
    seen.add(r.canonical_id);
    bucket.total += 1;
    if (bucket.people.length < perDocLimit) {
      bucket.people.push({
        personId: r.canonical_id,
        canonicalName: r.canonical_name,
        role: r.role,
        isSelf: !!r.is_self,
      });
    }
  }
  return result;
}

export function getPersonDocuments(
  db: Db,
  personId: string,
  opts?: { role?: string; limit?: number; offset?: number },
): PersonDocumentEntry[] {
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  // Conditional behavior based on whether this row is a canonical or
  // a logical-merge loser:
  //
  //   - Canonical (`merged_into IS NULL`): UNION across the
  //     equivalence class — include this row's own `document_people`
  //     rows AND every merged-loser's. Logical merge doesn't move
  //     `document_people` entries, so without this UNION the canonical
  //     page would hide every doc the losers were originally on.
  //
  //   - Loser (`merged_into IS NOT NULL`): only this row's own
  //     `document_people` rows. The operator clicked a loser link
  //     (typically from the merge-rules page) precisely to see the
  //     loser's pre-merge state — what aliases this row carries and
  //     which docs surfaced them. UNIONing here would show the
  //     canonical's docs too, defeating the purpose.
  const row = db
    .prepare<
      [string],
      { merged_into: string | null }
    >("SELECT merged_into FROM people WHERE id = ?")
    .get(personId);
  const isCanonical = row?.merged_into == null;

  // GROUP_CONCAT collapses the (DISTINCT doc, role) rows into one row
  // per doc with a comma-joined role list. The role filter (when set)
  // narrows the GROUP rows but the joined list still reflects every
  // matching role for that doc.
  //
  // Rows come back newest-first, ordered by the joined document's
  // `source_created_at` — the same timestamp every client renders as the
  // per-row "time ago" — so the person page leads with the most recent
  // documents. `document_id` is a stable tiebreaker, which keeps
  // offset-based pagination deterministic when several docs share a
  // timestamp. The join to `documents` is 1:1 (document_people.document_id
  // references documents.id), so it neither drops rows nor inflates the
  // DISTINCT role list.
  type Row = { document_id: string; roles: string };

  let rows: Row[];
  if (opts?.role) {
    rows = isCanonical
      ? db
          .prepare<[string, string, string, number, number], Row>(
            `SELECT dp.document_id, GROUP_CONCAT(DISTINCT dp.role) AS roles
             FROM document_people dp JOIN documents d ON d.id = dp.document_id
             WHERE (dp.person_id = ? OR dp.person_id IN (SELECT id FROM people WHERE merged_into = ?))
               AND dp.role = ?
             GROUP BY dp.document_id
             ORDER BY d.source_created_at DESC, dp.document_id
             LIMIT ? OFFSET ?`,
          )
          .all(personId, personId, opts.role, limit, offset)
      : db
          .prepare<[string, string, number, number], Row>(
            `SELECT dp.document_id, GROUP_CONCAT(DISTINCT dp.role) AS roles
             FROM document_people dp JOIN documents d ON d.id = dp.document_id
             WHERE dp.person_id = ? AND dp.role = ?
             GROUP BY dp.document_id
             ORDER BY d.source_created_at DESC, dp.document_id
             LIMIT ? OFFSET ?`,
          )
          .all(personId, opts.role, limit, offset);
  } else {
    rows = isCanonical
      ? db
          .prepare<[string, string, number, number], Row>(
            `SELECT dp.document_id, GROUP_CONCAT(DISTINCT dp.role) AS roles
             FROM document_people dp JOIN documents d ON d.id = dp.document_id
             WHERE dp.person_id = ?
                OR dp.person_id IN (SELECT id FROM people WHERE merged_into = ?)
             GROUP BY dp.document_id
             ORDER BY d.source_created_at DESC, dp.document_id
             LIMIT ? OFFSET ?`,
          )
          .all(personId, personId, limit, offset)
      : db
          .prepare<[string, number, number], Row>(
            `SELECT dp.document_id, GROUP_CONCAT(DISTINCT dp.role) AS roles
             FROM document_people dp JOIN documents d ON d.id = dp.document_id
             WHERE dp.person_id = ?
             GROUP BY dp.document_id
             ORDER BY d.source_created_at DESC, dp.document_id
             LIMIT ? OFFSET ?`,
          )
          .all(personId, limit, offset);
  }

  return rows.map((r) => ({
    id: r.document_id,
    roles: r.roles ? r.roles.split(",") : [],
  }));
}

export function getSelfPersonId(db: Db): string | null {
  const row = db
    .prepare<
      [],
      { id: string }
    >("SELECT id FROM people WHERE is_self = TRUE AND merged_into IS NULL LIMIT 1")
    .get();
  return row?.id ?? null;
}

export function getPeopleStats(db: Db): PeopleBaseStats {
  const people = db
    .prepare<[], { c: number }>("SELECT COUNT(*) as c FROM people WHERE merged_into IS NULL")
    .get()!.c;
  const aliases = db.prepare<[], { c: number }>("SELECT COUNT(*) as c FROM person_aliases").get()!
    .c;
  const links = db.prepare<[], { c: number }>("SELECT COUNT(*) as c FROM document_people").get()!.c;
  const self = getSelfPersonId(db) !== null;

  return { totalPeople: people, totalAliases: aliases, totalLinks: links, selfDetected: self };
}
