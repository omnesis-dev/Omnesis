// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";

import { createLogger } from "@omnesis/core";
import { advanceOccWatermark } from "../data/occ-materialized.js";
import { openEncryptedSqlite } from "../sqlite-encryption.js";
import {
  nextDfGeneration,
  publishDfGeneration,
  readLiveDfGeneration,
  setDfBuiltAt,
  setActiveAlgoVersion,
  setSweepWatermark,
} from "./meta.js";
import { enqueueAllEligibleForAlgoBump, removeNearDupInboxRows } from "./inbox.js";
import type { Db } from "../data/types.js";
import type { ResolvedNearDupConfig } from "./config.js";
import type { NearDupApplyBatch, NearDupApplyResult, NearDupDfSnapshot } from "./types.js";

/**
 * Open a DF staging file for reading, with the key it was written with.
 * Read-only: this connection exists to move rows into the live table and
 * must not be able to alter the build it is reading.
 */
function openStagingRead(path: string, keyHex?: string): Database.Database {
  if (!keyHex) return new Database(path, { readonly: true, fileMustExist: true });
  return openEncryptedSqlite(path, {
    key: Buffer.from(keyHex, "hex"),
    readonly: true,
    fileMustExist: true,
    migratePlaintext: false,
  }) as unknown as Database.Database;
}

const log = createLogger("gateway:near-dupes:writer");

export interface PreemptToken {
  requested(): boolean;
}

/**
 * Apply a NearDupApplyBatch — `APPLY_CHUNK_SIZE` docs per transaction, with a
 * preempt-token poll between chunks. Mirrors the yieldable patterns in
 * `links.upsertExtractedLinksBatch` and `tokens.touchTokenUsageBatch`: when
 * the token requests yield, we commit the chunks done so far, return the
 * un-applied tail via `remaining`, and let the scheduler dispatch
 * higher-priority work before resuming.
 */
export interface NearDupApplyResultWithRemaining extends NearDupApplyResult {
  remaining: NearDupApplyBatch | null;
}

/**
 * Drop the `remaining` field from an apply result. The wire-side
 * `NearDupApplyResult` doesn't carry `remaining` — that's the
 * scheduler's yield-vs-done distinction, not a value the caller
 * observes. Both `directWriteGate` (sync-in-promise) and the worker's
 * yieldable handler use this helper rather than hand-listing fields.
 */
export function stripRemaining(result: NearDupApplyResultWithRemaining): NearDupApplyResult {
  return {
    inboxConsumed: result.inboxConsumed,
    signaturesUpserted: result.signaturesUpserted,
    bucketsUpserted: result.bucketsUpserted,
    edgesUpserted: result.edgesUpserted,
    edgesDeleted: result.edgesDeleted,
  };
}

/**
 * Docs applied per transaction (one fsync each) before the preempt token is
 * re-checked. Small enough that a higher-priority writer op never waits more
 * than one chunk; large enough that a full compute batch is only a handful of
 * commits, not one per doc.
 */
export const APPLY_CHUNK_SIZE = 25;

/**
 * How many DF rows move from staging into the live table per transaction.
 * Bounds both the write lock held at once and the largest set of rows this
 * process holds while moving a table of several million.
 */
export const DF_APPLY_CHUNK_SIZE = 5_000;

