// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Historical discovery applies the current relevance rubric and records
 * separate interpretation/organization milestones, including gated revisions.
 */
import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  preserveCurrentOwner,
  compressCognitionCadences,
  sourceInterpretations,
  seedHistory,
  historicalAdmissions,
  waitFor,
  type DecisionServerRequest,
} from "./brain-bench/index.js";
compressCognitionCadences();
const SOURCE = "synthetic:archive@example.com";
const MAILS = [
  {
    id: "history-promotion",
    title: "Outlet clearance notice",
    content: "Generic clearance announcement with no personal context.",
    score: 0,
  },
  {
    id: "history-booking",
    title: "Workshop booking confirmation",
    content: "Your workshop starts on 12 March 2029. The balance is due two weeks before arrival.",
    score: 2,
  },
];
function decision(request: DecisionServerRequest) {
  const purpose = Object.keys(request.questions)[0]!;
  const state = request.state as { source?: { title?: string }; title?: string };
  const mail = MAILS.find((m) => m.title === (state.source?.title ?? state.title));
  return {
    [purpose]: { type: "score" as const, score: purpose === "discovery" ? (mail?.score ?? 2) : 2 },
  };
}
describe("historical discovery: relevance gate", () => {
  let bench: BrainBench;
  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      decision: { policy: decision, inputTokens: 300 },
      brain: {
        knowledge: { soonDelay: "0s", routineDelay: "0s", maxSeeds: 1, maxFrontierNodes: 1 },
        derivationBarrier: "0s",
        mergeAdjudication: { enabled: false },
        bootstrap: {
          enabled: true,
          direction: "recent-first",
          backlogTarget: 5,
          maxRunsPerDay: 5,
          maxRuns: 50,
          batchSize: 10,
        },
      },
      behaviors: {
        dynamic: sourceInterpretations({
          maintainNode: preserveCurrentOwner,
          sources: [{ plan: { calls: [] } }],
        }),
      },
    });
    await bench.drainUntilQuiet();
    const { now } = await bench.clock.now();
    MAILS.forEach((mail, i) =>
      seedHistory(bench, { ...mail, at: now - (8 + i) * 86_400_000, sourceId: SOURCE }),
    );
    await bench.obs.startBootstrap();
    await waitFor(
      "both historical source admissions",
      () => (historicalAdmissions(bench).length === 2 ? true : null),
      120_000,
    );
    await bench.drainUntilQuiet();
  }, 600_000);
  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);
  test("both admitted historical revisions are judged with the current discovery rubric", () => {
    expect(historicalAdmissions(bench).map((w) => w.subject_id)).toEqual(MAILS.map((m) => m.id));
    for (const mail of MAILS) {
      const calls = bench.decision.calls.filter((c) => {
        const state = c.request.state as { source?: { title?: string } };
        return !!c.request.questions.discovery && state.source?.title === mail.title;
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.request.questions.discovery).toMatchObject({ type: "score" });
    }
  });
  test("a low-relevance historical source settles gated without source interpretation", async () => {
    expect(await bench.obs.runsForSource(MAILS[0]!.id)).toHaveLength(0);
    expect(
      bench.sql
        .prepare<
          [string],
          { status: string }
        >("SELECT status FROM knowledge_work WHERE subject_id=? AND reason='discovery'")
        .get(MAILS[0]!.id)?.status,
    ).toBe("completed");
    const coverage = bench.sql
      .prepare<
        [string],
        { phase: string; status: string }
      >("SELECT phase,status FROM knowledge_discovery_coverage WHERE subject_id=?")
      .all(MAILS[0]!.id);
    expect(coverage).toEqual(
      expect.arrayContaining([
        { phase: "interpretation", status: "gated" },
        { phase: "organization", status: "gated" },
      ]),
    );
  });
  test("a relevant historical source executes the model and real discovery tools", async () => {
    const run = await bench.obs.interpretationForSource(MAILS[1]!.id);
    expect(run.status).toBe("completed");
    expect(bench.puppetCalls.some((c) => c.runId === run.id)).toBe(true);
    expect(
      (await bench.obs.executedTools(run.id)).some(
        (t) => t.tool === "knowledge_discovery_complete",
      ),
    ).toBe(true);
  });
  test("gated coverage stays distinct from considered coverage in the current operator projection", async () => {
    const row = (await bench.obs.coverage()).items.find(
      (r) => r.sourceId === SOURCE && r.workflowId === "knowledge-maintenance",
    );
    expect(row).toMatchObject({
      eligible: 2,
      processed: 1,
      skipped: 1,
      unit: "source-revisions",
      costAttribution: "shared-run-ledger",
    });
    const status = await bench.obs.bootstrapStatus();
    expect(status.admission?.completed).toBe(2);
    expect(status.corpusCompletion).toBe("not-measured");
    const verdicts = bench.sql
      .prepare<
        [],
        { score: number | null; rubric_version: string }
      >("SELECT score,rubric_version FROM knowledge_decisions WHERE purpose='discovery'")
      .all();
    expect(verdicts.some((v) => v.score === 0)).toBe(true);
    expect(verdicts.every((v) => v.rubric_version === "knowledge-decisions-v2")).toBe(true);
  });
});
