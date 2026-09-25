// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Write-time grounding teeth for the user-facing surfaces:
 *
 *  - `brief_create` / `brief_update` asserted claims — every factual,
 *    document-derived assertion a brief makes must cite a real document,
 *    quote it verbatim, sit inside its claim-basis confidence band, clear
 *    the persistence floor, and pass the entailment gate (cheap SQL checks
 *    strictly before any verifier call; ONE refusal names every failing
 *    claim and is re-askable; passing claims are born-verified; a configured
 *    verifier outage holds the Brief; with no verifier configured the stamp
 *    is null).
 *  - `temporal_annotation_add` / `temporal_annotation_update` conditional
 *    evidence — a write
 *    declaring its grounding gets the same quote + entailment teeth; a
 *    write without evidence is never gated.
 *
 * Fixture data is invented — no corpus content.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "@omnesis/core";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { listSweepTallies } from "../storage/sweep-tally.js";
import { directWriteGate } from "../../write-gate.js";
import { listLiveBriefClaims } from "../storage/brief-claims.js";
import {
  getTemporalAnnotationById,
  listTemporalAnnotationEvidence,
} from "../../enrichment/temporal-annotations/storage.js";
import { createDocAnnotation } from "../storage/annotations.js";
import { RunConsumptionTracker } from "./consumption.js";
import { createOpenLoopMirror } from "./mirror.js";
import { buildCognitionOwnTools, type CognitionToolDeps } from "./tools.js";
import type { BriefJudge, BriefJudgeCandidate } from "./brief-judge.js";
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

const throwingVerifier: EntailCapability = {
  verify: () => Promise.reject(new Error("judge backend is down")),
  dispose() {},
};

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

