// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the cross-loop collision finder: person / doc / deadline-day
 * collisions, merge across signals, self exclusion, the active-brief coverage
 * filter, ranking + limit, and the sweep producer that seeds `synthesis`
 * collision runs. Fixture data invented.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger, type TemporalPrecision } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { createOpenLoop, updateOpenLoop } from "../storage/open-loops.js";
import { createBrief } from "../storage/briefs.js";
import { listCognitionRuns } from "../storage/run-queue.js";
import {
  synthesisCollisionDedupeKey,
  synthesisAnnotationContradictionDedupeKey,
} from "../run-payloads.js";
import { runCollisionSweepPass } from "../rhythm/collision-sweep-enqueuer.js";
import {
  insertTemporalAnnotation,
  updateTemporalAnnotation,
} from "../../enrichment/temporal-annotations/storage.js";
import { createDocAnnotation, updateDocAnnotation } from "../storage/annotations.js";
import { createPersonAnnotation } from "../storage/person-annotations.js";
import {
  findCollisionCandidates,
  findTemporalAnnotationCollisionCandidates,
  findAnnotationContradictionCandidates,
  collisionDedupeSuffix,
} from "./collision-candidates.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("test").child("collision");
const NOW = Date.parse("2026-07-02T10:00:00.000Z");

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

interface LoopOpts {
  importance?: number;
  actors?: string[];
  involved?: string[];
  docs?: string[];
  deadline?: unknown;
}
function loop(db: Db, id: string, opts: LoopOpts = {}): void {
  createOpenLoop(
    db,
    {
      id,
      createdByRun: "r",
      title: id,
      confidence: 0.9,
      importance: opts.importance ?? 0.5,
      ...(opts.actors ? { actors: opts.actors } : {}),
      ...(opts.involved ? { involved: opts.involved } : {}),
      ...(opts.docs ? { docs: opts.docs } : {}),
      ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
    },
    NOW,
  );
}

/** Record a settled (completed, no-brief) collision-judge run for a loop set. */
function markJudged(db: Db, loopIds: string[], completedAt: number): void {
  db.prepare(
    `INSERT INTO cognition_runs
       (id, kind, dedupe_key, status, next_attempt_at, enqueued_at, completed_at)
     VALUES (?, 'synthesis', ?, 'completed', 0, 0, ?)`,
  ).run(
    `run_${randomUUID()}`,
    synthesisCollisionDedupeKey(collisionDedupeSuffix(loopIds)),
    completedAt,
  );
}

