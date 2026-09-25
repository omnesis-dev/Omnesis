// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the durable doc-annotation layer: the store (create / list /
 * recent-live / has-live / invalidate / privacy cascade), the `annotate_durable`
 * tool's evidence firewall (quote-must-appear, real-doc grounding, confidence
 * ceiling), and the content-change invalidation subscriber.
 *
 * Fixture data is invented — no corpus content.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "@omnesis/core";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { directWriteGate, type WriteGate } from "../../write-gate.js";
import { createOpenLoopMirror } from "../steward/mirror.js";
import { buildCognitionOwnTools, COGNITION_MUTATING_TOOL_NAMES } from "../steward/tools.js";
import { subscribeAnnotationInvalidator } from "../annotation-invalidator.js";
import { subscribePersonAnnotationInvalidator } from "../person-annotation-invalidator.js";
import {
  createDocAnnotation,
  createDocAnnotationSuperseding,
  supersedeDocAnnotation,
  supersedeDocAnnotationBy,
  getDocAnnotation,
  updateDocAnnotation,
  listDocAnnotationEvidence,
  listRecentLiveAnnotations,
  listLiveAnnotationsForDoc,
  hasLiveAnnotationsForDoc,
  invalidateAnnotationsForDoc,
  cascadeAnnotationPrivacyDelete,
  listDueVerificationDocAnnotations,
} from "./annotations.js";
import {
  createPersonAnnotation,
  getPersonAnnotation,
  deletePersonAnnotation,
  revisePersonAnnotation,
  listPersonAnnotationEvidence,
  invalidatePersonAnnotationsForDoc,
  hasLivePersonAnnotationsForEvidenceDoc,
  listLivePersonAnnotationsForPerson,
  supersedePersonAnnotation,
  listDueVerificationPersonAnnotations,
} from "./person-annotations.js";
import type Database from "better-sqlite3";
import type { EntailCapability, ToolResult } from "@omnesis/core";
import type { SearchPort, ToolHandle } from "@omnesis/agent";

type Db = Database.Database;

const log = createLogger("test").child("annotations");
const CTX = { sessionId: "S", messageId: "M" };
const NOW = Date.parse("2026-07-02T10:00:00.000Z");

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function sourceDoc(externalId: string, content: string): DocumentInput {
  return {
    providerId: ProviderId("google"),
    sourceId: SourceId("gmail-test"),
    externalId,
    title: `Message ${externalId}`,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    sourceCreatedAt: "2026-07-01T09:00:00.000Z",
    sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
    metadata: { documentType: "email" },
  };
}

function insertDoc(db: Db, externalId: string, content: string): string {
  upsertDocuments(db, [sourceDoc(externalId, content)]);
  const row = db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId);
  if (!row) throw new Error("insert failed");
  return row.id;
}

const emptySearchPort: SearchPort = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async search(input) {
    return { query: input.query, durationMs: 0, results: [] };
  },
};

function annotationRow(db: Db, id: string): Record<string, unknown> | undefined {
  return db
    .prepare<[string], Record<string, unknown>>("SELECT * FROM doc_annotations WHERE id = ?")
    .get(id);
}

function structured(result: ToolResult): { resultType: string; data: Record<string, unknown> } {
  if (result.kind !== "structured") {
    throw new Error(`expected a structured result, got ${JSON.stringify(result)}`);
  }
  return { resultType: result.resultType, data: result.data as Record<string, unknown> };
}

// ── store ──────────────────────────────────────────────────────────────────

describe("doc annotation store", () => {
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

  test("create → list → recent-live, with the llm_derived + subject/evidence split", () => {
    const subject = insertDoc(db, "d1", "the vendor confirmed the marquee for July 20");
    const evidence = insertDoc(db, "d2", "we can hold the marquee until the 20th");
    const a = createDocAnnotation(
      db,
      {
        id: "anno_1",
        docId: subject,
        claimType: "commitment-status",
        claimText: "marquee held for July 20",
        evidenceDocId: evidence,
        evidenceQuote: "hold the marquee until the 20th",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "run_a",
      },
      NOW,
    );
    expect(a.llmDerived).toBe(true);
    expect(a.invalidatedAt).toBeNull();

    const recent = listRecentLiveAnnotations(db, { sinceMs: NOW - 1000, limit: 10 });
    expect(recent.map((r) => r.id)).toEqual(["anno_1"]);
    expect(recent[0]!.claimText).toBe("marquee held for July 20");
    expect(hasLiveAnnotationsForDoc(db, subject)).toBe(true);
    expect(hasLiveAnnotationsForDoc(db, evidence)).toBe(true);
    expect(hasLiveAnnotationsForDoc(db, "d-none")).toBe(false);
  });

  test("recent synthesis priors retain null and verified but quarantine explicit non-passes", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "evidence body");
    for (const [id, at] of [
      ["anno_null", NOW],
      ["anno_verified", NOW + 1],
      ["anno_unverified", NOW + 2],
      ["anno_failed", NOW + 3],
    ] as const) {
      createDocAnnotation(
        db,
        {
          id,
          docId: subject,
          claimType: "topic",
          claimText: id,
          evidenceDocId: evidence,
          evidenceQuote: "evidence body",
          confidence: 0.8,
          claimBasis: "quoted",
          createdByRun: "run_a",
        },
        at,
      );
    }
    db.prepare(
      "UPDATE doc_annotations SET verification_state = 'verified' WHERE id = 'anno_verified'",
    ).run();
    db.prepare(
      "UPDATE doc_annotations SET verification_state = 'unverified' WHERE id = 'anno_unverified'",
    ).run();
    db.prepare(
      "UPDATE doc_annotations SET verification_state = 'failed' WHERE id = 'anno_failed'",
    ).run();

    expect(listRecentLiveAnnotations(db, { sinceMs: 0, limit: 10 }).map((a) => a.id)).toEqual([
      "anno_verified",
      "anno_null",
    ]);
    expect(annotationRow(db, "anno_unverified")?.invalidated_at).toBeNull();
  });

  test("a content change that BREAKS the quote invalidates the prior and excludes it from live reads", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "evidence body text");
    createDocAnnotation(
      db,
      {
        id: "anno_1",
        docId: subject,
        claimType: "topic",
        claimText: "about the offsite",
        evidenceDocId: evidence,
        evidenceQuote: "evidence body text",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_a",
      },
      NOW,
    );
    // The evidence doc's new content no longer contains the grounding quote.
    insertDoc(db, "d2", "entirely rewritten message");
    const r = invalidateAnnotationsForDoc(db, evidence, NOW + 1000);
    expect(r).toEqual({ invalidated: 1, flaggedUnverified: 0, promoted: 0 });
    expect(hasLiveAnnotationsForDoc(db, subject)).toBe(false);
    expect(listRecentLiveAnnotations(db, { sinceMs: 0, limit: 10 })).toHaveLength(0);
    // Still present for audit — the row survives, stamped with invalidated_at.
    expect(annotationRow(db, "anno_1")?.invalidated_at).toBe(NOW + 1000);
    // Idempotent: a second invalidation changes nothing.
    expect(invalidateAnnotationsForDoc(db, evidence, NOW + 2000)).toEqual({
      invalidated: 0,
      flaggedUnverified: 0,
      promoted: 0,
    });
  });

  test("a content change the quote SURVIVES keeps the prior live, re-flagged unverified", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the venue holds the booking until Friday");
    createDocAnnotation(
      db,
      {
        id: "anno_1",
        docId: subject,
        claimType: "commitment-status",
        claimText: "booking held until Friday",
        evidenceDocId: evidence,
        evidenceQuote: "holds the booking until Friday",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_a",
      },
      NOW,
    );
    // Simulate a prior verified stamp, then shift the content AROUND the quote.
    db.prepare(
      "UPDATE doc_annotations SET verification_state = 'verified', last_verified_at = ? WHERE id = 'anno_1'",
    ).run(NOW);
    insertDoc(db, "d2", "update: the venue holds the booking until Friday, deposit due Monday");
    const r = invalidateAnnotationsForDoc(db, evidence, NOW + 1000);
    expect(r).toEqual({ invalidated: 0, flaggedUnverified: 1, promoted: 0 });
    // Still a live prior — but its verdict is wiped for the sweep to re-judge:
    // the row leads the re-verification backlog (last_verified_at cleared).
    expect(hasLiveAnnotationsForDoc(db, subject)).toBe(true);
    const row = annotationRow(db, "anno_1")!;
    expect(row.invalidated_at).toBeNull();
    expect(row.verification_state).toBe("unverified");
    expect(row.last_verified_at).toBeNull();
  });

  test("a SUBJECT-only content change keeps the prior live (its evidence is elsewhere), re-flagged", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "evidence body text");
    createDocAnnotation(
      db,
      {
        id: "anno_1",
        docId: subject,
        claimType: "topic",
        claimText: "about the offsite",
        evidenceDocId: evidence,
        evidenceQuote: "evidence body text",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_a",
      },
      NOW,
    );
    // The SUBJECT changed; the quote lives in the (unchanged) evidence doc.
    insertDoc(db, "d1", "subject body, now revised");
    const r = invalidateAnnotationsForDoc(db, subject, NOW + 1000);
    expect(r).toEqual({ invalidated: 0, flaggedUnverified: 1, promoted: 0 });
    expect(annotationRow(db, "anno_1")?.invalidated_at).toBeNull();
    expect(annotationRow(db, "anno_1")?.verification_state).toBe("unverified");
  });

  test("a vanished document row degrades to the blanket invalidation (un-regroundable)", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "evidence body text");
    createDocAnnotation(
      db,
      {
        id: "anno_1",
        docId: subject,
        claimType: "topic",
        claimText: "x",
        evidenceDocId: evidence,
        evidenceQuote: "evidence body text",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_a",
      },
      NOW,
    );
    db.prepare("DELETE FROM documents WHERE id = ?").run(evidence);
    const r = invalidateAnnotationsForDoc(db, evidence, NOW + 1000);
    expect(r).toEqual({ invalidated: 1, flaggedUnverified: 0, promoted: 0 });
    expect(annotationRow(db, "anno_1")?.invalidated_at).toBe(NOW + 1000);
  });

  test("privacy cascade HARD-purges annotations grounded on a deleted document", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "evidence body");
    createDocAnnotation(
      db,
      {
        id: "anno_1",
        docId: subject,
        claimType: "topic",
        claimText: "x",
        evidenceDocId: evidence,
        evidenceQuote: "evidence body",
        confidence: 0.6,
        claimBasis: "quoted",
        createdByRun: "run_a",
      },
      NOW,
    );
    const purged = cascadeAnnotationPrivacyDelete(db, [evidence]);
    expect(purged).toEqual(["anno_1"]);
    // Gone entirely — not merely invalidated (derived text may embed source).
    expect(annotationRow(db, "anno_1")).toBeUndefined();
  });

  test("invalidation only touches annotations that existed at the event time", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "evidence body");
    const base = {
      docId: subject,
      claimType: "topic",
      evidenceDocId: evidence,
      evidenceQuote: "evidence body",
      confidence: 0.5,
      claimBasis: "quoted",
      createdByRun: "r",
    };
    createDocAnnotation(db, { ...base, id: "anno_old", claimText: "old" }, NOW);
    // The content change drops the quote…
    insertDoc(db, "d2", "totally different text");
    // …and a fresh annotation lands AFTER the content-change event time.
    createDocAnnotation(db, { ...base, id: "anno_new", claimText: "new" }, NOW + 2000);
    // Invalidate as of the event time (NOW + 1000): only the older one is
    // touched — the newer row is neither invalidated nor re-flagged.
    expect(invalidateAnnotationsForDoc(db, evidence, NOW + 1000)).toEqual({
      invalidated: 1,
      flaggedUnverified: 0,
      promoted: 0,
    });
    expect(listRecentLiveAnnotations(db, { sinceMs: 0, limit: 10 }).map((a) => a.id)).toEqual([
      "anno_new",
    ]);
    expect(annotationRow(db, "anno_new")?.verification_state).toBeNull();
  });

  test("supersede stamps BOTH invalidated_at and superseded_by; idempotent; dead/unknown → false", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the venue moved the booking to August");
    const base = {
      docId: subject,
      claimType: "key-date",
      evidenceDocId: evidence,
      evidenceQuote: "the venue moved the booking to August",
      confidence: 0.7,
      claimBasis: "quoted" as const,
      createdByRun: "run_a",
    };
    createDocAnnotation(db, { ...base, id: "anno_old", claimText: "booking is in July" }, NOW);
    createDocAnnotation(db, { ...base, id: "anno_new", claimText: "booking moved to August" }, NOW);

    expect(supersedeDocAnnotation(db, "anno_old", "anno_new", NOW + 1000)).toBe(true);
    const row = annotationRow(db, "anno_old")!;
    expect(row.invalidated_at).toBe(NOW + 1000);
    expect(row.superseded_by).toBe("anno_new");
    // Every existing liveness predicate drops it untouched.
    expect(listLiveAnnotationsForDoc(db, subject).map((r) => r.id)).toEqual(["anno_new"]);
    // Audit split: a content-drift invalidation keeps superseded_by NULL.
    expect(getDocAnnotation(db, "anno_old")?.supersededBy).toBe("anno_new");
    expect(getDocAnnotation(db, "anno_new")?.supersededBy).toBeNull();
    // Idempotent: a replay cannot re-point the row at a second successor.
    expect(supersedeDocAnnotation(db, "anno_old", "anno_other", NOW + 2000)).toBe(false);
    expect(annotationRow(db, "anno_old")!.superseded_by).toBe("anno_new");
    // Unknown row → false.
    expect(supersedeDocAnnotation(db, "anno_missing", "anno_new", NOW)).toBe(false);
  });

  test("createDocAnnotationSuperseding lands the successor + retire stamp atomically", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the deposit was refunded in full");
    createDocAnnotation(
      db,
      {
        id: "anno_old",
        docId: subject,
        claimType: "commitment-status",
        claimText: "deposit refund pending",
        evidenceDocId: evidence,
        evidenceQuote: "the deposit was refunded in full",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_a",
      },
      NOW,
    );
    const { annotation, superseded } = createDocAnnotationSuperseding(
      db,
      {
        id: "anno_new",
        docId: subject,
        claimType: "commitment-status",
        claimText: "deposit refunded in full",
        evidenceDocId: evidence,
        evidenceQuote: "the deposit was refunded in full",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "run_b",
      },
      "anno_old",
      NOW + 1000,
    );
    expect(superseded).toBe(true);
    expect(annotation.id).toBe("anno_new");
    expect(annotationRow(db, "anno_old")!.superseded_by).toBe("anno_new");
    expect(listLiveAnnotationsForDoc(db, subject).map((r) => r.id)).toEqual(["anno_new"]);
  });

  test("createDocAnnotationSuperseding throws on a self-supersede", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the deposit was refunded in full");
    expect(() =>
      createDocAnnotationSuperseding(
        db,
        {
          id: "anno_self",
          docId: subject,
          claimType: "commitment-status",
          claimText: "x",
          evidenceDocId: evidence,
          evidenceQuote: "the deposit was refunded in full",
          confidence: 0.5,
          claimBasis: "quoted",
          createdByRun: "run_a",
        },
        "anno_self",
        NOW,
      ),
    ).toThrow(/cannot supersede itself/);
    // Nothing was committed.
    expect(annotationRow(db, "anno_self")).toBeUndefined();
  });

  test("supersedeDocAnnotationBy retires in favour of a live successor; races and self are safe", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the venue moved the booking to August");
    const base = {
      docId: subject,
      claimType: "key-date",
      evidenceDocId: evidence,
      evidenceQuote: "the venue moved the booking to August",
      confidence: 0.7,
      claimBasis: "quoted" as const,
      createdByRun: "run_a",
    };
    createDocAnnotation(db, { ...base, id: "anno_old", claimText: "booking is in July" }, NOW);
    createDocAnnotation(db, { ...base, id: "anno_new", claimText: "booking is in August" }, NOW);

    // Success: pure retirement, no new row.
    expect(supersedeDocAnnotationBy(db, "anno_old", "anno_new", NOW + 1000)).toEqual({
      superseded: true,
    });
    expect(annotationRow(db, "anno_old")!.superseded_by).toBe("anno_new");
    expect(listLiveAnnotationsForDoc(db, subject).map((r) => r.id)).toEqual(["anno_new"]);

    // Already-dead target → false, stamp untouched.
    expect(supersedeDocAnnotationBy(db, "anno_old", "anno_new", NOW + 2000)).toEqual({
      superseded: false,
    });
    expect(annotationRow(db, "anno_old")!.superseded_by).toBe("anno_new");

    // Dead successor → false, target stays LIVE (never pointed at a dead row).
    createDocAnnotation(db, { ...base, id: "anno_live", claimText: "booking unconfirmed" }, NOW);
    expect(supersedeDocAnnotationBy(db, "anno_live", "anno_old", NOW + 3000)).toEqual({
      superseded: false,
    });
    expect(annotationRow(db, "anno_live")!.invalidated_at).toBeNull();

    // Unknown successor → false; self-supersede throws.
    expect(supersedeDocAnnotationBy(db, "anno_live", "anno_missing", NOW + 4000)).toEqual({
      superseded: false,
    });
    expect(() => supersedeDocAnnotationBy(db, "anno_live", "anno_live", NOW + 5000)).toThrow(
      /cannot supersede itself/,
    );
  });

  test("a dangling annotation (evidence doc deleted) is not surfaced as a live prior", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "evidence body");
    createDocAnnotation(
      db,
      {
        id: "anno_1",
        docId: subject,
        claimType: "topic",
        claimText: "x",
        evidenceDocId: evidence,
        evidenceQuote: "evidence body",
        confidence: 0.5,
        claimBasis: "quoted",
        createdByRun: "r",
      },
      NOW,
    );
    expect(listRecentLiveAnnotations(db, { sinceMs: 0, limit: 10 })).toHaveLength(1);
    expect(listLiveAnnotationsForDoc(db, subject)).toHaveLength(1);
    // Evidence removed via a path that never cascaded to annotations (e.g. a
    // bulk source wipe) — the read-side guard drops the now-ungrounded prior
    // from EVERY live read (the recent prime and the per-document lookup).
    db.prepare("DELETE FROM documents WHERE id = ?").run(evidence);
    expect(listRecentLiveAnnotations(db, { sinceMs: 0, limit: 10 })).toHaveLength(0);
    expect(listLiveAnnotationsForDoc(db, subject)).toHaveLength(0);
  });
});

