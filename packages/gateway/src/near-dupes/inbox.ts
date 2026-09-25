// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "../data/types.js";

/**
 * Inbox operations — small, focused helpers for the writer to enqueue
 * doc-changed work, and for the compute side to drain it.
 *
 * The dedup index `idx_near_dup_inbox_dedup` on `(doc_id,
 * enqueued_reason)` means duplicate enqueues coalesce into a single row.
 * Reply-chain storms (parent doc re-quoted in every reply) cost one write
 * per enqueue, no inbox growth.
 */

/**
 * Why a doc entered the inbox. Single English words are stored as-is;
 * compound reasons use kebab-case (`algo-bump`). The schema's CHECK
 * constraint pins this set so a typo here fails to compile and a
 * mistyped value at insert time fails the SQL CHECK.
 */
export type NearDupInboxReason = "insert" | "update" | "delete" | "algo-bump";

export interface NearDupInboxRow {
  id: number;
  docId: string;
  reason: NearDupInboxReason;
  enqueuedAt: number;
}

/**
 * Enqueue one or more docs. A doc already pending under the same reason
 * keeps a single row — but a re-enqueue REPLACES that row rather than
 * being ignored, and the `AUTOINCREMENT` id it gets is strictly larger
 * than any this table has ever used.
 *
 * That id is the queue token: the compute pass peeks rows without
 * claiming them and the writer drains the batch by deleting the ids it
 * consumed. Leaving the original row in place would let a content update
 * that lands between the peek and the drain be deleted along with the
 * work it was meant to schedule — the document would keep a signature,
 * LSH buckets and edges describing the body the compute pass read, with
 * nothing queued to correct them. Re-minting the row makes that delete
 * miss, so the newer content is signed on the next cycle.
 *
 * Returns the number of rows written, new or replaced.
 */
export function enqueueNearDupInbox(
  db: Db,
  docIds: ReadonlyArray<string>,
  reason: NearDupInboxReason,
  now: number = Math.floor(Date.now() / 1000),
): { enqueued: number } {
  if (docIds.length === 0) return { enqueued: 0 };
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO near_dup_inbox (doc_id, enqueued_reason, enqueued_at)
     VALUES (?, ?, ?)`,
  );
  let enqueued = 0;
  const tx = db.transaction((ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const r = stmt.run(id, reason, now);
      if (r.changes > 0) enqueued++;
    }
  });
  tx(docIds);
  return { enqueued };
}

/**
 * Drain up to `batchSize` rows from the inbox, oldest first. Does
 * NOT remove them from the inbox — the compute pass produces the
 * apply-batch snapshot, and the writer applies that snapshot
 * (including the inbox row deletions) atomically.
 */
export function peekNearDupInbox(db: Db, batchSize: number): NearDupInboxRow[] {
  const rows = db
    .prepare<
      [number],
      { id: number; doc_id: string; enqueued_reason: NearDupInboxReason; enqueued_at: number }
    >(
      `SELECT id, doc_id, enqueued_reason, enqueued_at
       FROM near_dup_inbox
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(batchSize);
  return rows.map((r) => ({
    id: r.id,
    docId: r.doc_id,
    reason: r.enqueued_reason,
    enqueuedAt: r.enqueued_at,
  }));
}

/** Writer-side: drop a set of processed inbox row ids in a single statement. */
export function removeNearDupInboxRows(db: Db, ids: ReadonlyArray<number>): { removed: number } {
  if (ids.length === 0) return { removed: 0 };
  const placeholders = ids.map(() => "?").join(",");
  const result = db.prepare(`DELETE FROM near_dup_inbox WHERE id IN (${placeholders})`).run(...ids);
  return { removed: result.changes };
}

/** Total inbox depth — used by the BackgroundJob tracker to surface "N docs remaining". */
export function countNearDupInbox(db: Db): number {
  const row = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM near_dup_inbox`).get();
  return row?.n ?? 0;
}

/**
 * Algo-bump bulk enqueue. One SQL statement (not a loop) — the
 * algo-bump path runs at boot and the corpus can be a million rows.
 * Re-runs are safe (INSERT OR IGNORE).
 *
 * Returns the number of newly-enqueued rows.
 */
export function enqueueAllEligibleForAlgoBump(
  db: Db,
  eligibleDocTypes: ReadonlySet<string>,
  now: number = Math.floor(Date.now() / 1000),
): { enqueued: number } {
  if (eligibleDocTypes.size === 0) return { enqueued: 0 };
  const placeholders = [...eligibleDocTypes].map(() => "?").join(",");
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO near_dup_inbox (doc_id, enqueued_reason, enqueued_at)
       SELECT id, 'algo-bump', ?
         FROM documents
        WHERE json_extract(metadata, '$.documentType') IN (${placeholders})`,
    )
    .run(now, ...eligibleDocTypes);
  return { enqueued: result.changes };
}