describe("findCollisionCandidates", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("no collision below two loops or with no shared key", () => {
    loop(db, "L1", { actors: ["p1"], docs: ["d1"] });
    expect(findCollisionCandidates(db, { limit: 10, selfPersonId: null })).toEqual([]);
    loop(db, "L2", { actors: ["p2"], docs: ["d2"] }); // disjoint
    expect(findCollisionCandidates(db, { limit: 10, selfPersonId: null })).toEqual([]);
  });

  test("a shared person, doc, or deadline-day each yields a collision", () => {
    loop(db, "P1", { actors: ["shared-person"] });
    loop(db, "P2", { involved: ["shared-person"] });
    loop(db, "D1", { docs: ["shared-doc"] });
    loop(db, "D2", { docs: ["shared-doc"] });
    loop(db, "T1", { deadline: { type: "by", date: "2026-08-01" } });
    loop(db, "T2", { deadline: { type: "on_day", date: "2026-08-01" } });
    const cands = findCollisionCandidates(db, { limit: 10, selfPersonId: null });
    const byTag = new Map(cands.map((c) => [c.matchedBy.join("|"), c.loopIds]));
    expect(byTag.get("person:shared-person")).toEqual(["P1", "P2"]);
    expect(byTag.get("doc:shared-doc")).toEqual(["D1", "D2"]);
    expect(byTag.get("deadline-day:2026-08-01")).toEqual(["T1", "T2"]);
  });

  test("a pair colliding on several signals merges into one candidate carrying all tags", () => {
    loop(db, "L1", { actors: ["p1"], docs: ["d1"] });
    loop(db, "L2", { actors: ["p1"], docs: ["d1"] });
    const cands = findCollisionCandidates(db, { limit: 10, selfPersonId: null });
    expect(cands).toHaveLength(1);
    expect(cands[0]!.loopIds).toEqual(["L1", "L2"]);
    expect(cands[0]!.matchedBy).toEqual(["doc:d1", "person:p1"]);
  });

  test("self is excluded from the person signal", () => {
    loop(db, "L1", { actors: ["self"] });
    loop(db, "L2", { actors: ["self"] });
    expect(findCollisionCandidates(db, { limit: 10, selfPersonId: "self" })).toEqual([]);
    // but a non-self shared person still collides
    loop(db, "L3", { actors: ["self", "friend"] });
    loop(db, "L4", { actors: ["self", "friend"] });
    const cands = findCollisionCandidates(db, { limit: 10, selfPersonId: "self" });
    expect(cands.map((c) => c.loopIds)).toContainEqual(["L3", "L4"]);
    expect(cands.every((c) => !c.matchedBy.includes("person:self"))).toBe(true);
  });

  test("a candidate already spanned by an active brief is suppressed", () => {
    loop(db, "L1", { actors: ["p1"] });
    loop(db, "L2", { actors: ["p1"] });
    expect(findCollisionCandidates(db, { limit: 10, selfPersonId: null })).toHaveLength(1);
    createBrief(
      db,
      {
        id: "brief_1",
        createdByRun: "r",
        kind: "loop",
        title: "these relate",
        confidence: 0.8,
        urgency: 0.5,
        relatedLoopIds: ["L1", "L2"],
      },
      NOW,
    );
    expect(findCollisionCandidates(db, { limit: 10, selfPersonId: null })).toEqual([]);
  });

  test("ranks by max member importance and honours the limit", () => {
    loop(db, "A1", { actors: ["pa"], importance: 0.2 });
    loop(db, "A2", { actors: ["pa"], importance: 0.3 });
    loop(db, "B1", { actors: ["pb"], importance: 0.9 });
    loop(db, "B2", { actors: ["pb"], importance: 0.1 });
    const top = findCollisionCandidates(db, { limit: 1, selfPersonId: null });
    expect(top).toHaveLength(1);
    expect(top[0]!.loopIds).toEqual(["B1", "B2"]); // max importance 0.9 wins
    expect(top[0]!.score).toBe(0.9);
  });

  test("a non-positive limit returns nothing", () => {
    loop(db, "L1", { actors: ["p1"] });
    loop(db, "L2", { actors: ["p1"] });
    expect(findCollisionCandidates(db, { limit: 0, selfPersonId: null })).toEqual([]);
  });

  test("a group larger than the member cap keeps the highest-importance members", () => {
    for (let i = 1; i <= 9; i++) loop(db, `G${i}`, { actors: ["shared"], importance: i / 10 });
    const cands = findCollisionCandidates(db, { limit: 10, selfPersonId: null });
    expect(cands).toHaveLength(1);
    expect(cands[0]!.loopIds).toHaveLength(8); // MAX_GROUP_MEMBERS
    expect(cands[0]!.loopIds).not.toContain("G1"); // the lowest-importance loop is dropped
  });

  test("an active brief that is a strict SUPERSET of a candidate suppresses it", () => {
    loop(db, "L1", { actors: ["p1"] });
    loop(db, "L2", { actors: ["p1"] });
    loop(db, "L3", { importance: 0.9 }); // an unrelated third loop
    createBrief(
      db,
      {
        id: "brief_1",
        createdByRun: "r",
        kind: "loop",
        title: "spans three",
        confidence: 0.8,
        urgency: 0.5,
        relatedLoopIds: ["L1", "L2", "L3"],
      },
      NOW,
    );
    expect(findCollisionCandidates(db, { limit: 10, selfPersonId: null })).toEqual([]);
  });

  test("a set the judge already settled (no brief) is not re-proposed until a member is touched", () => {
    loop(db, "L1", { actors: ["p1"] });
    loop(db, "L2", { actors: ["p1"] });
    expect(findCollisionCandidates(db, { limit: 10, selfPersonId: null })).toHaveLength(1);
    // The judge ran and created no brief (a negative verdict), after the loops.
    markJudged(db, ["L1", "L2"], NOW + 1000);
    expect(findCollisionCandidates(db, { limit: 10, selfPersonId: null })).toEqual([]);
    // A member is touched afterwards → new evidence → the set is re-proposed.
    updateOpenLoop(db, "L1", { importance: 0.6 }, NOW + 2000);
    expect(findCollisionCandidates(db, { limit: 10, selfPersonId: null })).toHaveLength(1);
  });
});

describe("collisionDedupeSuffix", () => {
  test("is order-independent over the loop set", () => {
    expect(collisionDedupeSuffix(["b", "a"])).toBe("a,b");
    expect(collisionDedupeSuffix(["a", "b"])).toBe(collisionDedupeSuffix(["b", "a"]));
  });
});

