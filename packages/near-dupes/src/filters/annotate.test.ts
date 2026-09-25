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
 * Exercises the real `annotate` CLI (filters/annotate.ts) end-to-end: it
 * reads recorded pairs + their document_minhash shingle counts from the side
 * DB, reads document metadata (senders, doc types, content hashes, thread ids)
 * from a read-only omnesis DB, then writes back is_exact_dupe / is_same_thread
 * / gate_status / gate_family. The CLI is the production-bound decision logic
 * (extractSender + containment + the gate write-back) and has no other tests.
 */

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ANNOTATE_SCRIPT = resolve(HERE, "annotate.ts");
const TSX_CLI = require.resolve("tsx/cli");
const ALGO = "annot-test-v1";

interface OmnesisDoc {
  id: string;
  contentHash?: string | null;
  extractedContentHash?: string | null;
  documentType: string;
  threadId?: string | null;
  people?: unknown;
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
    `INSERT INTO documents (id, content_hash, extracted_content_hash, metadata) VALUES (?, ?, ?, ?)`,
  );
  for (const d of docs) {
    const metadata = JSON.stringify({
      documentType: d.documentType,
      extra: d.threadId ? { threadId: d.threadId } : {},
      ...(d.people !== undefined ? { people: d.people } : {}),
    });
    insert.run(d.id, d.contentHash ?? null, d.extractedContentHash ?? null, metadata);
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
  // document_minhash carries shingle_count, which the gate reads to derive
  // containment = intersection_size / min(shingle_count_a, shingle_count_b).
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
  is_exact_dupe: number | null;
  is_same_thread: number | null;
  gate_status: string | null;
  gate_family: string | null;
  annotated_at: number | null;
}

function readPair(path: string, docX: string, docY: string): AnnotatedRow {
  const db = new Database(path, { readonly: true });
  const [a, b] = DupeStore.canonicalPairOrder(docX, docY);
  const row = db
    .prepare(
      `SELECT is_exact_dupe, is_same_thread, gate_status, gate_family, annotated_at
       FROM pairs WHERE doc_a = ? AND doc_b = ? AND algo_version = ?`,
    )
    .get(a, b, ALGO) as AnnotatedRow;
  db.close();
  return row;
}

