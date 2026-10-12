// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the scorecard's pure reduction half: the daily-mix
 * derivation, fuzzy loop→arc attribution (cited doc ids first, marker
 * fallback, never exact titles), and the metric computation over
 * synthetic observations — so the instrument-validation e2e never debugs
 * arithmetic through a spawned gateway.
 */

import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { arcById, generateArcSet, FROZEN_ARC_SEED, type ArcSet } from "./briefs-arcs.js";
import {
  runScorecard,
  completedSourceRunCounts,
  attributeLoops,
  computeDailyMix,
  computeScorecardMetrics,
  countUncorrectedFailures,
  type ObservedLoop,
  type ScorecardObservations,
} from "./briefs-scorecard.js";

const SET = generateArcSet(FROZEN_ARC_SEED);

/** Deterministic fake document ids for every arc datum. */
function fakeDocIds(set: ArcSet): Map<string, string> {
  const map = new Map<string, string>();
  for (const arc of set.arcs) {
    for (const step of arc.steps) map.set(step.doc.externalId, `d-${step.doc.externalId}`);
  }
  return map;
}

function loop(partial: Partial<ObservedLoop> & { id: string }): ObservedLoop {
  return { state: "open", title: "", description: "", docs: [], ...partial };
}

/**
 * Ledger evidence a CORRECT agent leaves for the `note` datums — the
 * decision thread's three venue options and the wording-poor nudge: each
 * note's data run appended to its tracked loop's ledger.
 */
function perfectUpdateEvidence(): {
  runIdsByDocId: Map<string, string[]>;
  ledgerRunIdsByLoopId: Map<string, string[]>;
} {
  const docIds = fakeDocIds(SET);
  const runIdsByDocId = new Map<string, string[]>();
  const decisionLedger: string[] = [];
  const thread = arcById(SET, "decision-thread");
  for (const [i, step] of thread.steps.entries()) {
    if (step.doc.behavior.onCreated.kind !== "note") continue;
    const runId = `r-note-${i}`;
    runIdsByDocId.set(docIds.get(step.doc.externalId)!, [runId]);
    decisionLedger.push(runId);
  }
  const nudgeStep = arcById(SET, "nudge").steps[1]!;
  runIdsByDocId.set(docIds.get(nudgeStep.doc.externalId)!, ["r-nudge"]);
  return {
    runIdsByDocId,
    ledgerRunIdsByLoopId: new Map([
      ["l-decision", decisionLedger],
      ["l-nudge", ["r-nudge"]],
    ]),
  };
}

function observations(
  loops: ObservedLoop[],
  overrides: Partial<ScorecardObservations> = {},
): ScorecardObservations {
  return {
    loops,
    observationNotes: 5,
    loopCreates: loops.length,
    runsCompleted: 22,
    runsFailed: 0,
    dataRunsCompleted: 22,
    promptTokens: 90_000,
    completionTokens: 1_000,
    docIdsByExternalId: fakeDocIds(SET),
    mutatingToolCalls: 25,
    mutatingToolCallsFailed: 0,
    mutatingToolCallsUncorrected: 0,
    scheduledRuns: 0,
    ...perfectUpdateEvidence(),
    ...overrides,
  };
}

/** The fourteen loops a CORRECT agent leaves behind on the frozen arc set.
 * The arc that CORRECTLY ends with no loop: mistaken-commit (retracted ->
 * deleted). */
