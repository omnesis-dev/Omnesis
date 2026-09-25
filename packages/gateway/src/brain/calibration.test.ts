// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The calibration measurement definition: one test per label rule (each
 * ground-truth signal maps to exactly the class + verdict the module doc
 * declares), the binning + ECE math, the read-only report over a real store,
 * and the SQL/spec parity net — the report aggregates inside SQLite, so a
 * randomized corpus is folded twice (grouped SQL vs. mapping the pure
 * labelers over raw rows) and the two reports must be identical. All fixture
 * data is invented — never corpus-derived.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
type Db = Database.Database;
import { createDatabase } from "../db.js";
import { createDevAnnotation } from "../dev-annotations/store.js";
import { createBrief, setBriefState, markBriefRead } from "./storage/briefs.js";
import {
  createDocAnnotation,
  supersedeDocAnnotationBy,
  invalidateAnnotationsForDoc,
} from "./storage/annotations.js";
import {
  createPersonAnnotation,
  supersedePersonAnnotationBy,
  invalidatePersonAnnotationsForDoc,
} from "./storage/person-annotations.js";
import {
  binReliability,
  computeCalibrationReport,
  expectedCalibrationError,
  labelAnnotation,
  labelBrief,
  CALIBRATION_FAMILIES,
} from "./calibration.js";
import type {
  CalibrationFamily,
  CalibrationLabel,
  CalibrationReport,
  CalibrationReportOptions,
  FamilyCalibrationReport,
  LabeledSample,
} from "./calibration.js";
import type { BriefState } from "./storage/types.js";
import type Database from "better-sqlite3";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

const NOW = new Date(2026, 5, 20, 12, 0, 0).getTime();

function seedBrief(db: Db, id: string, confidence: number, createdAt: number = NOW): void {
  createBrief(
    db,
    {
      id,
      createdByRun: "run-fixture",
      kind: "info",
      title: "Quarterly budget review scheduled",
      confidence,
      urgency: 0.4,
    },
    createdAt,
  );
}

function seedDocAnnotation(
  db: Db,
  id: string,
  opts: {
    confidence?: number;
    docId?: string;
    verificationState?: "unverified" | "verified" | "failed" | null;
    createdAt?: number;
  } = {},
): void {
  createDocAnnotation(
    db,
    {
      id,
      docId: opts.docId ?? "doc-1",
      claimType: "topic",
      claimText: "This document concerns the Q4 budget review.",
      evidenceDocId: opts.docId ?? "doc-1",
      evidenceQuote: "the Q4 budget review",
      confidence: opts.confidence ?? 0.7,
      claimBasis: "quoted",
      createdByRun: "run-fixture",
      verificationState: opts.verificationState ?? null,
    },
    opts.createdAt ?? NOW,
  );
}

function seedPersonAnnotation(
  db: Db,
  id: string,
  opts: {
    confidence?: number;
    verificationState?: "unverified" | "verified" | "failed" | null;
    evidenceDocId?: string;
    createdAt?: number;
  } = {},
): void {
  createPersonAnnotation(
    db,
    {
      id,
      personId: "person-1",
      claimType: "role",
      claimText: "Maya Reeves coordinates the marathon entry forms.",
      evidenceDocId: opts.evidenceDocId ?? "doc-9",
      evidenceQuote: "Maya coordinates the entry forms",
      confidence: opts.confidence ?? 0.6,
      claimBasis: "quoted",
      createdByRun: "run-fixture",
      verificationState: opts.verificationState ?? null,
    },
    opts.createdAt ?? NOW,
  );
}

// ── Label rules — briefs ─────────────────────────────────────────────

