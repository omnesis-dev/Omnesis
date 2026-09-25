// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { createLogger } from "@omnesis/core";
import { markPeopleGraphDirty, markMergeRulesDirty } from "../../data/DirtyMarks.js";
import { seedFromContacts, detectSelfFromSourceIds } from "../ContactCardBootstrap.js";
import type { SelfIdentitySource } from "../../self-identity-sources.js";

const log = createLogger("gateway:people");

/**
 * Rows cleared per flag-clear batch. The `people_resolved_at` reset is the
 * only O(corpus) step of a rebuild; batching keeps each writer transaction
 * bounded so a rebuild on a six-figure corpus never parks realtime ingest
 * for the full-table UPDATE.
 */
const FLAG_CLEAR_BATCH = 5_000;

/** Which slice of the rebuild a (resumed) call should run. */
export type RebuildPhase = "reset" | "flags";

/**
 * Drop all people data and rebuild from raw metadata on documents.
 *
 * Phased + yieldable. Two phases, each bounded:
 *
 *   - `reset` — clear the people graph (`document_people`, `person_aliases`,
 *     `people`, `person_equivalences`) and re-seed from contacts. Bounded by
 *     the *people graph*, not the corpus, so it runs as one unit. The token
 *     is polled only at its very end, so no writer op interleaves within it
 *     and it runs exactly once (the continuation carries `"flags"`).
 *
 *   - `flags` — clear the O(corpus) `people_resolved_at` markers in
 *     `FLAG_CLEAR_BATCH`-sized batches, polling the token between batches.
 *     The WHERE predicate is self-advancing (each batch clears rows that are
 *     then no longer selected), so a resume needs no offset and is
 *     crash-idempotent.
 *
 * With no token (the direct-handle callers), the poll is always false, so the
 * function runs both phases to completion in one call — behaviour identical to
 * an unphased rebuild.
 *
 * Ordering note: after `reset`, documents still carry stale `people_resolved_at`
 * (pointing at now-deleted people), so `backfillManyPeople` (which selects
 * `WHERE people_resolved_at IS NULL`) won't re-derive them until the `flags`
 * batches clear the marker. A backfill that interleaves between `flags` batches
 * (both are background) re-derives people from already-cleared docs and stamps
 * their `people_resolved_at` back to a fresh timestamp — exactly the intended
 * post-rebuild behaviour, just started early. The converged end state is "every
 * doc re-resolved (flags non-NULL again), graph = seeded contacts + the people
 * backfill re-derived". The interleave costs some churn — a doc cleared here,
 * re-resolved by backfill, then re-cleared by a later `flags` batch — which is
 * wasted resolution work, never corruption. It terminates because `flags`
 * clears far faster than backfill re-stamps (5000/batch vs ~one doc/backfill),
 * so the non-NULL set drains to empty and the loop stops on a zero-change batch.
 */
export function rebuildPeopleFromDocuments(
  db: Db,
  /** The collector-declared self-identity hooks, handed over by the HTTP thread. */
  hooks: readonly SelfIdentitySource[],
  token?: { requested(): boolean },
  phase: RebuildPhase = "reset",
): { resume: RebuildPhase } | undefined {
  if (phase === "reset") {
    log.info("Rebuilding people from document metadata...");
    db.prepare("DELETE FROM document_people").run();
    db.prepare("DELETE FROM person_aliases").run();
    db.prepare("DELETE FROM people").run();
    // Existing equivalences point at person ids that no longer exist —
    // wipe so the rule eval starts from a clean slate.
    db.prepare("DELETE FROM person_equivalences").run();
    const { seeded } = seedFromContacts(db);
    detectSelfFromSourceIds(db, hooks);
    // Whole graph rebooted — every score is invalid until the next refresh
    // tick. Same for merge rules: every previously-resolved alias is gone,
    // every dormant rule may now resolve to different people, and existing
    // equivalences (cleared above) need re-deriving from active rules against
    // the rebuilt graph.
    markPeopleGraphDirty(db);
    markMergeRulesDirty(db);
    log.info(`Rebuild reset: seeded ${seeded} contacts; clearing document flags...`);
    if (token?.requested()) return { resume: "flags" };
  }

  // Flag-clear — the O(corpus) step, bounded + yieldable.
  const clear = db.prepare(
    `UPDATE documents SET people_resolved_at = NULL
     WHERE id IN (SELECT id FROM documents WHERE people_resolved_at IS NOT NULL LIMIT ?)`,
  );
  for (;;) {
    if (clear.run(FLAG_CLEAR_BATCH).changes === 0) break;
    if (token?.requested()) return { resume: "flags" };
  }
  log.info("Rebuild complete: document flags cleared. Backfill will re-derive people.");
  return undefined;
}
