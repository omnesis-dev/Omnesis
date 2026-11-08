// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The bounded near-dup apply makes the same decisions as the apply it
 * replaced.
 *
 * The apply now pins its bucket delete to the doc index, closes a chunk on a
 * row budget as well as a doc count, and gives the writer back once its time
 * slice is spent. None of that may change what a batch writes. The reference
 * below is the previous apply as it ran in one uninterrupted call: the same
 * statements, unpinned, in chunks of 25 docs. Randomised sequences of batches
 * — inserts, updates that drop edges, documents removed between compute and
 * apply, pairs inside one batch and pairs reaching the existing corpus — go
 * through both, and every near-dup row, the inbox and the reported totals must
 * match.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { enqueueNearDupInbox, peekNearDupInbox, removeNearDupInboxRows } from "./inbox.js";
import { setActiveAlgoVersion } from "./meta.js";
import { applyNearDupBatch, BUCKET_DELETE_FOR_DOC_SQL } from "./NearDupWriterOps.js";
import type { Db } from "../data/types.js";
import type { NearDupApplyBatch, NearDupApplyResult, NearDupEdgeUpsert } from "./types.js";

const ALGO = "v1";
const DOCS = 90;
const docId = (i: number): string => `doc-${String(i).padStart(3, "0")}`;

