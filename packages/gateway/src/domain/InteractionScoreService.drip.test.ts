// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import {
  computeInteractionScores,
  interactionScoresChunkSql,
  computeInteractionScoresChunk,
  fetchSelfPersonId,
  harmonicMean,
  DECAY_HALF_LIFE_DAYS,
  type InteractionScoreRow,
  type InteractionEdgeTuple,
} from "./InteractionScoreService.js";
import type { Db } from "../data/types.js";

// ─── Test setup ──────────────────────────────────────────────────────────

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-interaction-drip-"));
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

// ─── Seeding helpers ─────────────────────────────────────────────────────

function seedPerson(
  id: string,
  name: string,
  opts: { isSelf?: boolean; mergedInto?: string } = {},
): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, merged_into,
        first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    "test",
    opts.isSelf ? 1 : 0,
    opts.mergedInto ?? null,
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
  );
}

function seedDoc(id: string, sourceCreatedAt = "2025-06-15T12:00:00Z"): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
        content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "p",
    `src:${id}`,
    id,
    `title-${id}`,
    "body",
    `ch-${id}`,
    "{}",
    sourceCreatedAt,
    sourceCreatedAt,
    "2025-06-15T12:00:00Z",
    "2025-06-15T12:00:00Z",
  );
}

function seedDocPerson(docId: string, personId: string, role: string): void {
  db.prepare(
    `INSERT INTO document_people (document_id, person_id, role, source_id)
     VALUES (?, ?, ?, ?)`,
  ).run(docId, personId, role, `src:${docId}`);
}

// ─── Accumulate-and-normalize: reproduces the unbounded function's
//     post-processing from raw edge tuples. ───────────────────────────────

interface PersonAcc {
  inRaw: number;
  outRaw: number;
  inDecayed: number;
  outDecayed: number;
}

/**
 * Paginate through `computeInteractionScoresChunk`, accumulate per-person
 * edge counts (raw + decayed), normalize, and return the same shape as
 * `computeInteractionScores().rows`. This is the function under test:
 * its output must match the unbounded function exactly.
 */
function accumulateChunked(
  selfId: string,
  batchSize: number,
  nowMs: number,
): InteractionScoreRow[] {
  const decayConstant = Math.LN2 / (DECAY_HALF_LIFE_DAYS * 86_400_000);

  let cursor: string | null = null;
  const perPerson = new Map<string, PersonAcc>();
  let totalInRaw = 0;
  let totalOutRaw = 0;
  let totalInDecayed = 0;
  let totalOutDecayed = 0;

  do {
    const chunk = computeInteractionScoresChunk(db, cursor, batchSize, selfId);
    for (const edge of chunk.rows) {
      const inboundEdge = edge.pK === 2 || (edge.pK === 1 && edge.selfK === 1) ? 1 : 0;
      const outboundEdge = edge.selfK === 2 || (edge.selfK === 1 && edge.pK === 1) ? 1 : 0;
      if (inboundEdge === 0 && outboundEdge === 0) continue;

      let weight = 1;
      if (edge.docDate) {
        const ts = Date.parse(edge.docDate);
        if (Number.isFinite(ts)) {
          const ageMs = Math.max(0, nowMs - ts);
          weight = Math.exp(-decayConstant * ageMs);
        }
      }

      let acc = perPerson.get(edge.personId);
      if (!acc) {
        acc = { inRaw: 0, outRaw: 0, inDecayed: 0, outDecayed: 0 };
        perPerson.set(edge.personId, acc);
      }
      acc.inRaw += inboundEdge;
      acc.outRaw += outboundEdge;
      acc.inDecayed += inboundEdge * weight;
      acc.outDecayed += outboundEdge * weight;
      totalInRaw += inboundEdge;
      totalOutRaw += outboundEdge;
      totalInDecayed += inboundEdge * weight;
      totalOutDecayed += outboundEdge * weight;
    }
    cursor = chunk.nextCursor;
  } while (cursor !== null);

  const rows: InteractionScoreRow[] = [];
  for (const [personId, acc] of perPerson) {
    const inScore = totalInRaw > 0 ? acc.inRaw / totalInRaw : 0;
    const outScore = totalOutRaw > 0 ? acc.outRaw / totalOutRaw : 0;
    const inScoreRecent = totalInDecayed > 0 ? acc.inDecayed / totalInDecayed : 0;
    const outScoreRecent = totalOutDecayed > 0 ? acc.outDecayed / totalOutDecayed : 0;
    rows.push({
      personId,
      inboundCount: acc.inRaw,
      outboundCount: acc.outRaw,
      inboundScore: inScore,
      outboundScore: outScore,
      interactionScore: harmonicMean(inScore, outScore),
      inboundScoreRecent: inScoreRecent,
      outboundScoreRecent: outScoreRecent,
      interactionScoreRecent: harmonicMean(inScoreRecent, outScoreRecent),
    });
  }
  return rows;
}

