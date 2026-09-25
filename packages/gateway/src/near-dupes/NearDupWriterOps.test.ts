// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { advanceOccWatermark, captureOccVersion } from "../data/occ-materialized.js";
import { markNearDupDfDirty } from "../data/DirtyMarks.js";
import { writerYieldableHandlers } from "../scheduler/writer-handlers.js";
import { PreemptBuffer, PreemptToken } from "../scheduler/preempt.js";
import { DEFAULT_NEAR_DUP_CONFIG } from "./config.js";
import { enqueueNearDupInbox, peekNearDupInbox } from "./inbox.js";
import {
  readActiveAlgoVersion,
  readNearDupDfBuiltAt,
  readNearDupDfMeta,
  setActiveAlgoVersion,
  setDfBuiltAt,
} from "./meta.js";
import {
  applyNearDupBatch,
  applyNearDupDfFromStaging,
  applyNearDupDfSnapshot,
  algoSweepStep,
  generationSweepStep,
  bumpNearDupAlgo,
  APPLY_CHUNK_SIZE,
  DF_APPLY_CHUNK_SIZE,
} from "./NearDupWriterOps.js";
import { buildInMemoryDfFromTable, ShingleDfAccumulator } from "./NearDupDfService.js";
import type { Db } from "../data/types.js";
import type { NearDupApplyBatch, NearDupDfSnapshot } from "./types.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-near-dup-writer-ops-"));
  db = new Database(join(dir, "omnesis.db")) as unknown as Db;
  // Match the gateway journal while retaining fully synchronized commits.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedDoc(id: string, documentType = "email"): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
        content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "p",
    "src:" + id,
    id,
    "title-" + id,
    "body content " + id,
    "ch-" + id,
    JSON.stringify({ documentType }),
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
  );
}

/**
 * What a reader sees: the generation the meta row points at. A rebuild
 * leaves the generation it replaced in the table for the sweep to
 * reclaim, so reading the table raw would show both.
 */
function liveRows(): Array<{ shingle: string; df: number }> {
  return db
    .prepare(
      `SELECT shingle, df FROM near_dup_df
        WHERE algo_version = 'v1'
          AND generation = (SELECT live_generation FROM near_dup_df_meta WHERE algo_version = 'v1')
        ORDER BY shingle`,
    )
    .all() as Array<{ shingle: string; df: number }>;
}

/** Every row, live or superseded — what the retire sweep still owes. */
function allRows(): number {
  return (
    (
      db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM near_dup_df WHERE algo_version = 'v1'")
        .get() as { n: number }
    ).n ?? 0
  );
}