describe("runCollisionSweepPass", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("enqueues a synthesis collision run per candidate, then respects its cadence", async () => {
    loop(db, "L1", { actors: ["p1"] });
    loop(db, "L2", { actors: ["p1"] });
    const writeGate = directWriteGate(db);
    let now = NOW;
    let seq = 0;
    const deps = {
      db,
      writeGate,
      clock: () => now,
      getCadenceHours: () => 24,
      getMaxPerSweep: () => 5,
      getSelfPersonId: () => null,
      getTimeHorizonDays: () => 60,
      log,
      idGen: () => `c${++seq}`,
    };

    const first = await runCollisionSweepPass(deps);
    expect(first).toEqual({ fired: true, enqueued: 1 });
    const runs = listCognitionRuns(db, { limit: 10 });
    const synth = runs.filter((r) => r.kind === "synthesis");
    expect(synth).toHaveLength(1);
    expect((synth[0]!.payload as { focus: string }).focus).toBe("collision");

    // Within cadence → no fire.
    now = NOW + 60 * 60 * 1000;
    expect(await runCollisionSweepPass(deps)).toEqual({ fired: false, enqueued: 0 });

    // Past cadence, but the same pair folds on its dedupe key → still one run.
    now = NOW + 25 * 60 * 60 * 1000;
    const third = await runCollisionSweepPass(deps);
    expect(third.fired).toBe(true);
    expect(listCognitionRuns(db, { limit: 10 }).filter((r) => r.kind === "synthesis")).toHaveLength(
      1,
    );
  });
});

// ── time-interval collisions ───────────────────────────────────────────────

const DAY = 24 * 3_600_000;

interface TemporalAnnotationOpts {
  precision?: TemporalPrecision;
  docs?: string[];
  kind?: string;
}
function temporalAnnotation(
  db: Db,
  id: string,
  startMs: number,
  endMs: number,
  opts: TemporalAnnotationOpts = {},
): void {
  insertTemporalAnnotation(
    db,
    {
      id,
      intervalStartMs: startMs,
      intervalEndMs: endMs,
      precision: opts.precision ?? "range",
      canonical: null,
      sentence: id,
      kind: opts.kind ?? null,
      documentIds: opts.docs ?? [],
      createdByRun: "r",
    },
    NOW,
  );
}