// ── the annotate_durable tool + its evidence firewall ────────────────────────

describe("annotate_durable firewall", () => {
  let path: string;
  let db: Db;
  let seq: number;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    seq = 0;
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function buildTools(opts: {
    enabled: boolean;
    ceiling?: number;
    basisCeilings?: { quoted: number; inferred: number; synthesized: number };
    floor?: number;
  }): ToolHandle[] {
    const writeGate = directWriteGate(db);
    return buildCognitionOwnTools({
      db,
      writeGate,
      searchPort: emptySearchPort,
      mirror: createOpenLoopMirror({ db, writeGate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => NOW,
      runId: "run_anno_1",
      idGen: () => `seq${++seq}`,
      annotationsEnabled: opts.enabled,
      ...(opts.ceiling !== undefined ? { annotationConfidenceCeiling: opts.ceiling } : {}),
      ...(opts.basisCeilings !== undefined ? { annotationBasisCeilings: opts.basisCeilings } : {}),
      ...(opts.floor !== undefined ? { annotationConfidenceFloor: opts.floor } : {}),
      log,
    });
  }
  function tool(tools: ToolHandle[], name: string): ToolHandle {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  }

  test("absent unless annotations are enabled; listed as a mutating tool", () => {
    expect(buildTools({ enabled: false }).some((t) => t.name === "annotate_durable")).toBe(false);
    expect(buildTools({ enabled: true }).some((t) => t.name === "annotate_durable")).toBe(true);
    expect(COGNITION_MUTATING_TOOL_NAMES.has("annotate_durable")).toBe(true);
  });

  test("rejects an unknown subject or evidence document", async () => {
    const evidence = insertDoc(db, "d2", "some real text");
    const t = tool(buildTools({ enabled: true }), "annotate_durable");
    const badSubject = await t.invoke(
      {
        docId: "d-nope",
        claimType: "topic",
        claimText: "x",
        evidenceDocId: evidence,
        evidenceQuote: "some real text",
        confidence: 0.5,
        claimBasis: "quoted",
      },
      CTX,
    );
    expect(badSubject.kind).toBe("error");
    const subject = insertDoc(db, "d1", "subject");
    const badEvidence = await t.invoke(
      {
        docId: subject,
        claimType: "topic",
        claimText: "x",
        evidenceDocId: "d-nope",
        evidenceQuote: "x",
        confidence: 0.5,
        claimBasis: "quoted",
      },
      CTX,
    );
    expect(badEvidence.kind).toBe("error");
  });

  test("rejects a quote not found verbatim in the cited document (the reground teeth)", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the caterer will confirm numbers on Friday");
    const t = tool(buildTools({ enabled: true }), "annotate_durable");
    const res = await t.invoke(
      {
        docId: subject,
        claimType: "commitment-status",
        claimText: "caterer confirming Friday",
        evidenceDocId: evidence,
        evidenceQuote: "the caterer promised a full refund", // not in the doc
        confidence: 0.7,
        claimBasis: "quoted",
      },
      CTX,
    );
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.code).toBe("evidence_not_found");
    // Nothing was persisted.
    expect(listRecentLiveAnnotations(db, { sinceMs: 0, limit: 10 })).toHaveLength(0);
  });

  test("accepts a whitespace-insensitive quote match, caps confidence, and persists the prior", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "We can\n  HOLD the marquee   until the 20th.");
    const t = tool(buildTools({ enabled: true, ceiling: 0.9 }), "annotate_durable");
    const res = await t.invoke(
      {
        docId: subject,
        claimType: "commitment-status",
        claimText: "marquee held to the 20th",
        evidenceDocId: evidence,
        evidenceQuote: "hold the marquee until the 20th", // case/space differ
        confidence: 0.99, // over the ceiling
        claimBasis: "quoted",
      },
      CTX,
    );
    expect(res.kind).toBe("structured");
    const persisted = listRecentLiveAnnotations(db, { sinceMs: 0, limit: 10 });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.docId).toBe(subject);
    expect(persisted[0]!.createdByRun).toBe("run_anno_1");
    expect(persisted[0]!.confidence).toBe(0.9); // clamped
    expect(persisted[0]!.llmDerived).toBe(true);
  });

  test("rejects a too-short evidence quote (must be a substantive span)", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the caterer will confirm numbers on Friday");
    const t = tool(buildTools({ enabled: true }), "annotate_durable");
    const res = await t.invoke(
      {
        docId: subject,
        claimType: "topic",
        claimText: "x",
        evidenceDocId: evidence,
        evidenceQuote: "Friday", // 6 chars — below the min(12) floor
        confidence: 0.5,
        claimBasis: "quoted",
      },
      CTX,
    );
    expect(res.kind).toBe("error");
    expect(listRecentLiveAnnotations(db, { sinceMs: 0, limit: 10 })).toHaveLength(0);
  });

  test("rejects an agent-derived open-loop mirror doc as evidence (self-reference)", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    // A doc typed like the open-loop system source's mirror projection.
    upsertDocuments(db, [
      {
        providerId: ProviderId("google"),
        sourceId: SourceId("gmail-test"),
        externalId: "mirror1",
        title: "m",
        content: "the tenant owes the deposit refund",
        contentHash: "hm",
        sourceCreatedAt: "2026-07-01T09:00:00.000Z",
        sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
        metadata: { documentType: "open-loop" },
      },
    ]);
    const mirrorId = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get("mirror1")!.id;
    const t = tool(buildTools({ enabled: true }), "annotate_durable");
    const res = await t.invoke(
      {
        docId: subject,
        claimType: "commitment-status",
        claimText: "x",
        evidenceDocId: mirrorId,
        evidenceQuote: "owes the deposit refund",
        confidence: 0.5,
        claimBasis: "quoted",
      },
      CTX,
    );
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.code).toBe("invalid_evidence");
  });

  test("a below-ceiling confidence passes through unchanged, with no cap flag", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "hold the marquee until the 20th of the month");
    const t = tool(buildTools({ enabled: true, ceiling: 0.9 }), "annotate_durable");
    const res = await t.invoke(
      {
        docId: subject,
        claimType: "commitment-status",
        claimText: "held",
        evidenceDocId: evidence,
        evidenceQuote: "hold the marquee until the 20th",
        confidence: 0.6,
        claimBasis: "quoted",
      },
      CTX,
    );
    expect(res.kind).toBe("structured");
    if (res.kind === "structured") {
      expect((res.data as { confidence: number }).confidence).toBe(0.6);
      expect(res.data).not.toHaveProperty("confidenceCappedTo");
    }
  });

  test("per-basis ceilings clamp tighter the further the claim reasons from its evidence", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "three invoices this quarter reference the same venue");
    // One claimType per write — a repeat claimType on one subject would trip
    // the reconcile-before-create refusal, which is not what this test probes.
    const args = (basis: string, confidence: number) => ({
      docId: subject,
      claimType: `pattern-${basis}`,
      claimText: "the venue is a recurring vendor",
      evidenceDocId: evidence,
      evidenceQuote: "three invoices this quarter reference the same venue",
      confidence,
      claimBasis: basis,
    });
    const t = tool(buildTools({ enabled: true }), "annotate_durable");
    // A synthesized claim caps at its own (lowest) ceiling, not the global one.
    const synthesized = await t.invoke(args("synthesized", 0.9), CTX);
    expect(synthesized.kind).toBe("structured");
    if (synthesized.kind === "structured") {
      expect(synthesized.data).toMatchObject({
        confidence: 0.55,
        claimBasis: "synthesized",
        confidenceCappedTo: 0.55,
      });
    }
    const inferred = await t.invoke(args("inferred", 0.8), CTX);
    expect(inferred.kind).toBe("structured");
    if (inferred.kind === "structured") {
      expect(inferred.data).toMatchObject({ confidence: 0.7, confidenceCappedTo: 0.7 });
    }
    // The persisted rows carry the declared basis.
    const persisted = listRecentLiveAnnotations(db, { sinceMs: 0, limit: 10 });
    expect(persisted.map((r) => r.claimBasis).sort()).toEqual(["inferred", "synthesized"]);
    // The global ceiling still applies AFTER the basis ceiling.
    const t2 = tool(
      buildTools({
        enabled: true,
        ceiling: 0.5,
        basisCeilings: { quoted: 0.9, inferred: 0.7, synthesized: 0.55 },
      }),
      "annotate_durable",
    );
    const globallyCapped = await t2.invoke(args("quoted", 0.9), CTX);
    expect(globallyCapped.kind).toBe("structured");
    if (globallyCapped.kind === "structured") {
      expect(globallyCapped.data).toMatchObject({ confidence: 0.5, confidenceCappedTo: 0.5 });
    }
  });

  test("the abstention floor refuses a too-weak claim outright", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the venue might still be available in autumn");
    const args = {
      docId: subject,
      claimType: "topic",
      claimText: "the venue may be available",
      evidenceDocId: evidence,
      evidenceQuote: "the venue might still be available in autumn",
      claimBasis: "quoted",
    };
    // Default floor (0.25): a 0.1-confidence claim is refused, not persisted.
    const t = tool(buildTools({ enabled: true }), "annotate_durable");
    const refused = await t.invoke({ ...args, confidence: 0.1 }, CTX);
    expect(refused.kind).toBe("error");
    if (refused.kind === "error") expect(refused.code).toBe("insufficient_confidence_to_persist");
    expect(listRecentLiveAnnotations(db, { sinceMs: 0, limit: 10 })).toHaveLength(0);
    // The floor applies AFTER the basis clamp: a synthesized 0.9 claim clamps
    // to 0.55, which a 0.6 floor then refuses.
    const strict = tool(buildTools({ enabled: true, floor: 0.6 }), "annotate_durable");
    const clampedOut = await strict.invoke(
      { ...args, claimBasis: "synthesized", confidence: 0.9 },
      CTX,
    );
    expect(clampedOut.kind).toBe("error");
    if (clampedOut.kind === "error") {
      expect(clampedOut.code).toBe("insufficient_confidence_to_persist");
    }
    expect(listRecentLiveAnnotations(db, { sinceMs: 0, limit: 10 })).toHaveLength(0);
  });
});

// ── content-change invalidation subscriber ───────────────────────────────────