describe("grounding teeth (asserted claims + temporal annotation evidence)", () => {
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
    return t;
  }

  const QUOTE = "we paid the venue deposit this morning";
  function seedEvidence(): string {
    return insertDoc(db, "ev1", `Quick update — ${QUOTE}, receipt attached.`);
  }
  function briefArgs(claims?: unknown[]): Record<string, unknown> {
    return {
      kind: "info",
      title: "Venue deposit confirmed",
      confidence: 0.7,
      urgency: 0.4,
      annotationDependencies: [],
      ...(claims !== undefined ? { assertedClaims: claims } : {}),
    };
  }
  function claimArg(evidenceDocId: string, over: Record<string, unknown> = {}) {
    return {
      claimText: "the venue deposit was paid",
      evidenceDocId,
      evidenceQuote: QUOTE,
      claimBasis: "quoted",
      confidence: 0.8,
      ...over,
    };
  }
  function liveClaimsOfOnlyBrief(): ReturnType<typeof listLiveBriefClaims> {
    const brief = db.prepare<[], { id: string }>("SELECT id FROM briefs").get();
    if (!brief) throw new Error("no brief persisted");
    return listLiveBriefClaims(db, brief.id);
  }

  // ── brief_create teeth ───────────────────────────────────────────────────

  test("a zero-claims brief passes untouched (awareness cards may assert nothing)", async () => {
    const res = await tool(buildTools(), "brief_create").invoke(briefArgs(), CTX);
    const { resultType, data } = structured(res);
    expect(resultType).toBe("brief.created");
    expect(data.assertedClaimCount).toBeUndefined();
    expect(liveClaimsOfOnlyBrief()).toEqual([]);
  });

  test("an output write must make an explicit annotation-dependency judgment", async () => {
    const res = await tool(buildTools(), "brief_create").invoke(
      { kind: "info", title: "Venue update", confidence: 0.7, urgency: 0.4 },
      CTX,
    );
    expect(errorResult(res)).toMatchObject({ code: "invalid_args" });
    expect(errorResult(res).message).toContain("annotationDependencies");
  });

  test("a claim citing a missing evidence doc refuses, naming the claim (index + text)", async () => {
    const res = await tool(buildTools(), "brief_create").invoke(
      briefArgs([claimArg("doc_missing")]),
      CTX,
    );
    const err = errorResult(res);
    expect(err.code).toBe("not_found");
    expect(err.message).toContain("assertedClaims[0]");
    expect(err.message).toContain("the venue deposit was paid");
    expect(err.message).toContain("doc_missing");
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM briefs").get()?.n).toBe(0);
  });

  test("a quote not present in its document refuses, naming the claim", async () => {
    const ev = seedEvidence();
    const res = await tool(buildTools(), "brief_create").invoke(
      briefArgs([
        claimArg(ev),
        claimArg(ev, {
          claimText: "the balance was settled",
          evidenceQuote: "the remaining balance was settled in full",
        }),
      ]),
      CTX,
    );
    const err = errorResult(res);
    expect(err.code).toBe("evidence_not_found");
    expect(err.message).toContain("assertedClaims[1]");
    expect(err.message).toContain("the balance was settled");
  });

  test("cheap refusals come strictly before the gate — the verifier is never called", async () => {
    const ev = seedEvidence();
    const verifier = fakeVerifier("entailment");
    const res = await tool(
      buildTools({ getEntailmentVerifier: async () => verifier }),
      "brief_create",
    ).invoke(
      briefArgs([
        claimArg(ev), // would pass the gate…
        claimArg(ev, { evidenceQuote: "a quote that appears nowhere in the document" }),
      ]),
      CTX,
    );
    expect(errorResult(res).code).toBe("evidence_not_found");
    // …but the cheap failure on claim 1 refused the whole set gate-free.
    expect(verifier.calls).toEqual([]);
  });

  test("an entailment refusal names the failing claim and its verdict; nothing persists", async () => {
    const ev = seedEvidence();
    const verifier = fakeVerifier("neutral");
    const res = await tool(
      buildTools({ getEntailmentVerifier: async () => verifier }),
      "brief_create",
    ).invoke(briefArgs([claimArg(ev, { claimText: "the entire wedding is fully paid off" })]), CTX);
    const err = errorResult(res);
    expect(err.code).toBe("evidence_does_not_entail_claim");
    expect(err.message).toContain("assertedClaims[0]");
    expect(err.message).toContain("the entire wedding is fully paid off");
    expect(err.message).toContain("neutral");
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM briefs").get()?.n).toBe(0);
  });

  test("claims that pass are born-verified, judged quote ⊨ claim, one gate call per claim", async () => {
    const ev = seedEvidence();
    const verifier = fakeVerifier("entailment");
    const res = await tool(
      buildTools({ getEntailmentVerifier: async () => verifier }),
      "brief_create",
    ).invoke(
      briefArgs([claimArg(ev), claimArg(ev, { claimText: "a deposit payment was made" })]),
      CTX,
    );
    const { data } = structured(res);
    expect(data.assertedClaimCount).toBe(2);
    const claims = liveClaimsOfOnlyBrief();
    expect(claims).toHaveLength(2);
    for (const c of claims) {
      expect(c.verificationState).toBe("verified");
      expect(c.evidenceDocId).toBe(ev);
    }
    expect(verifier.calls).toEqual([
      { claim: "the venue deposit was paid", evidence: QUOTE },
      { claim: "a deposit payment was made", evidence: QUOTE },
    ]);
  });

  test("configured verifier unavailable → Brief is held and no unchecked claim persists", async () => {
    const ev = seedEvidence();
    const res = await tool(
      buildTools({ getEntailmentVerifier: async () => throwingVerifier }),
      "brief_create",
    ).invoke(briefArgs([claimArg(ev)]), CTX);
    const { resultType, data } = structured(res);
    expect(resultType).toBe("brief.held_for_verification");
    expect(data.reason).toContain("configured entailment verifier was unavailable");
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM briefs").get()?.n).toBe(0);
  });

  test("no verifier configured → claims persist with a NULL stamp (no gate, no stamp)", async () => {
    const ev = seedEvidence();
    const res = await tool(buildTools(), "brief_create").invoke(briefArgs([claimArg(ev)]), CTX);
    expect(structured(res).resultType).toBe("brief.created");
    // Mirrors the annotation stores: null (no verifier) is distinct from
    // 'unverified' (a configured verifier was unavailable).
    expect(liveClaimsOfOnlyBrief()[0]!.verificationState).toBeNull();
  });

  test("a claim below the persistence floor refuses (abstention floor), naming it", async () => {
    const ev = seedEvidence();
    const verifier = fakeVerifier("entailment");
    const res = await tool(
      buildTools({ annotationConfidenceFloor: 0.5, getEntailmentVerifier: async () => verifier }),
      "brief_create",
    ).invoke(briefArgs([claimArg(ev, { confidence: 0.4 })]), CTX);
    const err = errorResult(res);
    expect(err.code).toBe("insufficient_confidence_to_persist");
    expect(err.message).toContain("assertedClaims[0]");
    expect(err.message).toContain("the venue deposit was paid");
    expect(err.message).toContain("0.40");
    expect(err.message).toContain("0.50");
    // A floor refusal is a cheap-stage refusal — no verifier spend.
    expect(verifier.calls).toEqual([]);
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM briefs").get()?.n).toBe(0);
  });

  test("an at-floor claim persists (the floor refuses strictly below it)", async () => {
    const ev = seedEvidence();
    const res = await tool(buildTools({ annotationConfidenceFloor: 0.5 }), "brief_create").invoke(
      briefArgs([claimArg(ev, { confidence: 0.5 })]),
      CTX,
    );
    expect(structured(res).resultType).toBe("brief.created");
    expect(liveClaimsOfOnlyBrief()[0]!.confidence).toBe(0.5);
  });

  test("the floor applies to the POST-clamp confidence, not the reported one", async () => {
    const ev = seedEvidence();
    // Reported 0.9 clamps to the synthesized band's 0.55 — below a 0.6 floor.
    const res = await tool(buildTools({ annotationConfidenceFloor: 0.6 }), "brief_create").invoke(
      briefArgs([claimArg(ev, { claimBasis: "synthesized", confidence: 0.9 })]),
      CTX,
    );
    const err = errorResult(res);
    expect(err.code).toBe("insufficient_confidence_to_persist");
    expect(err.message).toContain("0.55");
  });

  test("a multi-bad set refuses ONCE, naming every failing claim across failure kinds", async () => {
    const ev = seedEvidence();
    const verifier = fakeVerifier("entailment");
    const res = await tool(
      buildTools({ getEntailmentVerifier: async () => verifier }),
      "brief_create",
    ).invoke(
      briefArgs([
        claimArg(ev), // fine
        claimArg(ev, { claimText: "cites a ghost document", evidenceDocId: "doc_missing" }),
        claimArg(ev, {
          claimText: "quotes text that is not there",
          evidenceQuote: "a quote that appears nowhere in the document",
        }),
        claimArg(ev, { claimText: "far too weak to keep", confidence: 0.05 }),
      ]),
      CTX,
    );
    const err = errorResult(res);
    // Mixed failure kinds → the aggregate code; every failing claim named.
    expect(err.code).toBe("asserted_claims_refused");
    expect(err.message).toContain("assertedClaims[1]");
    expect(err.message).toContain("cites a ghost document");
    expect(err.message).toContain("assertedClaims[2]");
    expect(err.message).toContain("quotes text that is not there");
    expect(err.message).toContain("assertedClaims[3]");
    expect(err.message).toContain("far too weak to keep");
    // The passing claim is not named.
    expect(err.message).not.toContain("assertedClaims[0]");
    // Cheap-stage refusal: the gate never ran, even for the passing claim.
    expect(verifier.calls).toEqual([]);
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM briefs").get()?.n).toBe(0);
  });

  test("the gate keeps judging past a refusal: one call per claim, one refusal naming all failures", async () => {
    const ev = seedEvidence();
    // A verifier whose verdicts are scripted per call, in order.
    const calls: Array<{ claim: string; evidence: string }> = [];
    const labels: Array<"entailment" | "neutral" | "contradiction"> = [
      "neutral",
      "entailment",
      "contradiction",
    ];
    const verifier: EntailCapability = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async verify(input) {
        calls.push(input);
        return { label: labels[calls.length - 1]! };
      },
      dispose() {},
    };
    const res = await tool(
      buildTools({ getEntailmentVerifier: async () => verifier }),
      "brief_create",
    ).invoke(
      briefArgs([
        claimArg(ev, { claimText: "the entire wedding is fully paid off" }),
        claimArg(ev, { claimText: "a deposit payment was made" }),
        claimArg(ev, { claimText: "the venue cancelled the booking" }),
      ]),
      CTX,
    );
    const err = errorResult(res);
    expect(err.code).toBe("asserted_claims_refused");
    expect(err.message).toContain("assertedClaims[0]");
    expect(err.message).toContain("neutral");
    expect(err.message).toContain("assertedClaims[2]");
    expect(err.message).toContain("contradiction");
    expect(err.message).not.toContain("assertedClaims[1]");
    // Bounded spend: exactly one gate call per claim — the first refusal
    // did not short-circuit the second and third judgments.
    expect(calls).toHaveLength(3);
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM briefs").get()?.n).toBe(0);
  });

  test("per-basis clamp: a synthesized claim's confidence is capped into its band", async () => {
    const ev = seedEvidence();
    const res = await tool(buildTools(), "brief_create").invoke(
      briefArgs([
        claimArg(ev, { claimBasis: "synthesized", confidence: 0.95 }),
        claimArg(ev, { claimText: "a deposit payment was made", confidence: 0.85 }),
      ]),
      CTX,
    );
    expect(structured(res).resultType).toBe("brief.created");
    const claims = liveClaimsOfOnlyBrief();
    // Default bands: synthesized ≤ 0.55; quoted ≤ 0.9 (0.85 already inside).
    expect(claims[0]!.confidence).toBe(0.55);
    expect(claims[1]!.confidence).toBe(0.85);
  });

  // ── brief judge gate (the push bar) ──────────────────────────────────────

  /** A judge stub returning a fixed verdict, recording every candidate it saw. */
  function spyJudge(decision: "ship" | "hold", calls: BriefJudgeCandidate[]): BriefJudge {
    return {
      // eslint-disable-next-line @typescript-eslint/require-await
      async judge(candidate) {
        calls.push(candidate);
        return { decision, reason: `stub ${decision}` };
      },
    };
  }

  test("a hold on a sweep run is tallied against that sweep; other runs tally nothing", async () => {
    // A hold is the one thing a sweep produced that leaves no trace in the
    // artifact stores, so it cannot be counted back from `created_by_run` at
    // settle — it has to be recorded as it happens.
    const seen: BriefJudgeCandidate[] = [];
    await tool(
      buildTools({ getBriefJudge: () => spyJudge("hold", seen), sweepId: "weekly-finances" }),
      "brief_create",
    ).invoke(briefArgs(), CTX);
    expect(listSweepTallies(db).get("weekly-finances")).toMatchObject({
      briefsHeld: 1,
      // A hold is not a run: it must not make the sweep look like it ran.
      runs: 0,
      lastRunAt: null,
    });

    // The same hold on a run that is not a sweep writes no row at all.
    await tool(buildTools({ getBriefJudge: () => spyJudge("hold", seen) }), "brief_create").invoke(
      briefArgs(),
      CTX,
    );
    expect(listSweepTallies(db).size).toBe(1);
  });

  test("the judge holds a candidate: nothing is created, the agent is told why", async () => {
    const seen: BriefJudgeCandidate[] = [];
    const res = await tool(
      buildTools({ getBriefJudge: () => spyJudge("hold", seen) }),
      "brief_create",
    ).invoke(briefArgs(), CTX);
    const { resultType, data } = structured(res);
    expect(resultType).toBe("brief.held_by_judge");
    expect(data.reason).toBe("stub hold");
    expect(data.guidance).toContain("did not authorize shipping");
    // The candidate carried the brief's content and timing signals.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.title).toBe("Venue deposit confirmed");
    expect(seen[0]!.citationCount).toBe(0);
    expect(seen[0]!.scheduledForLater).toBe(false);
    // Held ⇒ no brief persisted.
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM briefs").get()?.n).toBe(0);
  });

  test("the judge ships a candidate: the brief is created", async () => {
    const seen: BriefJudgeCandidate[] = [];
    const res = await tool(
      buildTools({ getBriefJudge: () => spyJudge("ship", seen) }),
      "brief_create",
    ).invoke(briefArgs(), CTX);
    expect(structured(res).resultType).toBe("brief.created");
    expect(seen).toHaveLength(1);
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM briefs").get()?.n).toBe(1);
  });

  test("a configured judge outage holds the Brief instead of shipping it unreviewed", async () => {
    const judge: BriefJudge = {
      judge: () => Promise.reject(new Error("review backend unavailable")),
    };
    const res = await tool(buildTools({ getBriefJudge: () => judge }), "brief_create").invoke(
      briefArgs(),
      CTX,
    );
    const { resultType, data } = structured(res);
    expect(resultType).toBe("brief.held_by_judge");
    expect(data.reason).toContain("held rather than shipped without review");
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM briefs").get()?.n).toBe(0);
  });

  test("a scheduled reminder reaches the judge marked timing-satisfied", async () => {
    const seen: BriefJudgeCandidate[] = [];
    await tool(buildTools({ getBriefJudge: () => spyJudge("ship", seen) }), "brief_create").invoke(
      { ...briefArgs(), nextShow: "2026-08-01T06:00:00.000Z", eventAt: "2026-08-01T00:00:00.000Z" },
      CTX,
    );
    expect(seen[0]!.scheduledForLater).toBe(true);
    expect(seen[0]!.hasEventAt).toBe(true);
  });

  test("the judge runs AFTER the claims teeth: a claim-fix refusal never reaches it", async () => {
    const ev = seedEvidence();
    const seen: BriefJudgeCandidate[] = [];
    const res = await tool(
      buildTools({ getBriefJudge: () => spyJudge("ship", seen) }),
      "brief_create",
    ).invoke(
      briefArgs([claimArg(ev, { evidenceQuote: "a quote that is nowhere in the doc" })]),
      CTX,
    );
    // The cheap claim check refuses; the judge is never consulted.
    expect(errorResult(res).code).toBe("evidence_not_found");
    expect(seen).toEqual([]);
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM briefs").get()?.n).toBe(0);
  });

  test("a judge that throws fails closed: the brief is held", async () => {
    const judge: BriefJudge = {
      judge: () => Promise.reject(new Error("judge model is down")),
    };
    const res = await tool(buildTools({ getBriefJudge: () => judge }), "brief_create").invoke(
      briefArgs(),
      CTX,
    );
    expect(structured(res).resultType).toBe("brief.held_by_judge");
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM briefs").get()?.n).toBe(0);
  });

  test("no judge wired: briefs ship unjudged (byte-for-byte as before)", async () => {
    const res = await tool(buildTools(), "brief_create").invoke(briefArgs(), CTX);
    expect(structured(res).resultType).toBe("brief.created");
  });

  test("brief_fetch surfaces the live claim set", async () => {
    const ev = seedEvidence();
    const tools = buildTools();
    const created = structured(
      await tool(tools, "brief_create").invoke(briefArgs([claimArg(ev)]), CTX),
    );
    const briefId = (created.data.brief as { id: string }).id;
    const fetched = structured(await tool(tools, "brief_fetch").invoke({ id: briefId }, CTX));
    expect(fetched.data.assertedClaims).toEqual([
      {
        claimText: "the venue deposit was paid",
        evidenceDocId: ev,
        evidenceQuote: QUOTE,
        claimBasis: "quoted",
        confidence: 0.8,
        // No verifier configured in this toolset → no stamp.
        verificationState: null,
      },
    ]);
  });

  // ── brief_update replace-set ─────────────────────────────────────────────

  test("brief_update with assertedClaims atomically replaces the live set (same teeth)", async () => {
    const ev = seedEvidence();
    const ev2 = insertDoc(db, "ev2", "the final balance is due on 15 July per the contract");
    const tools = buildTools();
    const created = structured(
      await tool(tools, "brief_create").invoke(briefArgs([claimArg(ev)]), CTX),
    );
    const briefId = (created.data.brief as { id: string }).id;

    const updated = await tool(tools, "brief_update").invoke(
      {
        id: briefId,
        annotationDependencies: [],
        assertedClaims: [
          {
            claimText: "the final balance is due on 15 July",
            evidenceDocId: ev2,
            evidenceQuote: "the final balance is due on 15 July",
            claimBasis: "quoted",
            confidence: 0.8,
          },
        ],
      },
      CTX,
    );
    const { data } = structured(updated);
    expect(data.assertedClaimCount).toBe(1);
    const live = listLiveBriefClaims(db, briefId);
    expect(live).toHaveLength(1);
    expect(live[0]!.claimText).toBe("the final balance is due on 15 July");
    // The replaced claim is audit-kept, invalidated.
    const total = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM brief_claims").get();
    expect(total?.n).toBe(2);
  });

  test("a refused update leaves the standing claim set untouched", async () => {
    const ev = seedEvidence();
    const tools = buildTools();
    const created = structured(
      await tool(tools, "brief_create").invoke(briefArgs([claimArg(ev)]), CTX),
    );
    const briefId = (created.data.brief as { id: string }).id;

    const refused = await tool(tools, "brief_update").invoke(
      {
        id: briefId,
        annotationDependencies: [],
        assertedClaims: [claimArg(ev, { evidenceQuote: "a quote not in the doc" })],
      },
      CTX,
    );
    expect(errorResult(refused).code).toBe("evidence_not_found");
    expect(listLiveBriefClaims(db, briefId).map((c) => c.claimText)).toEqual([
      "the venue deposit was paid",
    ]);
  });

  test("a verifier outage holds a claim-replacing update and preserves the standing set", async () => {
    const ev = seedEvidence();
    const initialTools = buildTools();
    const created = structured(
      await tool(initialTools, "brief_create").invoke(briefArgs([claimArg(ev)]), CTX),
    );
    const briefId = (created.data.brief as { id: string }).id;

    const updateTools = buildTools({ getEntailmentVerifier: async () => throwingVerifier });
    const held = await tool(updateTools, "brief_update").invoke(
      {
        id: briefId,
        annotationDependencies: [],
        assertedClaims: [claimArg(ev, { claimText: "a deposit payment was made" })],
      },
      CTX,
    );
    expect(structured(held).resultType).toBe("brief.held_for_verification");
    expect(listLiveBriefClaims(db, briefId).map((c) => c.claimText)).toEqual([
      "the venue deposit was paid",
    ]);
  });

  test("brief_update without assertedClaims leaves the claims untouched", async () => {
    const ev = seedEvidence();
    const tools = buildTools();
    const created = structured(
      await tool(tools, "brief_create").invoke(briefArgs([claimArg(ev)]), CTX),
    );
    const briefId = (created.data.brief as { id: string }).id;
    await tool(tools, "brief_update").invoke(
      { id: briefId, title: "Retitled", annotationDependencies: [] },
      CTX,
    );
    expect(listLiveBriefClaims(db, briefId)).toHaveLength(1);
  });

  test("an unknown brief refuses before the claims teeth spend a verifier call", async () => {
    const ev = seedEvidence();
    const verifier = fakeVerifier("entailment");
    const res = await tool(
      buildTools({ getEntailmentVerifier: async () => verifier }),
      "brief_update",
    ).invoke(
      { id: "brf_missing", assertedClaims: [claimArg(ev)], annotationDependencies: [] },
      CTX,
    );
    expect(errorResult(res).code).toBe("not_found");
    expect(verifier.calls).toEqual([]);
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
    expect(verifier.calls).toEqual([{ claim: "passport expires", evidence: TIX_QUOTE }]);
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
    expect(verifier.calls).toEqual([{ claim: "passport expires", evidence: TIX_QUOTE }]);
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
    return t;
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
    expect(verifier.calls[0]!.evidence).toBe(`[1] ${Q1}\n[2] ${Q2}`);
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

  test("a scalar-only annotate passes the bare quote to the gate, unchanged", async () => {
    const subject = insertDoc(db, "d1", `Note — ${Q1}.`);
    const verifier = fakeVerifier("entailment");
    const res = await tool(
      buildTools({ getEntailmentVerifier: () => Promise.resolve(verifier) }),
      "annotate_durable",
    ).invoke(annotateArgs(subject, subject, { claimBasis: "quoted" }), CTX);
    expect(structured(res).data.evidenceCount).toBeUndefined();
    expect(verifier.calls).toHaveLength(1);
    expect(verifier.calls[0]!.evidence).toBe(Q1);
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
    expect(verifier.calls[0]!.evidence).toBe(`[1] ${Q1}\n[2] ${Q2}`);
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM person_annotation_evidence").get()!
        .n,
    ).toBe(2);
  });

  test("a multi-atom claim re-affirms via a stamps-only revise gated on the JOINT evidence (doc store)", async () => {
    const subject = insertDoc(db, "d1", `Note — ${Q1}.`);
    const ev2 = insertDoc(db, "d2", `Heads up: ${Q2}.`);
    const joint = `[1] ${Q1}\n[2] ${Q2}`;
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
    const joint = `[1] ${Q1}\n[2] ${Q2}`;
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
    const created = await tool(tools, "brief_create").invoke(
      {
        kind: "info",
        title: "Venue bills match",
        confidence: 0.7,
        urgency: 0.3,
        annotationDependencies: [{ store: "doc", annotationId: "anno_seen" }],
      },
      CTX,
    );
    const briefId = (structured(created).data.brief as { id: string }).id;
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
        dependent_kind: "brief",
        dependent_id: briefId,
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

    const brief = structured(
      await tool(tools, "brief_create").invoke(
        {
          kind: "info",
          title: "Studio invoice ready for review",
          confidence: 0.7,
          urgency: 0.3,
          annotationDependencies,
        },
        CTX,
      ),
    );
    const briefId = (brief.data.brief as { id: string }).id;
    expect(
      structured(
        await tool(tools, "brief_update").invoke(
          { id: briefId, urgency: 0.4, annotationDependencies },
          CTX,
        ),
      ).resultType,
    ).toBe("brief.updated");
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_consumption_edges").get()
        ?.n,
    ).toBe(2);

    expect(
      structured(await tool(tools, "annotation_retract").invoke({ id: annotationId }, CTX))
        .resultType,
    ).toBe("annotation.retracted");
    const refused = await tool(tools, "brief_create").invoke(
      {
        kind: "info",
        title: "Stale invoice prior",
        confidence: 0.7,
        urgency: 0.3,
        annotationDependencies,
      },
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
      async createBrief(
        ...args: Parameters<typeof baseGate.createBrief>
      ): ReturnType<typeof baseGate.createBrief> {
        await baseGate.deleteDocAnnotation(annotationId, NOW + 10);
        return baseGate.createBrief(...args);
      },
    };
    const racingTools = buildTools({ consumption, writeGate: racingGate });
    const refused = await tool(racingTools, "brief_create").invoke(
      {
        kind: "info",
        title: "Equipment invoice review",
        confidence: 0.7,
        urgency: 0.3,
        annotationDependencies: [{ store: "doc", annotationId }],
      },
      CTX,
    );
    expect(errorResult(refused).message).toContain("dead or missing");
    expect(db.prepare("SELECT 1 FROM briefs WHERE title = ?").get("Equipment invoice review")).toBe(
      undefined,
    );
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_consumption_edges").get()
        ?.n,
    ).toBe(0);
  });

  test("with nothing consumed (or no tracker), a brief write records no edges", async () => {
    insertDoc(db, "d1", "plain note");
    // Tracker present but empty.
    const tools = buildTools({ consumption: new RunConsumptionTracker() });
    await tool(tools, "brief_create").invoke(
      {
        kind: "info",
        title: "Quiet card",
        confidence: 0.7,
        urgency: 0.3,
        annotationDependencies: [],
      },
      CTX,
    );
    // No tracker at all (pure-composition callers).
    await tool(buildTools(), "brief_create").invoke(
      {
        kind: "info",
        title: "Second quiet card",
        confidence: 0.7,
        urgency: 0.3,
        annotationDependencies: [],
      },
      CTX,
    );
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_consumption_edges").get()!
        .n,
    ).toBe(0);
  });
});
