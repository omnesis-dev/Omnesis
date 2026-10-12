// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Historical discovery uses the same real maintenance tools as live intake.
 * Persisted history fixtures distinguish operator admission from new arrivals;
 * coverage belongs to a source revision, never to merely opening a document.
 */
import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  sourceInterpretations,
  preserveCurrentOwner,
  seedHistory,
  historicalAdmissions,
  sleep,
  waitFor,
} from "./brain-bench/index.js";

compressCognitionCadences();
const DAY = 86_400_000;
const SRC = "synthetic:archive@example.com";
const OFF = {
  knowledge: { soonDelay: "0s", routineDelay: "0s", maxSeeds: 1, maxFrontierNodes: 1 },
  derivationBarrier: "0s",
  mergeAdjudication: { enabled: false },
};
function covered(bench: BrainBench, docId: string): boolean {
  return !!bench.sql
    .prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n
    FROM knowledge_discovery_coverage c JOIN documents d ON d.id=c.subject_id
    WHERE d.id=? AND c.input_revision=d.content_hash AND c.phase='organization'
      AND c.status='considered'`,
    )
    .get(docId)?.n;
}

describe("historical discovery: writes and revision coverage", () => {
  let bench: BrainBench;
  let leaseId = "";
  let annexeId = "";
  const title = "Rehearsal room lease renewal";
  const quote = "renews on 14 March 2029";
  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      // Admission limits apply only to this scenario's explicit history.
      syncSources: false,
      clock: "virtual",
      brain: {
        ...OFF,
        bootstrap: {
          enabled: true,
          direction: "recent-first",
          backlogTarget: 1,
          maxRunsPerDay: 1,
          maxRuns: 50,
          batchSize: 10,
        },
      },
      behaviors: {
        dynamic: sourceInterpretations({
          maintainNode: preserveCurrentOwner,
          sources: [
            {
              docTitle: title,
              plan: (ctx) => ({
                calls: [
                  call("fetch_many", { documents: [{ documentId: annexeId }] }),
                  call("temporal_query", { from: "2029-03-01", to: "2029-03-31" }),
                  call("temporal_annotation_add", {
                    when: "2029-03-14",
                    sentence: "BS-LEASE rehearsal room lease renews.",
                    kind: "event",
                    documentIds: [ctx.subject!],
                    evidence: { docId: ctx.subject!, quote },
                  }),
                  call("open_loop_search", { query: "lease notice" }),
                  call("open_loop_create", {
                    title: "BS-LOOP Decide on the lease before renewal",
                    description: "Give written notice before renewal if ending the lease.",
                    confidence: 0.85,
                    importance: 0.6,
                    docs: [ctx.subject],
                  }),
                ],
                finalText: "Seeded the renewal and notice decision.",
              }),
            },
          ],
        }),
      },
    });
    await bench.drainUntilQuiet();
    const { now } = await bench.clock.now();
    leaseId = seedHistory(bench, {
      id: "history-lease",
      title,
      content: `The rehearsal room lease ${quote}. Give written notice if ending the lease.`,
      at: now - 8 * DAY,
      sourceId: SRC,
    });
    annexeId = seedHistory(bench, {
      id: "history-annexe",
      title: "Annexe access terms",
      content: "Annexe access continues until 14 March 2029 under the same agreement.",
      at: now - 9 * DAY,
      sourceId: SRC,
    });
    await bench.obs.startBootstrap();
    await waitFor(
      "first historical admission",
      () => (historicalAdmissions(bench).length === 1 ? true : null),
      120_000,
    );
    await bench.drainUntilQuiet();
  }, 600_000);
  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("recent-first admits one newest source revision under the daily bound", async () => {
    expect(historicalAdmissions(bench).map((w) => w.subject_id)).toEqual([leaseId]);
    expect((await bench.obs.interpretationForSource(leaseId)).status).toBe("completed");
    expect(await bench.obs.settledRuns("bootstrap")).toHaveLength(0);
  });
  test("the historical source writes its grounded future appointment", async () => {
    const window = await bench.obs.temporalWindow({
      from: Date.parse("2029-03-01"),
      to: Date.parse("2029-04-01"),
    });
    expect(JSON.stringify(window.items)).toContain("BS-LEASE");
  });
  test("the historical obligation becomes a real open loop", async () => {
    const loops = await bench.obs.loopsMatching("BS-LOOP");
    expect(loops).toHaveLength(1);
    expect(loops[0]!.state).toBe("open");
  });
  test("opening an arc document does not invent organization coverage", async () => {
    const run = await bench.obs.interpretationForSource(leaseId);
    expect(JSON.stringify(await bench.obs.executedTools(run.id))).toContain(annexeId);
    expect(covered(bench, leaseId)).toBe(true);
    expect(covered(bench, annexeId)).toBe(false);
  });
  test("the next day admits the uncovered arc and never rebuys the covered revision", async () => {
    await bench.clock.advance(DAY);
    await waitFor(
      "the uncovered historical arc admission",
      () => (historicalAdmissions(bench).some((w) => w.subject_id === annexeId) ? true : null),
      120_000,
    );
    await bench.drainUntilQuiet();
    expect(historicalAdmissions(bench).filter((w) => w.subject_id === leaseId)).toHaveLength(1);
    expect(covered(bench, annexeId)).toBe(true);
  }, 300_000);
});

describe("historical discovery: boundary with live intake", () => {
  let bench: BrainBench;
  let coveredId = "";
  let controlId = "";
  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      // Admission limits apply only to this scenario's explicit history.
      syncSources: false,
      clock: "virtual",
      brain: { ...OFF, bootstrap: { enabled: true, maxRunsPerDay: 10, maxRuns: 50 } },
      behaviors: {
        dynamic: sourceInterpretations({ maintainNode: preserveCurrentOwner, sources: [] }),
      },
    });
    await bench.drainUntilQuiet();
    const { now } = await bench.clock.now();
    [coveredId] = await bench.pushAndSettle([
      {
        externalId: "history-live-covered",
        title: "Equipment service term",
        content: "Equipment service continues through 9 October 2029.",
        documentType: "document",
        at: now - DAY,
      },
    ]);
    controlId = seedHistory(bench, {
      id: "history-uncovered-control",
      title: "Workshop booking term",
      content: "Workshop access continues through 9 October 2029.",
      at: now - 8 * DAY,
      sourceId: SRC,
    });
  }, 600_000);
  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);
  test("live completion covers its revision while untouched persisted history stays uncovered", () => {
    expect(covered(bench, coveredId)).toBe(true);
    expect(covered(bench, controlId)).toBe(false);
  });
  test("aging a covered source does not re-admit it when history is authorized", async () => {
    await bench.clock.advance(10 * DAY);
    await bench.obs.startBootstrap();
    await waitFor(
      "historical control admission",
      () => (historicalAdmissions(bench).some((w) => w.subject_id === controlId) ? true : null),
      120_000,
    );
    await bench.drainUntilQuiet();
    const admitted = historicalAdmissions(bench).map((w) => w.subject_id);
    expect(admitted).toContain(controlId);
    expect(admitted).not.toContain(coveredId);
  }, 300_000);
});

describe("historical discovery: admission lifecycle", () => {
  let bench: BrainBench;
  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      // Admission limits apply only to this scenario's explicit history.
      syncSources: false,
      clock: "virtual",
      brain: {
        ...OFF,
        bootstrap: { enabled: true, maxRuns: 1, maxRunsPerDay: 10, backlogTarget: 10 },
      },
      behaviors: {
        dynamic: sourceInterpretations({ maintainNode: preserveCurrentOwner, sources: [] }),
      },
    });
    await bench.drainUntilQuiet();
    const { now } = await bench.clock.now();
    for (let i = 0; i < 2; i++)
      seedHistory(bench, {
        id: `history-life-${i}`,
        title: `Workshop archive ${i}`,
        content: "Archived workshop planning details.",
        at: now - (8 + i) * DAY,
        sourceId: SRC,
      });
    await bench.obs.startBootstrap();
    await waitFor(
      "lifetime-bound historical admission",
      () => (historicalAdmissions(bench).length === 1 ? true : null),
      120_000,
    );
    await bench.drainUntilQuiet();
  }, 600_000);
  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);
  test("the lifetime admission ceiling parks history without retiring source work", async () => {
    const status = await bench.obs.bootstrapStatus();
    expect(status.mode).toBe("knowledge");
    expect(status.state).toBe("parked");
    expect(status.admission?.total).toBe(1);
    expect(status.admission?.completed).toBe(1);
  });
  test("raising the ceiling resumes real historical work without restart", async () => {
    await bench.patchConfig({ brain: { bootstrap: { maxRuns: 50 } } });
    await waitFor(
      "history resumes after ceiling increase",
      () => (historicalAdmissions(bench).length === 2 ? true : null),
      120_000,
    );
    await bench.drainUntilQuiet();
    expect((await bench.obs.bootstrapStatus()).state).toBe("running");
  }, 300_000);
  test("an empty queue reports measured admission instead of claiming corpus completion", async () => {
    const status = await bench.obs.bootstrapStatus();
    expect(status.admission?.pending).toBe(0);
    expect(status.admission?.batched).toBe(0);
    expect(status.corpusCompletion).toBe("not-measured");
  });
  test("a later source's persisted history is discovered without a day change or roster trick", async () => {
    const { now } = await bench.clock.now();
    const id = seedHistory(bench, {
      id: "history-new-source",
      title: "Annexe archive",
      content: "Annexe workshop planning details.",
      at: now - 9 * DAY,
      sourceId: "synthetic:annexe@example.com",
    });
    await waitFor(
      "new source history admission",
      () => (historicalAdmissions(bench).some((w) => w.subject_id === id) ? true : null),
      120_000,
    );
    await bench.drainUntilQuiet();
    expect(covered(bench, id)).toBe(true);
  }, 300_000);
  test("deleted history is excluded before admission and creates no remembered prose", async () => {
    const { now } = await bench.clock.now();
    let id = "";
    // Atomic fixture establishes deletion before the engine can select it.
    await bench.patchConfig({
      brain: { bootstrap: { maxRuns: historicalAdmissions(bench).length } },
    });
    id = seedHistory(bench, {
      id: "history-doomed",
      title: "Cancelled workshop booking",
      content: "The workshop booking has been cancelled.",
      at: now - 10 * DAY,
      sourceId: SRC,
    });
    await bench.deleteDoc(id);
    await bench.patchConfig({ brain: { bootstrap: { maxRuns: 50 } } });
    await bench.drainUntilQuiet();
    expect(historicalAdmissions(bench).some((w) => w.subject_id === id)).toBe(false);
    expect(await bench.obs.runsForSource(id)).toHaveLength(0);
  }, 300_000);
});

describe("historical discovery: provider outage", () => {
  let bench: BrainBench;
  const id = "history-outage";
  const failedRuns = () =>
    bench.sql
      .prepare<
        [],
        { id: string; status: string; attempts: number; last_error: string | null }
      >("SELECT id,status,attempts,last_error FROM cognition_runs WHERE kind='synthesis' AND last_error LIKE '%412%'")
      .all();
  const openUntil = () => Number(bench.markers.get("provider_breaker_open_until") ?? "0");
  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      // Admission limits apply only to this scenario's explicit history.
      syncSources: false,
      clock: "virtual",
      brain: {
        ...OFF,
        bootstrap: { enabled: true, maxRunsPerDay: 1, maxRuns: 50, backlogTarget: 1 },
      },
      behaviors: {
        dynamic: sourceInterpretations({
          maintainNode: preserveCurrentOwner,
          sources: [
            {
              docTitle: "Storage term renewal",
              plan: (ctx) => ({
                calls: [
                  call("temporal_query", { from: "2031-10-01", to: "2031-11-01" }),
                  call("temporal_annotation_add", {
                    when: "2031-10-09",
                    sentence: "BS-OUTAGE storage term renews.",
                    kind: "event",
                    documentIds: [ctx.subject!],
                    evidence: { docId: ctx.subject!, quote: "renews on 9 October 2031" },
                  }),
                ],
              }),
            },
          ],
        }),
      },
    });
    await bench.drainUntilQuiet();
    const { now } = await bench.clock.now();
    seedHistory(bench, {
      id,
      title: "Storage term renewal",
      content: "The storage term renews on 9 October 2031.",
      at: now - 8 * DAY,
      sourceId: SRC,
    });
    bench.refuseModelWith(412, "Account has insufficient credit.");
    await bench.obs.startBootstrap();
    await waitFor(
      "maintenance refusal reached the real backend",
      () => (failedRuns().length ? true : null),
      120_000,
    );
    for (let i = 0; i < 15 && openUntil() === 0; i++) {
      await bench.clock.advance(61_000);
      await sleep(3_000);
    }
    await waitFor("provider breaker opens", () => (openUntil() > 0 ? true : null), 30_000);
  }, 600_000);
  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);
  test("an outage leaves maintenance retryable rather than deciding the source is irrelevant", () => {
    expect(failedRuns().length).toBeGreaterThan(0);
    expect(failedRuns().every((r) => r.status === "pending")).toBe(true);
    expect(covered(bench, id)).toBe(false);
  });
  test("provider refusals refund run attempts", () => {
    expect(failedRuns().every((r) => r.attempts <= 1)).toBe(true);
  });
  test("the bootstrap panel exposes the provider outage", async () => {
    const status = await bench.obs.bootstrapStatus();
    expect(status.providerOutage).not.toBeNull();
    expect(status.providerOutage!.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(status.providerOutage!.lastError).toContain("412");
  });
  test("the same admitted revision is interpreted when credit returns", async () => {
    bench.refuseModelWith(null);
    await bench.clock.advance(20 * 60_000);
    await bench.drainUntilQuiet({ timeoutMs: 180_000 });
    expect(covered(bench, id)).toBe(true);
    expect(historicalAdmissions(bench).filter((w) => w.subject_id === id)).toHaveLength(1);
    const window = await bench.obs.temporalWindow({
      from: Date.parse("2031-10-01"),
      to: Date.parse("2031-11-01"),
    });
    expect(JSON.stringify(window.items)).toContain("BS-OUTAGE");
  }, 300_000);
});