interface FakeBus {
  on(name: string, h: (ev: unknown) => void): () => void;
  emit(name: string, ev: unknown): void;
}
function fakeBus(): FakeBus {
  const handlers = new Map<string, Array<(ev: unknown) => void>>();
  return {
    on(name, h) {
      const list = handlers.get(name) ?? [];
      list.push(h);
      handlers.set(name, list);
      return () => {};
    },
    emit(name, ev) {
      for (const h of handlers.get(name) ?? []) h(ev);
    },
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("annotation invalidator subscription", () => {
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

  function seedAnnotation(subject: string, evidence: string): void {
    createDocAnnotation(
      db,
      {
        id: "anno_1",
        docId: subject,
        claimType: "topic",
        claimText: "x",
        evidenceDocId: evidence,
        evidenceQuote: "evidence body",
        confidence: 0.6,
        claimBasis: "quoted",
        createdByRun: "run_a",
      },
      NOW,
    );
  }

  test("a quote-breaking content change invalidates annotations citing the doc, when enabled", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "evidence body");
    seedAnnotation(subject, evidence);
    insertDoc(db, "d2", "rewritten without the old text");
    const bus = fakeBus();
    subscribeAnnotationInvalidator({
      db,
      eventBus: bus,
      invalidate: (docId, now) => Promise.resolve(invalidateAnnotationsForDoc(db, docId, now)),
      isEnabled: () => true,
      clock: () => NOW + 100,
      log,
    });
    bus.emit("document.upserted", { after: { id: evidence }, contentChanged: true });
    await flush();
    expect(hasLiveAnnotationsForDoc(db, subject)).toBe(false);
  });

  test("a quote-preserving content change keeps the annotation live, flagged unverified", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "evidence body");
    seedAnnotation(subject, evidence);
    insertDoc(db, "d2", "prefix added — evidence body — and a suffix");
    const bus = fakeBus();
    subscribeAnnotationInvalidator({
      db,
      eventBus: bus,
      invalidate: (docId, now) => Promise.resolve(invalidateAnnotationsForDoc(db, docId, now)),
      isEnabled: () => true,
      clock: () => NOW + 100,
      log,
    });
    bus.emit("document.upserted", { after: { id: evidence }, contentChanged: true });
    await flush();
    expect(hasLiveAnnotationsForDoc(db, subject)).toBe(true);
    expect(annotationRow(db, "anno_1")?.verification_state).toBe("unverified");
  });

  test("no-op when disabled, and no-op for a metadata-only (contentChanged=false) upsert", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "evidence body");
    seedAnnotation(subject, evidence);

    const busOff = fakeBus();
    subscribeAnnotationInvalidator({
      db,
      eventBus: busOff,
      invalidate: (docId, now) => Promise.resolve(invalidateAnnotationsForDoc(db, docId, now)),
      isEnabled: () => false,
      clock: () => NOW + 100,
      log,
    });
    busOff.emit("document.upserted", { after: { id: evidence }, contentChanged: true });
    await flush();
    expect(hasLiveAnnotationsForDoc(db, subject)).toBe(true); // disabled → untouched

    const busOn = fakeBus();
    subscribeAnnotationInvalidator({
      db,
      eventBus: busOn,
      invalidate: (docId, now) => Promise.resolve(invalidateAnnotationsForDoc(db, docId, now)),
      isEnabled: () => true,
      clock: () => NOW + 100,
      log,
    });
    busOn.emit("document.upserted", { after: { id: evidence }, contentChanged: false });
    await flush();
    expect(hasLiveAnnotationsForDoc(db, subject)).toBe(true); // no content change → untouched
  });
});

describe("person annotation invalidator subscription", () => {
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

  function seedPersonAnnotation(evidence: string): void {
    createPersonAnnotation(
      db,
      {
        id: "panno_1",
        personId: "per_a",
        claimType: "role",
        claimText: "x",
        evidenceDocId: evidence,
        evidenceQuote: "evidence body",
        confidence: 0.6,
        claimBasis: "quoted",
        createdByRun: "run_a",
      },
      NOW,
    );
  }

  test("a quote-breaking evidence change invalidates the person annotation, when enabled", async () => {
    const evidence = insertDoc(db, "d1", "evidence body");
    seedPersonAnnotation(evidence);
    insertDoc(db, "d1", "rewritten without the old text");
    const bus = fakeBus();
    subscribePersonAnnotationInvalidator({
      db,
      eventBus: bus,
      invalidate: (docId, now) =>
        Promise.resolve(invalidatePersonAnnotationsForDoc(db, docId, now)),
      isEnabled: () => true,
      clock: () => NOW + 100,
      log,
    });
    bus.emit("document.upserted", { after: { id: evidence }, contentChanged: true });
    await flush();
    expect(hasLivePersonAnnotationsForEvidenceDoc(db, evidence)).toBe(false);
    expect(listLivePersonAnnotationsForPerson(db, "per_a")).toHaveLength(0);
  });

  test("a quote-preserving evidence change keeps the person annotation live, flagged unverified", () => {
    const evidence = insertDoc(db, "d1", "evidence body");
    seedPersonAnnotation(evidence);
    insertDoc(db, "d1", "prefix — evidence body — suffix");
    expect(invalidatePersonAnnotationsForDoc(db, evidence, NOW + 100)).toEqual({
      invalidated: 0,
      flaggedUnverified: 1,
      promoted: 0,
    });
    expect(hasLivePersonAnnotationsForEvidenceDoc(db, evidence)).toBe(true);
    const row = db
      .prepare<
        [],
        { verification_state: string | null; last_verified_at: number | null }
      >("SELECT verification_state, last_verified_at FROM person_annotations WHERE id = 'panno_1'")
      .get();
    expect(row?.verification_state).toBe("unverified");
    expect(row?.last_verified_at).toBeNull();
  });

  test("a person annotation created after the event time is untouched", () => {
    const evidence = insertDoc(db, "d1", "evidence body");
    seedPersonAnnotation(evidence);
    insertDoc(db, "d1", "rewritten without the old text");
    createPersonAnnotation(
      db,
      {
        id: "panno_2",
        personId: "per_a",
        claimType: "role",
        claimText: "y",
        evidenceDocId: evidence,
        evidenceQuote: "rewritten without",
        confidence: 0.6,
        claimBasis: "quoted",
        createdByRun: "run_b",
      },
      NOW + 2000,
    );
    // Event time NOW + 1000: only the pre-event row is judged (and breaks).
    expect(invalidatePersonAnnotationsForDoc(db, evidence, NOW + 1000)).toEqual({
      invalidated: 1,
      flaggedUnverified: 0,
      promoted: 0,
    });
    expect(listLivePersonAnnotationsForPerson(db, "per_a").map((a) => a.id)).toEqual(["panno_2"]);
  });

  test("no-op when disabled, on a non-evidence doc, and on a metadata-only upsert", async () => {
    const evidence = insertDoc(db, "d1", "evidence body");
    const unrelated = insertDoc(db, "d2", "unrelated body");
    seedPersonAnnotation(evidence);

    const busOff = fakeBus();
    subscribePersonAnnotationInvalidator({
      db,
      eventBus: busOff,
      invalidate: (docId, now) =>
        Promise.resolve(invalidatePersonAnnotationsForDoc(db, docId, now)),
      isEnabled: () => false,
      clock: () => NOW + 100,
      log,
    });
    busOff.emit("document.upserted", { after: { id: evidence }, contentChanged: true });
    await flush();
    expect(hasLivePersonAnnotationsForEvidenceDoc(db, evidence)).toBe(true); // disabled → untouched

    const busOn = fakeBus();
    subscribePersonAnnotationInvalidator({
      db,
      eventBus: busOn,
      invalidate: (docId, now) =>
        Promise.resolve(invalidatePersonAnnotationsForDoc(db, docId, now)),
      isEnabled: () => true,
      clock: () => NOW + 100,
      log,
    });
    // A change to a doc the annotation does NOT cite leaves it live.
    busOn.emit("document.upserted", { after: { id: unrelated }, contentChanged: true });
    await flush();
    expect(hasLivePersonAnnotationsForEvidenceDoc(db, evidence)).toBe(true);
    // A metadata-only (contentChanged=false) upsert of the evidence doc is a no-op.
    busOn.emit("document.upserted", { after: { id: evidence }, contentChanged: false });
    await flush();
    expect(hasLivePersonAnnotationsForEvidenceDoc(db, evidence)).toBe(true);
  });
});

// ── annotation_revise / annotation_retract (doc) ─────────────────────────────

describe("annotation_revise / annotation_retract", () => {
  let path: string;
  let db: Db;
  let seq: number;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    seq = 0;
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });
  function buildTools(): ToolHandle[] {
    const writeGate = directWriteGate(db);
    return buildCognitionOwnTools({
      db,
      writeGate,
      searchPort: emptySearchPort,
      mirror: createOpenLoopMirror({ db, writeGate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => NOW,
      runId: "run_rev_1",
      idGen: () => `seq${++seq}`,
      annotationsEnabled: true,
      annotationConfidenceCeiling: 0.9,
      log,
    });
  }
  function tool(tools: ToolHandle[], name: string): ToolHandle {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  }
  async function seedAnnotation(confidence = 0.5): Promise<string> {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the deposit is confirmed for July");
    createDocAnnotation(
      db,
      {
        id: "anno_1",
        docId: subject,
        claimType: "commitment-status",
        claimText: "deposit confirmed",
        evidenceDocId: evidence,
        evidenceQuote: "the deposit is confirmed for July",
        confidence,
        claimBasis: "quoted",
        createdByRun: "run_a",
      },
      NOW,
    );
    return evidence;
  }

  test("both are gated + declared mutating; absent when disabled", () => {
    const off = buildCognitionOwnTools({
      db,
      writeGate: directWriteGate(db),
      searchPort: emptySearchPort,
      mirror: createOpenLoopMirror({ db, writeGate: directWriteGate(db), log }),
      getNotesMaxBytes: () => 8192,
      clock: () => NOW,
      runId: "r",
      annotationsEnabled: false,
      log,
    });
    expect(off.some((t) => t.name === "annotation_revise")).toBe(false);
    const on = buildTools();
    expect(on.some((t) => t.name === "annotation_revise")).toBe(true);
    expect(on.some((t) => t.name === "annotation_retract")).toBe(true);
    expect(COGNITION_MUTATING_TOOL_NAMES.has("annotation_revise")).toBe(true);
    expect(COGNITION_MUTATING_TOOL_NAMES.has("annotation_retract")).toBe(true);
  });

  test("revise edits claim + caps confidence, re-checking the immutable grounding", async () => {
    await seedAnnotation();
    const res = await tool(buildTools(), "annotation_revise").invoke(
      { id: "anno_1", claimText: "deposit confirmed for July", confidence: 0.99 },
      CTX,
    );
    expect(res.kind).toBe("structured");
    const row = getDocAnnotation(db, "anno_1")!;
    expect(row.claimText).toBe("deposit confirmed for July");
    expect(row.confidence).toBe(0.9); // capped below certainty
    expect(row.updatedAt).toBe(NOW);
  });

  test("revise refuses once the grounding quote no longer appears in the evidence doc", async () => {
    const evidence = await seedAnnotation();
    // Rewrite the evidence content so the original quote is gone. content_hash
    // must change with it — production keeps content_hash = hash(content), and
    // the quote-match check memoizes the normalized body on that hash, so a
    // content edit that left the hash stale would return the cached (pre-edit)
    // match instead of re-checking the new text.
    db.prepare("UPDATE documents SET content = ?, content_hash = ? WHERE id = ?").run(
      "totally different text",
      "hash-after-rewrite-1",
      evidence,
    );
    const res = await tool(buildTools(), "annotation_revise").invoke(
      { id: "anno_1", claimText: "x" },
      CTX,
    );
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.code).toBe("evidence_not_found");
    // Unchanged.
    expect(getDocAnnotation(db, "anno_1")!.claimText).toBe("deposit confirmed");
  });

  test("revise re-declares claimBasis and re-clamps standing confidence under the tighter ceiling", async () => {
    await seedAnnotation(0.8);
    const res = await tool(buildTools(), "annotation_revise").invoke(
      { id: "anno_1", claimBasis: "synthesized" },
      CTX,
    );
    expect(res.kind).toBe("structured");
    if (res.kind === "structured") {
      expect(res.data).toMatchObject({
        claimBasis: "synthesized",
        confidence: 0.55,
        confidenceCappedTo: 0.55,
      });
    }
    const row = getDocAnnotation(db, "anno_1")!;
    expect(row.claimBasis).toBe("synthesized");
    expect(row.confidence).toBe(0.55);
  });

  test("a revise lowering confidence below the floor is told to retract instead", async () => {
    await seedAnnotation();
    const res = await tool(buildTools(), "annotation_revise").invoke(
      { id: "anno_1", confidence: 0.1 },
      CTX,
    );
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.code).toBe("insufficient_confidence_to_persist");
      expect(res.message).toContain("retract");
    }
    // Unchanged.
    expect(getDocAnnotation(db, "anno_1")!.confidence).toBe(0.5);
  });

  test("editing a legacy sub-floor row without weakening it passes, whatever fields it touches", async () => {
    // A row already below the floor (created before the floor existed, or
    // before the operator raised it) — the floor refuses only a genuine
    // further weakening, so whether the row can be edited never flips on a
    // no-op field re-declaration.
    await seedAnnotation();
    db.prepare("UPDATE doc_annotations SET confidence = 0.1 WHERE id = 'anno_1'").run();
    // Wording-only edit: passes.
    const reworded = await tool(buildTools(), "annotation_revise").invoke(
      { id: "anno_1", claimText: "the deposit remains unpaid" },
      CTX,
    );
    expect(reworded.kind).toBe("structured");
    // No-op basis re-declaration: also passes (nothing got weaker).
    const redeclared = await tool(buildTools(), "annotation_revise").invoke(
      { id: "anno_1", claimBasis: "quoted" },
      CTX,
    );
    expect(redeclared.kind).toBe("structured");
    // A genuine further lowering still refuses.
    const lowered = await tool(buildTools(), "annotation_revise").invoke(
      { id: "anno_1", confidence: 0.05 },
      CTX,
    );
    expect(lowered.kind).toBe("error");
  });

  test("retract hard-deletes; unknown id → not_found", async () => {
    await seedAnnotation();
    expect(
      (await tool(buildTools(), "annotation_retract").invoke({ id: "anno_1" }, CTX)).kind,
    ).toBe("structured");
    expect(getDocAnnotation(db, "anno_1")).toBeNull();
    expect(
      (await tool(buildTools(), "annotation_retract").invoke({ id: "anno_x" }, CTX)).kind,
    ).toBe("error");
  });
});