/** The previous apply, run the way a call that is never preempted ran it. */
function referenceApply(db: Db, batch: NearDupApplyBatch): NearDupApplyResult {
  const result: NearDupApplyResult = {
    inboxConsumed: 0,
    signaturesUpserted: 0,
    bucketsUpserted: 0,
    edgesUpserted: 0,
    edgesDeleted: 0,
  };
  const sigDelete = db.prepare(
    `DELETE FROM near_dup_signatures WHERE doc_id = ? AND algo_version = ?`,
  );
  const bucketDeleteForDoc = db.prepare(
    `DELETE FROM near_dup_lsh_buckets WHERE doc_id = ? AND algo_version = ?`,
  );
  const edgeDeleteForDoc = db.prepare(
    `DELETE FROM near_dup_edges WHERE algo_version = ? AND (doc_a = ? OR doc_b = ?)`,
  );
  const sigUpsert = db.prepare(
    `INSERT OR REPLACE INTO near_dup_signatures
     (doc_id, algo_version, signature, shingle_count, computed_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const bucketUpsert = db.prepare(
    `INSERT OR IGNORE INTO near_dup_lsh_buckets
     (algo_version, band_idx, bucket_hash, doc_id) VALUES (?, ?, ?, ?)`,
  );
  const edgeUpsert = db.prepare(
    `INSERT OR REPLACE INTO near_dup_edges
       (doc_a, doc_b, algo_version, jaccard, pair_unique_df2, pair_unique_df5,
        containment_min, gate_family, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const edgeDelete = db.prepare(
    `DELETE FROM near_dup_edges WHERE doc_a = ? AND doc_b = ? AND algo_version = ?`,
  );
  const docExistsStmt = db.prepare(`SELECT 1 AS one FROM documents WHERE id = ?`);
  const existence = new Map<string, boolean>();
  const docExists = (id: string): boolean => {
    if (!existence.has(id)) existence.set(id, docExistsStmt.get(id) !== undefined);
    return existence.get(id)!;
  };
  const now = Math.floor(Date.now() / 1000);
  const writtenEdges = new Set<string>();
  const writtenEdgeDeletes = new Set<string>();
  const processedIds = [...batch.processedInboxIds].sort((a, b) => a - b);
  const sigsByDoc = new Map(batch.signatures.map((s) => [s.docId, s]));
  const group = <T>(rows: T[], keys: (row: T) => string[]): Map<string, T[]> => {
    const map = new Map<string, T[]>();
    for (const row of rows) for (const k of keys(row)) map.set(k, [...(map.get(k) ?? []), row]);
    return map;
  };
  const bucketsByDoc = group(batch.bucketRows, (b) => [b.docId]);
  const edgeUpsertsByDoc = group(batch.edgeUpserts, (e) => [e.docA, e.docB]);
  const edgeDeletesByDoc = group(batch.edgeDeletes, (e) => [e.docA, e.docB]);
  const touchedDocs = [...new Set(batch.signatureDeletes)];

  const writeDoc = (id: string): void => {
    sigDelete.run(id, batch.algoVersion);
    bucketDeleteForDoc.run(id, batch.algoVersion);
    edgeDeleteForDoc.run(batch.algoVersion, id, id);
    if (!docExists(id)) return;
    const sig = sigsByDoc.get(id);
    if (sig) {
      sigUpsert.run(sig.docId, sig.algoVersion, sig.signature, sig.shingleCount, now);
      result.signaturesUpserted++;
    }
    for (const b of bucketsByDoc.get(id) ?? []) {
      bucketUpsert.run(b.algoVersion, b.bandIdx, b.bucketHash, b.docId);
      result.bucketsUpserted++;
    }
    for (const e of edgeUpsertsByDoc.get(id) ?? []) {
      if (!docExists(e.docA) || !docExists(e.docB)) continue;
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
      const key = `${e.docA}|${e.docB}`;
      if (!writtenEdges.has(key)) {
        writtenEdges.add(key);
        result.edgesUpserted++;
      }
    }
    for (const e of edgeDeletesByDoc.get(id) ?? []) {
      const key = `${e.docA}|${e.docB}`;
      if (writtenEdgeDeletes.has(key)) continue;
      edgeDelete.run(e.docA, e.docB, e.algoVersion);
      writtenEdgeDeletes.add(key);
      result.edgesDeleted++;
    }
  };
  for (let i = 0; i < touchedDocs.length; i += 25) {
    db.transaction(() => {
      for (const id of touchedDocs.slice(i, i + 25)) writeDoc(id);
    })();
  }
  result.inboxConsumed = removeNearDupInboxRows(db, processedIds).removed;
  return result;
}

/** The bounded apply, driven the way the scheduler drives its continuations. */
function boundedApply(
  db: Db,
  batch: NearDupApplyBatch,
  rand: () => number,
): { result: NearDupApplyResult; calls: number } {
  let pending: NearDupApplyBatch = batch;
  for (let calls = 1; ; calls++) {
    const token = { requested: () => rand() < 0.3 };
    const r = applyNearDupBatch(db, pending, {
      token,
      maxSliceMs: rand() < 0.5 ? 0 : undefined,
      chunkRowBudget: 1 + Math.floor(rand() * 60),
    });
    if (r.remaining === null) {
      const { remaining: _remaining, ...result } = r;
      return { result, calls };
    }
    pending = r.remaining;
  }
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function openDb(dir: string, name: string): Db {
  const db = new Database(join(dir, name)) as unknown as Db;
  db.exec("PRAGMA journal_mode = WAL");
  runSchemaSetup(db);
  runMigrations(db);
  db.pragma("foreign_keys = ON");
  setActiveAlgoVersion(db, ALGO);
  const insert = db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
        content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'p', 'src:p', ?, ?, 'body', ?, '{"documentType":"document"}',
       '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`,
  );
  db.transaction(() => {
    for (let i = 0; i < DOCS; i++) insert.run(docId(i), docId(i), `t-${i}`, `ch-${i}`);
  })();
  return db;
}

/** A compute batch: random touched docs, their rows, and edges in and out of the batch. */
function randomBatch(rand: () => number, live: ReadonlySet<string>, inboxIds: number[]) {
  const pick = (): string => docId(Math.floor(rand() * DOCS));
  const touched = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 70) }, pick))];
  const batch: NearDupApplyBatch = {
    algoVersion: ALGO,
    processedInboxIds: inboxIds,
    signatureDeletes: [],
    signatures: [],
    bucketRows: [],
    edgeUpserts: [],
    edgeDeletes: [],
  };
  const emitted = new Set<string>();
  for (const id of touched) {
    batch.signatureDeletes.push(id);
    if (rand() < 0.1) continue;
    batch.signatures.push({
      docId: id,
      algoVersion: ALGO,
      signature: Buffer.from([Math.floor(rand() * 256)]),
      shingleCount: 1 + Math.floor(rand() * 50),
    });
    for (let b = 0; b < 16; b++) {
      batch.bucketRows.push({
        algoVersion: ALGO,
        bandIdx: b,
        bucketHash: Math.floor(rand() * 40),
        docId: id,
      });
    }
    const edges = rand() < 0.05 ? 40 : Math.floor(rand() * 5);
    for (let k = 0; k < edges; k++) {
      const other = rand() < 0.5 ? touched[Math.floor(rand() * touched.length)] : pick();
      if (other === id) continue;
      const [docA, docB] = id < other ? [id, other] : [other, id];
      if (emitted.has(`${docA}|${docB}`)) continue;
      emitted.add(`${docA}|${docB}`);
      const edge: NearDupEdgeUpsert = {
        docA,
        docB,
        algoVersion: ALGO,
        jaccard: Math.round(rand() * 100) / 100,
        pairUniqueDf2: Math.floor(rand() * 9),
        pairUniqueDf5: Math.floor(rand() * 9),
        containmentMin: Math.round(rand() * 100) / 100,
        gateFamily: rand() < 0.5 ? "email" : "file-like",
      };
      batch.edgeUpserts.push(edge);
    }
    if (rand() < 0.3) {
      for (let k = 0; k < 3; k++) {
        const other = pick();
        if (other === id) continue;
        const [docA, docB] = id < other ? [id, other] : [other, id];
        if (!emitted.has(`${docA}|${docB}`))
          batch.edgeDeletes.push({ docA, docB, algoVersion: ALGO });
      }
    }
  }
  const removed = touched.filter((id) => live.has(id) && rand() < 0.08);
  return { batch, touched, removed };
}