describe("labelBrief", () => {
  test("a dev annotation targeting the brief → operator_flagged, incorrect", () => {
    expect(labelBrief("read", true)).toEqual({
      labelClass: "operator_flagged",
      verdict: "incorrect",
    });
    // The operator's explicit flag beats any positive state.
    expect(labelBrief("dismissed_acknowledged", true).verdict).toBe("incorrect");
  });

  test("dismissed_wrong → incorrect", () => {
    expect(labelBrief("dismissed_wrong", false)).toEqual({
      labelClass: "dismissed_wrong",
      verdict: "incorrect",
    });
  });

  test("dismissed_not_relevant → excluded (irrelevant is not untrue)", () => {
    expect(labelBrief("dismissed_not_relevant", false)).toEqual({
      labelClass: "dismissed_not_relevant",
      verdict: "excluded",
    });
  });

  test("dismissed_acknowledged → weak correct", () => {
    expect(labelBrief("dismissed_acknowledged", false)).toEqual({
      labelClass: "acknowledged",
      verdict: "correct",
    });
  });

  test("dismissed_already_handled → weak correct", () => {
    expect(labelBrief("dismissed_already_handled", false)).toEqual({
      labelClass: "already_handled",
      verdict: "correct",
    });
  });

  test("read (kept in the feed) → weak correct", () => {
    expect(labelBrief("read", false)).toEqual({ labelClass: "kept_read", verdict: "correct" });
  });

  test("unread and snoozed carry no verdict yet → excluded", () => {
    expect(labelBrief("unread", false)).toEqual({ labelClass: "unlabeled", verdict: "excluded" });
    expect(labelBrief("dismissed_snoozed", false)).toEqual({
      labelClass: "unlabeled",
      verdict: "excluded",
    });
  });
});

// ── Label rules — annotations ────────────────────────────────────────

describe("labelAnnotation", () => {
  const live = { verificationState: null, invalidatedAt: null, supersededBy: null };

  test("dev flag on the subject DOCUMENT → subject_flagged, excluded (not a truth verdict)", () => {
    // A doc-targeted dev annotation is a source-data-quality note about the
    // document, not a judgment of any claim about it — the annotation leaves
    // the truth bins entirely, whatever its own stamps say.
    expect(labelAnnotation({ ...live, verificationState: "verified" }, true)).toEqual({
      labelClass: "subject_flagged",
      verdict: "excluded",
    });
    expect(
      labelAnnotation({ verificationState: null, invalidatedAt: NOW, supersededBy: "ann-2" }, true)
        .labelClass,
    ).toBe("subject_flagged");
  });

  test("superseded (belief revised away) → weak incorrect, beats an old verified stamp", () => {
    expect(
      labelAnnotation(
        { verificationState: "verified", invalidatedAt: NOW, supersededBy: "ann-2" },
        false,
      ),
    ).toEqual({ labelClass: "superseded", verdict: "incorrect" });
  });

  test("a 'failed' stamp has no rule — nothing writes it, so it falls through to unlabeled", () => {
    // Deliberate: failed re-checks surface as supersessions / weakens /
    // retracts today (module doc, known blind spots). Restore a
    // verification_failed → incorrect rule if a 'failed' writer appears.
    expect(labelAnnotation({ ...live, verificationState: "failed" }, false)).toEqual({
      labelClass: "unlabeled",
      verdict: "excluded",
    });
  });

  test("content-drift invalidation (no successor) → excluded, not a truth verdict", () => {
    expect(
      labelAnnotation({ verificationState: null, invalidatedAt: NOW, supersededBy: null }, false),
    ).toEqual({ labelClass: "drift_invalidated", verdict: "excluded" });
  });

  test("live verified → weak correct", () => {
    expect(labelAnnotation({ ...live, verificationState: "verified" }, false)).toEqual({
      labelClass: "verified",
      verdict: "correct",
    });
  });

  test("live unverified / never-adjudicated → excluded", () => {
    expect(labelAnnotation({ ...live, verificationState: "unverified" }, false).verdict).toBe(
      "excluded",
    );
    expect(labelAnnotation(live, false)).toEqual({ labelClass: "unlabeled", verdict: "excluded" });
  });
});

// ── Binning + ECE math ───────────────────────────────────────────────