describe("applyNearDupBatch", () => {
  test("returns zero-result and remaining:null on an empty batch", () => {
    const batch: NearDupApplyBatch = {
      algoVersion: "v1",
      processedInboxIds: [],
      signatureDeletes: [],
      signatures: [],
      bucketRows: [],
      edgeUpserts: [],
      edgeDeletes: [],
    };
    const r = applyNearDupBatch(db, batch);
    expect(r.inboxConsumed).toBe(0);
    expect(r.remaining).toBeNull();
  });

  test("applies signature + bucket + edge upserts and drains the inbox", () => {
    setActiveAlgoVersion(db, "v1");
    seedDoc("a");
    seedDoc("b");
    enqueueNearDupInbox(db, ["a"], "insert");
    const inbox = peekNearDupInbox(db, 10);
    expect(inbox).toHaveLength(1);

    const batch: NearDupApplyBatch = {
      algoVersion: "v1",
      processedInboxIds: [inbox[0].id],
      signatureDeletes: ["a"],
      signatures: [
        {
          docId: "a",
          algoVersion: "v1",
          signature: Buffer.from([0, 1, 2, 3]),
          shingleCount: 4,
        },
      ],
      bucketRows: [{ algoVersion: "v1", bandIdx: 0, bucketHash: 42, docId: "a" }],
      edgeUpserts: [
        {
          docA: "a",
          docB: "b",
          algoVersion: "v1",
          jaccard: 0.9,
          pairUniqueDf2: 5,
          pairUniqueDf5: 10,
          containmentMin: 0.95,
          gateFamily: "email",
        },
      ],
      edgeDeletes: [],
    };
    const r = applyNearDupBatch(db, batch);
    expect(r.remaining).toBeNull();
    expect(r.signaturesUpserted).toBe(1);
    expect(r.bucketsUpserted).toBe(1);
    expect(r.edgesUpserted).toBe(1);
    expect(r.inboxConsumed).toBe(1);
    expect(peekNearDupInbox(db, 10)).toHaveLength(0);
    const edge = db.prepare("SELECT COUNT(*) AS n FROM near_dup_edges").get() as { n: number };
    expect(edge.n).toBe(1);
  });

  test("edge survives when both endpoints are in processedInboxIds (cross-tx wipe regression)", () => {
    // Regression for the writer cross-tx edge wipe: each per-doc tx
    // begins with `edgeDeleteForDoc(docId)` which wipes EVERY edge
    // touching that doc — including ones an earlier per-doc tx in the
    // same batch just inserted. A previous version of the code carried
    // a batch-wide `writtenEdges` skip that bypassed the re-insert,
    // so the second endpoint's tx wiped the first's edge and didn't
    // restore it. Both endpoints in `processedInboxIds` is the
    // scenario that exposes it.
    setActiveAlgoVersion(db, "v1");
    seedDoc("a");
    seedDoc("b");
    enqueueNearDupInbox(db, ["a", "b"], "insert");
    const inbox = peekNearDupInbox(db, 10);
    expect(inbox).toHaveLength(2);

    const batch: NearDupApplyBatch = {
      algoVersion: "v1",
      processedInboxIds: inbox.map((r) => r.id),
      signatureDeletes: ["a", "b"],
      signatures: [
        { docId: "a", algoVersion: "v1", signature: Buffer.from([1]), shingleCount: 1 },
        { docId: "b", algoVersion: "v1", signature: Buffer.from([2]), shingleCount: 1 },
      ],
      bucketRows: [],
      edgeUpserts: [
        {
          docA: "a",
          docB: "b",
          algoVersion: "v1",
          jaccard: 0.9,
          pairUniqueDf2: 5,
          pairUniqueDf5: 10,
          containmentMin: 0.95,
          gateFamily: "file-like",
        },
      ],
      edgeDeletes: [],
    };
    applyNearDupBatch(db, batch);
    const edge = db
      .prepare<
        [],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM near_dup_edges WHERE doc_a='a' AND doc_b='b' AND algo_version='v1'`)
      .get();
    // The edge must persist after BOTH per-doc transactions run — the
    // second one (b's tx) deletes all edges touching b, then must
    // re-insert (a, b) from `edgeUpsertsByDoc.get("b")`. Reverting the
    // writer fix to the batch-wide `writtenEdges` skip will fail here.
    expect(edge?.n).toBe(1);
  });

  test("an edge whose endpoints straddle a yield boundary survives the resume", () => {
    // The apply commits `APPLY_CHUNK_SIZE` docs per transaction and polls the
    // preempt token between chunks. Every doc's write starts by deleting
    // every edge touching it, so an edge whose two endpoints fall on
    // opposite sides of a yield is written by the applied endpoint and then
    // wiped by the pending endpoint when it resumes. The remainder has to
    // carry that edge for the pending endpoint to re-emit it.
    setActiveAlgoVersion(db, "v1");
    const docIds = Array.from(
      { length: APPLY_CHUNK_SIZE + 1 },
      (_, i) => `d${String(i).padStart(3, "0")}`,
    );
    for (const id of docIds) seedDoc(id);
    enqueueNearDupInbox(db, docIds, "insert");
    const inbox = peekNearDupInbox(db, docIds.length);
    expect(inbox).toHaveLength(docIds.length);

    const first = docIds[0];
    const last = docIds[docIds.length - 1];
    const batch: NearDupApplyBatch = {
      algoVersion: "v1",
      processedInboxIds: inbox.map((r) => r.id),
      signatureDeletes: [...docIds],
      signatures: docIds.map((id) => ({
        docId: id,
        algoVersion: "v1",
        signature: Buffer.from([1]),
        shingleCount: 1,
      })),
      bucketRows: [],
      edgeUpserts: [
        {
          docA: first,
          docB: last,
          algoVersion: "v1",
          jaccard: 0.9,
          pairUniqueDf2: 5,
          pairUniqueDf5: 10,
          containmentMin: 0.95,
          gateFamily: "email",
        },
      ],
      edgeDeletes: [],
    };

    const edgeCount = (): number =>
      db
        .prepare<
          [string, string],
          { n: number }
        >(`SELECT COUNT(*) AS n FROM near_dup_edges WHERE doc_a = ? AND doc_b = ? AND algo_version = 'v1'`)
        .get(first, last)!.n;

    // Yield after the first chunk: `first` is applied, `last` is not.
    let polls = 0;
    const token = { requested: () => ++polls > 1 };
    const r1 = applyNearDupBatch(db, batch, { token });
    expect(r1.remaining).not.toBeNull();
    expect(r1.remaining!.signatureDeletes).toEqual([last]);
    expect(edgeCount()).toBe(1);

    const r2 = applyNearDupBatch(db, r1.remaining!);
    expect(r2.remaining).toBeNull();
    expect(edgeCount()).toBe(1);
  });

  test("counters report the whole batch, not the last continuation's slice", () => {
    // The scheduler discards the value of a call that yields — only the
    // terminal continuation's result reaches the caller. Totals therefore
    // have to travel on the remainder, or the operator log describes one
    // chunk of a batch that took several.
    setActiveAlgoVersion(db, "v1");
    const docIds = Array.from(
      { length: APPLY_CHUNK_SIZE + 1 },
      (_, i) => `c${String(i).padStart(3, "0")}`,
    );
    for (const id of docIds) seedDoc(id);
    enqueueNearDupInbox(db, docIds, "insert");
    const inbox = peekNearDupInbox(db, docIds.length);

    const first = docIds[0];
    const last = docIds[docIds.length - 1];
    const batch: NearDupApplyBatch = {
      algoVersion: "v1",
      processedInboxIds: inbox.map((r) => r.id),
      signatureDeletes: [...docIds],
      signatures: docIds.map((id) => ({
        docId: id,
        algoVersion: "v1",
        signature: Buffer.from([1]),
        shingleCount: 1,
      })),
      bucketRows: docIds.map((id) => ({
        algoVersion: "v1",
        bandIdx: 0,
        bucketHash: 7,
        docId: id,
      })),
      edgeUpserts: [
        {
          docA: first,
          docB: last,
          algoVersion: "v1",
          jaccard: 0.9,
          pairUniqueDf2: 5,
          pairUniqueDf5: 10,
          containmentMin: 0.95,
          gateFamily: "email",
        },
      ],
      edgeDeletes: [],
    };

    let polls = 0;
    const r1 = applyNearDupBatch(db, batch, { token: { requested: () => ++polls > 1 } });
    expect(r1.remaining).not.toBeNull();

    const r2 = applyNearDupBatch(db, r1.remaining!);
    expect(r2.remaining).toBeNull();
    expect(r2.signaturesUpserted).toBe(docIds.length);
    expect(r2.bucketsUpserted).toBe(docIds.length);
    // The straddling pair is written by both endpoints; it is one edge.
    expect(r2.edgesUpserted).toBe(1);
    expect(r2.inboxConsumed).toBe(docIds.length);
  });

  test("a document deleted between compute and apply is skipped, not a batch-wide failure", () => {
    // The compute pass reads document bodies minutes before the writer
    // applies its snapshot. A source removal, resync or absence sweep in
    // that window leaves the batch holding signature / bucket / edge rows
    // keyed on a document that no longer exists, and the writer enforces
    // foreign keys — so the whole apply used to abort, discarding the rest
    // of the batch and leaving its inbox rows undrained.
    db.pragma("foreign_keys = ON");
    setActiveAlgoVersion(db, "v1");
    seedDoc("alive");
    seedDoc("gone");
    enqueueNearDupInbox(db, ["alive", "gone"], "insert");
    const inbox = peekNearDupInbox(db, 10);
    expect(inbox).toHaveLength(2);

    const batch: NearDupApplyBatch = {
      algoVersion: "v1",
      processedInboxIds: inbox.map((r) => r.id),
      signatureDeletes: ["alive", "gone"],
      signatures: [
        { docId: "alive", algoVersion: "v1", signature: Buffer.from([1]), shingleCount: 1 },
        { docId: "gone", algoVersion: "v1", signature: Buffer.from([2]), shingleCount: 1 },
      ],
      bucketRows: [
        { algoVersion: "v1", bandIdx: 0, bucketHash: 11, docId: "alive" },
        { algoVersion: "v1", bandIdx: 0, bucketHash: 11, docId: "gone" },
      ],
      edgeUpserts: [
        {
          docA: "alive",
          docB: "gone",
          algoVersion: "v1",
          jaccard: 0.9,
          pairUniqueDf2: 5,
          pairUniqueDf5: 10,
          containmentMin: 0.95,
          gateFamily: "email",
        },
      ],
      edgeDeletes: [],
    };

    // The removal lands after the compute pass read both documents.
    db.prepare("DELETE FROM documents WHERE id = 'gone'").run();

    const r = applyNearDupBatch(db, batch);
    expect(r.remaining).toBeNull();
    // The surviving document is signed; the removed one contributes nothing.
    expect(r.signaturesUpserted).toBe(1);
    expect(r.bucketsUpserted).toBe(1);
    expect(r.edgesUpserted).toBe(0);
    // Both inbox rows are consumed — neither has any work left to do.
    expect(r.inboxConsumed).toBe(2);
    const sigs = db
      .prepare<[], { doc_id: string }>(`SELECT doc_id FROM near_dup_signatures ORDER BY doc_id`)
      .all();
    expect(sigs.map((s) => s.doc_id)).toEqual(["alive"]);
    const edges = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM near_dup_edges`).get();
    expect(edges?.n).toBe(0);
  });
});