// ── annotate_person + person revise/retract ──────────────────────────────────

describe("annotate_person firewall", () => {
  let path: string;
  let db: Db;
  let seq: number;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    seq = 0;
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });
  function buildTools(): ToolHandle[] {
    const writeGate = directWriteGate(db);
    return buildCognitionOwnTools({
      db,
      writeGate,
      searchPort: emptySearchPort,
      mirror: createOpenLoopMirror({ db, writeGate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => NOW,
      runId: "run_pa_1",
      idGen: () => `seq${++seq}`,
      annotationsEnabled: true,
      annotationConfidenceCeiling: 0.9,
      log,
    });
  }
  function tool(tools: ToolHandle[], name: string): ToolHandle {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  }
  function insertPerson(id: string): void {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, ?, 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(id, "Contact");
  }

  test("tools present + mutating; annotate_person rejects an unknown person", async () => {
    const on = buildTools();
    for (const n of ["annotate_person", "person_annotation_revise", "person_annotation_retract"]) {
      expect(on.some((t) => t.name === n)).toBe(true);
      expect(COGNITION_MUTATING_TOOL_NAMES.has(n)).toBe(true);
    }
    const evidence = insertDoc(db, "d2", "chairs the review board");
    const res = await tool(on, "annotate_person").invoke(
      {
        personId: "per_missing",
        claimType: "role",
        claimText: "chairs the board",
        evidenceDocId: evidence,
        evidenceQuote: "chairs the review board",
        confidence: 0.7,
        claimBasis: "quoted",
      },
      CTX,
    );
    expect(res.kind).toBe("error");
  });

  test("full firewall: real person + evidence + verbatim quote + confidence cap → persists", async () => {
    insertPerson("per_a");
    const evidence = insertDoc(db, "d2", "owns the vendor relationship end to end");
    const res = await tool(buildTools(), "annotate_person").invoke(
      {
        personId: "per_a",
        claimType: "role",
        claimText: "owns vendor relationships",
        evidenceDocId: evidence,
        evidenceQuote: "owns the vendor relationship end to end",
        confidence: 0.99,
        claimBasis: "quoted",
      },
      CTX,
    );
    expect(res.kind).toBe("structured");
    const rows = listLivePersonAnnotationsForPerson(db, "per_a");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.confidence).toBe(0.9); // capped
    expect(rows[0]!.claimType).toBe("role");
  });

  test("annotate_person rejects a quote not present in the cited document", async () => {
    insertPerson("per_a");
    const evidence = insertDoc(db, "d2", "some unrelated content");
    const res = await tool(buildTools(), "annotate_person").invoke(
      {
        personId: "per_a",
        claimType: "role",
        claimText: "x",
        evidenceDocId: evidence,
        evidenceQuote: "a quote that is absent from the document",
        confidence: 0.6,
        claimBasis: "quoted",
      },
      CTX,
    );
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.code).toBe("evidence_not_found");
    expect(listLivePersonAnnotationsForPerson(db, "per_a")).toHaveLength(0);
  });

  test("person_annotation_revise re-checks the grounding + caps confidence", async () => {
    insertPerson("per_a");
    const tools = buildTools();
    const evidence = insertDoc(db, "d2", "leads the design review each sprint");
    const created = await tool(tools, "annotate_person").invoke(
      {
        personId: "per_a",
        claimType: "role",
        claimText: "leads reviews",
        evidenceDocId: evidence,
        evidenceQuote: "leads the design review each sprint",
        confidence: 0.5,
        claimBasis: "quoted",
      },
      CTX,
    );
    const id = (created as { kind: "structured"; data: { id: string } }).data.id;

    // A revise that bumps confidence past the ceiling is clamped and reported.
    const revised = await tool(tools, "person_annotation_revise").invoke(
      { id, claimText: "leads the sprint reviews", confidence: 0.99 },
      CTX,
    );
    expect(revised.kind).toBe("structured");
    expect((revised as { data: Record<string, unknown> }).data.confidenceCappedTo).toBe(0.9);
    expect(listLivePersonAnnotationsForPerson(db, "per_a")[0]!.claimText).toBe(
      "leads the sprint reviews",
    );

    // Once the evidence quote no longer appears, a revise is refused (firewall
    // re-check) — the person path is no longer suspenders-only. content_hash
    // changes with the content (production invariant) so the memoized quote
    // match re-checks the new body instead of returning the cached result.
    db.prepare("UPDATE documents SET content = ?, content_hash = ? WHERE id = ?").run(
      "rewritten text",
      "hash-after-rewrite-2",
      evidence,
    );
    const blocked = await tool(tools, "person_annotation_revise").invoke(
      { id, claimText: "stale" },
      CTX,
    );
    expect(blocked.kind).toBe("error");
    if (blocked.kind === "error") expect(blocked.code).toBe("evidence_not_found");
    expect(listLivePersonAnnotationsForPerson(db, "per_a")[0]!.claimText).toBe(
      "leads the sprint reviews",
    );
  });

  test("annotate_person clamps per claim basis and refuses below the floor", async () => {
    insertPerson("per_a");
    const tools = buildTools();
    const evidence = insertDoc(db, "d2", "signs off on every vendor contract this year");
    const args = {
      personId: "per_a",
      claimType: "role",
      claimText: "acts as the vendor gatekeeper",
      evidenceDocId: evidence,
      evidenceQuote: "signs off on every vendor contract this year",
    };
    // A synthesized claim caps at its own ceiling, and the row carries the basis.
    const created = await tool(tools, "annotate_person").invoke(
      { ...args, confidence: 0.9, claimBasis: "synthesized" },
      CTX,
    );
    expect(created.kind).toBe("structured");
    if (created.kind === "structured") {
      expect(created.data).toMatchObject({
        confidence: 0.55,
        claimBasis: "synthesized",
        confidenceCappedTo: 0.55,
      });
    }
    expect(listLivePersonAnnotationsForPerson(db, "per_a")[0]!.claimBasis).toBe("synthesized");

    // The floor refuses a too-weak new claim outright.
    const refused = await tool(tools, "annotate_person").invoke(
      { ...args, confidence: 0.1, claimBasis: "quoted" },
      CTX,
    );
    expect(refused.kind).toBe("error");
    if (refused.kind === "error") expect(refused.code).toBe("insufficient_confidence_to_persist");

    // A revise lowering confidence below the floor is told to retract instead.
    const id = (created as { kind: "structured"; data: { id: string } }).data.id;
    const weakRevise = await tool(tools, "person_annotation_revise").invoke(
      { id, confidence: 0.05 },
      CTX,
    );
    expect(weakRevise.kind).toBe("error");
    if (weakRevise.kind === "error") {
      expect(weakRevise.code).toBe("insufficient_confidence_to_persist");
      expect(weakRevise.message).toContain("retract");
    }
    // A basis re-declaration alone patches through and re-clamps.
    const rebased = await tool(tools, "person_annotation_revise").invoke(
      { id, claimBasis: "inferred" },
      CTX,
    );
    expect(rebased.kind).toBe("structured");
    const row = listLivePersonAnnotationsForPerson(db, "per_a")[0]!;
    expect(row.claimBasis).toBe("inferred");
    expect(row.confidence).toBe(0.55); // already under the inferred ceiling
  });
});

// ── the annotation_search read tool ──────────────────────────────────────────