function perfectLoops(): ObservedLoop[] {
  const docIds = fakeDocIds(SET);
  const byFirstStep = (arcId: string): string =>
    docIds.get(arcById(SET, arcId).steps[0]!.doc.externalId)!;
  return [
    loop({ id: "l-invoice", state: "done", docs: [byFirstStep("invoice")] }),
    loop({ id: "l-twin", state: "open", docs: [byFirstStep("invoice-twin")] }),
    loop({ id: "l-request", state: "open", docs: [byFirstStep("request")] }),
    loop({ id: "l-concurrent", state: "open", docs: [byFirstStep("concurrent")] }),
    loop({ id: "l-obligation-invoice", state: "open", docs: [byFirstStep("obligation-invoice")] }),
    loop({ id: "l-obligation-quote", state: "open", docs: [byFirstStep("obligation-quote")] }),
    loop({ id: "l-restatement", state: "open", docs: [byFirstStep("restatement")] }),
    loop({ id: "l-ooo", state: "done", docs: [byFirstStep("out-of-order")] }),
    loop({ id: "l-decision", state: "open", docs: [byFirstStep("decision-thread")] }),
    loop({ id: "l-long-horizon", state: "done", docs: [byFirstStep("long-horizon")] }),
    loop({ id: "l-ooo-2", state: "done", docs: [byFirstStep("out-of-order-2")] }),
    loop({ id: "l-errand-cutter", state: "open", docs: [byFirstStep("errand-cutter")] }),
    loop({ id: "l-errand-key", state: "open", docs: [byFirstStep("errand-key")] }),
    loop({ id: "l-nudge", state: "open", docs: [byFirstStep("nudge")] }),
  ];
}

describe("computeDailyMix", () => {
  test("derives the documented mix from the frozen arc set", () => {
    expect(computeDailyMix(SET)).toEqual({
      representsDays: 1,
      datumsDelivered: 35,
      eligibleWakes: 31,
      wakerSkips: 2,
      expectedRuns: 32,
    });
  });
});

describe("attributeLoops", () => {
  test("attributes by cited doc ids first, marker text as fallback, unmatched to nobody", () => {
    const docIds = fakeDocIds(SET);
    const twinMarker = arcById(SET, "invoice-twin").marker!;
    const byDocId = loop({
      id: "l-doc",
      docs: [docIds.get(arcById(SET, "invoice").steps[1]!.doc.externalId)!],
    });
    const byMarker = loop({
      id: "l-marker",
      title: `Follow up about ${twinMarker} soon`,
    });
    const unmatched = loop({ id: "l-nobody", title: "Completely unrelated" });

    const byArc = attributeLoops(SET, {
      loops: [byDocId, byMarker, unmatched],
      docIdsByExternalId: docIds,
    });
    expect(byArc.get("invoice")!.map((l) => l.id)).toEqual(["l-doc"]);
    expect(byArc.get("invoice-twin")!.map((l) => l.id)).toEqual(["l-marker"]);
    for (const loops of byArc.values()) {
      expect(loops.map((l) => l.id)).not.toContain("l-nobody");
    }
  });

  test("a loop citing a sibling arc's doc as context attributes by its own marker", () => {
    const docIds = fakeDocIds(SET);
    const invoiceArc = arcById(SET, "obligation-invoice");
    const quoteArc = arcById(SET, "obligation-quote");
    // The same-vendor/same-amount quote loop cites the near-identical
    // invoice it was disambiguated against ALONGSIDE its own datum — the
    // loop's title carries the quote marker, so it belongs to the quote arc.
    const quoteLoop = loop({
      id: "l-quote-with-context",
      title: `Review quote ${quoteArc.marker} from the vendor`,
      description: `Separate obligation from invoice ${invoiceArc.marker}.`,
      docs: [
        docIds.get(invoiceArc.steps[0]!.doc.externalId)!,
        docIds.get(quoteArc.steps[0]!.doc.externalId)!,
      ],
    });
    const byArc = attributeLoops(SET, {
      loops: [quoteLoop],
      docIdsByExternalId: docIds,
    });
    expect(byArc.get("obligation-quote")!.map((l) => l.id)).toEqual(["l-quote-with-context"]);
    expect(byArc.get("obligation-invoice")!).toEqual([]);
  });
});