describe("applyNearDupDfSnapshot", () => {
  test("wipes + reinserts and advances the OCC watermark", () => {
    setActiveAlgoVersion(db, "v1");
    // Seed an old DF row that should be wiped by the snapshot apply.
    db.prepare(
      "INSERT INTO near_dup_df (algo_version, shingle, df) VALUES ('v1', 'stale', 99)",
    ).run();
    markNearDupDfDirty(db);
    const captured = captureOccVersion(db, "near_dup_df");
    expect(captured).toBeGreaterThan(0);

    const snapshot: NearDupDfSnapshot = {
      algoVersion: "v1",
      totalDocs: 3,
      entries: [
        { shingle: "abc", df: 1 },
        { shingle: "def", df: 2 },
      ],
      uniqueShingles: 2,
      capturedVersion: captured,
    };
    const r = applyNearDupDfSnapshot(db, snapshot);
    expect(r.rebuilt).toBe(2);
    const rows = db
      .prepare("SELECT shingle, df FROM near_dup_df WHERE algo_version='v1' ORDER BY shingle")
      .all() as Array<{ shingle: string; df: number }>;
    expect(rows).toEqual([
      { shingle: "abc", df: 1 },
      { shingle: "def", df: 2 },
    ]);
    const occ = readNearDupDfMeta(db);
    expect(occ.lastAppliedVersion).toBe(captured);
  });

  test("a dirty bump that lands during compute leaves the next tick non-idle", () => {
    setActiveAlgoVersion(db, "v1");
    markNearDupDfDirty(db);
    const captured = captureOccVersion(db, "near_dup_df");

    // Simulate a bump that landed AFTER compute captured but BEFORE
    // the writer applied. The watermark advances to `captured`, but
    // the live `dirty_version` is now higher.
    markNearDupDfDirty(db);

    applyNearDupDfSnapshot(db, {
      algoVersion: "v1",
      totalDocs: 0,
      entries: [],
      uniqueShingles: 0,
      capturedVersion: captured,
    });
    const occ = readNearDupDfMeta(db);
    expect(occ.dirtyVersion).toBeGreaterThan(occ.lastAppliedVersion);
  });

  test("yields between chunks when token fires, resumes to completion", () => {
    setActiveAlgoVersion(db, "v1");
    markNearDupDfDirty(db);
    const captured = captureOccVersion(db, "near_dup_df");

    // Generate entries exceeding one chunk.
    const entryCount = DF_APPLY_CHUNK_SIZE + 100;
    const entries = Array.from({ length: entryCount }, (_, i) => ({
      shingle: `s${i}`,
      df: i + 1,
    }));
    const snapshot: NearDupDfSnapshot = {
      algoVersion: "v1",
      totalDocs: entryCount,
      entries,
      uniqueShingles: entryCount,
      capturedVersion: captured,
    };

    // Token fires after the first chunk.
    let callCount = 0;
    const token = { requested: () => ++callCount > 1 };

    const r1 = applyNearDupDfSnapshot(db, snapshot, 0, { token });
    expect(r1.done).toBe(false);
    expect(r1.nextOffset).toBe(DF_APPLY_CHUNK_SIZE);
    expect(r1.rebuilt).toBe(DF_APPLY_CHUNK_SIZE);

    // Table has been wiped and first chunk inserted.
    const countMid = db
      .prepare("SELECT COUNT(*) as c FROM near_dup_df WHERE algo_version='v1'")
      .get() as { c: number };
    expect(countMid.c).toBe(DF_APPLY_CHUNK_SIZE);

    // Metadata NOT stamped yet.
    expect(readNearDupDfBuiltAt(db, "v1")).toBeNull();

    // Resume from the yielded offset (no preemption this time).
    const r2 = applyNearDupDfSnapshot(db, snapshot, r1.nextOffset);
    expect(r2.done).toBe(true);
    expect(r2.rebuilt).toBe(entryCount);

    // All rows present + metadata stamped.
    const countFinal = db
      .prepare("SELECT COUNT(*) as c FROM near_dup_df WHERE algo_version='v1'")
      .get() as { c: number };
    expect(countFinal.c).toBe(entryCount);
    expect(readNearDupDfBuiltAt(db, "v1")).not.toBeNull();
  });

  test("pre-existing rows are wiped only on first chunk (offset=0)", () => {
    setActiveAlgoVersion(db, "v1");
    db.prepare(
      "INSERT INTO near_dup_df (algo_version, shingle, df) VALUES ('v1', 'old', 42)",
    ).run();
    markNearDupDfDirty(db);
    const captured = captureOccVersion(db, "near_dup_df");

    const snapshot: NearDupDfSnapshot = {
      algoVersion: "v1",
      totalDocs: 2,
      entries: [
        { shingle: "new1", df: 1 },
        { shingle: "new2", df: 2 },
      ],
      uniqueShingles: 2,
      capturedVersion: captured,
    };

    const r = applyNearDupDfSnapshot(db, snapshot, 0);
    expect(r.done).toBe(true);

    const rows = db
      .prepare("SELECT shingle FROM near_dup_df WHERE algo_version='v1' ORDER BY shingle")
      .all() as Array<{ shingle: string }>;
    expect(rows.map((r) => r.shingle)).toEqual(["new1", "new2"]);
  });
});