describe("binReliability", () => {
  test("returns all 10 bins; empty ones carry n=0 and null stats", () => {
    const bins = binReliability([]);
    expect(bins).toHaveLength(10);
    expect(bins[0]).toEqual({
      lo: 0,
      hi: 0.1,
      n: 0,
      meanConfidence: null,
      empiricalCorrectness: null,
      gap: null,
    });
  });

  test("places samples by confidence, closing the last bin at 1.0", () => {
    const bins = binReliability([
      { confidence: 0.05, correct: true },
      { confidence: 0.1, correct: true }, // exactly on a boundary → bin [0.1, 0.2)
      { confidence: 0.95, correct: false },
      { confidence: 1, correct: true }, // exactly 1.0 → last bin, not out of range
    ]);
    expect(bins[0]!.n).toBe(1);
    expect(bins[1]!.n).toBe(1);
    expect(bins[9]!.n).toBe(2);
  });

  test("clamps out-of-range confidences into the edge bins", () => {
    const bins = binReliability([
      { confidence: -0.2, correct: false },
      { confidence: 1.4, correct: true },
    ]);
    expect(bins[0]!.n).toBe(1);
    expect(bins[9]!.n).toBe(1);
  });

  test("computes mean confidence, empirical correctness, and the signed gap", () => {
    const bins = binReliability([
      { confidence: 0.9, correct: true },
      { confidence: 0.94, correct: false },
    ]);
    const bin = bins[9]!;
    expect(bin.n).toBe(2);
    expect(bin.meanConfidence).toBeCloseTo(0.92, 10);
    expect(bin.empiricalCorrectness).toBeCloseTo(0.5, 10);
    // Overconfident: correctness sits 0.42 BELOW the stated confidence.
    expect(bin.gap).toBeCloseTo(-0.42, 10);
  });
});

describe("expectedCalibrationError", () => {
  test("weights each bin's |gap| by its share of the labeled samples", () => {
    const bins = binReliability([
      // Bin [0.8, 0.9): mean 0.8, correctness 1 → gap +0.2, weight 1/4.
      { confidence: 0.8, correct: true },
      // Bin [0.5, 0.6): mean 0.5, correctness 1/3 → gap ≈ -0.1667, weight 3/4.
      { confidence: 0.5, correct: true },
      { confidence: 0.5, correct: false },
      { confidence: 0.5, correct: false },
    ]);
    const ece = expectedCalibrationError(bins);
    expect(ece).toBeCloseTo(0.25 * 0.2 + 0.75 * (0.5 - 1 / 3), 10);
  });

  test("is null over zero labeled samples — an empty family is honest, not perfect", () => {
    expect(expectedCalibrationError(binReliability([]))).toBeNull();
  });
});

// ── The report over a real store ─────────────────────────────────────