describe("findTemporalAnnotationCollisionCandidates", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });
  const opts = { limit: 5, now: NOW, horizonDays: 60 };

  test("two annotations occupying overlapping days pair up, tagged with the overlap window", () => {
    // A week-long trip and a deadline that falls inside it.
    temporalAnnotation(db, "ta_trip", NOW + 10 * DAY, NOW + 17 * DAY);
    temporalAnnotation(db, "ta_deadline", NOW + 12 * DAY, NOW + 12 * DAY + DAY - 1, {
      precision: "day",
    });
    // A far-away unrelated annotation pairs with nothing.
    temporalAnnotation(db, "ta_solo", NOW + 40 * DAY, NOW + 40 * DAY + DAY - 1, {
      precision: "day",
    });
    const out = findTemporalAnnotationCollisionCandidates(db, opts);
    expect(out).toHaveLength(1);
    expect(out[0]!.temporalAnnotationIds).toEqual(["ta_deadline", "ta_trip"]);
    expect(out[0]!.matchedBy).toHaveLength(1);
    expect(out[0]!.matchedBy[0]).toMatch(/^time-overlap:\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/);
  });

  test("pairs sharing a source document are the same event, not a collision", () => {
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('doc_x', 'prov', 'src', 'ext', 't', 'c', 'h', ${NOW}, ${NOW}, ${NOW}, ${NOW})`,
    ).run();
    temporalAnnotation(db, "ta_a", NOW + 5 * DAY, NOW + 6 * DAY, { docs: ["doc_x"] });
    temporalAnnotation(db, "ta_b", NOW + 5 * DAY, NOW + 6 * DAY, { docs: ["doc_x"] });
    expect(findTemporalAnnotationCollisionCandidates(db, opts)).toHaveLength(0);
  });

  test("coarse periods and over-wide ranges never join a collision", () => {
    // Year + month granularities overlap half the index by construction.
    temporalAnnotation(db, "ta_year", NOW, NOW + 365 * DAY, { precision: "year" });
    temporalAnnotation(db, "ta_month", NOW, NOW + 30 * DAY, { precision: "month" });
    // A range wider than the span cap (e.g. a certificate validity window).
    temporalAnnotation(db, "ta_wide", NOW, NOW + 90 * DAY);
    // One concrete day inside all of them.
    temporalAnnotation(db, "ta_day", NOW + 3 * DAY, NOW + 3 * DAY + DAY - 1, {
      precision: "day",
    });
    expect(findTemporalAnnotationCollisionCandidates(db, opts)).toHaveLength(0);
  });

  test("overlaps past the horizon or entirely in the past are ignored", () => {
    temporalAnnotation(db, "ta_past_a", NOW - 10 * DAY, NOW - 9 * DAY);
    temporalAnnotation(db, "ta_past_b", NOW - 10 * DAY, NOW - 9 * DAY + 3_600_000);
    temporalAnnotation(db, "ta_far_a", NOW + 90 * DAY, NOW + 91 * DAY);
    temporalAnnotation(db, "ta_far_b", NOW + 90 * DAY, NOW + 91 * DAY);
    expect(findTemporalAnnotationCollisionCandidates(db, opts)).toHaveLength(0);
  });

  test("a judged pair stays settled until one of its entries is updated", () => {
    temporalAnnotation(db, "ta_a", NOW + 5 * DAY, NOW + 6 * DAY);
    temporalAnnotation(db, "ta_b", NOW + 5 * DAY, NOW + 6 * DAY);
    expect(findTemporalAnnotationCollisionCandidates(db, opts)).toHaveLength(1);
    markJudged(db, ["ta_a", "ta_b"], NOW + 1000);
    expect(findTemporalAnnotationCollisionCandidates(db, opts)).toHaveLength(0);
    // Touching one annotation re-opens the question.
    updateTemporalAnnotation(db, "ta_a", { sentence: "retimed thing" }, NOW + 2000);
    expect(findTemporalAnnotationCollisionCandidates(db, opts)).toHaveLength(1);
  });

  test("a judged pair at the head of the window cannot starve a fresh pair past the limit", () => {
    // Judged pair overlaps soonest; the fresh pair sits later in the window.
    temporalAnnotation(db, "ta_j1", NOW + 2 * DAY, NOW + 3 * DAY);
    temporalAnnotation(db, "ta_j2", NOW + 2 * DAY, NOW + 3 * DAY);
    markJudged(db, ["ta_j1", "ta_j2"], NOW + 1000);
    temporalAnnotation(db, "ta_f1", NOW + 20 * DAY, NOW + 21 * DAY);
    temporalAnnotation(db, "ta_f2", NOW + 20 * DAY, NOW + 21 * DAY);
    // The settled pair is excluded inside the query, so even limit 1 finds
    // the fresh pair instead of returning an empty page.
    const out = findTemporalAnnotationCollisionCandidates(db, { ...opts, limit: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]!.temporalAnnotationIds).toEqual(["ta_f1", "ta_f2"]);
  });

  test("soonest overlap ranks first and the limit caps the pairs", () => {
    temporalAnnotation(db, "ta_l1", NOW + 20 * DAY, NOW + 21 * DAY);
    temporalAnnotation(db, "ta_l2", NOW + 20 * DAY, NOW + 21 * DAY);
    temporalAnnotation(db, "ta_e1", NOW + 2 * DAY, NOW + 3 * DAY);
    temporalAnnotation(db, "ta_e2", NOW + 2 * DAY, NOW + 3 * DAY);
    const out = findTemporalAnnotationCollisionCandidates(db, { ...opts, limit: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]!.temporalAnnotationIds).toEqual(["ta_e1", "ta_e2"]);
  });
});

describe("runCollisionSweepPass with temporal annotation candidates", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("temporal annotation pairs fill the per-sweep budget left by the loop joins", async () => {
    // One loop-join candidate (shared doc) …
    loop(db, "loop_a", { docs: ["doc_shared"], importance: 0.9 });
    loop(db, "loop_b", { docs: ["doc_shared"], importance: 0.8 });
    // … and one temporal annotation pair.
    temporalAnnotation(db, "ta_a", NOW + 5 * DAY, NOW + 6 * DAY);
    temporalAnnotation(db, "ta_b", NOW + 5 * DAY, NOW + 6 * DAY);

    let seq = 0;
    const deps = {
      db,
      writeGate: directWriteGate(db),
      clock: () => NOW,
      getCadenceHours: () => 24,
      getMaxPerSweep: () => 3,
      getSelfPersonId: () => null,
      getTimeHorizonDays: () => 60,
      log,
      idGen: () => `t${++seq}`,
    };
    const out = await runCollisionSweepPass(deps);
    expect(out).toEqual({ fired: true, enqueued: 2 });
    const synth = listCognitionRuns(db, { limit: 10 }).filter((r) => r.kind === "synthesis");
    expect(synth).toHaveLength(2);
    const payloads = synth.map(
      (r) => r.payload as { loopIds?: string[]; temporalAnnotationIds?: string[] },
    );
    expect(payloads.some((p) => p.loopIds?.length === 2)).toBe(true);
    const temporalAnnotationRun = synth.find(
      (r) =>
        (r.payload as { temporalAnnotationIds?: string[] }).temporalAnnotationIds !== undefined,
    )!;
    expect(
      (temporalAnnotationRun.payload as { temporalAnnotationIds: string[] }).temporalAnnotationIds,
    ).toEqual(["ta_a", "ta_b"]);
    expect(temporalAnnotationRun.dedupeKey).toBe(synthesisCollisionDedupeKey("ta_a,ta_b"));
  });

  test("a full budget leaves no room for temporal annotation pairs", async () => {
    loop(db, "loop_a", { docs: ["doc_shared"] });
    loop(db, "loop_b", { docs: ["doc_shared"] });
    temporalAnnotation(db, "ta_a", NOW + 5 * DAY, NOW + 6 * DAY);
    temporalAnnotation(db, "ta_b", NOW + 5 * DAY, NOW + 6 * DAY);
    const deps = {
      db,
      writeGate: directWriteGate(db),
      clock: () => NOW,
      getCadenceHours: () => 24,
      getMaxPerSweep: () => 1,
      getSelfPersonId: () => null,
      getTimeHorizonDays: () => 60,
      log,
    };
    const out = await runCollisionSweepPass(deps);
    expect(out).toEqual({ fired: true, enqueued: 1 });
    const synth = listCognitionRuns(db, { limit: 10 }).filter((r) => r.kind === "synthesis");
    expect((synth[0]!.payload as { loopIds?: string[] }).loopIds).toBeDefined();
  });
});

// ── annotation contradictions ──────────────────────────────────────────────

/**
 * Seed a real `documents` row for an evidence id — the finder only serves
 * annotations whose evidence doc still exists. Idempotent, so every fixture
 * helper can call it for its own evidence id.
 */
function seedEvidenceDoc(db: Db, id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO documents
       (id, provider_id, source_id, external_id, title, content, content_hash,
        source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'prov', 'src', ?, 't', 'an invented grounding quote', 'h', ?, ?, ?, ?)`,
  ).run(id, id, NOW, NOW, NOW, NOW);
}