describe("annotation_search", () => {
  let path: string;
  let db: Db;
  let seq: number;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    seq = 0;
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function buildTools(): ToolHandle[] {
    const writeGate = directWriteGate(db);
    return buildCognitionOwnTools({
      db,
      writeGate,
      searchPort: emptySearchPort,
      mirror: createOpenLoopMirror({ db, writeGate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => NOW,
      runId: "run_search_1",
      idGen: () => `seq${++seq}`,
      annotationsEnabled: true,
      log,
    });
  }
  function tool(tools: ToolHandle[], name: string): ToolHandle {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  }

  test("gated on annotations; read-only (not in the mutating set)", () => {
    expect(buildTools().some((t) => t.name === "annotation_search")).toBe(true);
    expect(COGNITION_MUTATING_TOOL_NAMES.has("annotation_search")).toBe(false);
  });

  test("lists a document's live priors with their evidence pointers", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the venue deposit is due friday");
    createDocAnnotation(
      db,
      {
        id: "anno_s1",
        docId: subject,
        claimType: "commitment-status",
        claimText: "deposit not yet paid",
        evidenceDocId: evidence,
        evidenceQuote: "deposit is due friday",
        confidence: 0.6,
        claimBasis: "quoted",
        createdByRun: "r1",
      },
      NOW,
    );
    const t = tool(buildTools(), "annotation_search");
    const res = await t.invoke({ docId: subject }, CTX);
    expect(res.kind).toBe("structured");
    const body = res as unknown as {
      resultType: string;
      data: { annotations: Array<{ id: string; evidenceDocId: string; evidenceQuote: string }> };
    };
    expect(body.resultType).toBe("annotation.search_results");
    expect(body.data.annotations).toHaveLength(1);
    expect(body.data.annotations[0]?.evidenceDocId).toBe(evidence);
    expect(body.data.annotations[0]?.evidenceQuote).toBe("deposit is due friday");
  });

  test("lists a person's live priors, resolving id or email to the canonical", async () => {
    const evidence = insertDoc(db, "d2", "she leads the workshop programme");
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at, merged_into)
       VALUES ('per_maya','Maya','test','2026-01-01','2026-01-01','2026-01-01','2026-01-01',NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO person_aliases (person_id, alias, alias_type, source_id, created_at)
       VALUES ('per_maya', 'maya@example.com', 'email', 'test', '2026-01-01')`,
    ).run();
    createPersonAnnotation(
      db,
      {
        id: "panno_s1",
        personId: "per_maya",
        claimType: "role",
        claimText: "leads the workshop programme",
        evidenceDocId: evidence,
        evidenceQuote: "leads the workshop programme",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "r1",
      },
      NOW,
    );
    const t = tool(buildTools(), "annotation_search");
    // By person id and by email alias — both resolve to the canonical.
    for (const ref of ["per_maya", "maya@example.com"]) {
      const res = await t.invoke({ personId: ref }, CTX);
      expect(res.kind).toBe("structured");
      const body = res as unknown as {
        resultType: string;
        data: {
          personId: string;
          annotations: Array<{ evidenceDocId: string; evidenceQuote: string }>;
        };
      };
      expect(body.resultType).toBe("annotation.search_results");
      expect(body.data.personId).toBe("per_maya");
      expect(body.data.annotations).toHaveLength(1);
      expect(body.data.annotations[0]?.evidenceDocId).toBe(evidence);
    }
    // An unknown person 404s.
    const missing = await t.invoke({ personId: "per_nope" }, CTX);
    expect(missing.kind).toBe("error");
  });

  test("requires exactly one subject and 404s an unknown one", async () => {
    const t = tool(buildTools(), "annotation_search");
    const both = await t.invoke({ docId: "d1", personId: "p1" }, CTX);
    expect(both.kind).toBe("error");
    const neither = await t.invoke({}, CTX);
    expect(neither.kind).toBe("error");
    const missing = await t.invoke({ docId: "d-nope" }, CTX);
    expect(missing.kind).toBe("error");
  });
});

// ── the entailment gate (firewall 5) over the annotation write tools ─────────

describe("entailment gate (firewall 5)", () => {
  let path: string;
  let db: Db;
  let seq: number;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    seq = 0;
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  /** A fake verifier returning a fixed verdict, recording what it was asked. */
  function fakeVerifier(
    label: "entailment" | "neutral" | "contradiction",
  ): EntailCapability & { calls: Array<{ claim: string; evidence: string }> } {
    const calls: Array<{ claim: string; evidence: string }> = [];
    return {
      calls,
      // eslint-disable-next-line @typescript-eslint/require-await
      async verify(input) {
        calls.push(input);
        return { label };
      },
      dispose() {},
    };
  }

  const throwingVerifier: EntailCapability = {
    verify: () => Promise.reject(new Error("judge backend is down")),
    dispose() {},
  };

  function buildTools(
    getEntailmentVerifier?: () => Promise<EntailCapability | null>,
  ): ToolHandle[] {
    const writeGate = directWriteGate(db);
    return buildCognitionOwnTools({
      db,
      writeGate,
      searchPort: emptySearchPort,
      mirror: createOpenLoopMirror({ db, writeGate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => NOW,
      runId: "run_gate_1",
      idGen: () => `seq${++seq}`,
      annotationsEnabled: true,
      annotationConfidenceCeiling: 0.9,
      ...(getEntailmentVerifier ? { getEntailmentVerifier } : {}),
      log,
    });
  }
  function tool(tools: ToolHandle[], name: string): ToolHandle {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  }
  function insertPerson(id: string): void {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, ?, 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(id, "Contact");
  }
  function annotateArgs(subject: string, evidence: string): Record<string, unknown> {
    return {
      docId: subject,
      claimType: "commitment-status",
      claimText: "the deposit was sent",
      evidenceDocId: evidence,
      evidenceQuote: "we sent the deposit this morning",
      confidence: 0.7,
      claimBasis: "quoted",
    };
  }
  function seedDocs(): { subject: string; evidence: string } {
    return {
      subject: insertDoc(db, "d1", "subject body"),
      evidence: insertDoc(db, "d2", "we sent the deposit this morning"),
    };
  }

  test("entailment verdict → persists with verification_state=verified + last_verified_at", async () => {
    const { subject, evidence } = seedDocs();
    const verifier = fakeVerifier("entailment");

    const t = tool(
      buildTools(async () => verifier),
      "annotate_durable",
    );
    const res = await t.invoke(annotateArgs(subject, evidence), CTX);
    expect(res.kind).toBe("structured");
    const row = listLiveAnnotationsForDoc(db, subject)[0]!;
    expect(row.verificationState).toBe("verified");
    expect(row.lastVerifiedAt).toBe(NOW);
    // The gate judged the claim against the QUOTE, not the whole document.
    expect(verifier.calls).toEqual([
      { claim: "the deposit was sent", evidence: "we sent the deposit this morning" },
    ]);
  });

  test.each(["neutral", "contradiction"] as const)(
    "%s verdict → refuses with evidence_does_not_entail_claim and persists nothing",
    async (label) => {
      const { subject, evidence } = seedDocs();

      const t = tool(
        buildTools(async () => fakeVerifier(label)),
        "annotate_durable",
      );
      const res = await t.invoke(annotateArgs(subject, evidence), CTX);
      expect(res.kind).toBe("error");
      if (res.kind === "error") {
        expect(res.code).toBe("evidence_does_not_entail_claim");
        expect(res.message).toContain(label);
      }
      expect(listRecentLiveAnnotations(db, { sinceMs: 0, limit: 10 })).toHaveLength(0);
    },
  );

  test("throwing verifier → fail-open: persists with verification_state=unverified", async () => {
    const { subject, evidence } = seedDocs();

    const t = tool(
      buildTools(async () => throwingVerifier),
      "annotate_durable",
    );
    const res = await t.invoke(annotateArgs(subject, evidence), CTX);
    expect(res.kind).toBe("structured");
    const row = listLiveAnnotationsForDoc(db, subject)[0]!;
    expect(row.verificationState).toBe("unverified");
    expect(row.lastVerifiedAt).toBeNull();
  });

  test("resolver rejection → fail-open: persists with verification_state=unverified", async () => {
    const { subject, evidence } = seedDocs();
    const t = tool(
      buildTools(() => Promise.reject(new Error("loader exploded"))),
      "annotate_durable",
    );
    const res = await t.invoke(annotateArgs(subject, evidence), CTX);
    expect(res.kind).toBe("structured");
    expect(listLiveAnnotationsForDoc(db, subject)[0]!.verificationState).toBe("unverified");
  });

  test("resolver returning null (role unset) → no stamp, exactly the ungated write", async () => {
    const { subject, evidence } = seedDocs();

    const t = tool(
      buildTools(async () => null),
      "annotate_durable",
    );
    const res = await t.invoke(annotateArgs(subject, evidence), CTX);
    expect(res.kind).toBe("structured");
    const row = listLiveAnnotationsForDoc(db, subject)[0]!;
    expect(row.verificationState).toBeNull();
    expect(row.lastVerifiedAt).toBeNull();
  });

  test("annotate_person runs the same gate: verified stamp on entailment, refusal on neutral", async () => {
    insertPerson("per_a");
    const evidence = insertDoc(db, "d2", "owns the vendor relationship end to end");
    const args = {
      personId: "per_a",
      claimType: "role",
      claimText: "owns vendor relationships",
      evidenceDocId: evidence,
      evidenceQuote: "owns the vendor relationship end to end",
      confidence: 0.7,
      claimBasis: "quoted",
    };

    const ok = await tool(
      buildTools(async () => fakeVerifier("entailment")),
      "annotate_person",
    ).invoke(args, CTX);
    expect(ok.kind).toBe("structured");
    const row = listLivePersonAnnotationsForPerson(db, "per_a")[0]!;
    expect(row.verificationState).toBe("verified");
    expect(row.lastVerifiedAt).toBe(NOW);

    // A distinct claimType keeps the reconcile probe quiet, so the refusal
    // below is the GATE's — the quote does not entail the overreaching claim.
    const refused = await tool(
      buildTools(async () => fakeVerifier("neutral")),
      "annotate_person",
    ).invoke({ ...args, claimType: "affiliation", claimText: "owns the whole company" }, CTX);
    expect(refused.kind).toBe("error");
    if (refused.kind === "error") expect(refused.code).toBe("evidence_does_not_entail_claim");
    expect(listLivePersonAnnotationsForPerson(db, "per_a")).toHaveLength(1);
  });

  test("deterministic refusals precede the gate: a conflict or bad supersede never spends a verifier call", async () => {
    const { subject, evidence } = seedDocs();
    createDocAnnotation(
      db,
      {
        id: "anno_standing",
        docId: subject,
        claimType: "commitment-status",
        claimText: "the deposit is pending",
        evidenceDocId: evidence,
        evidenceQuote: "we sent the deposit this morning",
        confidence: 0.6,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      NOW - 1000,
    );
    // A verifier that would ALSO refuse this claim — if the gate ran first,
    // the result would be an entailment refusal and a recorded call.
    const verifier = fakeVerifier("neutral");
    const t = tool(
      buildTools(async () => verifier),
      "annotate_durable",
    );

    // Standing same-claimType conflict → the SQL refusal wins, zero model spend.
    const conflicted = await t.invoke(annotateArgs(subject, evidence), CTX);
    expect(conflicted.kind).toBe("structured");
    if (conflicted.kind === "structured") {
      expect(conflicted.resultType).toBe("annotation.conflict_candidates");
    }
    expect(verifier.calls).toHaveLength(0);

    // Invalid supersede target → same: refused before the verifier.
    const bad = await t.invoke(
      { ...annotateArgs(subject, evidence), supersedes: "anno_ghost" },
      CTX,
    );
    expect(bad.kind).toBe("error");
    if (bad.kind === "error") expect(bad.code).toBe("invalid_supersede");
    expect(verifier.calls).toHaveLength(0);
  });

  test("annotate_person refuses conflicts and bad supersedes before the verifier too", async () => {
    insertPerson("per_a");
    const evidence = insertDoc(db, "d2", "owns the vendor relationship end to end");
    createPersonAnnotation(
      db,
      {
        id: "panno_standing",
        personId: "per_a",
        claimType: "role",
        claimText: "owns vendor relationships",
        evidenceDocId: evidence,
        evidenceQuote: "owns the vendor relationship end to end",
        confidence: 0.6,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      NOW - 1000,
    );
    const verifier = fakeVerifier("neutral");
    const t = tool(
      buildTools(async () => verifier),
      "annotate_person",
    );
    const args = {
      personId: "per_a",
      claimType: "role",
      claimText: "runs the vendor programme",
      evidenceDocId: evidence,
      evidenceQuote: "owns the vendor relationship end to end",
      confidence: 0.7,
      claimBasis: "quoted",
    };

    const conflicted = await t.invoke(args, CTX);
    expect(conflicted.kind).toBe("structured");
    if (conflicted.kind === "structured") {
      expect(conflicted.resultType).toBe("person_annotation.conflict_candidates");
    }
    expect(verifier.calls).toHaveLength(0);

    const bad = await t.invoke({ ...args, supersedes: "panno_ghost" }, CTX);
    expect(bad.kind).toBe("error");
    if (bad.kind === "error") expect(bad.code).toBe("invalid_supersede");
    expect(verifier.calls).toHaveLength(0);
  });

  test("annotation_revise re-judges the effective claim: refusal blocks, entailment re-stamps", async () => {
    const { subject, evidence } = seedDocs();
    createDocAnnotation(
      db,
      {
        id: "anno_1",
        docId: subject,
        claimType: "commitment-status",
        claimText: "the deposit was sent",
        evidenceDocId: evidence,
        evidenceQuote: "we sent the deposit this morning",
        confidence: 0.5,
        claimBasis: "quoted",
        createdByRun: "run_a",
      },
      NOW,
    );
    // A revise that overreaches past the quote is refused; the row is unchanged.
    const neutral = fakeVerifier("neutral");

    const refused = await tool(
      buildTools(async () => neutral),
      "annotation_revise",
    ).invoke({ id: "anno_1", claimText: "the deposit cleared and the booking is final" }, CTX);
    expect(refused.kind).toBe("error");
    if (refused.kind === "error") expect(refused.code).toBe("evidence_does_not_entail_claim");
    expect(neutral.calls[0]!.claim).toBe("the deposit cleared and the booking is final");
    expect(neutral.calls[0]!.evidence).toBe("we sent the deposit this morning");
    expect(getDocAnnotation(db, "anno_1")!.claimText).toBe("the deposit was sent");

    // A confidence-only revise re-judges the STANDING claim and re-stamps.
    const approving = fakeVerifier("entailment");

    const ok = await tool(
      buildTools(async () => approving),
      "annotation_revise",
    ).invoke({ id: "anno_1", confidence: 0.6 }, CTX);
    expect(ok.kind).toBe("structured");
    expect(approving.calls[0]!.claim).toBe("the deposit was sent");
    const row = getDocAnnotation(db, "anno_1")!;
    expect(row.verificationState).toBe("verified");
    expect(row.lastVerifiedAt).toBe(NOW);
  });

  test("person_annotation_revise runs the gate; absent verifier advances the last-checked stamp, state untouched", async () => {
    insertPerson("per_a");
    const evidence = insertDoc(db, "d2", "leads the design review each sprint");
    createPersonAnnotation(
      db,
      {
        id: "panno_1",
        personId: "per_a",
        claimType: "role",
        claimText: "leads reviews",
        evidenceDocId: evidence,
        evidenceQuote: "leads the design review each sprint",
        confidence: 0.5,
        claimBasis: "quoted",
        createdByRun: "run_a",
        verificationState: "verified",
        lastVerifiedAt: NOW - 1000,
      },
      NOW - 1000,
    );
    // Contradiction blocks the revise.
    const blocked = await tool(
      // eslint-disable-next-line @typescript-eslint/require-await
      buildTools(async () => fakeVerifier("contradiction")),
      "person_annotation_revise",
    ).invoke({ id: "panno_1", claimText: "no longer attends reviews" }, CTX);
    expect(blocked.kind).toBe("error");
    if (blocked.kind === "error") expect(blocked.code).toBe("evidence_does_not_entail_claim");

    // With no verifier wired at all, a successful revise still advances the
    // last-checked stamp — the quote firewall mechanically re-checked the
    // evidence — while the verification STATE stays whatever a verifier last
    // set (only a configured verifier may change it).
    const ok = await tool(buildTools(), "person_annotation_revise").invoke(
      { id: "panno_1", claimText: "leads the sprint reviews" },
      CTX,
    );
    expect(ok.kind).toBe("structured");
    const row = getPersonAnnotation(db, "panno_1")!;
    expect(row.claimText).toBe("leads the sprint reviews");
    expect(row.verificationState).toBe("verified");
    expect(row.lastVerifiedAt).toBe(NOW);
  });

  test("a gateless re-affirm advances lastVerifiedAt and leaves the re-verification due set (both stores)", async () => {
    // The sweep's livelock guard: a verification run's re-affirm revise on an
    // install with NO entailment verifier must still count as a re-grounding.
    // Due predicate = last_verified_at IS NULL OR < cutoff; after a gateless
    // revise the row carries a fresh stamp and stops being re-enqueued.
    const cutoff = NOW - 14 * 86_400_000;

    // Doc store: never-checked row is due; a gateless revise (role unset →
    // resolver yields null) clears it without minting a verification state.
    const { subject, evidence } = seedDocs();
    createDocAnnotation(
      db,
      {
        id: "anno_1",
        docId: subject,
        claimType: "commitment-status",
        claimText: "the deposit was sent",
        evidenceDocId: evidence,
        evidenceQuote: "we sent the deposit this morning",
        confidence: 0.5,
        claimBasis: "quoted",
        createdByRun: "run_a",
      },
      NOW - 30 * 86_400_000,
    );
    expect(listDueVerificationDocAnnotations(db, { cutoff, limit: 10 }).map((r) => r.id)).toEqual([
      "anno_1",
    ]);
    const reaffirmed = await tool(
      buildTools(async () => null),
      "annotation_revise",
    ).invoke({ id: "anno_1", confidence: 0.5 }, CTX);
    expect(reaffirmed.kind).toBe("structured");
    const row = getDocAnnotation(db, "anno_1")!;
    expect(row.lastVerifiedAt).toBe(NOW);
    expect(row.verificationState).toBeNull();
    expect(listDueVerificationDocAnnotations(db, { cutoff, limit: 10 })).toHaveLength(0);

    // Person store: a stale-verified row is due; the gateless (verifier absent
    // entirely) re-affirm refreshes the stamp and keeps the standing state.
    insertPerson("per_a");
    const evidence2 = insertDoc(db, "d3", "chairs the weekly planning call");
    createPersonAnnotation(
      db,
      {
        id: "panno_1",
        personId: "per_a",
        claimType: "role",
        claimText: "chairs planning",
        evidenceDocId: evidence2,
        evidenceQuote: "chairs the weekly planning call",
        confidence: 0.5,
        claimBasis: "quoted",
        createdByRun: "run_a",
        verificationState: "verified",
        lastVerifiedAt: NOW - 30 * 86_400_000,
      },
      NOW - 30 * 86_400_000,
    );
    expect(
      listDueVerificationPersonAnnotations(db, { cutoff, limit: 10 }).map((r) => r.id),
    ).toEqual(["panno_1"]);
    const ok = await tool(buildTools(), "person_annotation_revise").invoke(
      { id: "panno_1", confidence: 0.5 },
      CTX,
    );
    expect(ok.kind).toBe("structured");
    const prow = getPersonAnnotation(db, "panno_1")!;
    expect(prow.lastVerifiedAt).toBe(NOW);
    expect(prow.verificationState).toBe("verified");
    expect(listDueVerificationPersonAnnotations(db, { cutoff, limit: 10 })).toHaveLength(0);
  });
});

// ── supersession + reconcile-before-create (the tool contract) ──────────────

describe("annotation supersession + reconcile-before-create", () => {
  let path: string;
  let db: Db;
  let seq: number;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    seq = 0;
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function buildTools(): ToolHandle[] {
    const writeGate = directWriteGate(db);
    return buildCognitionOwnTools({
      db,
      writeGate,
      searchPort: emptySearchPort,
      mirror: createOpenLoopMirror({ db, writeGate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => NOW,
      runId: "run_sup_1",
      idGen: () => `seq${++seq}`,
      annotationsEnabled: true,
      log,
    });
  }
  function tool(tools: ToolHandle[], name: string): ToolHandle {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  }
  function insertPerson(id: string, mergedInto: string | null = null): void {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at, merged_into)
       VALUES (?, 'Contact', 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01', ?)`,
    ).run(id, mergedInto);
  }
  function docArgs(docId: string, evidence: string, over: Record<string, unknown> = {}) {
    return {
      docId,
      claimType: "commitment-status",
      claimText: "the rehearsal room is booked",
      evidenceDocId: evidence,
      evidenceQuote: "the rehearsal room is booked for the 14th",
      confidence: 0.7,
      claimBasis: "quoted",
      ...over,
    };
  }

  test("a same-subject same-claimType create without supersedes is refused with candidates", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the rehearsal room is booked for the 14th");
    const t = tool(buildTools(), "annotate_durable");
    const first = structured(await t.invoke(docArgs(subject, evidence), CTX));
    expect(first.resultType).toBe("annotation.created");
    const firstId = first.data.id as string;

    const conflicted = structured(
      await t.invoke(
        docArgs(subject, evidence, { claimText: "the room booking fell through" }),
        CTX,
      ),
    );
    expect(conflicted.resultType).toBe("annotation.conflict_candidates");
    const candidates = conflicted.data.candidates as Array<Record<string, unknown>>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      id: firstId,
      claimType: "commitment-status",
      claimText: "the rehearsal room is booked",
      confidence: 0.7,
      claimBasis: "quoted",
    });
    expect(typeof conflicted.data.guidance).toBe("string");
    // Not created — still exactly one live annotation on the subject.
    expect(listLiveAnnotationsForDoc(db, subject)).toHaveLength(1);

    // A genuinely different aspect (another claimType) is NOT a conflict.
    const other = structured(
      await t.invoke(docArgs(subject, evidence, { claimType: "topic" }), CTX),
    );
    expect(other.resultType).toBe("annotation.created");
  });

  test("re-ask with supersedes replaces the standing claim: created + old retired audit-linked", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the rehearsal room is booked for the 14th");
    const t = tool(buildTools(), "annotate_durable");
    const first = structured(await t.invoke(docArgs(subject, evidence), CTX));
    const firstId = first.data.id as string;

    const replaced = structured(
      await t.invoke(
        docArgs(subject, evidence, {
          claimText: "the room booking fell through",
          supersedes: firstId,
        }),
        CTX,
      ),
    );
    expect(replaced.resultType).toBe("annotation.created");
    expect(replaced.data.supersededId).toBe(firstId);
    const successorId = replaced.data.id as string;
    // Old row: dead, audit-linked to its successor; new row: the only live prior.
    const old = getDocAnnotation(db, firstId)!;
    expect(old.invalidatedAt).not.toBeNull();
    expect(old.supersededBy).toBe(successorId);
    expect(listLiveAnnotationsForDoc(db, subject).map((r) => r.id)).toEqual([successorId]);
  });

  test("supersedes cannot dodge the one-belief invariant: a standing same-claimType claim still refuses", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the rehearsal room is booked for the 14th");
    const t = tool(buildTools(), "annotate_durable");
    // Two live beliefs on the subject: one of the incoming claim's type, one
    // of an UNRELATED type.
    const seed = (id: string, claimType: string, claimText: string): void =>
      createDocAnnotation(
        db,
        {
          id,
          docId: subject,
          claimType,
          claimText,
          evidenceDocId: evidence,
          evidenceQuote: "the rehearsal room is booked for the 14th",
          confidence: 0.6,
          claimBasis: "quoted",
          createdByRun: "run_seed",
        },
        NOW - 1000,
      );
    seed("anno_same_type", "commitment-status", "the booking is pending");
    seed("anno_other_type", "topic", "about the rehearsal");

    // Superseding the UNRELATED belief while a same-claimType claim stands
    // would retire the wrong row and mint a silent contradiction — refused,
    // returning the standing same-claimType candidate.
    const viaOtherType = structured(
      await t.invoke(docArgs(subject, evidence, { supersedes: "anno_other_type" }), CTX),
    );
    expect(viaOtherType.resultType).toBe("annotation.conflict_candidates");
    expect((viaOtherType.data.candidates as Array<{ id: string }>).map((c) => c.id)).toEqual([
      "anno_same_type",
    ]);

    // Superseding one same-claimType belief while a SECOND stands beside it
    // is refused the same way; the candidates exclude the supersede target.
    seed("anno_same_type_2", "commitment-status", "the deposit is still owed");
    const besideSecond = structured(
      await t.invoke(docArgs(subject, evidence, { supersedes: "anno_same_type" }), CTX),
    );
    expect(besideSecond.resultType).toBe("annotation.conflict_candidates");
    expect((besideSecond.data.candidates as Array<{ id: string }>).map((c) => c.id)).toEqual([
      "anno_same_type_2",
    ]);

    // Nothing was created; all three seeded rows still stand.
    expect(listLiveAnnotationsForDoc(db, subject)).toHaveLength(3);
  });

  test("supersedes under a refined claimType is legitimate when no claim of the new type stands", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the rehearsal room is booked for the 14th");
    const t = tool(buildTools(), "annotate_durable");
    const first = structured(await t.invoke(docArgs(subject, evidence), CTX));
    const firstId = first.data.id as string;

    // The replacement narrows the claim under a more specific claimType —
    // the target's own claimType is deliberately not required to match.
    const refined = structured(
      await t.invoke(
        docArgs(subject, evidence, { claimType: "booking-status", supersedes: firstId }),
        CTX,
      ),
    );
    expect(refined.resultType).toBe("annotation.created");
    expect(getDocAnnotation(db, firstId)!.supersededBy).toBe(refined.data.id);
    expect(listLiveAnnotationsForDoc(db, subject).map((r) => r.id)).toEqual([refined.data.id]);
  });

  test("annotate_person: supersedes cannot dodge the one-belief invariant either", async () => {
    insertPerson("per_a");
    const evidence = insertDoc(db, "d2", "now coordinates the vendor reviews");
    const seed = (id: string, claimType: string, claimText: string): void =>
      createPersonAnnotation(
        db,
        {
          id,
          personId: "per_a",
          claimType,
          claimText,
          evidenceDocId: evidence,
          evidenceQuote: "now coordinates the vendor reviews",
          confidence: 0.6,
          claimBasis: "quoted",
          createdByRun: "run_seed",
        },
        NOW - 1000,
      );
    seed("panno_same_type", "role", "runs the vendor reviews");
    seed("panno_other_type", "affiliation", "sits on the vendor board");
    const t = tool(buildTools(), "annotate_person");
    const args = {
      personId: "per_a",
      claimType: "role",
      claimText: "coordinates the vendor reviews",
      evidenceDocId: evidence,
      evidenceQuote: "now coordinates the vendor reviews",
      confidence: 0.8,
      claimBasis: "quoted",
    };

    // Mismatched-claimType supersede while a same-claimType claim stands → refusal.
    const viaOtherType = structured(
      await t.invoke({ ...args, supersedes: "panno_other_type" }, CTX),
    );
    expect(viaOtherType.resultType).toBe("person_annotation.conflict_candidates");
    expect((viaOtherType.data.candidates as Array<{ id: string }>).map((c) => c.id)).toEqual([
      "panno_same_type",
    ]);

    // Supersede while a SECOND same-claimType claim stands → refusal,
    // candidates excluding the target.
    seed("panno_same_type_2", "role", "stepped back from the reviews");
    const besideSecond = structured(
      await t.invoke({ ...args, supersedes: "panno_same_type" }, CTX),
    );
    expect(besideSecond.resultType).toBe("person_annotation.conflict_candidates");
    expect((besideSecond.data.candidates as Array<{ id: string }>).map((c) => c.id)).toEqual([
      "panno_same_type_2",
    ]);
    expect(listLivePersonAnnotationsForPerson(db, "per_a")).toHaveLength(3);

    // With the second belief retired, the same supersede goes through: the
    // target is then the only same-claimType row.
    db.prepare("UPDATE person_annotations SET invalidated_at = ? WHERE id = ?").run(
      NOW,
      "panno_same_type_2",
    );
    const replaced = structured(await t.invoke({ ...args, supersedes: "panno_same_type" }, CTX));
    expect(replaced.resultType).toBe("person_annotation.created");
    expect(replaced.data.supersededId).toBe("panno_same_type");
  });

  test("invalid supersedes targets: unknown, dead, wrong subject, cross-store", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const otherDoc = insertDoc(db, "d3", "another subject");
    const evidence = insertDoc(db, "d2", "the rehearsal room is booked for the 14th");
    const t = tool(buildTools(), "annotate_durable");

    // Unknown id.
    const unknown = await t.invoke(docArgs(subject, evidence, { supersedes: "anno_nope" }), CTX);
    expect(unknown.kind).toBe("error");
    if (unknown.kind === "error") expect(unknown.code).toBe("invalid_supersede");

    // Wrong subject: a live annotation about ANOTHER document.
    const onOther = structured(await t.invoke(docArgs(otherDoc, evidence), CTX));
    const wrongSubject = await t.invoke(
      docArgs(subject, evidence, { supersedes: onOther.data.id }),
      CTX,
    );
    expect(wrongSubject.kind).toBe("error");
    if (wrongSubject.kind === "error") expect(wrongSubject.code).toBe("invalid_supersede");

    // Dead target: retire it first, then try to supersede it again.
    const standing = structured(await t.invoke(docArgs(subject, evidence), CTX));
    const standingId = standing.data.id as string;
    supersedeDocAnnotation(db, standingId, "anno_elsewhere", NOW + 1);
    const dead = await t.invoke(docArgs(subject, evidence, { supersedes: standingId }), CTX);
    expect(dead.kind).toBe("error");
    if (dead.kind === "error") expect(dead.code).toBe("invalid_supersede");

    // Cross-store: a PERSON annotation id can never be superseded from the doc tool.
    insertPerson("per_a");
    const panno = structured(
      await tool(buildTools(), "annotate_person").invoke(
        {
          personId: "per_a",
          claimType: "role",
          claimText: "books the rehearsal room",
          evidenceDocId: evidence,
          evidenceQuote: "the rehearsal room is booked for the 14th",
          confidence: 0.7,
          claimBasis: "quoted",
        },
        CTX,
      ),
    );
    const crossStore = await t.invoke(
      docArgs(subject, evidence, { supersedes: panno.data.id }),
      CTX,
    );
    expect(crossStore.kind).toBe("error");
    if (crossStore.kind === "error") expect(crossStore.code).toBe("invalid_supersede");
    // And the person tool rejects a DOC annotation id symmetrically.
    const docAnno = structured(await t.invoke(docArgs(subject, evidence), CTX));
    const reverse = await tool(buildTools(), "annotate_person").invoke(
      {
        personId: "per_a",
        claimType: "availability",
        claimText: "away for the summer",
        evidenceDocId: evidence,
        evidenceQuote: "the rehearsal room is booked for the 14th",
        confidence: 0.6,
        claimBasis: "inferred",
        supersedes: docAnno.data.id,
      },
      CTX,
    );
    expect(reverse.kind).toBe("error");
    if (reverse.kind === "error") expect(reverse.code).toBe("invalid_supersede");
  });

  test("annotate_person: conflict refusal, then supersedes across the merge equivalence class", async () => {
    // The standing claim was authored against a person id that has since
    // merged away — the subject compare resolves it to the canonical, so the
    // conflict fires AND the supersede is accepted from the canonical side.
    insertPerson("per_canon");
    insertPerson("per_loser", "per_canon");
    const evidence = insertDoc(db, "d2", "now coordinates the vendor reviews");
    createPersonAnnotation(
      db,
      {
        id: "panno_old",
        personId: "per_loser",
        claimType: "role",
        claimText: "runs the vendor reviews",
        evidenceDocId: evidence,
        evidenceQuote: "now coordinates the vendor reviews",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      NOW - 1000,
    );
    const t = tool(buildTools(), "annotate_person");
    const args = {
      personId: "per_canon",
      claimType: "role",
      claimText: "coordinates the vendor reviews",
      evidenceDocId: evidence,
      evidenceQuote: "now coordinates the vendor reviews",
      confidence: 0.8,
      claimBasis: "quoted",
    };
    const conflicted = structured(await t.invoke(args, CTX));
    expect(conflicted.resultType).toBe("person_annotation.conflict_candidates");
    const candidates = conflicted.data.candidates as Array<Record<string, unknown>>;
    expect(candidates.map((c) => c.id)).toEqual(["panno_old"]);

    const replaced = structured(await t.invoke({ ...args, supersedes: "panno_old" }, CTX));
    expect(replaced.resultType).toBe("person_annotation.created");
    expect(replaced.data.supersededId).toBe("panno_old");
    const old = getPersonAnnotation(db, "panno_old")!;
    expect(old.invalidatedAt).not.toBeNull();
    expect(old.supersededBy).toBe(replaced.data.id);
    // The canonical's live view holds exactly the successor.
    expect(listLivePersonAnnotationsForPerson(db, "per_canon").map((r) => r.id)).toEqual([
      replaced.data.id,
    ]);
  });

  test("annotate_person: a live claim on a DIFFERENT person is not supersedable", async () => {
    insertPerson("per_a");
    insertPerson("per_b");
    const evidence = insertDoc(db, "d2", "now coordinates the vendor reviews");
    createPersonAnnotation(
      db,
      {
        id: "panno_b",
        personId: "per_b",
        claimType: "role",
        claimText: "coordinates reviews",
        evidenceDocId: evidence,
        evidenceQuote: "now coordinates the vendor reviews",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      NOW - 1000,
    );
    const res = await tool(buildTools(), "annotate_person").invoke(
      {
        personId: "per_a",
        claimType: "role",
        claimText: "coordinates the vendor reviews",
        evidenceDocId: evidence,
        evidenceQuote: "now coordinates the vendor reviews",
        confidence: 0.8,
        claimBasis: "quoted",
        supersedes: "panno_b",
      },
      CTX,
    );
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.code).toBe("invalid_supersede");
  });
});