describe("computeCalibrationReport", () => {
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

  test("empty corpus: every family reports zeros, empty bins, null ECE", () => {
    const report = computeCalibrationReport(db, { now: NOW });
    expect(report.families.map((f) => f.family)).toEqual([...CALIBRATION_FAMILIES]);
    for (const family of report.families) {
      expect(family.total).toBe(0);
      expect(family.labeled).toBe(0);
      expect(family.ece).toBeNull();
      expect(family.bins).toHaveLength(10);
      expect(family.bins.every((b) => b.n === 0)).toBe(true);
    }
  });

  test("briefs: state signals label, not-relevant stays out of the truth bins", () => {
    seedBrief(db, "b-wrong", 0.9);
    setBriefState(db, "b-wrong", "dismissed_wrong", NOW);
    seedBrief(db, "b-not-relevant", 0.9);
    setBriefState(db, "b-not-relevant", "dismissed_not_relevant", NOW);
    seedBrief(db, "b-read", 0.85);
    markBriefRead(db, "b-read", NOW);
    seedBrief(db, "b-ack", 0.65);
    setBriefState(db, "b-ack", "dismissed_acknowledged", NOW);
    seedBrief(db, "b-unread", 0.5);
    seedBrief(db, "b-flagged", 0.95);
    markBriefRead(db, "b-flagged", NOW);
    createDevAnnotation(
      db,
      { id: "dev-1", targetType: "brief", targetId: "b-flagged", note: "this brief is wrong" },
      NOW,
    );

    const [family] = computeCalibrationReport(db, { family: "brief", now: NOW }).families;
    expect(family!.total).toBe(6);
    // Truth-labeled: wrong + read + ack + flagged. Excluded: not-relevant, unread.
    expect(family!.labeled).toBe(4);
    expect(family!.correct).toBe(2);
    expect(family!.incorrect).toBe(2);
    expect(family!.classCounts).toEqual({
      dismissed_wrong: 1,
      dismissed_not_relevant: 1,
      kept_read: 1,
      acknowledged: 1,
      unlabeled: 1,
      operator_flagged: 1,
    });
    expect(family!.bins.reduce((acc, b) => acc + b.n, 0)).toBe(4);
    expect(family!.ece).not.toBeNull();
  });

  test("doc annotations: verification, supersession, drift, and subject-doc flags", () => {
    seedDocAnnotation(db, "a-verified", { verificationState: "verified", confidence: 0.8 });
    // 'failed' exists in the storage union but no writer stamps it — it must
    // fall through to unlabeled, not bias the incorrect count.
    seedDocAnnotation(db, "a-failed", { verificationState: "failed", confidence: 0.75 });
    seedDocAnnotation(db, "a-unverified", { verificationState: "unverified" });
    seedDocAnnotation(db, "a-old", { confidence: 0.6 });
    seedDocAnnotation(db, "a-new", { confidence: 0.6 });
    expect(supersedeDocAnnotationBy(db, "a-old", "a-new", NOW).superseded).toBe(true);
    // Drift: invalidate everything about doc-drift (no successor involved).
    seedDocAnnotation(db, "a-drift", { docId: "doc-drift" });
    invalidateAnnotationsForDoc(db, "doc-drift", NOW);
    // A dev flag on a subject document is a data-quality note about the doc,
    // not a verdict on the claim — its annotations leave the truth bins.
    seedDocAnnotation(db, "a-flagged", { docId: "doc-flagged", verificationState: "verified" });
    createDevAnnotation(
      db,
      { id: "dev-2", targetType: "document", targetId: "doc-flagged", note: "bad extraction" },
      NOW,
    );

    const [family] = computeCalibrationReport(db, { family: "doc-annotation", now: NOW }).families;
    expect(family!.total).toBe(7);
    expect(family!.classCounts).toEqual({
      verified: 1,
      unlabeled: 3, // a-unverified + a-new (never adjudicated) + a-failed (no rule)
      superseded: 1,
      drift_invalidated: 1,
      subject_flagged: 1,
    });
    // Truth-labeled: verified + superseded only.
    expect(family!.labeled).toBe(2);
    expect(family!.correct).toBe(1);
    expect(family!.incorrect).toBe(1);
    // The flagged doc's annotation is out of the bins, not counted incorrect.
    expect(family!.bins.reduce((acc, b) => acc + b.n, 0)).toBe(2);
  });

  test("a doc flag excludes the doc's annotations; a brief flag still counts incorrect", () => {
    seedDocAnnotation(db, "a-on-flagged-doc", {
      docId: "doc-noisy",
      verificationState: "verified",
    });
    createDevAnnotation(
      db,
      { id: "dev-doc", targetType: "document", targetId: "doc-noisy", note: "duplicate ingest" },
      NOW,
    );
    seedBrief(db, "b-flagged-artifact", 0.9);
    createDevAnnotation(
      db,
      { id: "dev-brief", targetType: "brief", targetId: "b-flagged-artifact", note: "untrue" },
      NOW,
    );

    const report = computeCalibrationReport(db, { now: NOW });
    const briefs = report.families.find((f) => f.family === "brief")!;
    const docs = report.families.find((f) => f.family === "doc-annotation")!;
    expect(docs.classCounts).toEqual({ subject_flagged: 1 });
    expect(docs.labeled).toBe(0);
    expect(docs.incorrect).toBe(0);
    expect(briefs.classCounts).toEqual({ operator_flagged: 1 });
    expect(briefs.labeled).toBe(1);
    expect(briefs.incorrect).toBe(1);
  });

  test("person annotations: same rules, no operator-flag channel exists", () => {
    seedPersonAnnotation(db, "p-verified", { verificationState: "verified" });
    seedPersonAnnotation(db, "p-old");
    seedPersonAnnotation(db, "p-new");
    expect(supersedePersonAnnotationBy(db, "p-old", "p-new", NOW).superseded).toBe(true);
    // A document-targeted dev annotation must NOT leak onto person annotations
    // (their subject is a person, which the dev target vocabulary can't name).
    createDevAnnotation(
      db,
      { id: "dev-3", targetType: "document", targetId: "doc-9", note: "unrelated" },
      NOW,
    );

    const [family] = computeCalibrationReport(db, {
      family: "person-annotation",
      now: NOW,
    }).families;
    expect(family!.total).toBe(3);
    expect(family!.classCounts).toEqual({ verified: 1, superseded: 1, unlabeled: 1 });
    expect(family!.correct).toBe(1);
    expect(family!.incorrect).toBe(1);
  });

  test("sinceDays windows on artifact creation time", () => {
    const dayMs = 86_400_000;
    seedDocAnnotation(db, "a-recent", { verificationState: "verified" });
    createDocAnnotation(
      db,
      {
        id: "a-ancient",
        docId: "doc-2",
        claimType: "topic",
        claimText: "An older observation about the heart-rate trend.",
        evidenceDocId: "doc-2",
        evidenceQuote: "heart-rate trend",
        confidence: 0.5,
        claimBasis: "quoted",
        createdByRun: "run-fixture",
        verificationState: "verified",
      },
      NOW - 40 * dayMs,
    );

    const all = computeCalibrationReport(db, { family: "doc-annotation", now: NOW });
    expect(all.families[0]!.total).toBe(2);
    expect(all.sinceDays).toBeNull();
    const windowed = computeCalibrationReport(db, {
      family: "doc-annotation",
      sinceDays: 30,
      now: NOW,
    });
    expect(windowed.families[0]!.total).toBe(1);
    expect(windowed.sinceDays).toBe(30);
  });

  test("the report is measurement-only: computing it writes nothing", () => {
    seedBrief(db, "b-1", 0.9);
    setBriefState(db, "b-1", "dismissed_wrong", NOW);
    const before = db
      .prepare<
        [],
        { c: number }
      >("SELECT (SELECT COUNT(*) FROM briefs) + (SELECT COUNT(*) FROM doc_annotations) + (SELECT COUNT(*) FROM person_annotations) + (SELECT COUNT(*) FROM dev_annotations) AS c")
      .get()!.c;
    const first = computeCalibrationReport(db, { now: NOW });
    const second = computeCalibrationReport(db, { now: NOW });
    const after = db
      .prepare<
        [],
        { c: number }
      >("SELECT (SELECT COUNT(*) FROM briefs) + (SELECT COUNT(*) FROM doc_annotations) + (SELECT COUNT(*) FROM person_annotations) + (SELECT COUNT(*) FROM dev_annotations) AS c")
      .get()!.c;
    expect(after).toBe(before);
    expect(second.families).toEqual(first.families);
    // The stated confidence is untouched.
    expect(
      db
        .prepare<[], { confidence: number }>("SELECT confidence FROM briefs WHERE id = 'b-1'")
        .get()!.confidence,
    ).toBe(0.9);
  });
});

