// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { DupeStore } from "../store/repository.js";

/**
 * Boundary test for the containment divide-by-zero guard in annotate.ts:
 *
 *   const containmentMin =
 *     shA && shB && Math.min(shA, shB) > 0 ? inter / Math.min(shA, shB) : 0;
 *
 * The `> 0` guard protects the division. The reachable boundary is a
 * zero shingle count: when either count is 0 the `shA && shB` prefix
 * short-circuits to falsy and containment falls back to a finite 0, so
 * the gate sees `containmentMin = 0` and the file-like containment
 * OR-branch is denied — the pair lands at `below-threshold` rather than
 * being poisoned by a `0/0 = NaN` containment.
 *
 * This pins the guarded contract: a doc whose shingle_count is 0 must
 * still produce a clean, finite gate decision. (Mirrors the Phase-4
 * annotate harness; distinct DB paths so the two files never collide.)
 */

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ANNOTATE_SCRIPT = resolve(HERE, "annotate.ts");
const TSX_CLI = require.resolve("tsx/cli");
const ALGO = "annot-boundary-v1";

interface OmnesisDoc {
  id: string;
  documentType: string;
}

interface SeedPair {
  docA: string;
  docB: string;
  jaccard: number;
  intersectionSize: number;
  pairUniqueDf2: number;
  pairUniqueDf5: number;
}

function seedOmnesisDb(path: string, docs: OmnesisDoc[]): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      content_hash TEXT,
      extracted_content_hash TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    )
  `);
  const insert = db.prepare(
    `INSERT INTO documents (id, content_hash, extracted_content_hash, metadata) VALUES (?, NULL, NULL, ?)`,
  );
  for (const d of docs) {
    insert.run(d.id, JSON.stringify({ documentType: d.documentType, extra: {}, people: [] }));
  }
  db.close();
}

function seedSideDb(path: string, pairs: SeedPair[], shingleCounts: Record<string, number>): void {
  const store = new DupeStore(path);
  store.beginRun({ runId: "seed-run", algoVersion: ALGO, configJson: "{}", startedAt: 1 });
  for (const p of pairs) {
    const [a, b] = DupeStore.canonicalPairOrder(p.docA, p.docB);
    store.upsertPair({
      docA: a,
      docB: b,
      algoVersion: ALGO,
      jaccard: p.jaccard,
      sigSimilarity: p.jaccard,
      runId: "seed-run",
      intersectionSize: p.intersectionSize,
      pairUniqueDf2: p.pairUniqueDf2,
      pairUniqueDf5: p.pairUniqueDf5,
    });
  }
  const insert = store.db.prepare(
    `INSERT INTO document_minhash
       (document_id, algo_version, signature, shingle_count, content_hash, doc_type, plugin_id, computed_at)
     VALUES (?, ?, ?, ?, NULL, 'note', 'seed:plugin', 1)`,
  );
  for (const [id, count] of Object.entries(shingleCounts)) {
    insert.run(id, ALGO, Buffer.alloc(4), count);
  }
  store.close();
}

function runAnnotate(dupesPath: string, omnesisPath: string): void {
  execFileSync(
    process.execPath,
    [
      TSX_CLI,
      ANNOTATE_SCRIPT,
      "annotate",
      `--dupesDb=${dupesPath}`,
      `--omnesisDb=${omnesisPath}`,
      `--algoVersion=${ALGO}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

interface AnnotatedRow {
  gate_status: string | null;
  gate_family: string | null;
  annotated_at: number | null;
}

function readPair(path: string, docX: string, docY: string): AnnotatedRow {
  const db = new Database(path, { readonly: true });
  const [a, b] = DupeStore.canonicalPairOrder(docX, docY);
  const row = db
    .prepare(
      `SELECT gate_status, gate_family, annotated_at
       FROM pairs WHERE doc_a = ? AND doc_b = ? AND algo_version = ?`,
    )
    .get(a, b, ALGO) as AnnotatedRow;
  db.close();
  return row;
}

describe("annotate containment guard boundary (Math.min(shA, shB) === 0)", () => {
  let dupesPath: string;
  let omnesisPath: string;

  beforeEach(() => {
    dupesPath = `/tmp/omnesis-annotate-boundary-dupes-${randomUUID()}.db`;
    omnesisPath = `/tmp/omnesis-annotate-boundary-corpus-${randomUUID()}.db`;
  });

  afterEach(() => {
    for (const p of [dupesPath, omnesisPath]) {
      for (const s of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(p + s);
        } catch {
          // ignore
        }
      }
    }
  });

  it("a zero shingle_count yields a clean below-threshold decision (containment falls back to finite 0, not NaN)", () => {
    // File-like pair (note-note). Scores are strong enough that the gate
    // would PASS purely on containment IF containment were >= 0.95. The only
    // route to pass is the containment OR-branch, since pairUniqueDf2 (0) is
    // below the file-like minimum (1).
    //
    // doc-zero has shingle_count = 0, so Math.min(0, 200) = 0 and the
    // `shA && shB && Math.min(...) > 0` guard short-circuits → containment
    // is the finite fallback 0 (NOT inter/0 = NaN). containment 0 < 0.95 ⇒
    // the OR-branch is denied ⇒ below-threshold. A NaN containment would
    // make every `>=` comparison false too, but it would also be a
    // poisoned/ill-defined value flowing into the gate; this asserts the
    // guard keeps it finite and the decision deterministic.
    seedOmnesisDb(omnesisPath, [
      { id: "doc-zero", documentType: "note" },
      { id: "doc-big", documentType: "note" },
    ]);
    seedSideDb(
      dupesPath,
      [
        {
          docA: "doc-zero",
          docB: "doc-big",
          jaccard: 0.9, // >= fileLikeJaccardMin (0.75)
          intersectionSize: 50, // a large intersection; if divided by 0 → Infinity/NaN
          pairUniqueDf2: 0, // below fileLikePairUniqueDf2Min (1)
          pairUniqueDf5: 0,
        },
      ],
      { "doc-zero": 0, "doc-big": 200 },
    );

    runAnnotate(dupesPath, omnesisPath);

    const row = readPair(dupesPath, "doc-zero", "doc-big");
    expect(row.annotated_at).not.toBeNull();
    expect(row.gate_family).toBe("file-like");
    // Containment fell back to a finite 0, so the OR-branch is denied.
    expect(row.gate_status).toBe("below-threshold");
  });

  it("a positive shingle_count on both sides lets the containment OR-branch pass (boundary control)", () => {
    // Identical scores, but now both shingle counts are positive so the
    // guard's comparison is actually exercised: Math.min(20, 100) = 20 > 0,
    // containment = 19/20 = 0.95 ⇒ passes via the containment OR-branch.
    // Contrast with the zero-count case above: the difference is solely the
    // shingle_count crossing the guard boundary.
    seedOmnesisDb(omnesisPath, [
      { id: "doc-small", documentType: "note" },
      { id: "doc-large", documentType: "note" },
    ]);
    seedSideDb(
      dupesPath,
      [
        {
          docA: "doc-small",
          docB: "doc-large",
          jaccard: 0.9,
          intersectionSize: 19, // 19 / min(20,100) = 0.95
          pairUniqueDf2: 0,
          pairUniqueDf5: 0,
        },
      ],
      { "doc-small": 20, "doc-large": 100 },
    );

    runAnnotate(dupesPath, omnesisPath);

    const row = readPair(dupesPath, "doc-small", "doc-large");
    expect(row.gate_family).toBe("file-like");
    expect(row.gate_status).toBe("pass");
  });
});