/** Seed one doc annotation, with its evidence doc present in `documents`. */
function docAnno(
  db: Db,
  id: string,
  opts: {
    docId: string;
    claimType: string;
    claimText: string;
    createdAt?: number;
    evidenceDocId?: string;
  },
): void {
  const evidenceDocId = opts.evidenceDocId ?? "doc_ev";
  seedEvidenceDoc(db, evidenceDocId);
  createDocAnnotation(
    db,
    {
      id,
      docId: opts.docId,
      claimType: opts.claimType,
      claimText: opts.claimText,
      evidenceDocId,
      evidenceQuote: "an invented grounding quote",
      confidence: 0.7,
      claimBasis: "quoted",
      createdByRun: "r",
    },
    opts.createdAt ?? NOW,
  );
}

/** Seed one person annotation, with its evidence doc present in `documents`. */
function personAnno(
  db: Db,
  id: string,
  opts: { personId: string; claimType: string; claimText: string },
): void {
  seedEvidenceDoc(db, "doc_ev");
  createPersonAnnotation(
    db,
    {
      id,
      personId: opts.personId,
      claimType: opts.claimType,
      claimText: opts.claimText,
      evidenceDocId: "doc_ev",
      evidenceQuote: "an invented grounding quote",
      confidence: 0.7,
      claimBasis: "quoted",
      createdByRun: "r",
    },
    NOW,
  );
}

/** Seed a `people` row (canonical when mergedInto is null). */
function person(db: Db, id: string, mergedInto: string | null = null): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at, merged_into)
     VALUES (?, 'Contact', 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01', ?)`,
  ).run(id, mergedInto);
}