describe("bumpNearDupAlgo", () => {
  test("is a no-op when persisted algo matches code algo", () => {
    setActiveAlgoVersion(db, DEFAULT_NEAR_DUP_CONFIG.algorithm.algoVersion);
    const r = bumpNearDupAlgo(db, DEFAULT_NEAR_DUP_CONFIG);
    expect(r.enqueued).toBe(0);
    expect(r.bumpedFrom).toBe(DEFAULT_NEAR_DUP_CONFIG.algorithm.algoVersion);
  });

  test("flips the active algo + bulk-enqueues eligible docs on a fresh DB", () => {
    seedDoc("a", "email");
    seedDoc("b", "note");
    seedDoc("c", "contact"); // ineligible (not in DEFAULT_ELIGIBLE_DOC_TYPES)
    const r = bumpNearDupAlgo(db, DEFAULT_NEAR_DUP_CONFIG);
    expect(r.enqueued).toBe(2);
    expect(readActiveAlgoVersion(db)).toBe(DEFAULT_NEAR_DUP_CONFIG.algorithm.algoVersion);
    const inbox = peekNearDupInbox(db, 100);
    expect(inbox).toHaveLength(2);
    for (const row of inbox) expect(row.reason).toBe("algo-bump");
    expect(inbox.map((r) => r.docId).sort()).toEqual(["a", "b"]);
  });

  test("clears built_at so the wall-clock DF refresh fires on next tick", () => {
    // Pre-bump: seed an old algo with a non-null built_at (simulating
    // a prior DF apply). The bump must reset built_at to null so the
    // wall-clock DF refresh task ("fresh-algo" branch) fires for the
    // new algo on its next tick — without this, the compute drip
    // parks indefinitely waiting for DF that never gets rebuilt.
    setActiveAlgoVersion(db, "old-algo-v1");
    setDfBuiltAt(db, "old-algo-v1", 100, 1000, 12345);
    expect(readNearDupDfBuiltAt(db, "old-algo-v1")).toBe(12345);

    seedDoc("a", "email");
    const r = bumpNearDupAlgo(db, DEFAULT_NEAR_DUP_CONFIG);
    expect(r.bumpedFrom).toBe("old-algo-v1");
    // Active algo is now the code's algo, with built_at null.
    expect(readActiveAlgoVersion(db)).toBe(DEFAULT_NEAR_DUP_CONFIG.algorithm.algoVersion);
    expect(readNearDupDfBuiltAt(db, DEFAULT_NEAR_DUP_CONFIG.algorithm.algoVersion)).toBeNull();
  });
});

describe("algoSweepStep", () => {
  test("returns done:true when no stale rows exist", () => {
    setActiveAlgoVersion(db, "v1");
    const r = algoSweepStep(db, {
      ...DEFAULT_NEAR_DUP_CONFIG,
      algorithm: { ...DEFAULT_NEAR_DUP_CONFIG.algorithm, algoVersion: "v1" },
    });
    expect(r.done).toBe(true);
    expect(r.cleared).toBe(0);
  });

  test("clears rows tagged with non-active algo, leaves active rows alone", () => {
    setActiveAlgoVersion(db, "v2");
    seedDoc("a");
    seedDoc("b");
    db.prepare(
      `INSERT INTO near_dup_signatures (doc_id, algo_version, signature, shingle_count, computed_at)
       VALUES ('a', 'v1', X'00', 1, 0), ('b', 'v2', X'00', 1, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO near_dup_df (algo_version, shingle, df) VALUES ('v1', 's', 1), ('v2', 's', 1)`,
    ).run();
    // We don't iterate until done — the writer caller loops; one call
    // should clear at least the v1 rows seen this pass.
    let total = 0;
    for (let i = 0; i < 5; i++) {
      const r = algoSweepStep(db, {
        ...DEFAULT_NEAR_DUP_CONFIG,
        algorithm: { ...DEFAULT_NEAR_DUP_CONFIG.algorithm, algoVersion: "v2" },
      });
      total += r.cleared;
      if (r.done) break;
    }
    expect(total).toBeGreaterThanOrEqual(2);
    const sigRows = db.prepare("SELECT algo_version FROM near_dup_signatures").all() as Array<{
      algo_version: string;
    }>;
    expect(sigRows.map((r) => r.algo_version)).toEqual(["v2"]);
    const dfRows = db.prepare("SELECT algo_version FROM near_dup_df").all() as Array<{
      algo_version: string;
    }>;
    expect(dfRows.map((r) => r.algo_version)).toEqual(["v2"]);
  });
});

describe("markNearDupDfDirty", () => {
  test("bumps the OCC dirty version on the refresh_meta row", () => {
    const before = readNearDupDfMeta(db);
    markNearDupDfDirty(db);
    const after = readNearDupDfMeta(db);
    expect(after.dirtyVersion).toBe(before.dirtyVersion + 1);
  });

  test("advanceOccWatermark to the captured value lands an idle next-poll", () => {
    markNearDupDfDirty(db);
    const captured = captureOccVersion(db, "near_dup_df");
    advanceOccWatermark(db, { job: "near_dup_df", capturedVersion: captured });
    const occ = readNearDupDfMeta(db);
    expect(occ.dirtyVersion).toBe(occ.lastAppliedVersion);
  });
});

