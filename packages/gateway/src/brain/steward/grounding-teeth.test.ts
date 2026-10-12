// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Write-time grounding teeth for durable writes:
 *
 *  - `temporal_annotation_add` / `temporal_annotation_update` conditional
 *    evidence — a write declaring its grounding gets the quote + entailment
 *    teeth; a write without evidence is never gated.
 *  - document/person annotation evidence, including multi-evidence claims.
 *  - output writes (loops and observations) declare the annotation priors
 *    they rest on, and record consumption edges only for those.
 *
 * Fixture data is invented — no corpus content.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "@omnesis/core";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { withPersonProfileRead } from "../person-profile-test-tools.js";
import { createDatabase, upsertDocuments } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import {
  getTemporalAnnotationById,
  listTemporalAnnotationEvidence,
} from "../../enrichment/temporal-annotations/storage.js";
import { createDocAnnotation } from "../storage/annotations.js";
import { annotationEvidenceFrame } from "../annotation-verification.js";
import { contextualEvidence } from "./annotation-gate-evidence.js";
import { RunConsumptionTracker } from "./consumption.js";
import { createOpenLoopMirror } from "./mirror.js";
import { buildCognitionOwnTools, type CognitionToolDeps } from "./tools.js";
import type Database from "better-sqlite3";
import type { EntailCapability, ToolResult } from "@omnesis/core";
import type { SearchPort, ToolHandle } from "@omnesis/agent";

type Db = Database.Database;

const log = createLogger("test").child("grounding-teeth");
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

function structured(result: ToolResult): { resultType: string; data: Record<string, unknown> } {
  if (result.kind !== "structured") {
    throw new Error(`expected a structured result, got ${JSON.stringify(result)}`);
  }
  return { resultType: result.resultType, data: result.data as Record<string, unknown> };
}

function errorResult(result: ToolResult): { code: string; message: string } {
  if (result.kind !== "error") {
    throw new Error(`expected an error result, got ${JSON.stringify(result)}`);
  }
  return { code: result.code, message: result.message };
}