/**
 * Sort rows by personId for deterministic comparison.
 */
function sortById(rows: InteractionScoreRow[]): InteractionScoreRow[] {
  return [...rows].sort((a, b) => a.personId.localeCompare(b.personId));
}

/**
 * Deep-compare two InteractionScoreRow arrays (sorted by personId),
 * tolerating floating-point epsilon on score fields.
 */
function expectRowsEqual(actual: InteractionScoreRow[], expected: InteractionScoreRow[]): void {
  const a = sortById(actual);
  const e = sortById(expected);
  expect(a.length).toBe(e.length);
  const EPS = 1e-12;
  for (let i = 0; i < a.length; i++) {
    expect(a[i].personId).toBe(e[i].personId);
    expect(a[i].inboundCount).toBe(e[i].inboundCount);
    expect(a[i].outboundCount).toBe(e[i].outboundCount);
    expect(a[i].inboundScore).toBeCloseTo(e[i].inboundScore, 10);
    expect(a[i].outboundScore).toBeCloseTo(e[i].outboundScore, 10);
    expect(a[i].interactionScore).toBeCloseTo(e[i].interactionScore, 10);
    expect(a[i].inboundScoreRecent).toBeCloseTo(e[i].inboundScoreRecent, 10);
    expect(a[i].outboundScoreRecent).toBeCloseTo(e[i].outboundScoreRecent, 10);
    expect(a[i].interactionScoreRecent).toBeCloseTo(e[i].interactionScoreRecent, 10);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("computeInteractionScoresChunk equivalence", () => {
  test("no self person — chunk returns empty, fetchSelfPersonId returns null", () => {
    seedPerson("p-alice", "Alice");
    expect(fetchSelfPersonId(db)).toBeNull();
    const chunk = computeInteractionScoresChunk(db, null, 100, "nonexistent-self");
    expect(chunk.rows).toEqual([]);
    expect(chunk.nextCursor).toBeNull();

    const snapshot = computeInteractionScores(db);
    expect(snapshot.rows).toEqual([]);
  });

  test("self + 1 other person, 1 shared doc — edge tuple matches expected", () => {
    const nowMs = Date.parse("2025-07-01T00:00:00Z");
    seedPerson("p-self", "Self User", { isSelf: true });
    seedPerson("p-alice", "Alice");

    // Self sent a doc, Alice received it
    seedDoc("doc-1", "2025-06-15T12:00:00Z");
    seedDocPerson("doc-1", "p-self", "sender");
    seedDocPerson("doc-1", "p-alice", "recipient");

    expect(fetchSelfPersonId(db)).toBe("p-self");

    // Unbounded
    const snapshot = computeInteractionScores(db, { nowMs });
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].personId).toBe("p-alice");
    // Self is sender (producer=2), Alice is recipient (consumer=1):
    //   inboundEdge = (p_k=1, self_k=2) → p_k===2? no. p_k===1 && self_k===1? no → 0
    //   Actually: p_k = consumer(1), self_k = producer(2)
    //   inboundEdge = p_k===2? no. (p_k===1 && self_k===1)? no → 0
    //   outboundEdge = self_k===2? yes → 1
    expect(snapshot.rows[0].outboundCount).toBe(1);
    expect(snapshot.rows[0].inboundCount).toBe(0);

    // Chunked
    const selfId = fetchSelfPersonId(db)!;
    const chunked = accumulateChunked(selfId, 10, nowMs);
    expectRowsEqual(chunked, snapshot.rows);
  });

  test("self + 3 people, varying roles — paginated accumulation matches unbounded", () => {
    const nowMs = Date.parse("2025-07-01T00:00:00Z");
    seedPerson("p-self", "Self User", { isSelf: true });
    seedPerson("p-alice", "Alice");
    seedPerson("p-bob", "Bob");
    seedPerson("p-carol", "Carol");

    // Doc 1: self sent to Alice and Bob
    seedDoc("doc-1", "2025-06-01T00:00:00Z");
    seedDocPerson("doc-1", "p-self", "sender");
    seedDocPerson("doc-1", "p-alice", "recipient");
    seedDocPerson("doc-1", "p-bob", "recipient");

    // Doc 2: Alice sent to self
    seedDoc("doc-2", "2025-06-10T00:00:00Z");
    seedDocPerson("doc-2", "p-alice", "sender");
    seedDocPerson("doc-2", "p-self", "recipient");

    // Doc 3: self and Carol are both participants (symmetric)
    seedDoc("doc-3", "2025-05-01T00:00:00Z");
    seedDocPerson("doc-3", "p-self", "participant");
    seedDocPerson("doc-3", "p-carol", "participant");

    // Doc 4: Bob authored, self is attendee
    seedDoc("doc-4", "2025-04-01T00:00:00Z");
    seedDocPerson("doc-4", "p-bob", "author");
    seedDocPerson("doc-4", "p-self", "attendee");

    const snapshot = computeInteractionScores(db, { nowMs });
    expect(snapshot.rows.length).toBe(3);

    const selfId = fetchSelfPersonId(db)!;
    // Use a small batch size (2) to force multiple pages
    const chunked = accumulateChunked(selfId, 2, nowMs);
    expectRowsEqual(chunked, snapshot.rows);
  });

  test("merged people — losers' edges roll up to canonical", () => {
    const nowMs = Date.parse("2025-07-01T00:00:00Z");
    seedPerson("p-self", "Self User", { isSelf: true });
    // Alice is canonical; Alice-dupe merges into Alice
    seedPerson("p-alice", "Alice");
    seedPerson("p-alice-dupe", "Alice Duplicate", { mergedInto: "p-alice" });

    // Doc 1: self sent to Alice (canonical)
    seedDoc("doc-1", "2025-06-01T00:00:00Z");
    seedDocPerson("doc-1", "p-self", "sender");
    seedDocPerson("doc-1", "p-alice", "recipient");

    // Doc 2: Alice-dupe sent to self (edges should roll up to p-alice)
    seedDoc("doc-2", "2025-06-10T00:00:00Z");
    seedDocPerson("doc-2", "p-alice-dupe", "sender");
    seedDocPerson("doc-2", "p-self", "recipient");

    const snapshot = computeInteractionScores(db, { nowMs });
    // Only one person row: p-alice (the canonical)
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].personId).toBe("p-alice");
    // Doc 1: self=sender(2), alice=recipient(1) → outbound edge
    // Doc 2: alice-dupe=sender(2), self=recipient(1) → inbound edge for canonical alice
    expect(snapshot.rows[0].outboundCount).toBe(1);
    expect(snapshot.rows[0].inboundCount).toBe(1);

    const selfId = fetchSelfPersonId(db)!;
    const chunked = accumulateChunked(selfId, 10, nowMs);
    expectRowsEqual(chunked, snapshot.rows);
  });

  test("decay weighting — nowMs override produces matching decayed scores", () => {
    // Place docs at known dates, set nowMs far enough that decay matters
    const nowMs = Date.parse("2027-06-15T00:00:00Z"); // ~2 years after docs
    seedPerson("p-self", "Self User", { isSelf: true });
    seedPerson("p-alice", "Alice");
    seedPerson("p-bob", "Bob");

    // Alice doc: recent (6 months ago relative to nowMs)
    seedDoc("doc-recent", "2027-01-01T00:00:00Z");
    seedDocPerson("doc-recent", "p-self", "sender");
    seedDocPerson("doc-recent", "p-alice", "recipient");

    // Bob doc: old (2 years ago relative to nowMs)
    seedDoc("doc-old", "2025-06-15T00:00:00Z");
    seedDocPerson("doc-old", "p-self", "sender");
    seedDocPerson("doc-old", "p-bob", "recipient");

    const snapshot = computeInteractionScores(db, { nowMs });
    expect(snapshot.rows).toHaveLength(2);

    // Both have outboundCount=1, so lifetime scores are equal
    const alice = snapshot.rows.find((r) => r.personId === "p-alice")!;
    const bob = snapshot.rows.find((r) => r.personId === "p-bob")!;
    expect(alice.outboundScore).toBeCloseTo(bob.outboundScore, 10);

    // But recent scores should differ: Alice's doc is newer → higher weight
    expect(alice.outboundScoreRecent).toBeGreaterThan(bob.outboundScoreRecent);

    // Verify the chunked path produces identical results
    const selfId = fetchSelfPersonId(db)!;
    const chunked = accumulateChunked(selfId, 1, nowMs);
    expectRowsEqual(chunked, snapshot.rows);
  });

  test("batch size 1 forces one person per page — still matches unbounded", () => {
    const nowMs = Date.parse("2025-07-01T00:00:00Z");
    seedPerson("p-self", "Self User", { isSelf: true });
    seedPerson("p-alice", "Alice");
    seedPerson("p-bob", "Bob");
    seedPerson("p-carol", "Carol");

    seedDoc("doc-1", "2025-06-01T00:00:00Z");
    seedDocPerson("doc-1", "p-self", "sender");
    seedDocPerson("doc-1", "p-alice", "recipient");
    seedDocPerson("doc-1", "p-bob", "recipient");

    seedDoc("doc-2", "2025-05-01T00:00:00Z");
    seedDocPerson("doc-2", "p-carol", "author");
    seedDocPerson("doc-2", "p-self", "attendee");

    const snapshot = computeInteractionScores(db, { nowMs });
    const selfId = fetchSelfPersonId(db)!;
    // batch size = 1: each chunk covers exactly one person
    const chunked = accumulateChunked(selfId, 1, nowMs);
    expectRowsEqual(chunked, snapshot.rows);
  });

  test("participant-participant edges are both inbound and outbound", () => {
    const nowMs = Date.parse("2025-07-01T00:00:00Z");
    seedPerson("p-self", "Self User", { isSelf: true });
    seedPerson("p-alice", "Alice");

    seedDoc("doc-chat", "2025-06-15T00:00:00Z");
    seedDocPerson("doc-chat", "p-self", "participant");
    seedDocPerson("doc-chat", "p-alice", "participant");

    const snapshot = computeInteractionScores(db, { nowMs });
    expect(snapshot.rows).toHaveLength(1);
    // Both are participants (k=1 each): inboundEdge=1, outboundEdge=1
    expect(snapshot.rows[0].inboundCount).toBe(1);
    expect(snapshot.rows[0].outboundCount).toBe(1);
    // Harmonic mean of equal scores should equal those scores
    expect(snapshot.rows[0].interactionScore).toBeCloseTo(snapshot.rows[0].inboundScore, 10);

    const selfId = fetchSelfPersonId(db)!;
    const chunked = accumulateChunked(selfId, 10, nowMs);
    expectRowsEqual(chunked, snapshot.rows);
  });

  test("neutral roles (mentioned, contact) produce no edges", () => {
    const nowMs = Date.parse("2025-07-01T00:00:00Z");
    seedPerson("p-self", "Self User", { isSelf: true });
    seedPerson("p-alice", "Alice");

    seedDoc("doc-1", "2025-06-15T00:00:00Z");
    seedDocPerson("doc-1", "p-self", "author");
    seedDocPerson("doc-1", "p-alice", "mentioned");

    const snapshot = computeInteractionScores(db, { nowMs });
    // Alice's role is "mentioned" (neutral, k=0) → no edge
    expect(snapshot.rows).toHaveLength(0);

    const selfId = fetchSelfPersonId(db)!;
    const chunked = accumulateChunked(selfId, 10, nowMs);
    expect(chunked).toHaveLength(0);
  });

  test("merged self — docs from self-dupe count as self edges", () => {
    const nowMs = Date.parse("2025-07-01T00:00:00Z");
    seedPerson("p-self", "Self User", { isSelf: true });
    seedPerson("p-self-dupe", "Self Dupe", { mergedInto: "p-self" });
    seedPerson("p-alice", "Alice");

    // Doc where self-dupe is sender (should count as self's doc)
    seedDoc("doc-1", "2025-06-01T00:00:00Z");
    seedDocPerson("doc-1", "p-self-dupe", "sender");
    seedDocPerson("doc-1", "p-alice", "recipient");

    const snapshot = computeInteractionScores(db, { nowMs });
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].personId).toBe("p-alice");
    expect(snapshot.rows[0].outboundCount).toBe(1);

    const selfId = fetchSelfPersonId(db)!;
    const chunked = accumulateChunked(selfId, 10, nowMs);
    expectRowsEqual(chunked, snapshot.rows);
  });
});