describe("applyNearDupDfFromStaging", () => {
  /**
   * Build a staging file the way the compute pass does, so these exercise the
   * real accumulator format rather than a hand-written table that might drift
   * from it.
   */
  function stage(pairs: ReadonlyArray<readonly [string, number]>, encryptionKey?: Buffer): string {
    const path = join(dir, `staging-${pairs.length}-${encryptionKey ? "enc" : "plain"}.sqlite`);
    rmSync(path, { force: true });
    const accum = new ShingleDfAccumulator(path, encryptionKey ?? null);
    accum.add(pairs);
    accum.checkpoint();
    accum.close();
    return path;
  }

  test("moves the staged table into the live one and advances the OCC watermark", () => {
    setActiveAlgoVersion(db, "v1");
    db.prepare(
      "INSERT INTO near_dup_df (algo_version, shingle, df) VALUES ('v1', 'stale', 99)",
    ).run();
    markNearDupDfDirty(db);
    const captured = captureOccVersion(db, "near_dup_df");

    const path = stage([
      ["alpha", 4],
      ["bravo", 2],
      ["charlie", 1],
    ]);
    const r = applyNearDupDfFromStaging(db, {
      stagingPath: path,
      algoVersion: "v1",
      totalDocs: 7,
      minDf: 2,
      capturedVersion: captured,
      expectedRows: 2,
    });

    expect(r.done).toBe(true);
    // `charlie` is below minDf, `stale` was wiped by the first chunk.
    expect(r.rebuilt).toBe(2);
    expect(liveRows()).toEqual([
      { shingle: "alpha", df: 4 },
      { shingle: "bravo", df: 2 },
    ]);
    expect(readNearDupDfMeta(db).lastAppliedVersion).toBe(captured);
    expect(readNearDupDfBuiltAt(db, "v1")).not.toBeNull();
  });

  /**
   * On an install that encrypts its stores the staging file is encrypted too,
   * with the same derived key. A reader that ignores the key sees a file whose
   * header is not SQLite's and fails at open, which would make the DF rebuild
   * impossible on exactly the installs that have one.
   */
  test("reads a staging file written with the store's encryption key", () => {
    setActiveAlgoVersion(db, "v1");
    markNearDupDfDirty(db);
    const captured = captureOccVersion(db, "near_dup_df");
    const key = randomBytes(32);

    const path = stage(
      [
        ["delta", 3],
        ["echo", 5],
      ],
      key,
    );
    // The staged bytes really are encrypted — otherwise the key argument
    // below would be proving nothing.
    expect(readFileSync(path, "utf8")).not.toContain("delta");

    const r = applyNearDupDfFromStaging(db, {
      stagingPath: path,
      stagingKeyHex: key.toString("hex"),
      algoVersion: "v1",
      totalDocs: 9,
      minDf: 2,
      capturedVersion: captured,
      expectedRows: 2,
    });

    expect(r.done).toBe(true);
    expect(liveRows()).toEqual([
      { shingle: "delta", df: 3 },
      { shingle: "echo", df: 5 },
    ]);
  });

  test("stamps a build that legitimately found nothing, so the trigger stops", () => {
    // A corpus with nothing shared — a nearly-empty install, or one right
    // after an algo bump — produces no row at or above minDf. That is a
    // complete answer, not a failure: leaving `built_at` unset would make
    // the trigger repeat the whole corpus scan on every tick forever, and
    // park the compute drip while it did.
    setActiveAlgoVersion(db, "v1");
    db.prepare(
      "INSERT INTO near_dup_df (algo_version, shingle, df) VALUES ('v1', 'from-a-larger-corpus', 4)",
    ).run();
    markNearDupDfDirty(db);
    const captured = captureOccVersion(db, "near_dup_df");

    const path = stage([["lonely", 1]]);
    const r = applyNearDupDfFromStaging(db, {
      stagingPath: path,
      algoVersion: "v1",
      totalDocs: 1,
      minDf: 2,
      capturedVersion: captured,
      expectedRows: 0,
    });

    expect(r.done).toBe(true);
    expect(r.rebuilt).toBe(0);
    // The table describes the corpus as it is now, so rows describing the
    // corpus it used to be do not survive.
    expect(liveRows()).toEqual([]);
    expect(readNearDupDfBuiltAt(db, "v1")).not.toBeNull();
    expect(readNearDupDfMeta(db).lastAppliedVersion).toBe(captured);
  });

  test("a build over an empty corpus is not stamped, so the compute drip stays parked", () => {
    // With no document scanned every shingle gets idf weight
    // log((0 + 1) / (0 + 1)) = 0, so a signature computed against this
    // table distinguishes nothing at all. `built_at` is what un-parks the
    // compute drip, and nothing re-signs a document once it is signed, so
    // stamping a zero-document build hands a whole bootstrap permanently
    // meaningless signatures. Leave it unbuilt; the wall-clock trigger
    // retries on its next tick, when there is a corpus to weigh.
    setActiveAlgoVersion(db, "v1");
    markNearDupDfDirty(db);
    const captured = captureOccVersion(db, "near_dup_df");

    const path = stage([]);
    const r = applyNearDupDfFromStaging(db, {
      stagingPath: path,
      algoVersion: "v1",
      totalDocs: 0,
      minDf: 2,
      capturedVersion: captured,
      expectedRows: 0,
    });

    expect(r.done).toBe(true);
    expect(r.rebuilt).toBe(0);
    expect(readNearDupDfBuiltAt(db, "v1")).toBeNull();
    expect(readNearDupDfMeta(db).lastAppliedVersion).not.toBe(captured);
  });

  test("refuses an empty build rather than wiping the live table", () => {
    setActiveAlgoVersion(db, "v1");
    setDfBuiltAt(db, "v1", 5, 1, 1_700_000_000);
    db.prepare(
      "INSERT INTO near_dup_df (algo_version, shingle, df) VALUES ('v1', 'keep', 6)",
    ).run();
    markNearDupDfDirty(db);
    const captured = captureOccVersion(db, "near_dup_df");

    // The build counted rows and staging has none: they were lost between
    // the scan and here. That is the corruption case, and it must not be
    // allowed to stamp an empty table as the current one.
    const path = stage([["lonely", 1]]);
    expect(() =>
      applyNearDupDfFromStaging(db, {
        stagingPath: path,
        algoVersion: "v1",
        totalDocs: 5,
        minDf: 2,
        capturedVersion: captured,
        expectedRows: 7,
      }),
    ).toThrow(/refusing to replace the live table/);

    expect(liveRows()).toEqual([{ shingle: "keep", df: 6 }]);
    expect(readNearDupDfBuiltAt(db, "v1")).toBe(1_700_000_000);
  });

  test("resumes from the keyset position after a preempt, without redoing the delete", () => {
    setActiveAlgoVersion(db, "v1");
    markNearDupDfDirty(db);
    const captured = captureOccVersion(db, "near_dup_df");

    // Two full chunks plus a remainder, so the first pass must yield with
    // work still staged.
    const pairs = Array.from(
      { length: DF_APPLY_CHUNK_SIZE * 2 + 5 },
      (_, i) => [`s${String(i).padStart(6, "0")}`, 2] as const,
    );
    const path = stage(pairs);
    // The function checks the token before doing anything, so a token that is
    // always requested would return without applying a chunk. This one lets
    // the first check through and requests the yield at the chunk boundary,
    // which is the state the scheduler actually produces.
    let allowChecks = 1;
    const token = { requested: () => allowChecks-- <= 0 };

    const first = applyNearDupDfFromStaging(
      db,
      {
        stagingPath: path,
        algoVersion: "v1",
        totalDocs: 3,
        minDf: 2,
        capturedVersion: captured,
        expectedRows: pairs.length,
      },
      { afterShingle: null, applied: 0 },
      { token },
    );
    expect(first.done).toBe(false);
    expect(first.rebuilt).toBe(DF_APPLY_CHUNK_SIZE);
    expect(first.nextAfterShingle).not.toBeNull();
    // Unfinished builds must not advertise themselves as current.
    expect(readNearDupDfBuiltAt(db, "v1")).toBeNull();

    let resume = { afterShingle: first.nextAfterShingle, applied: first.rebuilt };
    for (let i = 0; i < 5; i += 1) {
      allowChecks = 1;
      const next = applyNearDupDfFromStaging(
        db,
        {
          stagingPath: path,
          algoVersion: "v1",
          totalDocs: 3,
          minDf: 2,
          capturedVersion: captured,
          expectedRows: pairs.length,
        },
        resume,
        { token },
      );
      resume = { afterShingle: next.nextAfterShingle, applied: next.rebuilt };
      if (next.done) break;
    }

    expect(resume.applied).toBe(pairs.length);
    expect(
      db.prepare("SELECT COUNT(*) FROM near_dup_df WHERE algo_version='v1'").pluck().get(),
    ).toBe(pairs.length);
    expect(readNearDupDfBuiltAt(db, "v1")).not.toBeNull();
  });

  test("yields on its time budget without a preemption request", () => {
    setActiveAlgoVersion(db, "v1");
    markNearDupDfDirty(db);
    const captured = captureOccVersion(db, "near_dup_df");
    const pairs = Array.from(
      { length: DF_APPLY_CHUNK_SIZE * 2 + 5 },
      (_, i) => [`budget-${String(i).padStart(6, "0")}`, 2] as const,
    );
    const path = stage(pairs);
    const input = {
      stagingPath: path,
      algoVersion: "v1",
      totalDocs: 3,
      minDf: 2,
      capturedVersion: captured,
      expectedRows: pairs.length,
    };
    const token = { requested: () => false };

    const first = applyNearDupDfFromStaging(
      db,
      input,
      { afterShingle: null, applied: 0 },
      { token, maxSliceMs: 0 },
    );
    expect(first).toMatchObject({ done: false, rebuilt: DF_APPLY_CHUNK_SIZE });
    expect(readNearDupDfBuiltAt(db, "v1")).toBeNull();

    let result = first;
    while (!result.done) {
      result = applyNearDupDfFromStaging(
        db,
        input,
        {
          afterShingle: result.nextAfterShingle,
          applied: result.rebuilt,
          generation: result.generation,
        },
        { token, maxSliceMs: 0 },
      );
    }

    expect(result.rebuilt).toBe(pairs.length);
    expect(readNearDupDfBuiltAt(db, "v1")).not.toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) FROM near_dup_df WHERE algo_version='v1'").pluck().get(),
    ).toBe(pairs.length);
  });

  test("the production writer handler supplies the time budget", () => {
    setActiveAlgoVersion(db, "v1");
    markNearDupDfDirty(db);
    const pairs = Array.from(
      { length: DF_APPLY_CHUNK_SIZE + 1 },
      (_, i) => [`handler-budget-${String(i).padStart(6, "0")}`, 2] as const,
    );
    const input = {
      stagingPath: stage(pairs),
      algoVersion: "v1",
      totalDocs: 3,
      minDf: 2,
      capturedVersion: captureOccVersion(db, "near_dup_df"),
      expectedRows: pairs.length,
    };
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(101);

    try {
      const outcome = writerYieldableHandlers["nearDup.applyDfFromStaging"](
        db,
        new PreemptToken(new PreemptBuffer().share()),
        input,
      );
      expect(outcome).toMatchObject({
        kind: "yield",
        resume: [
          input,
          {
            applied: DF_APPLY_CHUNK_SIZE,
            generation: expect.any(Number),
            afterShingle: expect.any(String),
          },
        ],
      });
      expect(readNearDupDfBuiltAt(db, "v1")).toBeNull();
    } finally {
      now.mockRestore();
    }
  });
});