describe("grounding teeth (output dependencies + temporal annotation evidence)", () => {
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

  function buildTools(overrides: Partial<CognitionToolDeps> = {}): ToolHandle[] {
    const writeGate = directWriteGate(db);
    return buildCognitionOwnTools({
      db,
      writeGate,
      searchPort: emptySearchPort,
      mirror: createOpenLoopMirror({ db, writeGate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => NOW,
      runId: "run_teeth_1",
      idGen: () => `id${++seq}`,
      log,
      ...overrides,
    });
  }
  function tool(tools: ToolHandle[], name: string): ToolHandle {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return withPersonProfileRead(db, tools, t);
  }

  test.each(["value", "resolver", "verifier"] as const)(
    "document annotation cancellation during %s cannot write or start the next paid stage",
    async (stage) => {
      const doc = insertDoc(db, "cancel-observation", "The workshop installed a new kiln.");
      const controller = new AbortController();
      let resolved = 0;
      let verified = 0;
      const tools = buildTools({
        annotationsEnabled: true,
        checkRecord: async () => {
          if (stage === "value") controller.abort(new Error("cancelled fixture"));
          return { save: true };
        },
        getEntailmentVerifier: async (signal) => {
          expect(signal).toBeInstanceOf(AbortSignal);
          resolved++;
          if (stage === "resolver") {
            controller.abort(new Error("cancelled fixture"));
            expect(signal?.aborted).toBe(true);
          }
          return {
            verify: async (input) => {
              verified++;
              expect(input.signal).toBeDefined();
              controller.abort(new Error("cancelled fixture"));
              return { label: "entailment" as const };
            },
            dispose() {
              throw new Error("shared verifier must not be disposed");
            },
          };
        },
      });
      await expect(
        tool(tools, "annotate_durable").invoke(
          {
            docId: doc,
            claimType: "equipment",
            claimText: "The workshop installed a new kiln.",
            evidenceDocId: doc,
            evidenceQuote: "The workshop installed a new kiln.",
            confidence: 0.8,
            claimBasis: "quoted",
          },
          { ...CTX, abortSignal: controller.signal },
        ),
      ).rejects.toThrow("cancelled fixture");
      expect(resolved).toBe(stage === "value" ? 0 : 1);
      expect(verified).toBe(stage === "verifier" ? 1 : 0);
      expect(db.prepare("SELECT id FROM doc_annotations").all()).toEqual([]);
    },
  );

  test.each(["changed", "deleted"] as const)(
    "source %s during value admission never reaches the verifier",
    async (change) => {
      const doc = insertDoc(db, "changing-source", "The workshop installed a new kiln.");
      let resolutions = 0;
      const tools = buildTools({
        annotationsEnabled: true,
        checkRecord: async () => {
          if (change === "deleted") db.prepare("DELETE FROM documents WHERE id=?").run(doc);
          else
            db.prepare(
              "UPDATE documents SET content='Different evidence', content_hash='new-version' WHERE id=?",
            ).run(doc);
          return { save: true };
        },
        getEntailmentVerifier: async () => {
          resolutions++;
          return fakeVerifier("entailment");
        },
      });
      const result = await tool(tools, "annotate_durable").invoke(
        {
          docId: doc,
          claimType: "equipment",
          claimText: "The workshop installed a new kiln.",
          evidenceDocId: doc,
          evidenceQuote: "The workshop installed a new kiln.",
          confidence: 0.8,
          claimBasis: "quoted",
        },
        CTX,
      );
      expect(result).toMatchObject({ kind: "error", code: "revision_conflict" });
      expect(resolutions).toBe(0);
      expect(db.prepare("SELECT id FROM doc_annotations").all()).toEqual([]);
    },
  );

  test("an output write must make an explicit annotation-dependency judgment", async () => {
    const ev = insertDoc(db, "venue-update", "The venue confirmed the booking for Saturday.");
    const res = await tool(buildTools(), "observation_note").invoke(
      { summary: "Venue booking confirmed", citations: [ev] },
      CTX,
    );
    expect(errorResult(res)).toMatchObject({ code: "invalid_args" });
    expect(errorResult(res).message).toContain("annotationDependencies");
  });

  // ── temporal-annotation conditional teeth ────────────────────────────────

  const TIX_QUOTE = "your passport expires on 23 February 2027";
  function tixArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      when: "2027-02-23",
      sentence: "passport expires",
      kind: "expiry",
      ...over,
    };
  }

  test("temporal value refusal precedes verifier resolution and leaves no entry", async () => {
    const ev = insertDoc(db, "temporal-value", TIX_QUOTE);
    let values = 0,
      resolutions = 0;
    const tools = buildTools({
      checkRecord: async () => {
        values++;
        return { save: false, decisionId: "decision", score: 0.1, threshold: 0.5 };
      },
      getEntailmentVerifier: async () => {
        resolutions++;
        return fakeVerifier("entailment");
      },
    });
    const result = await tool(tools, "temporal_annotation_add").invoke(
      tixArgs({ evidence: { docId: ev, quote: TIX_QUOTE } }),
      CTX,
    );
    expect(structured(result).resultType).toBe("record.not_saved");
    expect(values).toBe(1);
    expect(resolutions).toBe(0);
    expect(db.prepare("SELECT id FROM temporal_annotations").all()).toEqual([]);
  });

  test("invalid temporal evidence spends neither value nor entailment checks", async () => {
    const ev = insertDoc(db, "temporal-invalid", TIX_QUOTE);
    let values = 0,
      resolutions = 0;
    const tools = buildTools({
      checkRecord: async () => {
        values++;
        return { save: true };
      },
      getEntailmentVerifier: async () => {
        resolutions++;
        return fakeVerifier("entailment");
      },
    });
    const result = await tool(tools, "temporal_annotation_add").invoke(
      tixArgs({ evidence: { docId: ev, quote: "Invented unrelated passage" } }),
      CTX,
    );
    expect(errorResult(result).code).toBe("evidence_not_found");
    expect(values).toBe(0);
    expect(resolutions).toBe(0);
  });

  test.each(["initial", "value", "resolver", "verifier"] as const)(
    "temporal cancellation during %s prevents the next paid stage and write",
    async (stage) => {
      const ev = insertDoc(db, "temporal-cancel", TIX_QUOTE);
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error("cancelled temporal fixture"));
      if (stage === "initial") cancel();
      let values = 0,
        resolutions = 0,
        verifications = 0;
      const tools = buildTools({
        checkRecord: async () => {
          values++;
          if (stage === "value") cancel();
          return { save: true };
        },
        getEntailmentVerifier: async () => {
          resolutions++;
          if (stage === "resolver") cancel();
          return {
            verify: async (input) => {
              verifications++;
              expect(input.signal).toBeDefined();
              cancel();
              return { label: "entailment" as const };
            },
            dispose() {
              throw new Error("shared verifier disposed");
            },
          };
        },
      });
      await expect(
        tool(tools, "temporal_annotation_add").invoke(
          tixArgs({ evidence: { docId: ev, quote: TIX_QUOTE } }),
          { ...CTX, abortSignal: controller.signal },
        ),
      ).rejects.toThrow("cancelled temporal fixture");
      expect(values).toBe(stage === "initial" ? 0 : 1);
      expect(resolutions).toBe(stage === "resolver" || stage === "verifier" ? 1 : 0);
      expect(verifications).toBe(stage === "verifier" ? 1 : 0);
      expect(db.prepare("SELECT id FROM temporal_annotations").all()).toEqual([]);
    },
  );

  test.each(["changed", "deleted", "hidden"] as const)(
    "temporal source %s during value assessment never reaches entailment",
    async (change) => {
      const ev = insertDoc(db, "temporal-source-race", TIX_QUOTE);
      let resolutions = 0;
      const tools = buildTools({
        checkRecord: async () => {
          if (change === "deleted") db.prepare("DELETE FROM documents WHERE id=?").run(ev);
          else if (change === "hidden")
            db.prepare("INSERT INTO removed_sources(id,removed_at) VALUES ('gmail-test',?)").run(
              NOW,
            );
          else db.prepare("UPDATE documents SET content_hash='changed' WHERE id=?").run(ev);
          return { save: true };
        },
        getEntailmentVerifier: async () => {
          resolutions++;
          return fakeVerifier("entailment");
        },
      });
      const result = await tool(tools, "temporal_annotation_add").invoke(
        tixArgs({ evidence: { docId: ev, quote: TIX_QUOTE } }),
        CTX,
      );
      expect(errorResult(result).code).toBe("revision_conflict");
      expect(resolutions).toBe(0);
      expect(db.prepare("SELECT id FROM temporal_annotations").all()).toEqual([]);
    },
  );

  test("temporal source revision changes during verification leave no entry", async () => {
    const ev = insertDoc(db, "temporal-verification-race", TIX_QUOTE);
    const tools = buildTools({
      getEntailmentVerifier: async () => ({
        verify: async () => {
          db.prepare(
            "UPDATE documents SET content_hash='changed-during-verification' WHERE id=?",
          ).run(ev);
          return { label: "entailment" as const };
        },
        dispose() {},
      }),
    });
    const result = await tool(tools, "temporal_annotation_add").invoke(
      tixArgs({ evidence: { docId: ev, quote: TIX_QUOTE } }),
      CTX,
    );
    expect(errorResult(result).code).toBe("revision_conflict");
    expect(db.prepare("SELECT id FROM temporal_annotations").all()).toEqual([]);
  });

  test("cancelling temporal re-grounding preserves the standing entry", async () => {
    const ev = insertDoc(db, "temporal-update-cancel", TIX_QUOTE);
    const added = structured(
      await tool(buildTools(), "temporal_annotation_add").invoke(tixArgs(), CTX),
    );
    const controller = new AbortController();
    const tools = buildTools({
      getEntailmentVerifier: async () => ({
        verify: async () => {
          controller.abort(new Error("cancelled update"));
          return { label: "entailment" as const };
        },
        dispose() {},
      }),
    });
    await expect(
      tool(tools, "temporal_annotation_update").invoke(
        {
          annotationId: added.data.id,
          sentence: "Changed sentence",
          evidence: { docId: ev, quote: TIX_QUOTE },
        },
        { ...CTX, abortSignal: controller.signal },
      ),
    ).rejects.toThrow("cancelled update");
    expect(getTemporalAnnotationById(db, added.data.id as string)?.sentence).toBe(
      "passport expires",
    );
  });

  test("a temporal-annotation add without evidence stays legal and skips verification", async () => {
    const verifier = fakeVerifier("neutral"); // would refuse if consulted
    const res = await tool(
      buildTools({ getEntailmentVerifier: async () => verifier }),
      "temporal_annotation_add",
    ).invoke(tixArgs(), CTX);
    expect(structured(res).resultType).toBe("temporal_annotation.added");
    expect(verifier.calls).toEqual([]);
  });

  test("with evidence: the pass creates the entry and links the evidence doc as a source", async () => {
    const ev = insertDoc(db, "tix-ev", `Renewal notice: ${TIX_QUOTE}. Renew online.`);
    const verifier = fakeVerifier("entailment");
    const res = await tool(
      buildTools({ getEntailmentVerifier: async () => verifier }),
      "temporal_annotation_add",
    ).invoke(tixArgs({ evidence: { docId: ev, quote: TIX_QUOTE } }), CTX);
    const { data } = structured(res);
    expect(data.documentIds).toEqual([ev]);
    const entry = getTemporalAnnotationById(db, data.id as string);
    expect(entry?.documentIds).toEqual([ev]);
    // The quote is persisted as the entry's grounding atom — surgical
    // invalidation checks against it when the source document churns.
    expect(listTemporalAnnotationEvidence(db, data.id as string)).toEqual([
      {
        annotationId: data.id,
        position: 0,
        documentId: ev,
        quote: TIX_QUOTE,
        brokenAt: null,
      },
    ]);
    // The gate judged the quote against the entry's sentence.
    expect(verifier.calls).toEqual([
      { claim: "passport expires", evidence: TIX_QUOTE, signal: expect.any(AbortSignal) },
    ]);
  });

  test("update with evidence replaces the grounding atoms and unions the doc link", async () => {
    const evA = insertDoc(db, "tix-ev-a", `Original notice: ${TIX_QUOTE}.`);
    const evB = insertDoc(db, "tix-ev-b", `Corrected notice: ${TIX_QUOTE} after the extension.`);
    const tools = buildTools();
    const added = structured(
      await tool(tools, "temporal_annotation_add").invoke(
        tixArgs({ evidence: { docId: evA, quote: TIX_QUOTE } }),
        CTX,
      ),
    );
    const id = added.data.id as string;

    // An evidence-only update is a real mutation (re-grounding) — no other
    // field is required alongside it.
    const res = await tool(tools, "temporal_annotation_update").invoke(
      { annotationId: id, evidence: { docId: evB, quote: TIX_QUOTE } },
      CTX,
    );
    expect(structured(res).resultType).toBe("temporal_annotation.updated");
    // The atom set is REPLACED by the new grounding…
    expect(listTemporalAnnotationEvidence(db, id)).toEqual([
      { annotationId: id, position: 0, documentId: evB, quote: TIX_QUOTE, brokenAt: null },
    ]);
    // …while the doc links are UNIONED — the standing source survives.
    expect(getTemporalAnnotationById(db, id)?.documentIds.sort()).toEqual([evA, evB].sort());
  });

  test("a curly-punctuation source quote passes the gate quoted with straight punctuation", async () => {
    // Regression: sources rendered with typographic punctuation (curly
    // apostrophes, em dashes) used to refuse true verbatim quotes retyped
    // with straight characters, teaching the model to omit evidence.
    const ev = insertDoc(
      db,
      "curly-ev",
      "Note from the desk — it’s official: your passport expires on 23 February 2027.",
    );
    const res = await tool(buildTools(), "temporal_annotation_add").invoke(
      tixArgs({ evidence: { docId: ev, quote: "it's official: your passport expires" } }),
      CTX,
    );
    expect(structured(res).resultType).toBe("temporal_annotation.added");
    expect(listTemporalAnnotationEvidence(db, structured(res).data.id as string)).toHaveLength(1);
  });

  test("with evidence: a quote not in the document refuses gate-free; nothing is written", async () => {
    const ev = insertDoc(db, "tix-ev", "Renewal notice: renew online before the deadline.");
    const verifier = fakeVerifier("entailment");
    const res = await tool(
      buildTools({ getEntailmentVerifier: async () => verifier }),
      "temporal_annotation_add",
    ).invoke(tixArgs({ evidence: { docId: ev, quote: TIX_QUOTE } }), CTX);
    expect(errorResult(res).code).toBe("evidence_not_found");
    expect(verifier.calls).toEqual([]);
    const n = db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM temporal_annotations")
      .get()?.n;
    expect(n).toBe(0);
  });

  test("with evidence: an entailment refusal blocks the add, re-askable", async () => {
    const ev = insertDoc(db, "tix-ev", `Renewal notice: ${TIX_QUOTE}.`);
    const res = await tool(
      buildTools({ getEntailmentVerifier: async () => fakeVerifier("contradiction") }),
      "temporal_annotation_add",
    ).invoke(
      tixArgs({ sentence: "driving licence expires", evidence: { docId: ev, quote: TIX_QUOTE } }),
      CTX,
    );
    const err = errorResult(res);
    expect(err.code).toBe("evidence_does_not_entail_claim");
    expect(err.message).toContain("contradiction");
  });

  test("temporal_annotation_update gates the annotation's effective sentence", async () => {
    const ev = insertDoc(db, "tix-ev", `Update: ${TIX_QUOTE} — moved from January.`);
    const verifier = fakeVerifier("entailment");
    const tools = buildTools({ getEntailmentVerifier: async () => verifier });
    const added = structured(await tool(tools, "temporal_annotation_add").invoke(tixArgs(), CTX));

    const res = await tool(tools, "temporal_annotation_update").invoke(
      {
        annotationId: added.data.id,
        when: "2027-02-23",
        evidence: { docId: ev, quote: TIX_QUOTE },
      },
      CTX,
    );
    expect(structured(res).resultType).toBe("temporal_annotation.updated");
    // No new sentence supplied → the standing one is what the gate judged.
    expect(verifier.calls).toEqual([
      { claim: "passport expires", evidence: TIX_QUOTE, signal: expect.any(AbortSignal) },
    ]);
  });

  test("temporal_annotation_update refuses an unknown id before verification", async () => {
    const ev = insertDoc(db, "tix-ev", `Renewal notice: ${TIX_QUOTE}.`);
    const verifier = fakeVerifier("entailment");
    // Evidence AND a new sentence: the supplied sentence must not skip the
    // existence read — a dead id refuses without burning a gate call.
    const res = await tool(
      buildTools({ getEntailmentVerifier: async () => verifier }),
      "temporal_annotation_update",
    ).invoke(
      {
        annotationId: "ta_missing",
        sentence: "passport expires",
        evidence: { docId: ev, quote: TIX_QUOTE },
      },
      CTX,
    );
    expect(errorResult(res).code).toBe("not_found");
    expect(verifier.calls).toEqual([]);
  });

  test("temporal_annotation_update without evidence never consults the verifier", async () => {
    const verifier = fakeVerifier("neutral");
    const tools = buildTools({ getEntailmentVerifier: async () => verifier });
    const added = structured(await tool(tools, "temporal_annotation_add").invoke(tixArgs(), CTX));
    const res = await tool(tools, "temporal_annotation_update").invoke(
      { annotationId: added.data.id, sentence: "passport expires (renew early)" },
      CTX,
    );
    expect(structured(res).resultType).toBe("temporal_annotation.updated");
    expect(verifier.calls).toEqual([]);
  });
});