export function applyNearDupBatch(
  db: Db,
  batch: NearDupApplyBatch,
  options: { token?: PreemptToken } = {},
): NearDupApplyResultWithRemaining {
  const token = options.token;
  // Seeded from the remainder so a batch that took several continuations
  // reports what the whole batch wrote, not what its last slice did.
  const result: NearDupApplyResult = {
    inboxConsumed: 0,
    signaturesUpserted: batch.carried?.signaturesUpserted ?? 0,
    bucketsUpserted: batch.carried?.bucketsUpserted ?? 0,
    edgesUpserted: batch.carried?.edgesUpserted ?? 0,
    edgesDeleted: batch.carried?.edgesDeleted ?? 0,
  };
  if (
    batch.signatureDeletes.length === 0 &&
    batch.signatures.length === 0 &&
    batch.bucketRows.length === 0 &&
    batch.edgeUpserts.length === 0 &&
    batch.edgeDeletes.length === 0 &&
    batch.processedInboxIds.length === 0
  ) {
    return { ...result, remaining: null };
  }

  const sigDelete = db.prepare(
    `DELETE FROM near_dup_signatures WHERE doc_id = ? AND algo_version = ?`,
  );
  const bucketDeleteForDoc = db.prepare(
    `DELETE FROM near_dup_lsh_buckets WHERE doc_id = ? AND algo_version = ?`,
  );
  const edgeDeleteForDoc = db.prepare(
    `DELETE FROM near_dup_edges
      WHERE algo_version = ? AND (doc_a = ? OR doc_b = ?)`,
  );
  const sigUpsert = db.prepare(
    `INSERT OR REPLACE INTO near_dup_signatures
     (doc_id, algo_version, signature, shingle_count, computed_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const bucketUpsert = db.prepare(
    `INSERT OR IGNORE INTO near_dup_lsh_buckets
     (algo_version, band_idx, bucket_hash, doc_id) VALUES (?, ?, ?, ?)`,
  );
  const edgeUpsert = db.prepare(
    `INSERT OR REPLACE INTO near_dup_edges
       (doc_a, doc_b, algo_version, jaccard,
        pair_unique_df2, pair_unique_df5, containment_min,
        gate_family, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const edgeDelete = db.prepare(
    `DELETE FROM near_dup_edges WHERE doc_a = ? AND doc_b = ? AND algo_version = ?`,
  );
  const docExistsStmt = db.prepare<[string], { one: number }>(
    `SELECT 1 AS one FROM documents WHERE id = ?`,
  );

  // A document removed between the compute pass reading it and this apply
  // took its near-dup rows with it through the FK cascade. Signature,
  // bucket and edge rows all reference `documents`, and the writer enforces
  // foreign keys, so re-inserting one keyed on a document that is gone
  // aborts the whole op — discarding the rest of the batch and leaving its
  // inbox rows undrained. Each id is looked up once per apply.
  const existence = new Map<string, boolean>();
  const docExists = (docId: string): boolean => {
    const cached = existence.get(docId);
    if (cached !== undefined) return cached;
    const exists = docExistsStmt.get(docId) !== undefined;
    existence.set(docId, exists);
    return exists;
  };

  const now = Math.floor(Date.now() / 1000);
  let writes = 0;
  let remaining: NearDupApplyBatch | null = null;

  // Docs whose writes have committed — drives the yield remainder. Edge sets
  // dedup a pair reachable from either endpoint.
  const writtenDocs = new Set<string>();
  const writtenEdges = new Set<string>();
  const writtenEdgeDeletes = new Set<string>();

  // Pre-sort by inbox id for stable behaviour on yield.
  const processedIds = [...batch.processedInboxIds].sort((a, b) => a - b);

  // Group signature/bucket/edge ops by doc id so a yield mid-doc
  // leaves the doc partially-applied — which is fine because the
  // doc's inbox row hasn't been consumed yet, so the next tick
  // re-processes it.
  const sigsByDoc = new Map<string, (typeof batch.signatures)[number]>();
  for (const s of batch.signatures) sigsByDoc.set(s.docId, s);
  const bucketsByDoc = new Map<string, typeof batch.bucketRows>();
  for (const b of batch.bucketRows) {
    const existing = bucketsByDoc.get(b.docId) ?? [];
    existing.push(b);
    bucketsByDoc.set(b.docId, existing);
  }
  const edgeUpsertsByDoc = new Map<string, typeof batch.edgeUpserts>();
  for (const e of batch.edgeUpserts) {
    for (const docId of [e.docA, e.docB]) {
      const existing = edgeUpsertsByDoc.get(docId) ?? [];
      existing.push(e);
      edgeUpsertsByDoc.set(docId, existing);
    }
  }
  const edgeDeletesByDoc = new Map<string, typeof batch.edgeDeletes>();
  for (const e of batch.edgeDeletes) {
    for (const docId of [e.docA, e.docB]) {
      const existing = edgeDeletesByDoc.get(docId) ?? [];
      existing.push(e);
      edgeDeletesByDoc.set(docId, existing);
    }
  }

  // The signatureDeletes list is the authoritative "which docs got touched
  // this batch" set.
  const touchedDocs = [...new Set(batch.signatureDeletes)];

  // Write one doc's signature/bucket/edge rows. Runs inside a chunk
  // transaction; never opens its own.
  const writeDoc = (docId: string): void => {
    sigDelete.run(docId, batch.algoVersion);
    bucketDeleteForDoc.run(docId, batch.algoVersion);
    edgeDeleteForDoc.run(batch.algoVersion, docId, docId);

    if (!docExists(docId)) {
      // Nothing left to attach rows to. The deletes above stay — they are
      // idempotent, and the cascade has usually run them already.
      writtenDocs.add(docId);
      writes++;
      return;
    }

    const sig = sigsByDoc.get(docId);
    if (sig) {
      sigUpsert.run(sig.docId, sig.algoVersion, sig.signature, sig.shingleCount, now);
      result.signaturesUpserted++;
    }
    for (const b of bucketsByDoc.get(docId) ?? []) {
      bucketUpsert.run(b.algoVersion, b.bandIdx, b.bucketHash, b.docId);
      result.bucketsUpserted++;
    }
    for (const e of edgeUpsertsByDoc.get(docId) ?? []) {
      // The pair's other endpoint may have been removed even when this one
      // survives; an edge to a document that is gone is one this pass would
      // never have proposed had the compute pass read the corpus now.
      if (!docExists(e.docA) || !docExists(e.docB)) continue;
      const key = `${e.docA}|${e.docB}`;
      // Always re-emit: each touched doc's edgeDeleteForDoc above nukes every
      // edge on it — including one a sibling doc in this same batch just
      // wrote — so a batch-wide skip would drop edges. INSERT OR REPLACE
      // makes the double-write idempotent.
      edgeUpsert.run(
        e.docA,
        e.docB,
        e.algoVersion,
        e.jaccard,
        e.pairUniqueDf2,
        e.pairUniqueDf5,
        e.containmentMin,
        e.gateFamily,
        now,
      );
      if (!writtenEdges.has(key)) {
        writtenEdges.add(key);
        result.edgesUpserted++;
      }
    }
    for (const e of edgeDeletesByDoc.get(docId) ?? []) {
      const key = `${e.docA}|${e.docB}`;
      if (writtenEdgeDeletes.has(key)) continue;
      edgeDelete.run(e.docA, e.docB, e.algoVersion);
      writtenEdgeDeletes.add(key);
      result.edgesDeleted++;
    }
    writtenDocs.add(docId);
    writes++;
  };

  // Apply in chunks — ONE transaction (one fsync under WAL+synchronous=FULL)
  // per chunk, not per doc. A per-doc transaction fsynced ~once per doc; a
  // 100-doc cycle was ~100 fsyncs (seconds) though the writes themselves are
  // ~100ms. The preempt token is still honoured between chunks, so a
  // higher-priority writer op (e.g. collector upsertDocuments) interleaves
  // without waiting for the whole batch — see #199/#500 and
  // near-dup.preempt.e2e.
  let i = 0;
  while (i < touchedDocs.length) {
    if (token?.requested()) {
      // Docs the continuation still has to write. Each of them starts by
      // deleting every edge that touches it, so an edge with a pending
      // endpoint must travel in the remainder for that endpoint to
      // re-emit it — including one an already-applied endpoint wrote in
      // this call. Filtering the upserts on "already written" instead
      // drops exactly the pairs that straddle the yield boundary, and
      // nothing left in the batch would ever put them back.
      //
      // Edge deletes need no such carry: a pending endpoint's
      // `edgeDeleteForDoc` removes the pair anyway, so one dropped from
      // the remainder still ends up deleted.
      const pendingDocs = new Set(batch.signatureDeletes.filter((d) => !writtenDocs.has(d)));
      remaining = {
        algoVersion: batch.algoVersion,
        signatureDeletes: [...pendingDocs],
        signatures: batch.signatures.filter((s) => !writtenDocs.has(s.docId)),
        bucketRows: batch.bucketRows.filter((b) => !writtenDocs.has(b.docId)),
        edgeUpserts: batch.edgeUpserts.filter(
          (e) => pendingDocs.has(e.docA) || pendingDocs.has(e.docB),
        ),
        edgeDeletes: batch.edgeDeletes.filter(
          (e) => !writtenEdgeDeletes.has(`${e.docA}|${e.docB}`),
        ),
        // Carry all inbox ids: they're drained only once, when the final
        // remainder completes (matches the previous best-effort behaviour).
        processedInboxIds: processedIds,
      };
      // A carried edge with one endpoint already applied was counted here
      // and will be counted again when its pending endpoint re-emits it,
      // so drop it from the running total rather than count the pair twice.
      const recounted = new Set(
        remaining.edgeUpserts
          .map((e) => `${e.docA}|${e.docB}`)
          .filter((key) => writtenEdges.has(key)),
      );
      remaining.carried = {
        inboxConsumed: 0,
        signaturesUpserted: result.signaturesUpserted,
        bucketsUpserted: result.bucketsUpserted,
        edgesUpserted: result.edgesUpserted - recounted.size,
        edgesDeleted: result.edgesDeleted,
      };
      break;
    }
    const chunkDocs = touchedDocs.slice(i, i + APPLY_CHUNK_SIZE);
    const tx = db.transaction((): void => {
      for (const docId of chunkDocs) writeDoc(docId);
    });
    tx();
    i += APPLY_CHUNK_SIZE;
  }

  if (!remaining) {
    // Whole batch applied — drain its inbox rows in one statement.
    const { removed } = removeNearDupInboxRows(db, processedIds);
    result.inboxConsumed = removed;
  }

  log.debug(
    `applied batch: ${writes} docs, ${result.signaturesUpserted} sigs, ${result.edgesUpserted} edges, ${result.edgesDeleted} edge deletes` +
      (remaining ? ` (yielded with ${remaining.processedInboxIds.length} remaining)` : ""),
  );

  return { ...result, remaining };
}

/**
 * Build a `near_dup_df` table from an in-memory snapshot.
 *
 * A test fixture. Production builds the table from a staging database — see
 * `applyNearDupDfFromStaging`, the only DF path the writer exposes — because
 * a snapshot is the whole table as one array, which is convenient for a test
 * with twenty shingles and is exactly what does not work for a corpus with
 * several million.
 */
export interface DfApplyResult {
  rebuilt: number;
}

export interface DfApplyYieldable extends DfApplyResult {
  done: boolean;
  nextOffset: number;
}

export function applyNearDupDfSnapshot(
  db: Db,
  snapshot: NearDupDfSnapshot,
  offset: number = 0,
  options: { token?: PreemptToken } = {},
): DfApplyYieldable {
  if (options.token?.requested()) {
    return { rebuilt: 0, done: false, nextOffset: offset };
  }

  const entries = snapshot.entries;
  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO near_dup_df (algo_version, generation, shingle, df)
     VALUES (?, ?, ?, ?)`,
  );

  let cursor = offset;

  // Process chunks until preempted or done.
  while (cursor < entries.length) {
    const chunkEnd = Math.min(cursor + DF_APPLY_CHUNK_SIZE, entries.length);

    const tx = db.transaction(() => {
      if (cursor === 0) {
        db.prepare(`DELETE FROM near_dup_df WHERE algo_version = ? AND generation = ?`).run(
          snapshot.algoVersion,
          readLiveDfGeneration(db, snapshot.algoVersion),
        );
      }
      for (let i = cursor; i < chunkEnd; i++) {
        const r = entries[i];
        insertStmt.run(
          snapshot.algoVersion,
          readLiveDfGeneration(db, snapshot.algoVersion),
          r.shingle,
          r.df,
        );
      }
    });
    tx();

    cursor = chunkEnd;

    if (cursor < entries.length && options.token?.requested()) {
      log.debug(`DF apply yielding at ${cursor}/${entries.length}`);
      return { rebuilt: cursor - offset, done: false, nextOffset: cursor };
    }
  }

  // All rows inserted — stamp metadata + advance OCC.
  const finalize = db.transaction(() => {
    setDfBuiltAt(
      db,
      snapshot.algoVersion,
      snapshot.totalDocs,
      snapshot.uniqueShingles,
      Math.floor(Date.now() / 1000),
    );
    advanceOccWatermark(db, {
      job: "near_dup_df",
      capturedVersion: snapshot.capturedVersion,
    });
  });
  finalize();

  const totalChunks = Math.ceil(entries.length / DF_APPLY_CHUNK_SIZE);
  log.info(`DF apply complete: ${entries.length} rows in ${totalChunks} chunks`);
  return { rebuilt: entries.length, done: true, nextOffset: cursor };
}

/**
 * Apply a DF build the compute pass accumulated into a staging database.
 *
 * The staging file is opened as its own connection rather than attached.
 * Attaching would inherit the main database's key, and the two are separate
 * stores: on an encrypted install a keyless staging file cannot be attached
 * to a keyed connection at all, and giving it the main key through ATTACH
 * ties the lifetime of a scratch file to the corpus key handling. A second
 * connection keeps the two explicit.
 *
 * Rows move in chunks of `DF_APPLY_CHUNK_SIZE`, so the largest set held at
 * once is that chunk rather than the whole table. Chunked and resumable:
 * progress is a keyset position in the staging table's primary key, the
 * generation being built travels with the resume, and the build is
 * published only when the last chunk lands. The writer also gives the
 * scheduler control once its time slice expires, even without a preemption
 * request, so ordinary same-priority writes can run between chunks. An
 * interrupted apply resumes, and `built_at` never advertises a partial table.
 *
 * `expectedRows` is what the compute pass counted as it built the staging
 * table, and it is what separates the two ways staging can read as empty. A
 * build that counted rows and then finds none has lost them between the
 * scan and here — corruption, refused, so a failure cannot delete the
 * corpus's near-duplicate weighting and stamp the empty result as current.
 * A build that counted none is a complete and correct description of a
 * corpus where no shingle appears in two documents — a nearly-empty
 * install, or one right after an algo bump — and it is stamped like any
 * other, because refusing it would leave `built_at` unset and the trigger
 * rebuilding the same nothing on every tick, forever.
 *
 * `totalDocs` zero is the exception to that: a build with no document
 * behind it weighs every shingle at zero and is refused, because stamping
 * it starts the compute drip signing against a table that cannot tell two
 * documents apart.
 */
export function applyNearDupDfFromStaging(
  db: Db,
  input: {
    stagingPath: string;
    /** Hex key the staging file was written with, when storage is encrypted. */
    stagingKeyHex?: string;
    algoVersion: string;
    totalDocs: number;
    minDf: number;
    capturedVersion: number;
    /**
     * Rows the compute pass counted at or above `minDf` while building the
     * staging table. Zero means the corpus genuinely has no shared shingle.
     */
    expectedRows: number;
  },
  resume: { afterShingle: string | null; applied: number; generation?: number } = {
    afterShingle: null,
    applied: 0,
  },
  options: { token?: PreemptToken; maxSliceMs?: number } = {},
): { rebuilt: number; done: boolean; nextAfterShingle: string | null; generation: number } {
  const sliceStartedAt = Date.now();
  if (options.token?.requested()) {
    // Preempted before writing anything. The generation still has to be the
    // one this build will use, not the live one: whatever is returned here
    // is what the continuation builds into, and naming the live generation
    // would have it build into the table readers are using — publishing a
    // half-merged mixture of two builds under a pointer that never moved.
    return {
      rebuilt: resume.applied,
      done: false,
      nextAfterShingle: resume.afterShingle,
      generation: resume.generation ?? nextDfGeneration(db, input.algoVersion),
    };
  }
  // A build that scanned no document is not a weighting of the corpus: with
  // `totalDocs` zero every shingle's idf weight is log((0 + 1) / (0 + 1)) = 0,
  // so every signature computed against it is the signature of an empty
  // weighted set and matches nothing. `built_at` is what parks the compute
  // drip, and a signed document is never re-signed until the algorithm
  // version changes — so stamping this would spend a whole bootstrap
  // producing signatures no later rebuild repairs. Leave the table unbuilt
  // and let the wall-clock trigger come back once there is a corpus to weigh.
  if (input.totalDocs === 0) {
    log.info("DF apply skipped: no eligible document to weigh, leaving the DF unbuilt");
    return {
      rebuilt: 0,
      done: true,
      nextAfterShingle: null,
      generation: readLiveDfGeneration(db, input.algoVersion),
    };
  }
  // A build that legitimately found nothing still has to be stamped, or the
  // trigger sees an unbuilt table and repeats the whole scan on every tick.
  // Nothing is read from staging, so this needs no connection to it.
  if (input.expectedRows === 0 && resume.applied === 0) {
    const emptyTarget = nextDfGeneration(db, input.algoVersion);
    const finalizeEmpty = db.transaction(() => {
      // Publishing an empty generation IS the clear: readers move to a
      // generation with no rows, and the sweep retires the old one.
      publishDfGeneration(
        db,
        input.algoVersion,
        emptyTarget,
        input.totalDocs,
        0,
        Math.floor(Date.now() / 1000),
      );
      advanceOccWatermark(db, { job: "near_dup_df", capturedVersion: input.capturedVersion });
    });
    finalizeEmpty();
    log.info(
      `DF apply complete: no shingle reached df ${input.minDf} across ${input.totalDocs} document(s)`,
    );
    return { rebuilt: 0, done: true, nextAfterShingle: null, generation: emptyTarget };
  }

  const staging = openStagingRead(input.stagingPath, input.stagingKeyHex);
  try {
    if (resume.afterShingle === null && resume.applied === 0) {
      const any = staging
        .prepare<
          [number],
          { present: number }
        >("SELECT EXISTS (SELECT 1 FROM df WHERE df >= ?) AS present")
        .get(input.minDf);
      if ((any?.present ?? 0) === 0) {
        throw new Error(
          `near-dup DF staging at ${input.stagingPath} holds no shingle at or above df ${input.minDf}, but the build counted ${input.expectedRows}; refusing to replace the live table with an empty one`,
        );
      }
    }

    const read = staging.prepare<[number, string, number], { shingle: string; df: number }>(
      `SELECT shingle, df FROM df
        WHERE df >= ? AND shingle > ?
        ORDER BY shingle LIMIT ?`,
    );
    const insertStmt = db.prepare(
      `INSERT OR REPLACE INTO near_dup_df (algo_version, generation, shingle, df)
       VALUES (?, ?, ?, ?)`,
    );

    // The generation being built. Readers stay on the live one until the
    // finalize below moves the pointer, so nothing written here is visible
    // to them, and nothing written here has to remove what they are
    // reading.
    //
    // A resume carries its generation rather than recomputing one: the
    // rows it already wrote are in the table, so a fresh computation would
    // pick the number after them and scatter one build across two
    // generations.
    const target = resume.generation ?? nextDfGeneration(db, input.algoVersion);

    let after = resume.afterShingle;
    let applied = resume.applied;

    for (;;) {
      const rows = read.all(input.minDf, after ?? "", DF_APPLY_CHUNK_SIZE);
      const chunk = db.transaction(() => {
        for (const r of rows) insertStmt.run(input.algoVersion, target, r.shingle, r.df);
      });
      chunk();

      applied += rows.length;
      if (rows.length > 0) after = rows[rows.length - 1].shingle;
      if (rows.length < DF_APPLY_CHUNK_SIZE) break;
      const sliceExpired =
        options.maxSliceMs !== undefined && Date.now() - sliceStartedAt >= options.maxSliceMs;
      if (options.token?.requested() || sliceExpired) {
        log.debug(`DF apply yielding after ${applied} rows`);
        return { rebuilt: applied, done: false, nextAfterShingle: after, generation: target };
      }
    }

    // The swap. One row, one short transaction — the writer is held for
    // the length of an UPDATE whatever the table's size, which is the whole
    // point of building beside the live generation rather than over it.
    const finalize = db.transaction(() => {
      publishDfGeneration(
        db,
        input.algoVersion,
        target,
        input.totalDocs,
        applied,
        Math.floor(Date.now() / 1000),
      );
      advanceOccWatermark(db, { job: "near_dup_df", capturedVersion: input.capturedVersion });
    });
    finalize();
    log.info(`DF apply complete: ${applied} rows published as generation ${target}`);
    return { rebuilt: applied, done: true, nextAfterShingle: after, generation: target };
  } finally {
    staging.close();
  }
}

/**
 * Bump the active algo version. Idempotent: re-running with the same
 * version is a no-op once the meta row exists with that version.
 *
 * Run at boot when the code-declared `algoVersion` disagrees with
 * what's persisted in `near_dup_df_meta`. The bulk-enqueue covers
 * every eligible doc so the drip subsequently produces signatures /
 * edges under the new algo. Old-algo rows are swept by the
 * `nearDupAlgoSweep` task.
 */
export function bumpNearDupAlgo(
  db: Db,
  config: ResolvedNearDupConfig,
): { enqueued: number; bumpedFrom: string | null } {
  const previous = db
    .prepare<[], { algo_version: string }>(`SELECT algo_version FROM near_dup_df_meta LIMIT 1`)
    .get();
  const newAlgo = config.algorithm.algoVersion;
  if (previous?.algo_version === newAlgo) {
    return { enqueued: 0, bumpedFrom: previous.algo_version };
  }

  const tx = db.transaction((): { enqueued: number } => {
    // `setActiveAlgoVersion` clears `near_dup_df_meta` — the new algo
    // row is seeded with `built_at = NULL`. The wall-clock-driven
    // `nearDupDfRefreshTask` sees the null `built_at` on its next
    // tick and fires the DF rebuild for the new algo. Until DF
    // lands, the compute drip parks via `readNearDupDfBuiltAt`.
    setActiveAlgoVersion(db, newAlgo);
    const { enqueued } = enqueueAllEligibleForAlgoBump(db, config.eligibleDocTypes);
    return { enqueued };
  });
  const { enqueued } = tx();

  log.info(
    `algo bump: ${previous?.algo_version ?? "<fresh>"} -> ${newAlgo}, enqueued ${enqueued} docs`,
  );
  return { enqueued, bumpedFrom: previous?.algo_version ?? null };
}

/**
 * One-shot cleanup pass over rows tagged with non-active algos.
 * Yieldable in `algoSweepChunkSize` chunks. Idle when no rows remain
 * for any non-active algo.
 */
export interface AlgoSweepResult {
  cleared: number;
  done: boolean;
}

export function algoSweepStep(
  db: Db,
  config: ResolvedNearDupConfig,
  options: { token?: PreemptToken } = {},
): AlgoSweepResult {
  const token = options.token;
  const active = config.algorithm.algoVersion;
  const chunk = config.scheduler.algoSweepChunkSize;
  let cleared = 0;

  // Rowid-bearing tables: paginate via `rowid IN (... LIMIT ?)` so
  // each pass bounds the writer-busy window. better-sqlite3 isn't
  // built with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, so we can't
  // `DELETE ... LIMIT` directly.
  for (const table of ["near_dup_signatures", "near_dup_lsh_buckets", "near_dup_edges"] as const) {
    if (token?.requested()) return { cleared, done: false };
    const result = db
      .prepare(
        `DELETE FROM ${table} WHERE algo_version != ? AND rowid IN (
          SELECT rowid FROM ${table} WHERE algo_version != ? LIMIT ?
        )`,
      )
      .run(active, active, chunk);
    cleared += result.changes;
  }

  // Whether any row for a non-active algo exists at all.
  //
  // The delete below cannot answer this cheaply: `algo_version != ?` is not
  // a range, so it reads the table, and its LIMIT only short-circuits when
  // there is something to find. Proving ABSENCE therefore costs a full
  // read — which is the steady state, because an algo bump is rare and
  // every tick after the last one has nothing to do.
  //
  // The primary key starts with `algo_version`, so the two seeks below
  // answer the same question in log time: the greatest version below the
  // active one, and the least above it. If neither exists, there is nothing
  // to retire and the read is skipped entirely.
  const otherAlgoBelow = db
    .prepare<
      [string],
      { algo_version: string }
    >("SELECT algo_version FROM near_dup_df WHERE algo_version < ? ORDER BY algo_version DESC LIMIT 1")
    .get(active);
  const otherAlgoAbove = db
    .prepare<
      [string],
      { algo_version: string }
    >("SELECT algo_version FROM near_dup_df WHERE algo_version > ? ORDER BY algo_version LIMIT 1")
    .get(active);
  const staleAlgoRowsExist = otherAlgoBelow !== undefined || otherAlgoAbove !== undefined;

  // `near_dup_df` is WITHOUT ROWID, so we can't paginate by rowid.
  // Pre-#chunkSize fix: this ran as an unbounded DELETE, which can
  // hold the writer for several seconds when the corpus has churned
  // through multiple algo bumps and stacked up tens of millions of
  // stale shingle rows. Paginate by the (algo_version, shingle) PK
  // instead, one chunk per pass.
  if (staleAlgoRowsExist && !token?.requested()) {
    const dfResult = db
      .prepare(
        `DELETE FROM near_dup_df WHERE (algo_version, generation, shingle) IN (
           SELECT algo_version, generation, shingle FROM near_dup_df
            WHERE algo_version != ?
            LIMIT ?
         )`,
      )
      .run(active, chunk);
    cleared += dfResult.changes;
  }

  // Superseded generations of the ACTIVE algo. A rebuild publishes by
  // moving `live_generation` and leaves the generation it replaced in
  // place, so this is what reclaims it — in the same bounded chunks as
  // everything above, because the whole reason the rebuild stopped
  // deleting is that an unbounded delete holds the writer.
  return { cleared, done: cleared === 0 };
}

/**
 * Reclaim one chunk of a superseded DF generation.
 *
 * Separate from {@link algoSweepStep} because the two answer different
 * questions at different rates. A stale ALGO is left behind by a bump, so
 * it is rare and arrives all at once. A superseded GENERATION is owed after
 * every rebuild. This one is a range on the primary key's own prefix, so a
 * chunk costs no table read and the tick can repeat it.
 *
 * STRICTLY older than the live generation. A generation above it is a build
 * in progress — the apply is yieldable, so this runs between its chunks —
 * or the remains of one that died. Deleting either would take rows out from
 * under a build about to publish, and the loss would be silent: a
 * complete-looking table missing whatever this reached first. Both become
 * reclaimable once a later build publishes past them.
 */
export function generationSweepStep(
  db: Db,
  config: ResolvedNearDupConfig,
): { cleared: number; done: boolean } {
  const active = config.algorithm.algoVersion;
  const live = readLiveDfGeneration(db, active);
  const result = db
    .prepare(
      `DELETE FROM near_dup_df WHERE (algo_version, generation, shingle) IN (
         SELECT algo_version, generation, shingle FROM near_dup_df
          WHERE algo_version = ? AND generation < ?
          LIMIT ?
       )`,
    )
    .run(active, live, config.scheduler.algoSweepChunkSize);
  return { cleared: result.changes, done: result.changes === 0 };
}

/**
 * Update the sweep watermark. Called by `nearDupSweep` after a chunk
 * of eligible docs has been enqueued.
 */
export function applySweepWatermark(db: Db, algoVersion: string, watermark: string): void {
  setSweepWatermark(db, algoVersion, watermark);
}