describe("annotate CLI gate write-back", () => {
  let dupesPath: string;
  let omnesisPath: string;

  beforeEach(() => {
    dupesPath = `/tmp/omnesis-annotate-dupes-${randomUUID()}.db`;
    omnesisPath = `/tmp/omnesis-annotate-corpus-${randomUUID()}.db`;
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

  it("persists gate_status/gate_family and edge flags, with containment feeding the gate", () => {
    seedOmnesisDb(omnesisPath, [
      // Email-email, human senders → should pass the (strict) email lane.
      {
        id: "email-pass-a",
        documentType: "email",
        people: [{ role: "sender", emails: ["Maya.Reeves@example.com"] }],
      },
      {
        id: "email-pass-b",
        documentType: "email",
        people: [{ role: "sender", emails: ["jamie.lopez@example.org"] }],
      },
      // Email-email but one side is an automated sender → automated-sender.
      // Sender given in mixed case to also pin extractSender's lowercasing.
      {
        id: "email-auto-a",
        documentType: "email",
        people: [{ role: "sender", emails: ["NoReply@example.com"] }],
      },
      {
        id: "email-auto-b",
        documentType: "email",
        people: [{ role: "recipient", emails: ["david.lin@example.com"] }],
      },
      // File-like pair that passes only via the containment OR-branch
      // (pairUniqueDf2 == 0 but containment >= 0.95).
      { id: "file-contain-a", documentType: "note", people: [] },
      { id: "file-contain-b", documentType: "note", people: [] },
      // File-like control: identical except low containment → below-threshold.
      { id: "file-low-a", documentType: "note", people: [] },
      { id: "file-low-b", documentType: "note", people: [] },
      // Exact-dupe via shared content_hash. People metadata is malformed /
      // missing a sender to exercise extractSender's null branches.
      {
        id: "exact-a",
        documentType: "note",
        contentHash: "shared-hash-xyz",
        people: "not-an-array",
      },
      {
        id: "exact-b",
        documentType: "note",
        contentHash: "shared-hash-xyz",
        people: [{ role: "recipient", emails: ["sarah.mendez@example.com"] }],
      },
    ]);

    seedSideDb(
      dupesPath,
      [
        // Strong email pair: jaccard >= 0.85 AND pairUniqueDf2 >= 5.
        {
          docA: "email-pass-a",
          docB: "email-pass-b",
          jaccard: 0.9,
          intersectionSize: 40,
          pairUniqueDf2: 8,
          pairUniqueDf5: 12,
        },
        // Automated sender: scores are strong, but the gate must short-circuit.
        {
          docA: "email-auto-a",
          docB: "email-auto-b",
          jaccard: 0.95,
          intersectionSize: 40,
          pairUniqueDf2: 9,
          pairUniqueDf5: 15,
        },
        // File-like containment pass: inter/min = 19/20 = 0.95.
        {
          docA: "file-contain-a",
          docB: "file-contain-b",
          jaccard: 0.78,
          intersectionSize: 19,
          pairUniqueDf2: 0,
          pairUniqueDf5: 0,
        },
        // File-like below-threshold: same scores, but inter/min = 10/20 = 0.5.
        {
          docA: "file-low-a",
          docB: "file-low-b",
          jaccard: 0.78,
          intersectionSize: 10,
          pairUniqueDf2: 0,
          pairUniqueDf5: 0,
        },
        // Exact-dupe pair.
        {
          docA: "exact-a",
          docB: "exact-b",
          jaccard: 0.99,
          intersectionSize: 50,
          pairUniqueDf2: 20,
          pairUniqueDf5: 30,
        },
      ],
      {
        "email-pass-a": 50,
        "email-pass-b": 50,
        "email-auto-a": 50,
        "email-auto-b": 50,
        "file-contain-a": 20,
        "file-contain-b": 100,
        "file-low-a": 20,
        "file-low-b": 100,
        "exact-a": 60,
        "exact-b": 60,
      },
    );

    runAnnotate(dupesPath, omnesisPath);

    const pass = readPair(dupesPath, "email-pass-a", "email-pass-b");
    expect(pass.gate_status).toBe("pass");
    expect(pass.gate_family).toBe("email");
    expect(pass.is_exact_dupe).toBe(0);
    expect(pass.is_same_thread).toBe(0);
    expect(pass.annotated_at).not.toBeNull();

    const auto = readPair(dupesPath, "email-auto-a", "email-auto-b");
    expect(auto.gate_status).toBe("automated-sender");
    expect(auto.gate_family).toBe("email");

    // Containment OR-branch carries this pair to a pass despite df2 == 0.
    const contain = readPair(dupesPath, "file-contain-a", "file-contain-b");
    expect(contain.gate_status).toBe("pass");
    expect(contain.gate_family).toBe("file-like");

    // Identical scores but containment drops to 0.5 → the gate now rejects.
    // This is the wrong→right contract: containment (inter/min) feeds the gate.
    const low = readPair(dupesPath, "file-low-a", "file-low-b");
    expect(low.gate_status).toBe("below-threshold");
    expect(low.gate_family).toBe("file-like");

    // Shared content_hash → exact-dupe edge flag set regardless of gate.
    const exact = readPair(dupesPath, "exact-a", "exact-b");
    expect(exact.is_exact_dupe).toBe(1);
    expect(exact.annotated_at).not.toBeNull();
  });

  it("treats a missing/malformed sender as non-automated (extractSender null branches)", () => {
    seedOmnesisDb(omnesisPath, [
      // people is not an array → extractSender returns null.
      { id: "m-a", documentType: "email", people: { role: "sender", emails: ["x@example.com"] } },
      // sender role present but no emails → null.
      { id: "m-b", documentType: "email", people: [{ role: "sender", emails: [] }] },
    ]);
    seedSideDb(
      dupesPath,
      [
        {
          docA: "m-a",
          docB: "m-b",
          jaccard: 0.9,
          intersectionSize: 40,
          pairUniqueDf2: 8,
          pairUniqueDf5: 12,
        },
      ],
      { "m-a": 50, "m-b": 50 },
    );

    runAnnotate(dupesPath, omnesisPath);

    // Neither side resolves to an automated sender, so a strong email pair
    // passes rather than being suppressed.
    const row = readPair(dupesPath, "m-a", "m-b");
    expect(row.gate_status).toBe("pass");
    expect(row.gate_family).toBe("email");
  });
});