// ── multi-evidence annotate teeth + consumption provenance ──────────────────

describe("multi-evidence annotate teeth + consumption provenance", () => {
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

  function buildTools(overrides: Partial<CognitionToolDeps> = {}): ToolHandle[] {
    const writeGate = directWriteGate(db);
    return buildCognitionOwnTools({
      db,
      writeGate,
      searchPort: emptySearchPort,
      mirror: createOpenLoopMirror({ db, writeGate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => NOW,
      runId: "run_multi_1",
      idGen: () => `id${++seq}`,
      annotationsEnabled: true,
      log,
      ...overrides,
    });
  }
  function tool(tools: ToolHandle[], name: string): ToolHandle {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return withPersonProfileRead(db, tools, t);
  }
  function insertPerson(id: string, name: string): void {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, ?, 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(id, name);
  }

  const Q1 = "the studio invoice totals four hundred and eighty";
  const Q2 = "the rehearsal room bill also comes to four hundred and eighty";

  function annotateArgs(subject: string, ev1: string, over: Record<string, unknown> = {}) {
    return {
      docId: subject,
      claimType: "pattern",
      claimText: "both venue bills land at the same amount",
      evidenceDocId: ev1,
      evidenceQuote: Q1,
      confidence: 0.5,
      claimBasis: "synthesized",
      ...over,
    };
  }

  test("additionalEvidence writes the extra atoms and the gate judges the CONCATENATED quotes once", async () => {
    const subject = insertDoc(db, "d1", `Note — ${Q1}.`);
    const ev2 = insertDoc(db, "d2", `Heads up: ${Q2}.`);
    const verifier = fakeVerifier("entailment");
    const res = await tool(
      buildTools({ getEntailmentVerifier: () => Promise.resolve(verifier) }),
      "annotate_durable",
    ).invoke(
      annotateArgs(subject, subject, { additionalEvidence: [{ docId: ev2, quote: Q2 }] }),
      CTX,
    );
    const { resultType, data } = structured(res);
    expect(resultType).toBe("annotation.created");
    expect(data.evidenceCount).toBe(2);
    // ONE gate call, judging the claim against both quotes jointly.
    expect(verifier.calls).toHaveLength(1);
    expect(verifier.calls[0]).toHaveProperty("assessment", "annotation_atomic");
    expect(verifier.calls[0]!.evidence).toBe(
      annotationEvidenceFrame([
        { quote: Q1, source: `Note — ${Q1}.` },
        { quote: Q2, source: `Heads up: ${Q2}.` },
      ]),
    );
    const atoms = db
      .prepare<
        [],
        { position: number; evidence_doc_id: string }
      >("SELECT position, evidence_doc_id FROM doc_annotation_evidence ORDER BY position")
      .all();
    expect(atoms).toEqual([
      { position: 0, evidence_doc_id: subject },
      { position: 1, evidence_doc_id: ev2 },
    ]);
  });

  test("a scalar-only annotation preserves its surrounding source context", async () => {
    const subject = insertDoc(db, "d1", `Note — ${Q1}.`);
    const verifier = fakeVerifier("entailment");
    const res = await tool(
      buildTools({ getEntailmentVerifier: () => Promise.resolve(verifier) }),
      "annotate_durable",
    ).invoke(annotateArgs(subject, subject, { claimBasis: "quoted" }), CTX);
    expect(structured(res).data.evidenceCount).toBeUndefined();
    expect(verifier.calls).toHaveLength(1);
    expect(verifier.calls[0]).toHaveProperty("assessment", "annotation_atomic");
    expect(verifier.calls[0]!.evidence).toBe(
      annotationEvidenceFrame([{ quote: Q1, source: `Note — ${Q1}.` }]),
    );
  });

  test("a missing additional-evidence doc refuses naming the failing index, before any verifier call", async () => {
    const subject = insertDoc(db, "d1", `Note — ${Q1}.`);
    const verifier = fakeVerifier("entailment");
    const res = await tool(
      buildTools({ getEntailmentVerifier: () => Promise.resolve(verifier) }),
      "annotate_durable",
    ).invoke(
      annotateArgs(subject, subject, {
        additionalEvidence: [{ docId: "doc_missing", quote: Q2 }],
      }),
      CTX,
    );
    const err = errorResult(res);
    expect(err.code).toBe("not_found");
    expect(err.message).toContain("additionalEvidence[0]");
    expect(err.message).toContain("doc_missing");
    expect(verifier.calls).toHaveLength(0);
  });

  test("an additional quote absent from its document refuses naming the failing index", async () => {
    const subject = insertDoc(db, "d1", `Note — ${Q1}.`);
    const ev2 = insertDoc(db, "d2", `Heads up: ${Q2}.`);
    const ev3 = insertDoc(db, "d3", "unrelated content entirely");
    const verifier = fakeVerifier("entailment");
    const res = await tool(
      buildTools({ getEntailmentVerifier: () => Promise.resolve(verifier) }),
      "annotate_durable",
    ).invoke(
      annotateArgs(subject, subject, {
        additionalEvidence: [
          { docId: ev2, quote: Q2 },
          { docId: ev3, quote: "a quote that is nowhere in there" },
        ],
      }),
      CTX,
    );
    const err = errorResult(res);
    expect(err.code).toBe("evidence_not_found");
    expect(err.message).toContain("additionalEvidence[1]");
    expect(verifier.calls).toHaveLength(0);
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM doc_annotations").get()!.n,
    ).toBe(0);
  });

  test("annotate_person accepts additionalEvidence with the same teeth", async () => {
    insertPerson("per_1", "Maya Reeves");
    const ev1 = insertDoc(db, "d1", `Note — ${Q1}.`);
    const ev2 = insertDoc(db, "d2", `Heads up: ${Q2}.`);
    const verifier = fakeVerifier("entailment");
    const res = await tool(
      buildTools({ getEntailmentVerifier: () => Promise.resolve(verifier) }),
      "annotate_person",
    ).invoke(
      {
        personId: "per_1",
        claimType: "pattern",
        claimText: "books both venues at the same rate",
        evidenceDocId: ev1,
        evidenceQuote: Q1,
        confidence: 0.5,
        claimBasis: "synthesized",
        additionalEvidence: [{ docId: ev2, quote: Q2 }],
      },
      CTX,
    );
    expect(structured(res).data.evidenceCount).toBe(2);
    expect(verifier.calls).toHaveLength(1);
    expect(verifier.calls[0]).toHaveProperty("assessment", "annotation_atomic");
    expect(verifier.calls[0]!.evidence).toBe(
      annotationEvidenceFrame([
        { quote: Q1, source: `Note — ${Q1}.` },
        { quote: Q2, source: `Heads up: ${Q2}.` },
      ]),
    );
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM person_annotation_evidence").get()!
        .n,
    ).toBe(2);
  });

  test("a multi-atom claim re-affirms via a stamps-only revise gated on the JOINT evidence (doc store)", async () => {
    const subject = insertDoc(db, "d1", `Note — ${Q1}.`);
    const ev2 = insertDoc(db, "d2", `Heads up: ${Q2}.`);
    const joint = annotationEvidenceFrame([
      { quote: Q1, source: `Note — ${Q1}.` },
      { quote: Q2, source: `Heads up: ${Q2}.` },
    ]);
    // A verifier that entails ONLY on the concatenated atom set — a
    // synthesized claim whose atoms only jointly establish it. Gating the
    // revise on the scalar mirror alone would refuse forever (a livelock:
    // the row could never re-affirm, so the sweep re-enqueues it endlessly).
    const calls: Array<{ claim: string; evidence: string }> = [];
    const verifier: EntailCapability = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async verify(input) {
        calls.push(input);
        return { label: input.evidence === joint ? "entailment" : "neutral" };
      },
      dispose() {},
    };
    const created = structured(
      await tool(
        buildTools({ getEntailmentVerifier: () => Promise.resolve(verifier) }),
        "annotate_durable",
      ).invoke(
        annotateArgs(subject, subject, { additionalEvidence: [{ docId: ev2, quote: Q2 }] }),
        CTX,
      ),
    );
    expect(created.resultType).toBe("annotation.created");
    const id = created.data.id as string;
    const stamps = () =>
      db
        .prepare<
          [string],
          { s: string | null; t: number | null }
        >("SELECT verification_state AS s, last_verified_at AS t FROM doc_annotations WHERE id = ?")
        .get(id)!;
    expect(stamps()).toEqual({ s: "verified", t: NOW });
    // A stamps-only revise (standing confidence re-supplied) at a later time.
    const revised = await tool(
      buildTools({
        getEntailmentVerifier: () => Promise.resolve(verifier),
        clock: () => NOW + 5_000,
      }),
      "annotation_revise",
    ).invoke({ id, confidence: 0.5 }, CTX);
    expect(structured(revised).resultType).toBe("annotation.revised");
    // The revise gate judged the same joint text the create gate did.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.evidence).toBe(joint);
    // Re-affirmed: the last-checked stamp advanced.
    expect(stamps()).toEqual({ s: "verified", t: NOW + 5_000 });
  });

  test("a multi-atom claim re-affirms via a stamps-only revise gated on the JOINT evidence (person store)", async () => {
    insertPerson("per_1", "Maya Reeves");
    const ev1 = insertDoc(db, "d1", `Note — ${Q1}.`);
    const ev2 = insertDoc(db, "d2", `Heads up: ${Q2}.`);
    const joint = annotationEvidenceFrame([
      { quote: Q1, source: `Note — ${Q1}.` },
      { quote: Q2, source: `Heads up: ${Q2}.` },
    ]);
    const calls: Array<{ claim: string; evidence: string }> = [];
    const verifier: EntailCapability = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async verify(input) {
        calls.push(input);
        return { label: input.evidence === joint ? "entailment" : "neutral" };
      },
      dispose() {},
    };
    const created = structured(
      await tool(
        buildTools({ getEntailmentVerifier: () => Promise.resolve(verifier) }),
        "annotate_person",
      ).invoke(
        {
          personId: "per_1",
          claimType: "pattern",
          claimText: "books both venues at the same rate",
          evidenceDocId: ev1,
          evidenceQuote: Q1,
          confidence: 0.5,
          claimBasis: "synthesized",
          additionalEvidence: [{ docId: ev2, quote: Q2 }],
        },
        CTX,
      ),
    );
    expect(created.resultType).toBe("person_annotation.created");
    const id = created.data.id as string;
    const stamps = () =>
      db
        .prepare<
          [string],
          { s: string | null; t: number | null }
        >("SELECT verification_state AS s, last_verified_at AS t FROM person_annotations WHERE id = ?")
        .get(id)!;
    expect(stamps()).toEqual({ s: "verified", t: NOW });
    const revised = await tool(
      buildTools({
        getEntailmentVerifier: () => Promise.resolve(verifier),
        clock: () => NOW + 5_000,
      }),
      "person_annotation_revise",
    ).invoke({ id, confidence: 0.5 }, CTX);
    expect(structured(revised).resultType).toBe("person_annotation.revised");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.evidence).toBe(joint);
    expect(stamps()).toEqual({ s: "verified", t: NOW + 5_000 });
  });

  test("outputs record only the surfaced annotation dependencies they declare", async () => {
    const subject = insertDoc(db, "d1", `Note — ${Q1}.`);
    createDocAnnotation(
      db,
      {
        id: "anno_seen",
        docId: subject,
        claimType: "topic",
        claimText: "about venue billing",
        evidenceDocId: subject,
        evidenceQuote: Q1,
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_prev",
      },
      NOW - 1000,
    );
    const consumption = new RunConsumptionTracker();
    const tools = buildTools({ consumption });
    const search = await tool(tools, "annotation_search").invoke({ docId: subject }, CTX);
    expect(structured(search).resultType).toBe("annotation.search_results");
    const created = await tool(tools, "observation_note").invoke(
      {
        summary: "Venue bills match",
        citations: [subject],
        annotationDependencies: [{ store: "doc", annotationId: "anno_seen" }],
      },
      CTX,
    );
    const observationId = structured(created).data.id as string;
    const edges = db
      .prepare<
        [],
        Record<string, unknown>
      >("SELECT prior_store, prior_annotation_id, dependent_kind, dependent_id, run_id FROM cognition_consumption_edges")
      .all();
    expect(edges).toEqual([
      {
        prior_store: "doc",
        prior_annotation_id: "anno_seen",
        dependent_kind: "observation",
        dependent_id: observationId,
        run_id: "run_multi_1",
      },
    ]);
    // Merely having seen the prior does not attach it to an unrelated output.
    const loop = await tool(tools, "open_loop_create").invoke(
      {
        title: "Review the studio schedule",
        confidence: 0.7,
        importance: 0.5,
        annotationDependencies: [],
      },
      CTX,
    );
    const loopId = (structured(loop).data.loop as { id: string }).id;
    expect(
      db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM cognition_consumption_edges WHERE dependent_kind = 'loop' AND dependent_id = ?")
        .get(loopId)!.n,
    ).toBe(0);

    const refused = await tool(tools, "open_loop_create").invoke(
      {
        title: "Review an unseen prior",
        confidence: 0.7,
        importance: 0.5,
        annotationDependencies: [{ store: "person", annotationId: "panno_unseen" }],
      },
      CTX,
    );
    expect(errorResult(refused)).toMatchObject({ code: "invalid_args" });
  });

  test("same-run annotations can support every output mutation, but dead priors cannot", async () => {
    const subject = insertDoc(db, "same-run", `Invoice note — ${Q1}.`);
    const consumption = new RunConsumptionTracker();
    const tools = buildTools({ consumption });
    const annotation = structured(
      await tool(tools, "annotate_durable").invoke(
        annotateArgs(subject, subject, {
          claimType: "amount",
          claimText: "the studio invoice totals four hundred and eighty",
          claimBasis: "quoted",
        }),
        CTX,
      ),
    );
    const annotationId = annotation.data.id as string;
    const annotationDependencies = [{ store: "doc", annotationId }];

    const loop = structured(
      await tool(tools, "open_loop_create").invoke(
        {
          title: "Review the studio invoice",
          confidence: 0.7,
          importance: 0.5,
          annotationDependencies,
        },
        CTX,
      ),
    );
    const loopId = (loop.data.loop as { id: string }).id;
    expect(
      structured(
        await tool(tools, "open_loop_update").invoke(
          { id: loopId, importance: 0.6, annotationDependencies },
          CTX,
        ),
      ).resultType,
    ).toBe("open_loop.updated");

    expect(
      structured(
        await tool(tools, "observation_note").invoke(
          {
            summary: "Studio invoice ready for review",
            citations: [subject],
            annotationDependencies,
          },
          CTX,
        ),
      ).resultType,
    ).toBe("observation.noted");
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_consumption_edges").get()
        ?.n,
    ).toBe(2);

    expect(
      structured(await tool(tools, "annotation_retract").invoke({ id: annotationId }, CTX))
        .resultType,
    ).toBe("annotation.retracted");
    const refused = await tool(tools, "observation_note").invoke(
      { summary: "Stale invoice prior", citations: [subject], annotationDependencies },
      CTX,
    );
    expect(errorResult(refused).message).toContain("dead or missing");
  });

  test("an invalidation queued at the output boundary rolls back the output and its edges", async () => {
    const subject = insertDoc(db, "raced", `Invoice note — ${Q1}.`);
    const consumption = new RunConsumptionTracker();
    const baseGate = directWriteGate(db);
    const initialTools = buildTools({ consumption, writeGate: baseGate });
    const annotation = structured(
      await tool(initialTools, "annotate_durable").invoke(
        annotateArgs(subject, subject, {
          claimType: "amount",
          claimText: "the equipment invoice totals four hundred and eighty",
          claimBasis: "quoted",
        }),
        CTX,
      ),
    );
    const annotationId = annotation.data.id as string;
    const racingGate = {
      ...baseGate,
      async createObservation(
        ...args: Parameters<typeof baseGate.createObservation>
      ): ReturnType<typeof baseGate.createObservation> {
        await baseGate.deleteDocAnnotation(annotationId, NOW + 10);
        return baseGate.createObservation(...args);
      },
    };
    const racingTools = buildTools({ consumption, writeGate: racingGate });
    const refused = await tool(racingTools, "observation_note").invoke(
      {
        summary: "Equipment invoice review",
        citations: [subject],
        annotationDependencies: [{ store: "doc", annotationId }],
      },
      CTX,
    );
    expect(errorResult(refused).message).toContain("dead or missing");
    expect(
      db.prepare("SELECT 1 FROM observations WHERE summary = ?").get("Equipment invoice review"),
    ).toBe(undefined);
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_consumption_edges").get()
        ?.n,
    ).toBe(0);
  });

  test("with nothing consumed (or no tracker), an observation write records no edges", async () => {
    const doc = insertDoc(db, "d1", "plain note");
    // Tracker present but empty.
    const tools = buildTools({ consumption: new RunConsumptionTracker() });
    const first = await tool(tools, "observation_note").invoke(
      { summary: "Quiet observation", citations: [doc], annotationDependencies: [] },
      CTX,
    );
    expect(structured(first).resultType).toBe("observation.noted");
    // No tracker at all (pure-composition callers).
    const second = await tool(buildTools(), "observation_note").invoke(
      { summary: "Second quiet observation", citations: [doc], annotationDependencies: [] },
      CTX,
    );
    expect(structured(second).resultType).toBe("observation.noted");
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_consumption_edges").get()!
        .n,
    ).toBe(0);
  });
});