// ── SQL/spec parity — the aggregated report vs. the pure labelers ────

/**
 * Reference implementation of the report: load every raw row, map the pure
 * labelers over them, and fold with the exported binning/ECE math. This is
 * the executable specification the production SQL aggregation must match
 * cell-for-cell; it lives here as a test helper only.
 */
function referenceReport(db: Db, opts: CalibrationReportOptions): CalibrationReport {
  const sinceDays = opts.sinceDays ?? null;
  const sinceMs = sinceDays !== null ? opts.now - sinceDays * 86_400_000 : null;
  const wanted = opts.family ? [opts.family] : CALIBRATION_FAMILIES;
  const families = wanted.map((family) => {
    switch (family) {
      case "brief":
        return referenceFold(family, referenceBriefLabels(db, sinceMs));
      case "doc-annotation":
        return referenceFold(family, referenceAnnotationLabels(db, "doc_annotations", sinceMs));
      case "person-annotation":
        return referenceFold(family, referenceAnnotationLabels(db, "person_annotations", sinceMs));
    }
  });
  return { generatedAt: opts.now, sinceDays, families };
}

function referenceBriefLabels(
  db: Db,
  sinceMs: number | null,
): Array<{ confidence: number; label: CalibrationLabel }> {
  const rows = db
    .prepare<unknown[], { confidence: number; state: string; flagged: number }>(
      `SELECT b.confidence, b.state,
              EXISTS(SELECT 1 FROM dev_annotations da
                      WHERE da.target_type = 'brief' AND da.target_id = b.id) AS flagged
         FROM briefs b
        ${sinceMs !== null ? "WHERE b.created_at >= ?" : ""}`,
    )
    .all(...(sinceMs !== null ? [sinceMs] : []));
  return rows.map((r) => ({
    confidence: r.confidence,
    label: labelBrief(r.state, r.flagged === 1),
  }));
}

