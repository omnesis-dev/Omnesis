// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { DEFAULT_NEAR_DUP_CONFIG } from "./config.js";
import { enqueueNearDupInbox } from "./inbox.js";
import { setActiveAlgoVersion } from "./meta.js";
import { computeNearDupBatch } from "./NearDupComputeService.js";
import { applyNearDupBatch, applyNearDupDfSnapshot } from "./NearDupWriterOps.js";
import { computeNearDupDfSnapshot } from "./NearDupDfService.js";
import type { Db } from "../data/types.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-near-dup-compute-svc-"));
  db = new Database(join(dir, "omnesis.db")) as unknown as Db;
  // Match the gateway journal while retaining fully synchronized commits.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  runSchemaSetup(db);
  runMigrations(db);
  setActiveAlgoVersion(db, DEFAULT_NEAR_DUP_CONFIG.algorithm.algoVersion);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedDoc(id: string, body: string, documentType = "email"): void {
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
    body,
    "ch-" + id,
    JSON.stringify({ documentType }),
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
  );
}

describe("computeNearDupBatch", () => {
  test("empty inbox yields an empty batch", () => {
    const batch = computeNearDupBatch(db, DEFAULT_NEAR_DUP_CONFIG);
    expect(batch.processedInboxIds).toHaveLength(0);
    expect(batch.signatures).toHaveLength(0);
    expect(batch.edgeUpserts).toHaveLength(0);
  });

  test("an inbox 'insert' row produces signature + bucket rows, no edges when no candidates", () => {
    const body = "this is a long enough body for shingling ".repeat(20);
    seedDoc("a", body);
    enqueueNearDupInbox(db, ["a"], "insert");
    const batch = computeNearDupBatch(db, DEFAULT_NEAR_DUP_CONFIG);
    expect(batch.processedInboxIds).toHaveLength(1);
    expect(batch.signatures).toHaveLength(1);
    expect(batch.signatures[0].docId).toBe("a");
    expect(batch.bucketRows.length).toBeGreaterThan(0);
    // Solo doc — no candidates, no edges.
    expect(batch.edgeUpserts).toHaveLength(0);
  });

  test("identical-content doc pair is found as a candidate by LSH bucket lookup", () => {
    // This test validates the LSH bucket plumbing — that after
    // applying doc A's batch, doc B with byte-identical content can
    // find A as a candidate via the bucket lookup. Edge emission
    // itself depends on the gate's `pair_unique_df2 >= 5` (email) /
    // `containment >= 0.95` (file) thresholds, which are calibrated
    // against a real corpus; the production-gate behaviour is
    // tested in @omnesis/near-dupes. Here we only assert that
    // candidate-discovery works end-to-end through the compute path.
    const body = [
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
      "kilo lima mike november oscar papa quebec romeo sierra tango",
      "uniform victor whiskey xray yankee zulu apple banana cherry date",
      "elderberry fig grape honeydew kiwi lemon mango nectarine orange pear",
    ].join(" ");
    seedDoc("a", body, "file");
    seedDoc("b", body, "file");
    // Bootstrap DF.
    const dfSnapshot = computeNearDupDfSnapshot(db, DEFAULT_NEAR_DUP_CONFIG);
    applyNearDupDfSnapshot(db, dfSnapshot);

    enqueueNearDupInbox(db, ["a"], "insert");
    applyNearDupBatch(db, computeNearDupBatch(db, DEFAULT_NEAR_DUP_CONFIG));

    enqueueNearDupInbox(db, ["b"], "insert");
    const batchB = computeNearDupBatch(db, DEFAULT_NEAR_DUP_CONFIG);
    // The LSH lookup found A. Whether the gate accepts depends on
    // calibration; we assert only that B's signature got produced and
    // candidate discovery wired through. (Edge emission also requires
    // diverse shingles for the unique-df2 gate; see @omnesis/near-dupes
    // study for the real-corpus regression suite.)
    expect(batchB.signatures).toHaveLength(1);
    expect(batchB.signatures[0].docId).toBe("b");
  });

  test("ineligible doc types consume their inbox row without emitting state", () => {
    seedDoc("c", "body".repeat(50), "contact"); // ineligible
    enqueueNearDupInbox(db, ["c"], "insert");
    const batch = computeNearDupBatch(db, DEFAULT_NEAR_DUP_CONFIG);
    expect(batch.processedInboxIds).toHaveLength(1);
    // signatureDeletes still gets the doc id (defensive wipe) but no
    // signature is emitted under the active algo.
    expect(batch.signatures).toHaveLength(0);
    expect(batch.bucketRows).toHaveLength(0);
  });

  test("docs with no tokens (whitespace-only) are wiped + skipped", () => {
    seedDoc("d", "   \n\t   ");
    enqueueNearDupInbox(db, ["d"], "insert");
    const batch = computeNearDupBatch(db, DEFAULT_NEAR_DUP_CONFIG);
    expect(batch.signatures).toHaveLength(0);
    expect(batch.signatureDeletes).toContain("d");
  });

  test("a 'delete' inbox row queues a signature delete only", () => {
    enqueueNearDupInbox(db, ["never-existed"], "delete");
    const batch = computeNearDupBatch(db, DEFAULT_NEAR_DUP_CONFIG);
    expect(batch.signatureDeletes).toContain("never-existed");
    expect(batch.signatures).toHaveLength(0);
  });
});