describe("countUncorrectedFailures", () => {
  test("a failure followed by a successful same-tool call is corrected; others are not", () => {
    // The observed live pattern: an empty-args burst, then the real call.
    expect(
      countUncorrectedFailures([
        { tool: "open_loop_create", ok: false },
        { tool: "open_loop_create", ok: false },
        { tool: "open_loop_create", ok: false },
        { tool: "open_loop_create", ok: true },
        { tool: "observation_note", ok: true },
      ]),
    ).toBe(0);
    // A DIFFERENT tool succeeding later does not correct the failure...
    expect(
      countUncorrectedFailures([
        { tool: "open_loop_create", ok: false },
        { tool: "observation_note", ok: true },
      ]),
    ).toBe(1);
    // ...nor does an earlier success, and a trailing failure never corrects.
    expect(
      countUncorrectedFailures([
        { tool: "open_loop_update", ok: true },
        { tool: "open_loop_update", ok: false },
      ]),
    ).toBe(1);
    expect(countUncorrectedFailures([])).toBe(0);
  });
});

describe("computeScorecardMetrics", () => {
  test("a correct end-state scores clean", () => {
    const { metrics, counts } = computeScorecardMetrics(SET, observations(perfectLoops()), 1);
    expect(metrics.duplicateRate).toBe(0);
    expect(metrics.resolutionRecall).toBe(1);
    expect(metrics.loopPrecision).toBe(1);
    expect(metrics.loopRecall).toBe(1);
    expect(metrics.updateRecall).toBe(1);
    expect(metrics.silentCloseViolations).toBe(0);
    expect(metrics.infraFailureRate).toBe(0);
    expect(metrics.malformedToolCallRate).toBe(0);
    expect(metrics.observationsPerDay).toBe(5);
    expect(metrics.tokensPerDay).toBe(91_000);
    expect(counts.reconcileOpportunities).toBe(13);
    expect(counts.resolutionTargets).toBe(4);
    expect(counts.loopsJustified).toBe(14);
    expect(counts.loopArcTargets).toBe(12);
    expect(counts.updateTargets).toBe(4);
    expect(counts.updatesLanded).toBe(4);
  });

  test("a duplicate mint raises duplicate_rate and a skipped resolution drops recall", () => {
    const docIds = fakeDocIds(SET);
    const loops = perfectLoops();
    // The invoice was never closed; the resolution minted a chaser instead.
    loops[0] = { ...loops[0]!, state: "open" };
    loops.push(
      loop({
        id: "l-chaser",
        docs: [docIds.get(arcById(SET, "invoice").steps[1]!.doc.externalId)!],
      }),
    );
    const { metrics, counts } = computeScorecardMetrics(SET, observations(loops), 1);
    expect(counts.duplicatesMinted).toBe(1);
    expect(metrics.duplicateRate).toBeCloseTo(1 / 13, 10);
    expect(metrics.resolutionRecall).toBe(3 / 4);
    expect(metrics.loopPrecision).toBeCloseTo(14 / 15, 10);
  });

  test("closing the ambiguous arc counts a silent-close violation; an unjustified loop drops precision", () => {
    const docIds = fakeDocIds(SET);
    const loops = perfectLoops();
    // The ambiguous lease fulfilment was closed silently...
    loops[2] = { ...loops[2]!, state: "done" };
    // ...and the boring email became a loop.
    loops.push(
      loop({
        id: "l-boring",
        docs: [docIds.get(arcById(SET, "distractor-boring").steps[0]!.doc.externalId)!],
      }),
    );
    const { metrics } = computeScorecardMetrics(SET, observations(loops), 1);
    expect(metrics.silentCloseViolations).toBe(1);
    expect(metrics.loopPrecision).toBeCloseTo(14 / 15, 10);
  });

  test("a wrong-merged bait (no loop for an expecting arc) drops loop_recall, not precision", () => {
    const loops = perfectLoops().filter((l) => l.id !== "l-obligation-quote");
    const { metrics, counts } = computeScorecardMetrics(SET, observations(loops), 1);
    expect(counts.loopArcsTracked).toBe(11);
    expect(metrics.loopRecall).toBeCloseTo(11 / 12, 10);
    expect(metrics.loopPrecision).toBe(1);
    expect(metrics.duplicateRate).toBe(0);
  });

  test("an update datum with no trace on the tracked loop drops update_recall", () => {
    const docIds = fakeDocIds(SET);
    const thread = arcById(SET, "decision-thread");
    const evidence = perfectUpdateEvidence();
    // The third venue datum's run left no ledger entry (and no doc cite).
    evidence.runIdsByDocId.delete(docIds.get(thread.steps[2]!.doc.externalId)!);
    const { metrics, counts } = computeScorecardMetrics(
      SET,
      observations(perfectLoops(), evidence),
      1,
    );
    expect(counts.updatesLanded).toBe(3);
    expect(metrics.updateRecall).toBeCloseTo(3 / 4, 10);
  });

  test("a doc cite on the tracked loop also counts as update evidence", () => {
    const docIds = fakeDocIds(SET);
    const thread = arcById(SET, "decision-thread");
    const noteDocIds = thread.steps
      .filter((s) => s.doc.behavior.onCreated.kind === "note")
      .map((s) => docIds.get(s.doc.externalId)!);
    const nudgeNoteDocId = docIds.get(arcById(SET, "nudge").steps[1]!.doc.externalId)!;
    const loops = perfectLoops().map((l) => {
      if (l.id === "l-decision") return { ...l, docs: [...l.docs, ...noteDocIds] };
      if (l.id === "l-nudge") return { ...l, docs: [...l.docs, nudgeNoteDocId] };
      return l;
    });
    const { metrics } = computeScorecardMetrics(
      SET,
      observations(loops, { runIdsByDocId: new Map(), ledgerRunIdsByLoopId: new Map() }),
      1,
    );
    expect(metrics.updateRecall).toBe(1);
  });

  test("zeroLoopsAcceptable: no loop at all resolves the out-of-order arc; a lingering open loop does not", () => {
    const noLoop = perfectLoops().filter((l) => l.id !== "l-ooo");
    const zero = computeScorecardMetrics(SET, observations(noLoop), 1);
    expect(zero.metrics.resolutionRecall).toBe(1);
    expect(zero.metrics.loopRecall).toBe(1);
    expect(zero.metrics.loopPrecision).toBe(1);

    const open = perfectLoops().map((l) => (l.id === "l-ooo" ? { ...l, state: "open" } : l));
    const lingering = computeScorecardMetrics(SET, observations(open), 1);
    expect(lingering.metrics.resolutionRecall).toBe(3 / 4);
  });

  test("retains raw refusals while partitioning only verified concurrency retries", () => {
    const result = computeScorecardMetrics(
      SET,
      observations(perfectLoops(), {
        mutatingToolCalls: 25,
        mutatingToolCallsFailed: 4,
        verifiedConcurrentCreateRetries: 1,
        verifiedFrontierRetries: 1,
        mutatingToolCallsUncorrected: 2,
      }),
      1,
    );
    expect(result.counts.mutatingToolCallsFailed).toBe(4);
    expect(result.counts.verifiedConcurrentCreateRetries).toBe(1);
    expect(result.counts.malformedToolCallsFailed).toBe(2);
    expect(result.counts.mutatingToolCallsFailed).toBe(
      result.counts.verifiedConcurrentCreateRetries +
        result.counts.verifiedFrontierRetries +
        result.counts.malformedToolCallsFailed,
    );
    expect(result.metrics.malformedToolCallRateRaw).toBe(4 / 25);
    expect(result.metrics.malformedToolCallRate).toBe(2 / 25);
  });

  test("only UNCORRECTED failures gate as malformed_tool_call_rate; the raw rate reports all of them", () => {
    // A self-corrected burst: three failed calls, all followed by a
    // successful same-tool call in the same run. Gated rate stays zero;
    // the raw rate carries the burst.
    const selfCorrected = computeScorecardMetrics(
      SET,
      observations(perfectLoops(), {
        mutatingToolCalls: 25,
        mutatingToolCallsFailed: 3,
        mutatingToolCallsUncorrected: 0,
        scheduledRuns: 5,
      }),
      1,
    ).metrics;
    expect(selfCorrected.malformedToolCallRate).toBe(0);
    expect(selfCorrected.malformedToolCallRateRaw).toBeCloseTo(3 / 25, 10);
    expect(selfCorrected.scheduledRuns).toBe(5);

    // An uncorrected failure gates.
    const uncorrected = computeScorecardMetrics(
      SET,
      observations(perfectLoops(), {
        mutatingToolCalls: 25,
        mutatingToolCallsFailed: 1,
        mutatingToolCallsUncorrected: 1,
      }),
      1,
    ).metrics;
    expect(uncorrected.malformedToolCallRate).toBeCloseTo(1 / 25, 10);
    expect(uncorrected.malformedToolCallRateRaw).toBeCloseTo(1 / 25, 10);
  });

  test("failed runs count into infra_failure_rate; representsDays normalizes the per-day figures", () => {
    const { metrics } = computeScorecardMetrics(
      SET,
      observations(perfectLoops(), { runsCompleted: 8, runsFailed: 2 }),
      2,
    );
    expect(metrics.infraFailureRate).toBeCloseTo(0.2, 10);
    expect(metrics.observationsPerDay).toBe(2.5);
    expect(metrics.tokensPerDay).toBe(45_500);
    expect(() => computeScorecardMetrics(SET, observations(perfectLoops()), 0)).toThrow(
      /representsDays/,
    );
  });
});