function referenceAnnotationLabels(
  db: Db,
  table: "doc_annotations" | "person_annotations",
  sinceMs: number | null,
): Array<{ confidence: number; label: CalibrationLabel }> {
  const flaggedExpr =
    table === "doc_annotations"
      ? `EXISTS(SELECT 1 FROM dev_annotations da
                 WHERE da.target_type = 'document' AND da.target_id = a.doc_id)`
      : "0";
  const rows = db
    .prepare<
      unknown[],
      {
        confidence: number;
        verification_state: string | null;
        invalidated_at: number | null;
        superseded_by: string | null;
        flagged: number;
      }
    >(
      `SELECT a.confidence, a.verification_state, a.invalidated_at, a.superseded_by,
              ${flaggedExpr} AS flagged
         FROM ${table} a
        ${sinceMs !== null ? "WHERE a.created_at >= ?" : ""}`,
    )
    .all(...(sinceMs !== null ? [sinceMs] : []));
  return rows.map((r) => ({
    confidence: r.confidence,
    label: labelAnnotation(
      {
        verificationState: r.verification_state,
        invalidatedAt: r.invalidated_at,
        supersededBy: r.superseded_by,
      },
      r.flagged === 1,
    ),
  }));
}

function referenceFold(
  family: CalibrationFamily,
  artifacts: ReadonlyArray<{ confidence: number; label: CalibrationLabel }>,
): FamilyCalibrationReport {
  const classCounts: Record<string, number> = {};
  const samples: LabeledSample[] = [];
  let correct = 0;
  let incorrect = 0;
  for (const a of artifacts) {
    classCounts[a.label.labelClass] = (classCounts[a.label.labelClass] ?? 0) + 1;
    if (a.label.verdict === "excluded") continue;
    const isCorrect = a.label.verdict === "correct";
    if (isCorrect) correct += 1;
    else incorrect += 1;
    samples.push({ confidence: a.confidence, correct: isCorrect });
  }
  const bins = binReliability(samples);
  return {
    family,
    total: artifacts.length,
    labeled: samples.length,
    correct,
    incorrect,
    classCounts,
    bins,
    ece: expectedCalibrationError(bins),
  };
}