/**
 * The generation swap.
 *
 * A rebuild writes its rows under a generation of their own, alongside the
 * live ones, and publishes itself by moving a single pointer. That is what
 * keeps the write lock held for no longer than one chunk, and what lets a
 * reader see one complete build at every moment of a rebuild.
 */
describe("algoSweepStep — retiring a stale algo", () => {
  /**
   * The pass skips its table read when a primary-key seek shows no rows for
   * another algo. The seek has to look both ways: `algo_version` is a
   * string, and a stale version can sort either side of the active one, so
   * a guard that checked one direction would leave the other's rows on disk
   * forever while reporting nothing to do.
   */
  for (const [label, staleAlgo] of [
    ["sorting before the active version", "aaa-older-algo"],
    ["sorting after the active version", "zzz-newer-algo"],
  ] as const) {
    test(`retires every generation of a stale algo ${label}`, () => {
      setActiveAlgoVersion(db, "v1");
      const insert = db.prepare(
        "INSERT INTO near_dup_df (algo_version, generation, shingle, df) VALUES (?, ?, ?, ?)",
      );
      // Two generations of it, because a stale algo's rows are not confined
      // to one — it was rebuilt while it was active.
      for (const generation of [0, 1, 2]) {
        insert.run(staleAlgo, generation, `stale-${generation}`, 3);
      }
      insert.run("v1", 0, "live-row", 4);

      const config = {
        ...DEFAULT_NEAR_DUP_CONFIG,
        algorithm: { ...DEFAULT_NEAR_DUP_CONFIG.algorithm, algoVersion: "v1" },
        scheduler: { ...DEFAULT_NEAR_DUP_CONFIG.scheduler, algoSweepChunkSize: 100 },
      };
      for (let i = 0; i < 6; i += 1) {
        const { done } = algoSweepStep(db, config);
        if (done) break;
      }

      const left = db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM near_dup_df WHERE algo_version = ?")
        .get(staleAlgo);
      expect(left?.n, `${staleAlgo} rows survived the sweep`).toBe(0);
      // And it took nothing belonging to the active algo.
      const live = db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM near_dup_df WHERE algo_version = 'v1'")
        .get();
      expect(live?.n).toBe(1);
    });
  }
});