/** Record a settled (completed) annotation-contradiction judge run for an id set. */
function markAnnoJudged(db: Db, annotationIds: string[], completedAt: number): void {
  db.prepare(
    `INSERT INTO cognition_runs
       (id, kind, dedupe_key, status, next_attempt_at, enqueued_at, completed_at)
     VALUES (?, 'synthesis', ?, 'completed', 0, 0, ?)`,
  ).run(
    `run_${randomUUID()}`,
    synthesisAnnotationContradictionDedupeKey(collisionDedupeSuffix(annotationIds)),
    completedAt,
  );
}

describe("findAnnotationContradictionCandidates", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("live annotations sharing (doc, claimType) but disagreeing on the claim form one group", () => {
    docAnno(db, "anno_a", { docId: "doc_1", claimType: "key-date", claimText: "due in July" });
    docAnno(db, "anno_b", { docId: "doc_1", claimType: "key-date", claimText: "due in August" });
    // A third, AGREEING annotation joins the same group (same text is not a
    // second contradiction, but it is part of the disagreeing set).
    docAnno(db, "anno_c", { docId: "doc_1", claimType: "key-date", claimText: "due in August" });
    const out = findAnnotationContradictionCandidates(db, { max: 5 });
    expect(out).toEqual([
      {
        store: "doc",
        annotationIds: ["anno_a", "anno_b", "anno_c"],
        subjectId: "doc_1",
        claimType: "key-date",
      },
    ]);
  });

  test("agreeing duplicates, distinct claimTypes, different subjects, and dead rows never group", () => {
    // Same claim text twice — duplication, not contradiction.
    docAnno(db, "anno_a", { docId: "doc_1", claimType: "topic", claimText: "about the lease" });
    docAnno(db, "anno_b", { docId: "doc_1", claimType: "topic", claimText: "about the lease" });
    // Different claimType — a different aspect, not a contradiction.
    docAnno(db, "anno_c", { docId: "doc_1", claimType: "status", claimText: "lease signed" });
    // Different subject.
    docAnno(db, "anno_d", { docId: "doc_2", claimType: "topic", claimText: "about the invoice" });
    expect(findAnnotationContradictionCandidates(db, { max: 5 })).toEqual([]);
    // A disagreeing pair where one member is DEAD (invalidated) is no group.
    docAnno(db, "anno_e", { docId: "doc_3", claimType: "status", claimText: "paid" });
    docAnno(db, "anno_f", { docId: "doc_3", claimType: "status", claimText: "unpaid" });
    // Kill exactly one member: anno_e stays live but alone in its
    // (subject, claimType), and one live claim is no contradiction.
    db.prepare("UPDATE doc_annotations SET invalidated_at = ? WHERE id = 'anno_f'").run(NOW + 1);
    expect(findAnnotationContradictionCandidates(db, { max: 5 })).toEqual([]);
  });

  test("a disagreeing pair where one member's evidence doc is deleted is no group", () => {
    docAnno(db, "anno_a", {
      docId: "doc_1",
      claimType: "status",
      claimText: "paid",
      evidenceDocId: "doc_ev_kept",
    });
    docAnno(db, "anno_b", {
      docId: "doc_1",
      claimType: "status",
      claimText: "unpaid",
      evidenceDocId: "doc_ev_gone",
    });
    expect(findAnnotationContradictionCandidates(db, { max: 5 })).toHaveLength(1);
    // The second member's grounding atom vanishes (a deletion path no cascade
    // saw) — the dangling row is un-regroundable, so the group dissolves.
    db.prepare("DELETE FROM documents WHERE id = 'doc_ev_gone'").run();
    expect(findAnnotationContradictionCandidates(db, { max: 5 })).toEqual([]);
  });

  test("person-store groups are found separately (same-store pairs only)", () => {
    personAnno(db, "panno_a", {
      personId: "per_1",
      claimType: "role",
      claimText: "runs the reading group",
    });
    personAnno(db, "panno_b", {
      personId: "per_1",
      claimType: "role",
      claimText: "left the reading group",
    });
    // A doc annotation sharing the claimType can never join a person group.
    docAnno(db, "anno_x", { docId: "per_1", claimType: "role", claimText: "unrelated" });
    const out = findAnnotationContradictionCandidates(db, { max: 5 });
    expect(out).toEqual([
      {
        store: "person",
        annotationIds: ["panno_a", "panno_b"],
        subjectId: "per_1",
        claimType: "role",
      },
    ]);
  });

  test("the person arm spans the merge equivalence class: merged identities form one group", () => {
    // per_merged has been merged into per_canon — the serving reads resolve
    // both to the canonical, and a merge is exactly the event that mints a
    // contradiction with no create to refuse.
    person(db, "per_canon");
    person(db, "per_merged", "per_canon");
    personAnno(db, "panno_a", {
      personId: "per_merged",
      claimType: "role",
      claimText: "chairs the committee",
    });
    personAnno(db, "panno_b", {
      personId: "per_canon",
      claimType: "role",
      claimText: "left the committee",
    });
    const out = findAnnotationContradictionCandidates(db, { max: 5 });
    expect(out).toEqual([
      {
        store: "person",
        annotationIds: ["panno_a", "panno_b"],
        subjectId: "per_canon",
        claimType: "role",
      },
    ]);
    // The group members span both raw person ids.
    const rawIds = out[0]!.annotationIds.map(
      (id) =>
        db
          .prepare<
            [string],
            { person_id: string }
          >("SELECT person_id FROM person_annotations WHERE id = ?")
          .get(id)!.person_id,
    );
    expect(rawIds.sort()).toEqual(["per_canon", "per_merged"]);
  });

  test("the person arm resolves multi-hop merge chains: A→B→C rows group under the root", () => {
    // Chains are routine (resolvePersonId walks up to 10 hops) — a row
    // authored against A, two merges down, must land in the SAME group as a
    // row authored against the root C.
    person(db, "per_c");
    person(db, "per_b", "per_c");
    person(db, "per_a", "per_b");
    personAnno(db, "panno_a", {
      personId: "per_a",
      claimType: "role",
      claimText: "chairs the committee",
    });
    personAnno(db, "panno_c", {
      personId: "per_c",
      claimType: "role",
      claimText: "left the committee",
    });
    const out = findAnnotationContradictionCandidates(db, { max: 5 });
    expect(out).toEqual([
      {
        store: "person",
        annotationIds: ["panno_a", "panno_c"],
        subjectId: "per_c",
        claimType: "role",
      },
    ]);
  });

  test("claim types group case-insensitively (stored rows may predate boundary normalization)", () => {
    docAnno(db, "anno_a", { docId: "doc_1", claimType: "Topic", claimText: "about the lease" });
    docAnno(db, "anno_b", { docId: "doc_1", claimType: "topic", claimText: "about the invoice" });
    const out = findAnnotationContradictionCandidates(db, { max: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]!.annotationIds).toEqual(["anno_a", "anno_b"]);
    expect(out[0]!.subjectId).toBe("doc_1");
  });

  test("caps at opts.max, most recently touched groups first", () => {
    docAnno(db, "anno_a1", { docId: "doc_old", claimType: "t", claimText: "x", createdAt: 1000 });
    docAnno(db, "anno_a2", { docId: "doc_old", claimType: "t", claimText: "y", createdAt: 1000 });
    docAnno(db, "anno_b1", { docId: "doc_new", claimType: "t", claimText: "x", createdAt: 2000 });
    docAnno(db, "anno_b2", { docId: "doc_new", claimType: "t", claimText: "y", createdAt: 2000 });
    const out = findAnnotationContradictionCandidates(db, { max: 1 });
    expect(out.map((c) => c.subjectId)).toEqual(["doc_new"]);
    expect(findAnnotationContradictionCandidates(db, { max: 0 })).toEqual([]);
  });

  test("the member cap keeps the disagreement even when the freshest rows all agree", () => {
    // One old dissenting claim, then eight fresher rows that all agree: a
    // pure recency cap would emit eight identical texts (a judge no-op) and
    // bury the real contradiction. The cap must keep both texts.
    docAnno(db, "anno_old", {
      docId: "doc_1",
      claimType: "status",
      claimText: "waitlisted",
      createdAt: NOW - 9000,
    });
    for (let i = 1; i <= 8; i++) {
      docAnno(db, `anno_fresh_${i}`, {
        docId: "doc_1",
        claimType: "status",
        claimText: "confirmed",
        createdAt: NOW - (9 - i) * 1000,
      });
    }
    const out = findAnnotationContradictionCandidates(db, { max: 5 });
    expect(out).toHaveLength(1);
    const ids = out[0]!.annotationIds;
    expect(ids).toHaveLength(8);
    // The dissenting text is represented, at the cost of the OLDEST agreeing row.
    expect(ids).toContain("anno_old");
    expect(ids).toContain("anno_fresh_8");
    expect(ids).not.toContain("anno_fresh_1");
    const texts = new Set(
      ids.map(
        (id) =>
          db
            .prepare<
              [string],
              { claim_text: string }
            >("SELECT claim_text FROM doc_annotations WHERE id = ?")
            .get(id)!.claim_text,
      ),
    );
    expect(texts).toEqual(new Set(["waitlisted", "confirmed"]));
  });

  test("a settled group stays settled until a member is revised", () => {
    docAnno(db, "anno_a", { docId: "doc_1", claimType: "status", claimText: "paid" });
    docAnno(db, "anno_b", { docId: "doc_1", claimType: "status", claimText: "unpaid" });
    expect(findAnnotationContradictionCandidates(db, { max: 5 })).toHaveLength(1);
    // The judge completed AFTER the members were last touched → settled
    // (its verdict was "false positive / no-op"; don't re-pay it every sweep).
    markAnnoJudged(db, ["anno_a", "anno_b"], NOW + 1000);
    expect(findAnnotationContradictionCandidates(db, { max: 5 })).toEqual([]);
    // A member revised since the verdict re-opens the group.
    updateDocAnnotation(db, "anno_b", { claimText: "unpaid as of June" }, NOW + 2000);
    expect(findAnnotationContradictionCandidates(db, { max: 5 })).toHaveLength(1);
  });
});