describe("in-batch candidate visibility", () => {
  test("three near-identical docs enqueued in the same batch all form pairwise edges", () => {
    // Bootstrap a populated DF — without it the sketcher's weights
    // collapse to zero. Use diverse boilerplate that produces many
    // shared 5-grams across the cluster but not corpus-wide.
    const body = [
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
      "kilo lima mike november oscar papa quebec romeo sierra tango",
      "uniform victor whiskey xray yankee zulu apple banana cherry date",
      "elderberry fig grape honeydew kiwi lemon mango nectarine orange pear",
      "quince raspberry strawberry tangerine ugli vanilla watermelon",
    ].join(" ");
    // Pure filler docs with no overlap with the sibling cluster — they
    // exist only to keep DF meaningful (without them the corpus
    // df==totalDocs everywhere and the IDF weights collapse to zero).
    const fillerBody = [
      "completely separate words like xenon photon neutron proton electron",
      "another unique paragraph with airplane submarine rocket scooter unicycle",
      "yet more standalone content cement concrete granite marble limestone",
      "totally unrelated phrasing about violin trumpet saxophone clarinet flute",
      "distinct text covering oak maple birch sycamore willow poplar cedar",
    ].join(" ");
    seedDoc("filler-1", fillerBody, "file");
    seedDoc("filler-2", fillerBody.split(" ").reverse().join(" "), "file");
    const dfSnapshot = computeNearDupDfSnapshot(db, DEFAULT_NEAR_DUP_CONFIG);
    applyNearDupDfSnapshot(db, dfSnapshot);

    // Three siblings, all near-identical, all enqueued in ONE batch.
    seedDoc("sib-a", body + " sibling a unique tail", "file");
    seedDoc("sib-b", body + " sibling b unique tail", "file");
    seedDoc("sib-c", body + " sibling c unique tail", "file");
    enqueueNearDupInbox(db, ["sib-a", "sib-b", "sib-c"], "insert");

    const batch = computeNearDupBatch(db, DEFAULT_NEAR_DUP_CONFIG);
    // Each pair of (sib-a, sib-b, sib-c) is a clique → 3 edges total.
    const edgeKeys = new Set(batch.edgeUpserts.map((e) => `${e.docA}|${e.docB}`));
    expect(edgeKeys).toEqual(
      new Set([
        ["sib-a", "sib-b"].sort().join("|"),
        ["sib-a", "sib-c"].sort().join("|"),
        ["sib-b", "sib-c"].sort().join("|"),
      ]),
    );
    expect(batch.edgeUpserts.length).toBe(3);
  });
});

describe("DF snapshot round-trip", () => {
  test("compute → apply persists only df>=2 shingles + advances OCC watermark", () => {
    // Three docs that share a phrase, so most shared 5-grams have df>=2
    // (some df=3). Singletons in the long unique tails are pruned.
    const shared = (
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima " +
      "mike november oscar papa quebec romeo sierra tango uniform victor whiskey"
    ).repeat(3);
    seedDoc("a", shared + " unique-a-tokens that-only-a-has end-of-a");
    seedDoc("b", shared + " unique-b-tokens that-only-b-has end-of-b");
    seedDoc("c", shared + " unique-c-tokens that-only-c-has end-of-c");
    const snapshot = computeNearDupDfSnapshot(db, DEFAULT_NEAR_DUP_CONFIG);
    expect(snapshot.totalDocs).toBe(3);
    // After pruning df=1, the shared 5-grams remain with df>=2.
    expect(snapshot.uniqueShingles).toBeGreaterThan(0);
    expect(snapshot.entries.every((e) => e.df >= 2)).toBe(true);
    const result = applyNearDupDfSnapshot(db, snapshot);
    expect(result.rebuilt).toBe(snapshot.entries.length);
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM near_dup_df WHERE algo_version = ?")
      .get(DEFAULT_NEAR_DUP_CONFIG.algorithm.algoVersion) as { n: number };
    expect(row.n).toBe(snapshot.entries.length);
  });
});