// ── the supersede tools, the lost-supersede signal, and probe hardening ─────

describe("annotation supersede tools + probe hardening", () => {
  let path: string;
  let db: Db;
  let seq: number;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    seq = 0;
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function buildTools(opts: { enabled?: boolean; wrapGate?: (gate: WriteGate) => WriteGate } = {}) {
    const gate = directWriteGate(db);
    const writeGate = opts.wrapGate ? opts.wrapGate(gate) : gate;
    return buildCognitionOwnTools({
      db,
      writeGate,
      searchPort: emptySearchPort,
      mirror: createOpenLoopMirror({ db, writeGate: gate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => NOW,
      runId: "run_r2_1",
      idGen: () => `seq${++seq}`,
      annotationsEnabled: opts.enabled ?? true,
      log,
    });
  }
  function tool(tools: ToolHandle[], name: string): ToolHandle {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  }
  function insertPerson(id: string, mergedInto: string | null = null): void {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at, merged_into)
       VALUES (?, 'Contact', 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01', ?)`,
    ).run(id, mergedInto);
  }
  function seedDocAnno(
    id: string,
    docId: string,
    evidence: string,
    over: { claimType?: string; claimText?: string; createdAt?: number } = {},
  ): void {
    createDocAnnotation(
      db,
      {
        id,
        docId,
        claimType: over.claimType ?? "commitment-status",
        claimText: over.claimText ?? "the rehearsal room is booked",
        evidenceDocId: evidence,
        evidenceQuote: "the rehearsal room is booked for the 14th",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      over.createdAt ?? NOW - 5000,
    );
  }
  function seedPersonAnno(
    id: string,
    personId: string,
    evidence: string,
    over: { claimType?: string; claimText?: string } = {},
  ): void {
    createPersonAnnotation(
      db,
      {
        id,
        personId,
        claimType: over.claimType ?? "role",
        claimText: over.claimText ?? "runs the vendor reviews",
        evidenceDocId: evidence,
        evidenceQuote: "now coordinates the vendor reviews",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      NOW - 5000,
    );
  }

  test("both supersede tools are gated on annotations and declared mutating", () => {
    for (const name of ["annotation_supersede", "person_annotation_supersede"]) {
      expect(buildTools({ enabled: false }).some((t) => t.name === name)).toBe(false);
      const enabled = buildTools().find((t) => t.name === name);
      expect(enabled).toBeDefined();
      expect(enabled!.mutates).toBe(true);
      expect(COGNITION_MUTATING_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  test("annotation_supersede retires the outdated claim in favour of the kept one — no new row", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the rehearsal room is booked for the 14th");
    seedDocAnno("anno_outdated", subject, evidence, { claimText: "the booking is pending" });
    seedDocAnno("anno_kept", subject, evidence, { claimText: "the booking is confirmed" });
    const res = structured(
      await tool(buildTools(), "annotation_supersede").invoke(
        { id: "anno_outdated", supersededBy: "anno_kept" },
        CTX,
      ),
    );
    expect(res.resultType).toBe("annotation.superseded");
    expect(res.data).toEqual({ id: "anno_outdated", supersededBy: "anno_kept" });
    // The outdated row is dead and audit-linked; the kept row is the only live
    // belief; NO new row was minted.
    const old = getDocAnnotation(db, "anno_outdated")!;
    expect(old.invalidatedAt).not.toBeNull();
    expect(old.supersededBy).toBe("anno_kept");
    expect(listLiveAnnotationsForDoc(db, subject).map((r) => r.id)).toEqual(["anno_kept"]);
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM doc_annotations").get()!.n,
    ).toBe(2);
  });

  test("annotation_supersede refusals: self, unknown/dead target, unknown/dead successor, wrong subject", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const otherDoc = insertDoc(db, "d3", "another subject");
    const evidence = insertDoc(db, "d2", "the rehearsal room is booked for the 14th");
    seedDocAnno("anno_a", subject, evidence, { claimText: "pending" });
    seedDocAnno("anno_b", subject, evidence, { claimText: "confirmed" });
    seedDocAnno("anno_other", otherDoc, evidence, { claimText: "elsewhere" });
    seedDocAnno("anno_dead", subject, evidence, { claimText: "long gone" });
    supersedeDocAnnotation(db, "anno_dead", "anno_b", NOW - 1000);
    const t = tool(buildTools(), "annotation_supersede");

    const expectRefusal = async (args: unknown, code: string) => {
      const res = await t.invoke(args, CTX);
      expect(res.kind).toBe("error");
      if (res.kind === "error") expect(res.code).toBe(code);
    };
    await expectRefusal({ id: "anno_a", supersededBy: "anno_a" }, "invalid_supersede");
    await expectRefusal({ id: "anno_nope", supersededBy: "anno_b" }, "not_found");
    await expectRefusal({ id: "anno_dead", supersededBy: "anno_b" }, "invalid_supersede");
    await expectRefusal({ id: "anno_a", supersededBy: "anno_nope" }, "invalid_supersede");
    await expectRefusal({ id: "anno_a", supersededBy: "anno_dead" }, "invalid_supersede");
    await expectRefusal({ id: "anno_a", supersededBy: "anno_other" }, "invalid_supersede");
    // Nothing changed: both same-subject rows still live, untouched.
    expect(
      listLiveAnnotationsForDoc(db, subject)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["anno_a", "anno_b"]);
  });

  test("person_annotation_supersede works across the merge equivalence class, refuses across people", async () => {
    insertPerson("per_canon");
    insertPerson("per_loser", "per_canon");
    insertPerson("per_other");
    const evidence = insertDoc(db, "d2", "now coordinates the vendor reviews");
    seedPersonAnno("panno_old", "per_loser", evidence, { claimText: "runs the reviews" });
    seedPersonAnno("panno_kept", "per_canon", evidence, { claimText: "handed the reviews over" });
    seedPersonAnno("panno_other", "per_other", evidence, { claimText: "unrelated" });
    const t = tool(buildTools(), "person_annotation_supersede");

    // Different person → refused (canonical compare, not raw ids).
    const wrongPerson = await t.invoke({ id: "panno_old", supersededBy: "panno_other" }, CTX);
    expect(wrongPerson.kind).toBe("error");
    if (wrongPerson.kind === "error") expect(wrongPerson.code).toBe("invalid_supersede");

    // Merged-away target + canonical successor name the SAME person → allowed.
    const res = structured(await t.invoke({ id: "panno_old", supersededBy: "panno_kept" }, CTX));
    expect(res.resultType).toBe("person_annotation.superseded");
    expect(res.data).toEqual({ id: "panno_old", supersededBy: "panno_kept" });
    const old = getPersonAnnotation(db, "panno_old")!;
    expect(old.invalidatedAt).not.toBeNull();
    expect(old.supersededBy).toBe("panno_kept");
    expect(listLivePersonAnnotationsForPerson(db, "per_canon").map((r) => r.id)).toEqual([
      "panno_kept",
    ]);
  });

  test("annotate_durable reports supersedeLost (and no supersededId) when the retire half is lost", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the rehearsal room is booked for the 14th");
    seedDocAnno("anno_std", subject, evidence, { claimText: "the booking is pending" });
    // Simulate the race: a concurrent writer retires the target between the
    // tool's validation read and the serialized superseding create.
    const tools = buildTools({
      wrapGate: (gate) => ({
        ...gate,
        createDocAnnotationSuperseding: (input, supersedesId, now) => {
          supersedeDocAnnotation(db, supersedesId, "anno_concurrent", now);
          return gate.createDocAnnotationSuperseding(input, supersedesId, now);
        },
      }),
    });
    const res = structured(
      await tool(tools, "annotate_durable").invoke(
        {
          docId: subject,
          claimType: "commitment-status",
          claimText: "the booking fell through",
          evidenceDocId: evidence,
          evidenceQuote: "the rehearsal room is booked for the 14th",
          confidence: 0.7,
          claimBasis: "quoted",
          supersedes: "anno_std",
        },
        CTX,
      ),
    );
    expect(res.resultType).toBe("annotation.created");
    expect(res.data.supersedeLost).toBe(true);
    expect(res.data.supersededId).toBeUndefined();
    expect(typeof res.data.guidance).toBe("string");
    // The concurrent retirement stands — our create never re-pointed it.
    expect(getDocAnnotation(db, "anno_std")!.supersededBy).toBe("anno_concurrent");
  });

  test("annotate_person reports supersedeLost the same way", async () => {
    insertPerson("per_a");
    const evidence = insertDoc(db, "d2", "now coordinates the vendor reviews");
    seedPersonAnno("panno_std", "per_a", evidence);
    const tools = buildTools({
      wrapGate: (gate) => ({
        ...gate,
        createPersonAnnotationSuperseding: (input, supersedesId, now) => {
          supersedePersonAnnotation(db, supersedesId, "panno_concurrent", now);
          return gate.createPersonAnnotationSuperseding(input, supersedesId, now);
        },
      }),
    });
    const res = structured(
      await tool(tools, "annotate_person").invoke(
        {
          personId: "per_a",
          claimType: "role",
          claimText: "coordinates the vendor reviews",
          evidenceDocId: evidence,
          evidenceQuote: "now coordinates the vendor reviews",
          confidence: 0.7,
          claimBasis: "quoted",
          supersedes: "panno_std",
        },
        CTX,
      ),
    );
    expect(res.resultType).toBe("person_annotation.created");
    expect(res.data.supersedeLost).toBe(true);
    expect(res.data.supersededId).toBeUndefined();
    expect(typeof res.data.guidance).toBe("string");
  });

  test("annotation_supersede surfaces a mid-flight loss as a supersede_lost error", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the rehearsal room is booked for the 14th");
    seedDocAnno("anno_a", subject, evidence, { claimText: "pending" });
    seedDocAnno("anno_b", subject, evidence, { claimText: "confirmed" });
    const tools = buildTools({
      wrapGate: (gate) => ({
        ...gate,
        supersedeDocAnnotationBy: (id, supersededById, now) => {
          supersedeDocAnnotation(db, id, "anno_concurrent", now);
          return gate.supersedeDocAnnotationBy(id, supersededById, now);
        },
      }),
    });
    const res = await tool(tools, "annotation_supersede").invoke(
      { id: "anno_a", supersededBy: "anno_b" },
      CTX,
    );
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.code).toBe("supersede_lost");
    // The concurrent retirement stands.
    expect(getDocAnnotation(db, "anno_a")!.supersededBy).toBe("anno_concurrent");
  });

  test("annotation_revise refuses a claimType change into an occupied slot; a clean change passes", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the rehearsal room is booked for the 14th");
    seedDocAnno("anno_status", subject, evidence, { claimType: "commitment-status" });
    seedDocAnno("anno_topic", subject, evidence, {
      claimType: "topic",
      claimText: "about the rehearsal",
    });
    const t = tool(buildTools(), "annotation_revise");

    // Revising into the occupied claimType — case-insensitively — is refused
    // with the standing candidate; the row is untouched.
    const conflicted = structured(
      await t.invoke({ id: "anno_topic", claimType: "Commitment-Status" }, CTX),
    );
    expect(conflicted.resultType).toBe("annotation.conflict_candidates");
    expect((conflicted.data.candidates as Array<{ id: string }>).map((c) => c.id)).toEqual([
      "anno_status",
    ]);
    expect(typeof conflicted.data.guidance).toBe("string");
    expect(getDocAnnotation(db, "anno_topic")!.claimType).toBe("topic");

    // A probe-clean refinement passes and persists normalized.
    const revised = structured(
      await t.invoke({ id: "anno_topic", claimType: " Booking-Status " }, CTX),
    );
    expect(revised.resultType).toBe("annotation.revised");
    expect(getDocAnnotation(db, "anno_topic")!.claimType).toBe("booking-status");
  });

  test("person_annotation_revise runs the same claimType-change probe over the merge class", async () => {
    insertPerson("per_canon");
    insertPerson("per_loser", "per_canon");
    const evidence = insertDoc(db, "d2", "now coordinates the vendor reviews");
    // The standing occupant of the target claimType sits on a merged-away id.
    seedPersonAnno("panno_role", "per_loser", evidence, { claimType: "role" });
    seedPersonAnno("panno_aff", "per_canon", evidence, {
      claimType: "affiliation",
      claimText: "sits on the vendor board",
    });
    const t = tool(buildTools(), "person_annotation_revise");

    const conflicted = structured(await t.invoke({ id: "panno_aff", claimType: "Role" }, CTX));
    expect(conflicted.resultType).toBe("person_annotation.conflict_candidates");
    expect((conflicted.data.candidates as Array<{ id: string }>).map((c) => c.id)).toEqual([
      "panno_role",
    ]);
    expect(getPersonAnnotation(db, "panno_aff")!.claimType).toBe("affiliation");

    const revised = structured(await t.invoke({ id: "panno_aff", claimType: "preference" }, CTX));
    expect(revised.resultType).toBe("person_annotation.revised");
    expect(getPersonAnnotation(db, "panno_aff")!.claimType).toBe("preference");
  });

  test("the create probe matches case-insensitively, persists normalized, and is unbounded by recency", async () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evidence = insertDoc(db, "d2", "the rehearsal room is booked for the 14th");
    // A standing belief with legacy casing, OLDER than 100+ newer live rows on
    // the same subject — a newest-N client-side probe would never see it.
    seedDocAnno("anno_legacy", subject, evidence, {
      claimType: "Topic",
      claimText: "about the rehearsal",
      createdAt: NOW - 100_000,
    });
    for (let i = 0; i < 105; i++) {
      seedDocAnno(`anno_fill_${i}`, subject, evidence, {
        claimType: `filler-${i}`,
        claimText: `filler claim ${i}`,
        createdAt: NOW - 50_000 + i,
      });
    }
    const t = tool(buildTools(), "annotate_durable");
    const conflicted = structured(
      await t.invoke(
        {
          docId: subject,
          claimType: " topic ",
          claimText: "about the studio",
          evidenceDocId: evidence,
          evidenceQuote: "the rehearsal room is booked for the 14th",
          confidence: 0.7,
          claimBasis: "quoted",
        },
        CTX,
      ),
    );
    expect(conflicted.resultType).toBe("annotation.conflict_candidates");
    expect((conflicted.data.candidates as Array<{ id: string }>).map((c) => c.id)).toEqual([
      "anno_legacy",
    ]);

    // A fresh claimType persists trimmed + lowercased.
    const created = structured(
      await t.invoke(
        {
          docId: subject,
          claimType: " Key-Date ",
          claimText: "the rehearsal is on the 14th",
          evidenceDocId: evidence,
          evidenceQuote: "the rehearsal room is booked for the 14th",
          confidence: 0.7,
          claimBasis: "quoted",
        },
        CTX,
      ),
    );
    expect(created.resultType).toBe("annotation.created");
    expect(created.data.claimType).toBe("key-date");
    expect(getDocAnnotation(db, created.data.id as string)!.claimType).toBe("key-date");
  });
});