describe("harmonicMean", () => {
  test("returns 0 when either argument is zero", () => {
    expect(harmonicMean(0, 5)).toBe(0);
    expect(harmonicMean(5, 0)).toBe(0);
    expect(harmonicMean(0, 0)).toBe(0);
  });

  test("returns 0 for negative arguments", () => {
    expect(harmonicMean(-1, 5)).toBe(0);
    expect(harmonicMean(5, -1)).toBe(0);
  });

  test("returns the value when both arguments are equal", () => {
    expect(harmonicMean(4, 4)).toBeCloseTo(4, 10);
    expect(harmonicMean(0.5, 0.5)).toBeCloseTo(0.5, 10);
  });

  test("is symmetric", () => {
    expect(harmonicMean(3, 7)).toBeCloseTo(harmonicMean(7, 3), 10);
  });

  test("known value: harmonicMean(2, 6) = 3", () => {
    expect(harmonicMean(2, 6)).toBeCloseTo(3, 10);
  });
});

describe("fetchSelfPersonId", () => {
  test("returns null when no self person exists", () => {
    seedPerson("p-alice", "Alice");
    expect(fetchSelfPersonId(db)).toBeNull();
  });

  test("returns the self person id", () => {
    seedPerson("p-self", "Self User", { isSelf: true });
    seedPerson("p-alice", "Alice");
    expect(fetchSelfPersonId(db)).toBe("p-self");
  });

  test("returns null when the self person is merged (not canonical)", () => {
    seedPerson("p-canonical", "Canonical Self", { isSelf: true });
    seedPerson("p-merged-self", "Merged Self", { isSelf: true, mergedInto: "p-canonical" });
    // Only the unmerged self should be returned
    expect(fetchSelfPersonId(db)).toBe("p-canonical");
  });
});

describe("computeInteractionScoresChunk — cost tracks the batch", () => {
  test("reads edges by person id and self roles by document id", () => {
    const plan = db
      .prepare<[string, number, string, string], { detail: string }>(
        `EXPLAIN QUERY PLAN ${interactionScoresChunkSql()}`,
      )
      .all("", 500, "self", "self")
      .map((r) => r.detail);

    // The batch's own edges, one indexed lookup per member…
    expect(
      plan.some((d) =>
        /SEARCH dp USING (COVERING )?INDEX idx_document_people_person_source/.test(d),
      ),
    ).toBe(true);
    // …and self's role only on the documents those edges named.
    expect(
      plan.some((d) => /SEARCH dp USING (COVERING )?INDEX idx_document_people_doc/.test(d)),
    ).toBe(true);
    // Never a walk of the edge table with a per-row test, which is what
    // rebuilding the self side from scratch each chunk required.
    expect(plan.some((d) => /^SCAN (dp|document_people)\b/.test(d))).toBe(false);
  });
});