/** Deterministic PRNG so a parity failure reproduces exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("SQL aggregation ↔ pure-labeler parity", () => {
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

  const BRIEF_STATES: readonly BriefState[] = [
    "unread",
    "read",
    "dismissed_snoozed",
    "dismissed_already_handled",
    "dismissed_acknowledged",
    "dismissed_not_relevant",
    "dismissed_wrong",
  ];
  const VERIFICATION_STATES = [null, "unverified", "verified", "failed"] as const;
  const dayMs = 86_400_000;

  /**
   * A few hundred randomized artifacts across all three families, hitting
   * every label class (fixed seed → deterministic). Confidences are dyadic
   * (k/64) so per-bin sums are exact in floating point regardless of
   * summation order — SQL SUM() and the JS per-sample fold cannot diverge
   * by rounding, and toEqual can demand exact equality.
   */
  function seedRandomizedCorpus(): void {
    const rand = mulberry32(0xa11ce);
    const randInt = (n: number): number => Math.floor(rand() * n);
    const confidence = (): number => randInt(65) / 64;
    const createdAt = (): number => NOW - randInt(60) * dayMs;

    for (let i = 0; i < 140; i++) {
      const id = `b-rand-${i}`;
      seedBrief(db, id, confidence(), createdAt());
      const state = BRIEF_STATES[i % BRIEF_STATES.length]!;
      if (state !== "unread") setBriefState(db, id, state, NOW);
      // ~1 in 8 briefs gets an operator flag (plus one guaranteed).
      if (i === 0 || randInt(8) === 0) {
        createDevAnnotation(
          db,
          { id: `dev-b-${i}`, targetType: "brief", targetId: id, note: "flagged in review" },
          NOW,
        );
      }
    }

    for (let i = 0; i < 160; i++) {
      seedDocAnnotation(db, `a-rand-${i}`, {
        docId: `doc-r-${i % 40}`,
        confidence: confidence(),
        verificationState: VERIFICATION_STATES[randInt(VERIFICATION_STATES.length)],
        createdAt: createdAt(),
      });
    }
    // Supersessions (guaranteed pair first, then random attempts — a false
    // return just means the pair was already dead, which is fine).
    supersedeDocAnnotationBy(db, "a-rand-2", "a-rand-3", NOW);
    for (let j = 0; j < 20; j++) {
      const x = randInt(160);
      const y = (x + 7) % 160;
      supersedeDocAnnotationBy(db, `a-rand-${x}`, `a-rand-${y}`, NOW);
    }
    // Content drift on a few subject docs (no document row exists, so every
    // live annotation on them soft-invalidates).
    invalidateAnnotationsForDoc(db, "doc-r-1", NOW);
    for (let j = 0; j < 5; j++) invalidateAnnotationsForDoc(db, `doc-r-${randInt(40)}`, NOW);
    // Dev flags on a few subject docs.
    createDevAnnotation(
      db,
      { id: "dev-d-0", targetType: "document", targetId: "doc-r-0", note: "duplicate ingest" },
      NOW,
    );
    for (let j = 0; j < 4; j++) {
      createDevAnnotation(
        db,
        {
          id: `dev-d-${j + 1}`,
          targetType: "document",
          targetId: `doc-r-${randInt(40)}`,
          note: "garbled",
        },
        NOW,
      );
    }

    for (let i = 0; i < 120; i++) {
      seedPersonAnnotation(db, `p-rand-${i}`, {
        confidence: confidence(),
        verificationState: VERIFICATION_STATES[randInt(VERIFICATION_STATES.length)],
        evidenceDocId: `pdoc-${i % 25}`,
        createdAt: createdAt(),
      });
    }
    supersedePersonAnnotationBy(db, "p-rand-2", "p-rand-3", NOW);
    for (let j = 0; j < 15; j++) {
      const x = randInt(120);
      const y = (x + 5) % 120;
      supersedePersonAnnotationBy(db, `p-rand-${x}`, `p-rand-${y}`, NOW);
    }
    invalidatePersonAnnotationsForDoc(db, "pdoc-1", NOW);
    for (let j = 0; j < 3; j++) invalidatePersonAnnotationsForDoc(db, `pdoc-${randInt(25)}`, NOW);
    // A doc-targeted dev flag on a person annotation's EVIDENCE doc must not
    // leak into the person family (its subject is a person, not a document).
    createDevAnnotation(
      db,
      { id: "dev-pdoc", targetType: "document", targetId: "pdoc-3", note: "unrelated doc note" },
      NOW,
    );
  }

  test("the aggregated report equals the reference, full-history and windowed", () => {
    seedRandomizedCorpus();
    const optionVariants: CalibrationReportOptions[] = [
      { now: NOW },
      { sinceDays: 30, now: NOW },
      { family: "brief", now: NOW },
      { family: "doc-annotation", now: NOW },
      { family: "person-annotation", sinceDays: 14, now: NOW },
    ];
    for (const opts of optionVariants) {
      expect(computeCalibrationReport(db, opts)).toEqual(referenceReport(db, opts));
    }
  });

  test("the randomized corpus actually exercises every label class", () => {
    seedRandomizedCorpus();
    const [briefs, docs, people] = computeCalibrationReport(db, { now: NOW }).families;
    expect(Object.keys(briefs!.classCounts).sort()).toEqual([
      "acknowledged",
      "already_handled",
      "dismissed_not_relevant",
      "dismissed_wrong",
      "kept_read",
      "operator_flagged",
      "unlabeled",
    ]);
    expect(Object.keys(docs!.classCounts).sort()).toEqual([
      "drift_invalidated",
      "subject_flagged",
      "superseded",
      "unlabeled",
      "verified",
    ]);
    // No subject-flag channel exists for person annotations.
    expect(Object.keys(people!.classCounts).sort()).toEqual([
      "drift_invalidated",
      "superseded",
      "unlabeled",
      "verified",
    ]);
  });
});