// ── multi-evidence grounding (evidence child rows + the scalar mirror) ──────

describe("multi-evidence grounding", () => {
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

  function childRows(id: string): Array<Record<string, unknown>> {
    return db
      .prepare<
        [string],
        Record<string, unknown>
      >("SELECT position, evidence_doc_id, evidence_quote, broken_at FROM doc_annotation_evidence WHERE annotation_id = ? ORDER BY position")
      .all(id);
  }

  function seedMultiEvidence(): { subject: string; evA: string; evB: string } {
    const subject = insertDoc(db, "d1", "subject body");
    const evA = insertDoc(db, "d2", "the studio invoice totals 480");
    const evB = insertDoc(db, "d3", "the rehearsal room invoice totals 480 as well");
    createDocAnnotation(
      db,
      {
        id: "anno_m1",
        docId: subject,
        claimType: "pattern",
        claimText: "both venue invoices total 480",
        evidenceDocId: evA,
        evidenceQuote: "the studio invoice totals 480",
        confidence: 0.5,
        claimBasis: "synthesized",
        createdByRun: "run_m",
        additionalEvidence: [{ docId: evB, quote: "the rehearsal room invoice totals 480" }],
      },
      NOW,
    );
    return { subject, evA, evB };
  }

  test("create writes the child rows with the scalar pair as evidence[0]", () => {
    const { evA, evB } = seedMultiEvidence();
    const rows = listDocAnnotationEvidence(db, "anno_m1");
    expect(rows.map((r) => [r.position, r.evidenceDocId])).toEqual([
      [0, evA],
      [1, evB],
    ]);
    // The scalar mirror equals evidence[0].
    const parent = annotationRow(db, "anno_m1")!;
    expect(parent.evidence_doc_id).toBe(evA);
    expect(parent.evidence_quote).toBe("the studio invoice totals 480");
  });

  test("a scalar-only create still gets its single evidence[0] child row", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const ev = insertDoc(db, "d2", "evidence text here");
    createDocAnnotation(
      db,
      {
        id: "anno_s1",
        docId: subject,
        claimType: "topic",
        claimText: "about evidence",
        evidenceDocId: ev,
        evidenceQuote: "evidence text here",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_m",
      },
      NOW,
    );
    expect(childRows("anno_s1")).toEqual([
      { position: 0, evidence_doc_id: ev, evidence_quote: "evidence text here", broken_at: null },
    ]);
  });

  test("an evidence replace patch atomically rewrites the set and mirrors evidence[0]", () => {
    const { evA, evB } = seedMultiEvidence();
    const revised = updateDocAnnotation(
      db,
      "anno_m1",
      { evidence: [{ docId: evB, quote: "invoice totals 480 as well" }] },
      NOW + 500,
    );
    expect(revised).not.toBeNull();
    expect(revised!.evidenceDocId).toBe(evB);
    expect(revised!.evidenceQuote).toBe("invoice totals 480 as well");
    expect(listDocAnnotationEvidence(db, "anno_m1").map((r) => r.evidenceDocId)).toEqual([evB]);
    // No trace of the dropped atom remains.
    expect(childRows("anno_m1")).toHaveLength(1);
    // An empty replacement is a contract violation.
    expect(() => updateDocAnnotation(db, "anno_m1", { evidence: [] }, NOW + 600)).toThrow(
      />= 1 atom/,
    );
    void evA;
  });

  test("partial evidence break promotes the next surviving atom into the mirror, unverified + stamp cleared", () => {
    const { subject, evA, evB } = seedMultiEvidence();
    db.prepare(
      "UPDATE doc_annotations SET verification_state = 'verified', last_verified_at = ? WHERE id = 'anno_m1'",
    ).run(NOW);
    // evA's content shifts away from its quote; evB's atom survives.
    insertDoc(db, "d2", "entirely rewritten invoice message");
    const r = invalidateAnnotationsForDoc(db, evA, NOW + 1000);
    expect(r).toEqual({ invalidated: 0, flaggedUnverified: 1, promoted: 1 });
    const parent = annotationRow(db, "anno_m1")!;
    expect(parent.invalidated_at).toBeNull();
    expect(parent.evidence_doc_id).toBe(evB);
    expect(parent.evidence_quote).toBe("the rehearsal room invoice totals 480");
    expect(parent.verification_state).toBe("unverified");
    expect(parent.last_verified_at).toBeNull();
    // The broken atom is stamped, the survivor leads the live evidence list.
    expect(childRows("anno_m1").map((c) => [c.position, c.broken_at])).toEqual([
      [0, NOW + 1000],
      [1, null],
    ]);
    expect(listDocAnnotationEvidence(db, "anno_m1").map((r) => r.evidenceDocId)).toEqual([evB]);
    // Still servable — the mirror atom's document exists (first-alive rule).
    expect(listLiveAnnotationsForDoc(db, subject).map((a) => a.id)).toEqual(["anno_m1"]);
  });

  test("the annotation dies only when NO live evidence atoms remain", () => {
    const { subject, evA, evB } = seedMultiEvidence();
    insertDoc(db, "d2", "entirely rewritten invoice message");
    invalidateAnnotationsForDoc(db, evA, NOW + 1000);
    insertDoc(db, "d3", "rehearsal cancelled, no invoice this month");
    const r = invalidateAnnotationsForDoc(db, evB, NOW + 2000);
    expect(r).toEqual({ invalidated: 1, flaggedUnverified: 0, promoted: 0 });
    expect(annotationRow(db, "anno_m1")!.invalidated_at).toBe(NOW + 2000);
    expect(listLiveAnnotationsForDoc(db, subject)).toHaveLength(0);
  });

  test("a vanished evidence doc breaks only its atoms; the annotation survives on the rest", () => {
    const { evA, evB } = seedMultiEvidence();
    db.prepare("DELETE FROM documents WHERE id = ?").run(evA);
    const r = invalidateAnnotationsForDoc(db, evA, NOW + 1000);
    expect(r).toEqual({ invalidated: 0, flaggedUnverified: 1, promoted: 1 });
    expect(annotationRow(db, "anno_m1")!.evidence_doc_id).toBe(evB);
  });

  test("promotion skips an atom whose evidence document silently vanished; the mirror lands on the first servable atom", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evA = insertDoc(db, "d2", "the studio invoice totals 480");
    const evB = insertDoc(db, "d3", "the rehearsal room invoice totals 480 as well");
    const evC = insertDoc(db, "d4", "the mixing suite invoice also totals 480");
    createDocAnnotation(
      db,
      {
        id: "anno_m2",
        docId: subject,
        claimType: "pattern",
        claimText: "all three venue invoices total 480",
        evidenceDocId: evA,
        evidenceQuote: "the studio invoice totals 480",
        confidence: 0.5,
        claimBasis: "synthesized",
        createdByRun: "run_m",
        additionalEvidence: [
          { docId: evB, quote: "the rehearsal room invoice totals 480" },
          { docId: evC, quote: "the mixing suite invoice also totals 480" },
        ],
      },
      NOW,
    );
    // evB's document vanishes via a path no invalidation event saw; then
    // evA's content shifts away from its quote, triggering the pass.
    db.prepare("DELETE FROM documents WHERE id = ?").run(evB);
    insertDoc(db, "d2", "entirely rewritten invoice message");
    const r = invalidateAnnotationsForDoc(db, evA, NOW + 1000);
    expect(r).toEqual({ invalidated: 0, flaggedUnverified: 1, promoted: 1 });
    // The mirror lands on evC — the first surviving atom whose quote holds
    // AND whose document still exists — never on the dead-doc evB atom
    // (which would leave the row live yet unservable by every serving read).
    const parent = annotationRow(db, "anno_m2")!;
    expect(parent.invalidated_at).toBeNull();
    expect(parent.evidence_doc_id).toBe(evC);
    expect(childRows("anno_m2").map((c) => [c.position, c.broken_at !== null])).toEqual([
      [0, true],
      [1, true],
      [2, false],
    ]);
    expect(listLiveAnnotationsForDoc(db, subject).map((a) => a.id)).toEqual(["anno_m2"]);
  });

  test("with only broken and dead-doc atoms remaining, the annotation soft-invalidates", () => {
    const subject = insertDoc(db, "d1", "subject body");
    const evA = insertDoc(db, "d2", "the studio invoice totals 480");
    const evB = insertDoc(db, "d3", "the rehearsal room invoice totals 480 as well");
    createDocAnnotation(
      db,
      {
        id: "anno_m3",
        docId: subject,
        claimType: "pattern",
        claimText: "both venue invoices total 480",
        evidenceDocId: evA,
        evidenceQuote: "the studio invoice totals 480",
        confidence: 0.5,
        claimBasis: "synthesized",
        createdByRun: "run_m",
        additionalEvidence: [{ docId: evB, quote: "the rehearsal room invoice totals 480" }],
      },
      NOW,
    );
    db.prepare("DELETE FROM documents WHERE id = ?").run(evB);
    insertDoc(db, "d2", "entirely rewritten invoice message");
    const r = invalidateAnnotationsForDoc(db, evA, NOW + 1000);
    expect(r).toEqual({ invalidated: 1, flaggedUnverified: 0, promoted: 0 });
    expect(annotationRow(db, "anno_m3")!.invalidated_at).toBe(NOW + 1000);
    expect(listLiveAnnotationsForDoc(db, subject)).toHaveLength(0);
  });

  test("hasLiveAnnotationsForDoc sees a document cited only by a secondary atom", () => {
    const { evB } = seedMultiEvidence();
    expect(hasLiveAnnotationsForDoc(db, evB)).toBe(true);
    // A change to evB's content around the quote triggers the surgical pass.
    insertDoc(db, "d3", "note first: the rehearsal room invoice totals 480 as well");
    const r = invalidateAnnotationsForDoc(db, evB, NOW + 1000);
    expect(r).toEqual({ invalidated: 0, flaggedUnverified: 1, promoted: 0 });
  });

  test("the privacy cascade purges an annotation grounded via a secondary atom, children included", () => {
    const { evB } = seedMultiEvidence();
    const purged = cascadeAnnotationPrivacyDelete(db, [evB]);
    expect(purged).toEqual(["anno_m1"]);
    expect(annotationRow(db, "anno_m1")).toBeUndefined();
    expect(childRows("anno_m1")).toHaveLength(0);
  });

  test("person store: create children, promote-on-break, evidence replace, retract cleanup", () => {
    const evA = insertDoc(db, "d2", "handles the quarterly budget review");
    const evB = insertDoc(db, "d3", "she prepared the quarterly budget deck again");
    createPersonAnnotation(
      db,
      {
        id: "panno_m1",
        personId: "per_1",
        claimType: "role",
        claimText: "owns the quarterly budget process",
        evidenceDocId: evA,
        evidenceQuote: "handles the quarterly budget review",
        confidence: 0.5,
        claimBasis: "synthesized",
        createdByRun: "run_m",
        additionalEvidence: [{ docId: evB, quote: "prepared the quarterly budget deck" }],
      },
      NOW,
    );
    expect(listPersonAnnotationEvidence(db, "panno_m1").map((r) => r.evidenceDocId)).toEqual([
      evA,
      evB,
    ]);
    // Partial break → the surviving atom is promoted into the mirror.
    insertDoc(db, "d2", "left the finance rotation");
    const r = invalidatePersonAnnotationsForDoc(db, evA, NOW + 1000);
    expect(r).toEqual({ invalidated: 0, flaggedUnverified: 1, promoted: 1 });
    const row = db.prepare<[], Record<string, unknown>>("SELECT * FROM person_annotations").get()!;
    expect(row.evidence_doc_id).toBe(evB);
    expect(row.verification_state).toBe("unverified");
    // Whole-set evidence replace mirrors the new evidence[0].
    expect(
      revisePersonAnnotation(
        db,
        "panno_m1",
        { evidence: [{ docId: evB, quote: "quarterly budget deck again" }] },
        NOW + 2000,
      ),
    ).toBe(true);
    expect(
      db.prepare<[], { q: string }>("SELECT evidence_quote AS q FROM person_annotations").get()!.q,
    ).toBe("quarterly budget deck again");
    // Retract removes the child rows with the parent.
    expect(deletePersonAnnotation(db, "panno_m1")).toBe(true);
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM person_annotation_evidence").get()!
        .n,
    ).toBe(0);
  });

  test("person store: promotion skips a dead-doc atom; the mirror lands on the first servable atom", () => {
    const evA = insertDoc(db, "d2", "handles the quarterly budget review");
    const evB = insertDoc(db, "d3", "she prepared the quarterly budget deck again");
    const evC = insertDoc(db, "d4", "owns the budget calendar for the quarter");
    createPersonAnnotation(
      db,
      {
        id: "panno_m2",
        personId: "per_1",
        claimType: "role",
        claimText: "owns the quarterly budget process",
        evidenceDocId: evA,
        evidenceQuote: "handles the quarterly budget review",
        confidence: 0.5,
        claimBasis: "synthesized",
        createdByRun: "run_m",
        additionalEvidence: [
          { docId: evB, quote: "prepared the quarterly budget deck" },
          { docId: evC, quote: "owns the budget calendar" },
        ],
      },
      NOW,
    );
    // evB's document vanishes via a path no invalidation event saw; then
    // evA's content shifts away from its quote.
    db.prepare("DELETE FROM documents WHERE id = ?").run(evB);
    insertDoc(db, "d2", "left the finance rotation");
    const r = invalidatePersonAnnotationsForDoc(db, evA, NOW + 1000);
    expect(r).toEqual({ invalidated: 0, flaggedUnverified: 1, promoted: 1 });
    const row = db
      .prepare<
        [],
        Record<string, unknown>
      >("SELECT * FROM person_annotations WHERE id = 'panno_m2'")
      .get()!;
    expect(row.invalidated_at).toBeNull();
    expect(row.evidence_doc_id).toBe(evC);
    expect(listPersonAnnotationEvidence(db, "panno_m2").map((e) => e.evidenceDocId)).toEqual([evC]);
  });

  test("person store: with only broken and dead-doc atoms remaining, the annotation soft-invalidates", () => {
    const evA = insertDoc(db, "d2", "handles the quarterly budget review");
    const evB = insertDoc(db, "d3", "she prepared the quarterly budget deck again");
    createPersonAnnotation(
      db,
      {
        id: "panno_m3",
        personId: "per_1",
        claimType: "role",
        claimText: "owns the quarterly budget process",
        evidenceDocId: evA,
        evidenceQuote: "handles the quarterly budget review",
        confidence: 0.5,
        claimBasis: "synthesized",
        createdByRun: "run_m",
        additionalEvidence: [{ docId: evB, quote: "prepared the quarterly budget deck" }],
      },
      NOW,
    );
    db.prepare("DELETE FROM documents WHERE id = ?").run(evB);
    insertDoc(db, "d2", "left the finance rotation");
    const r = invalidatePersonAnnotationsForDoc(db, evA, NOW + 1000);
    expect(r).toEqual({ invalidated: 1, flaggedUnverified: 0, promoted: 0 });
    expect(
      db
        .prepare<
          [],
          { t: number | null }
        >("SELECT invalidated_at AS t FROM person_annotations WHERE id = 'panno_m3'")
        .get()!.t,
    ).toBe(NOW + 1000);
  });
});