function state(db: Db): unknown {
  return {
    signatures: db
      .prepare(
        "SELECT doc_id, algo_version, hex(signature) AS sig, shingle_count, computed_at FROM near_dup_signatures ORDER BY doc_id, algo_version",
      )
      .all(),
    buckets: db
      .prepare(
        "SELECT algo_version, band_idx, bucket_hash, doc_id FROM near_dup_lsh_buckets ORDER BY 1, 2, 3, 4",
      )
      .all(),
    edges: db.prepare("SELECT * FROM near_dup_edges ORDER BY doc_a, doc_b, algo_version").all(),
    inbox: db.prepare("SELECT doc_id, enqueued_reason FROM near_dup_inbox ORDER BY id").all(),
    documents: db.prepare("SELECT id FROM documents ORDER BY id").all(),
  };
}

let dir: string;
let reference: Db;
let bounded: Db;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  dir = mkdtempSync(join(tmpdir(), "omnesis-near-dup-equivalence-"));
  reference = openDb(dir, "reference.db");
  bounded = openDb(dir, "bounded.db");
});

afterEach(() => {
  reference.close();
  bounded.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("bounded near-dup apply equivalence", () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "seed %i: every batch writes the same rows and reports the same totals",
    (seed) => {
      const rand = mulberry32(seed * 7919);
      const drive = mulberry32(seed * 104729);
      const live = new Set(Array.from({ length: DOCS }, (_, i) => docId(i)));
      let yields = 0;
      for (let step = 0; step < 12; step++) {
        const reason = step === 0 ? "insert" : "update";
        const draft = randomBatch(rand, live, []);
        for (const db of [reference, bounded]) enqueueNearDupInbox(db, draft.touched, reason);
        const inboxIds = peekNearDupInbox(reference, 1_000).map((r) => r.id);
        expect(peekNearDupInbox(bounded, 1_000).map((r) => r.id)).toEqual(inboxIds);
        const batch = { ...draft.batch, processedInboxIds: inboxIds };

        for (const id of draft.removed) {
          live.delete(id);
          for (const db of [reference, bounded]) {
            db.prepare("DELETE FROM documents WHERE id = ?").run(id);
          }
        }

        const expected = referenceApply(reference, structuredClone(batch));
        const actual = boundedApply(bounded, structuredClone(batch), drive);
        yields += actual.calls - 1;
        expect(actual.result).toEqual(expected);
        expect(state(bounded)).toEqual(state(reference));
      }
      expect(yields).toBeGreaterThan(0);
    },
  );

  test("the pinned bucket delete reads the doc index and removes the same rows", () => {
    const plan = (sql: string): string =>
      (
        bounded.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(docId(1), ALGO) as Array<{
          detail: string;
        }>
      )
        .map((row) => row.detail)
        .join("; ");
    const unpinned = "DELETE FROM near_dup_lsh_buckets WHERE doc_id = ? AND algo_version = ?";
    expect(plan(BUCKET_DELETE_FOR_DOC_SQL)).toContain(
      "USING INDEX idx_near_dup_lsh_doc (doc_id=?)",
    );
    expect(plan(unpinned)).not.toContain("idx_near_dup_lsh_doc");

    const insert = (db: Db): void => {
      const stmt = db.prepare(
        "INSERT INTO near_dup_lsh_buckets (algo_version, band_idx, bucket_hash, doc_id) VALUES (?, ?, ?, ?)",
      );
      for (let i = 0; i < 20; i++) {
        for (let b = 0; b < 16; b++) {
          stmt.run(ALGO, b, (i * 31 + b) % 13, docId(i));
          stmt.run("v0", b, b, docId(i));
        }
      }
    };
    insert(reference);
    insert(bounded);
    for (const i of [0, 3, 7]) {
      const removedRef = reference.prepare(unpinned).run(docId(i), ALGO).changes;
      const removedNew = bounded.prepare(BUCKET_DELETE_FOR_DOC_SQL).run(docId(i), ALGO).changes;
      expect(removedNew).toBe(16);
      expect(removedNew).toBe(removedRef);
    }
    expect(state(bounded)).toEqual(state(reference));
  });
});
