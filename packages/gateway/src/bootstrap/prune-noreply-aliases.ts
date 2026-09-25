// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { isNonIdentifyingEmail, normalizeEmail } from "@omnesis/core";
import { markPeopleGraphDirty, markMergeRulesDirty } from "../data/DirtyMarks.js";
import { loadNonIdentifyingEmails } from "../data/repositories/PersonRepository.js";

/**
 * One-shot boot data fix that pairs with the resolution-time no-reply
 * filter in PeopleResolutionService.
 *
 * Shared no-reply addresses (`comments-noreply@docs.google.com`,
 * `notifications-noreply@linkedin.com`, …) used to be inserted as
 * `email` aliases on extracted people. Because the same SMTP address
 * fronts every notification regardless of author, multiple unrelated
 * authors ended up routed onto a single bucket person, which the
 * auto-merge pass then collapsed into whichever real person matched one
 * of the accreted name aliases — silently misattributing every
 * platform-notification email to that person.
 *
 * Resolution now drops these emails before identity decisions, but
 * pre-existing bad state remains in `person_aliases` (the offending
 * email rows) and in `document_people` (links to the wrongly-merged
 * bucket person). This pass:
 *
 *   1. Deletes every `email` alias that is non-identifying — either matched
 *      by the static `isNonIdentifyingEmail` heuristic or present in the
 *      learned `non_identifying_emails` blocklist (shared addresses the
 *      heuristic can't name, recorded by `demoteSharedAddresses`).
 *   2. Clears `people_resolved_at` on every document linked to any
 *      affected person (directly, or via `merged_into` to a canonical
 *      whose equivalence class contained an affected person). The
 *      scheduled people backfill re-resolves these documents with the
 *      new filter applied — Docs comment notifications end up
 *      unattributed (their only mention had a non-identifying email);
 *      legitimate emails from the real person / etc. re-link to the
 *      same canonical via their real email, idempotently.
 *
 * Idempotent: with the resolution-time filter in place no new
 * noreply alias rows can appear, so subsequent boots see no rows to
 * delete and short-circuit before scheduling any backfill work.
 */
export function pruneNoreplyAliases(db: Db): {
  aliasesRemoved: number;
  documentsToRebackfill: number;
} {
  const learned = loadNonIdentifyingEmails(db);
  const offenders = db
    .prepare<[], { id: string; person_id: string; alias: string }>(
      "SELECT id, person_id, alias FROM person_aliases WHERE alias_type = 'email'",
    )
    .all()
    .filter((r) => isNonIdentifyingEmail(r.alias) || learned.has(normalizeEmail(r.alias)));

  if (offenders.length === 0) {
    return { aliasesRemoved: 0, documentsToRebackfill: 0 };
  }

  const txn = db.transaction(() => {
    // Collect every person id touched by the pruning, plus every
    // person they're merged into — `document_people` rows are
    // attributed to canonicals, so we have to clear the canonical's
    // documents too.
    const affected = new Set<string>();
    const resolveCanonical = db.prepare<[string], { merged_into: string | null }>(
      "SELECT merged_into FROM people WHERE id = ?",
    );
    for (const row of offenders) {
      let id: string | null = row.person_id;
      let hops = 0;
      while (id && hops < 10) {
        affected.add(id);
        const next = resolveCanonical.get(id);
        if (!next?.merged_into) break;
        id = next.merged_into;
        hops += 1;
      }
    }

    // Also collect anyone whose canonical IS one of the affected
    // people (a different bucket merged into the same canonical). Those
    // bucket-people's docs are equally suspect.
    const reachStmt = db.prepare<[string], { id: string }>(
      "SELECT id FROM people WHERE merged_into = ?",
    );
    const queue = [...affected];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const r of reachStmt.all(id)) {
        if (!affected.has(r.id)) {
          affected.add(r.id);
          queue.push(r.id);
        }
      }
    }

    const ids = [...affected];
    let documentsToRebackfill = 0;
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const result = db
        .prepare(
          `UPDATE documents SET people_resolved_at = NULL
           WHERE id IN (
             SELECT DISTINCT document_id FROM document_people
             WHERE person_id IN (${placeholders})
           )`,
        )
        .run(...ids);
      documentsToRebackfill = result.changes;
    }

    const deleteStmt = db.prepare("DELETE FROM person_aliases WHERE id = ?");
    for (const row of offenders) deleteStmt.run(row.id);

    // Counts derived from `document_people` / `person_aliases` may
    // shift after the next backfill cycle; signal the periodic
    // refresh task to recompute.
    markPeopleGraphDirty(db);
    markMergeRulesDirty(db);

    return { aliasesRemoved: offenders.length, documentsToRebackfill };
  });

  return txn();
}