test("priced scorecards refuse startup until actual maintenance runs are budgeted", async () => {
  await expect(
    runScorecard({
      gatewayMode: "experimental",
      seed: 1,
      backend: {
        kind: "http",
        backendName: "fixture",
        url: "http://127.0.0.1:1",
        modelId: "fixture",
      },
    }),
  ).rejects.toThrow("actual-run budget reservation");
});

test("counts evidence revisions separately from later retrieval maintenance", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE cognition_runs(id TEXT,kind TEXT,status TEXT,payload_json TEXT,dedupe_key TEXT,usage_json TEXT,enqueued_at INTEGER);
      CREATE TABLE knowledge_work(subject_kind TEXT,subject_id TEXT,reason TEXT,batch_id TEXT,status TEXT DEFAULT 'completed');
      CREATE TABLE knowledge_batches(id TEXT,run_id TEXT);
      INSERT INTO cognition_runs VALUES
        ('initial','synthesis','completed','{}','initial',NULL,1),
        ('catchup','synthesis','completed','{}','catchup',NULL,2),
        ('changed','synthesis','completed','{}','changed',NULL,3),
        ('legacy','data','completed','{}','data:doc:legacy-doc',NULL,4),
        ('pending','synthesis','pending','{}','pending',NULL,5),
        ('handoff','synthesis','completed','{}','handoff',NULL,6);
      INSERT INTO knowledge_batches VALUES ('b1','initial'),('b2','catchup'),('b3','changed'),('b4','pending'),('b5','handoff');
      INSERT INTO knowledge_work(subject_kind,subject_id,reason,batch_id) VALUES
        ('source','doc','change','b1'),('source','doc','review','b2'),
        ('source','doc','change','b3'),('source','doc','change','b4'),
        ('source','other','review','b2');
      INSERT INTO knowledge_work VALUES('source','doc','change','b5','deferred');
    `);
    expect(completedSourceRunCounts(db, ["doc", "other", "legacy-doc"])).toEqual({
      dataRunsCompleted: 3,
      sourceMaintenanceRunsCompleted: 2,
    });
  } finally {
    db.close();
  }
});