describe("runCollisionSweepPass annotation-contradiction arm", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function deps(now: () => number, over: Record<string, unknown> = {}) {
    let seq = 0;
    return {
      db,
      writeGate: directWriteGate(db),
      clock: now,
      getCadenceHours: () => 24,
      getMaxPerSweep: () => 5,
      getSelfPersonId: () => null,
      getTimeHorizonDays: () => 60,
      log,
      idGen: () => `ac${++seq}`,
      ...over,
    };
  }

  test("knob-gated: no annotation runs unless the arm is enabled", async () => {
    docAnno(db, "anno_a", { docId: "doc_1", claimType: "status", claimText: "paid" });
    docAnno(db, "anno_b", { docId: "doc_1", claimType: "status", claimText: "unpaid" });
    const result = await runCollisionSweepPass(deps(() => NOW));
    expect(result.fired).toBe(true);
    expect(listCognitionRuns(db, { limit: 10 })).toHaveLength(0);
  });

  test("enqueues one judge run per group with the sorted-id dedupe key, and folds on re-sweep", async () => {
    docAnno(db, "anno_b", { docId: "doc_1", claimType: "status", claimText: "unpaid" });
    docAnno(db, "anno_a", { docId: "doc_1", claimType: "status", claimText: "paid" });
    let now = NOW;
    const d = deps(() => now, {
      // Loop arms off — only the annotation arm runs this sweep.
      getLoopCollisionsEnabled: () => false,
      getAnnotationContradictionsEnabled: () => true,
      getAnnotationContradictionsMaxPerSweep: () => 2,
    });
    const first = await runCollisionSweepPass(d);
    expect(first).toEqual({ fired: true, enqueued: 1 });
    const runs = listCognitionRuns(db, { limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.kind).toBe("synthesis");
    expect(runs[0]!.payload).toEqual({
      focus: "annotation-contradiction",
      annotationIds: ["anno_a", "anno_b"],
      store: "doc",
    });
    expect(runs[0]!.dedupeKey).toBe("synthesis:anno-contradiction:anno_a,anno_b");

    // Past cadence, the same group folds into the pending run.
    now = NOW + 25 * 60 * 60 * 1000;
    const second = await runCollisionSweepPass(d);
    expect(second.fired).toBe(true);
    expect(listCognitionRuns(db, { limit: 10 })).toHaveLength(1);
  });

  test("the loop arms and the annotation arm run independently under one cadence", async () => {
    loop(db, "L1", { actors: ["p1"] });
    loop(db, "L2", { actors: ["p1"] });
    docAnno(db, "anno_a", { docId: "doc_1", claimType: "status", claimText: "paid" });
    docAnno(db, "anno_b", { docId: "doc_1", claimType: "status", claimText: "unpaid" });
    const result = await runCollisionSweepPass(
      deps(() => NOW, {
        getLoopCollisionsEnabled: () => true,
        getAnnotationContradictionsEnabled: () => true,
        getAnnotationContradictionsMaxPerSweep: () => 2,
      }),
    );
    expect(result).toEqual({ fired: true, enqueued: 2 });
    const payloads = listCognitionRuns(db, { limit: 10 }).map(
      (r) => (r.payload as { focus: string }).focus,
    );
    expect(payloads.sort()).toEqual(["annotation-contradiction", "collision"]);
  });
});