describe("near_dup_df generations", () => {
  function stageRows(pairs: ReadonlyArray<readonly [string, number]>, name: string): string {
    const path = join(dir, `gen-${name}.sqlite`);
    rmSync(path, { force: true });
    const accum = new ShingleDfAccumulator(path, null);
    accum.add(pairs);
    accum.checkpoint();
    accum.close();
    return path;
  }

  function apply(path: string, expectedRows: number, captured: number): void {
    applyNearDupDfFromStaging(db, {
      stagingPath: path,
      algoVersion: "v1",
      totalDocs: 9,
      minDf: 2,
      capturedVersion: captured,
      expectedRows,
    });
  }

  function liveGeneration(): number {
    return (
      db
        .prepare<
          [],
          { live_generation: number }
        >("SELECT live_generation FROM near_dup_df_meta WHERE algo_version = 'v1'")
        .get()?.live_generation ?? -1
    );
  }

  function rowsInGeneration(gen: number): Array<{ shingle: string; df: number }> {
    return db
      .prepare(
        "SELECT shingle, df FROM near_dup_df WHERE algo_version='v1' AND generation=? ORDER BY shingle",
      )
      .all(gen) as Array<{ shingle: string; df: number }>;
  }

  test("a rebuild publishes a new generation and leaves the old one in place", () => {
    setActiveAlgoVersion(db, "v1");
    markNearDupDfDirty(db);
    apply(
      stageRows(
        [
          ["alpha", 3],
          ["bravo", 2],
        ],
        "first",
      ),
      2,
      captureOccVersion(db, "near_dup_df"),
    );
    const firstGen = liveGeneration();
    expect(rowsInGeneration(firstGen).map((r) => r.shingle)).toEqual(["alpha", "bravo"]);

    markNearDupDfDirty(db);
    apply(
      stageRows(
        [
          ["charlie", 4],
          ["delta", 5],
        ],
        "second",
      ),
      2,
      captureOccVersion(db, "near_dup_df"),
    );

    // The pointer moved, so readers see only the new build...
    expect(liveGeneration()).toBe(firstGen + 1);
    expect(liveRows().map((r) => r.shingle)).toEqual(["charlie", "delta"]);
    // ...and the old rows are still on disk, owed to the sweep. That is the
    // trade: no mass delete on the writer, reclaimed in the background.
    expect(rowsInGeneration(firstGen).map((r) => r.shingle)).toEqual(["alpha", "bravo"]);
    expect(allRows()).toBe(4);
  });

  test("a reader sees the whole previous build while the next one is part-written", () => {
    // Weighting must never run against a fraction of the corpus. A reader
    // reads one generation, so a rebuild part-way through writing the next
    // is invisible to it — what it sees is the last complete build.
    setActiveAlgoVersion(db, "v1");
    markNearDupDfDirty(db);
    apply(
      stageRows(
        [
          ["alpha", 3],
          ["bravo", 2],
        ],
        "published",
      ),
      2,
      captureOccVersion(db, "near_dup_df"),
    );
    // Drive the reader the near-duplicate compute pass actually uses, not
    // this file's helper — a helper with its own generation filter would
    // pass whatever the production query did.
    const before = buildInMemoryDfFromTable(db, "v1");
    expect(before.size()).toBe(2);
    expect(before.df("alpha")).toBe(3);

    // A rebuild that stops part-way: rows land in the next generation, and
    // nothing publishes them.
    const nextGen = liveGeneration() + 1;
    db.prepare(
      "INSERT INTO near_dup_df (algo_version, generation, shingle, df) VALUES ('v1', ?, 'partial', 9)",
    ).run(nextGen);

    // A fresh handle, because the reader memoises per database object and a
    // second call on `db` would answer from that cache without running the
    // query this is here to check.
    const reader = new Database(join(dir, "omnesis.db"), { readonly: true }) as unknown as Db;
    try {
      const during = buildInMemoryDfFromTable(reader, "v1");
      expect(during.size(), "the reader picked up a generation nothing published").toBe(2);
      expect(during.df("partial")).toBe(0);
      expect(during.df("alpha")).toBe(3);
    } finally {
      (reader as unknown as { close(): void }).close();
    }
  });

  test("the sweep leaves a build that is still writing alone", () => {
    // The apply is yieldable, so the sweep runs between its chunks. A sweep
    // that retired everything except the live generation would delete the
    // rows of the build about to publish, and the loss would be silent: a
    // complete-looking table missing whatever the sweep reached first.
    setActiveAlgoVersion(db, "v1");
    markNearDupDfDirty(db);
    apply(
      stageRows(
        [
          ["alpha", 3],
          ["bravo", 2],
        ],
        "published-before-sweep",
      ),
      2,
      captureOccVersion(db, "near_dup_df"),
    );
    const live = liveGeneration();

    // A build in flight: rows in the next generation, nothing published.
    db.prepare(
      "INSERT INTO near_dup_df (algo_version, generation, shingle, df) VALUES ('v1', ?, 'in-flight', 7)",
    ).run(live + 1);

    const config = {
      ...DEFAULT_NEAR_DUP_CONFIG,
      algorithm: { ...DEFAULT_NEAR_DUP_CONFIG.algorithm, algoVersion: "v1" },
      scheduler: { ...DEFAULT_NEAR_DUP_CONFIG.scheduler, algoSweepChunkSize: 100 },
    };
    for (let i = 0; i < 5; i += 1) {
      const { done } = generationSweepStep(db, config);
      if (done) break;
    }

    expect(
      rowsInGeneration(live + 1).map((r) => r.shingle),
      "the sweep took rows from a build that had not published",
    ).toEqual(["in-flight"]);
    expect(liveRows().map((r) => r.shingle)).toEqual(["alpha", "bravo"]);
  });

  test("a build that died mid-write is not folded into the next one", () => {
    // Its rows sit under a generation nothing published. Reusing that
    // number would merge them into the next build, which then publishes
    // shingles no scan of the current corpus produced.
    setActiveAlgoVersion(db, "v1");
    markNearDupDfDirty(db);
    apply(
      stageRows(
        [
          ["alpha", 3],
          ["bravo", 2],
        ],
        "first-of-orphan",
      ),
      2,
      captureOccVersion(db, "near_dup_df"),
    );
    const live = liveGeneration();
    db.prepare(
      "INSERT INTO near_dup_df (algo_version, generation, shingle, df) VALUES ('v1', ?, 'orphan', 9)",
    ).run(live + 1);

    markNearDupDfDirty(db);
    apply(
      stageRows(
        [
          ["charlie", 4],
          ["delta", 5],
        ],
        "after-orphan",
      ),
      2,
      captureOccVersion(db, "near_dup_df"),
    );

    expect(liveGeneration()).toBeGreaterThan(live + 1);
    expect(liveRows().map((r) => r.shingle)).toEqual(["charlie", "delta"]);
    expect(
      liveRows().some((r) => r.shingle === "orphan"),
      "the dead build's rows were published as part of a later one",
    ).toBe(false);
  });

  test("a build preempted before it writes anything still targets a new generation", () => {
    // The scheduler resets the preempt flag on the main thread and the op
    // then crosses a worker hop, so a higher-priority enqueue in that gap
    // leaves the flag set before the handler runs a single chunk. The
    // generation reported by that early return is what the continuation
    // builds into — if it named the live one, the build would land in the
    // table readers are using and publish a mixture of two builds under a
    // pointer that never moved.
    setActiveAlgoVersion(db, "v1");
    markNearDupDfDirty(db);
    apply(
      stageRows(
        [
          ["alpha", 3],
          ["bravo", 2],
        ],
        "before-preempt",
      ),
      2,
      captureOccVersion(db, "near_dup_df"),
    );
    const live = liveGeneration();

    const captured = captureOccVersion(db, "near_dup_df");
    const path = stageRows(
      [
        ["charlie", 4],
        ["delta", 5],
      ],
      "preempted",
    );
    const input = {
      stagingPath: path,
      algoVersion: "v1",
      totalDocs: 3,
      minDf: 2,
      capturedVersion: captured,
      expectedRows: 2,
    };

    // Already requested on entry: nothing is written this dispatch.
    const preempted = applyNearDupDfFromStaging(
      db,
      input,
      { afterShingle: null, applied: 0 },
      { token: { requested: () => true } },
    );
    expect(preempted.done).toBe(false);
    expect(preempted.rebuilt).toBe(0);
    expect(
      preempted.generation,
      "the continuation would have built into the live generation",
    ).toBeGreaterThan(live);

    // The continuation, fed exactly what the handler would feed it.
    const finished = applyNearDupDfFromStaging(db, input, {
      afterShingle: preempted.nextAfterShingle,
      applied: preempted.rebuilt,
      generation: preempted.generation,
    });
    expect(finished.done).toBe(true);
    expect(liveGeneration()).toBe(preempted.generation);
    // The earlier build's rows stayed where they were, whole, and are not
    // mixed into what was published.
    expect(liveRows().map((r) => r.shingle)).toEqual(["charlie", "delta"]);
    expect(rowsInGeneration(live).map((r) => r.shingle)).toEqual(["alpha", "bravo"]);
  });

  test("a resumed build keeps writing into the generation it started", () => {
    // Recomputing the target on resume would put the tail in a generation
    // after the head, and publish only the tail.
    setActiveAlgoVersion(db, "v1");
    markNearDupDfDirty(db);
    const captured = captureOccVersion(db, "near_dup_df");
    const pairs = Array.from(
      { length: DF_APPLY_CHUNK_SIZE * 2 + 3 },
      (_, i) => [`s${String(i).padStart(6, "0")}`, 2] as const,
    );
    const path = stageRows(pairs, "resumed");

    let allowChecks = 1;
    const token = { requested: () => allowChecks-- <= 0 };
    const first = applyNearDupDfFromStaging(
      db,
      {
        stagingPath: path,
        algoVersion: "v1",
        totalDocs: 3,
        minDf: 2,
        capturedVersion: captured,
        expectedRows: pairs.length,
      },
      { afterShingle: null, applied: 0 },
      { token },
    );
    expect(first.done).toBe(false);

    let resume = {
      afterShingle: first.nextAfterShingle,
      applied: first.rebuilt,
      generation: first.generation,
    };
    for (let i = 0; i < 6; i += 1) {
      allowChecks = 1;
      const next = applyNearDupDfFromStaging(
        db,
        {
          stagingPath: path,
          algoVersion: "v1",
          totalDocs: 3,
          minDf: 2,
          capturedVersion: captured,
          expectedRows: pairs.length,
        },
        resume,
        { token },
      );
      resume = {
        afterShingle: next.nextAfterShingle,
        applied: next.rebuilt,
        generation: next.generation,
      };
      if (next.done) break;
    }

    // One generation holds the whole build, and it is the published one.
    expect(liveGeneration()).toBe(first.generation);
    expect(liveRows().length).toBe(pairs.length);
    expect(allRows()).toBe(pairs.length);
  });

  test("the sweep reclaims a superseded generation in bounded chunks", () => {
    setActiveAlgoVersion(db, "v1");
    markNearDupDfDirty(db);
    apply(
      stageRows(
        [
          ["alpha", 3],
          ["bravo", 2],
        ],
        "old",
      ),
      2,
      captureOccVersion(db, "near_dup_df"),
    );
    markNearDupDfDirty(db);
    apply(
      stageRows(
        [
          ["charlie", 4],
          ["delta", 5],
        ],
        "new",
      ),
      2,
      captureOccVersion(db, "near_dup_df"),
    );
    expect(allRows()).toBe(4);

    const config = {
      ...DEFAULT_NEAR_DUP_CONFIG,
      algorithm: { ...DEFAULT_NEAR_DUP_CONFIG.algorithm, algoVersion: "v1" },
      scheduler: { ...DEFAULT_NEAR_DUP_CONFIG.scheduler, algoSweepChunkSize: 1 },
    };
    // One row per pass, because the chunk size says so — the sweep must not
    // reclaim a large generation in one unbounded statement either.
    let passes = 0;
    for (; passes < 10; passes += 1) {
      const { done } = generationSweepStep(db, config);
      if (done) break;
    }
    expect(passes).toBeGreaterThan(1);
    expect(allRows()).toBe(2);
    // What survives is exactly the live build.
    expect(liveRows().map((r) => r.shingle)).toEqual(["charlie", "delta"]);
  });
});
