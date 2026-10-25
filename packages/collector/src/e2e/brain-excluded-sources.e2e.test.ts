// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `brain.excludedSources` end to end: a source the operator excludes is never
 * admitted by live intake or historical review, a Brain run's search cannot
 * see its documents and a fetch of one is refused, the interactive search
 * still finds them, and removing the exclusion makes them eligible again
 * without a restart.
 */
import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  historicalAdmissions,
  preserveCurrentOwner,
  seedHistory,
  sourceInterpretations,
  waitFor,
} from "./brain-bench/index.js";

compressCognitionCadences();
const DAY = 86_400_000;
const EXCLUDED_TYPE = "assistant-log";
const EXCLUDED_SOURCE = `${EXCLUDED_TYPE}:workstation`;
const ARCHIVE = "synthetic:archive@example.com";
const QUERY = "lantern rehearsal";

function knowledgeWork(bench: BrainBench, docId: string): number {
  return bench.sql
    .prepare<
      [string],
      { n: number }
    >("SELECT COUNT(*) AS n FROM knowledge_work WHERE subject_kind='source' AND subject_id=?")
    .get(docId)!.n;
}

describe("brain.excludedSources", () => {
  let bench: BrainBench;
  let excludedLiveId = "";
  let allowedContextId = "";
  let probeId = "";
  let excludedHistoryId = "";
  let allowedHistoryId = "";
  let interactiveHits: string[] = [];

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      embedder: true,
      syncSources: false,
      brain: {
        excludedSources: [EXCLUDED_TYPE],
        derivationBarrier: "0s",
        mergeAdjudication: { enabled: false },
        knowledge: { soonDelay: "0s", routineDelay: "0s" },
        bootstrap: { enabled: true, maxRunsPerDay: 20, maxRuns: 50, backlogTarget: 20 },
      },
      behaviors: {
        dynamic: sourceInterpretations({
          maintainNode: preserveCurrentOwner,
          sources: [
            {
              docTitle: "Lantern rehearsal probe",
              expectedRefusals: [{ tool: "fetch_many", code: "excluded_source" }],
              plan: () => ({
                calls: [
                  call("search_many", { queries: [{ query: QUERY, limit: 10 }] }),
                  call("fetch_many", { documents: [{ documentId: excludedLiveId }] }),
                ],
              }),
            },
          ],
        }),
      },
    });
    await bench.drainUntilQuiet();
    await bench.pushAll([
      {
        externalId: "excluded-lantern-session",
        title: "Lantern rehearsal session log",
        content: "Session notes: the lantern rehearsal moves to the north hall on Thursday.",
        documentType: "document",
        sourceId: EXCLUDED_SOURCE,
        providerId: EXCLUDED_SOURCE,
      },
      {
        externalId: "allowed-lantern-context",
        title: "Lantern rehearsal schedule",
        content: "The lantern rehearsal schedule lists the north hall booking for Thursday.",
        documentType: "document",
      },
    ]);
    excludedLiveId = await bench.docId("excluded-lantern-session");
    allowedContextId = await bench.docId("allowed-lantern-context");
    await bench.drainUntilQuiet();
    // Ingestion is not index readiness: wait until ordinary search, which the
    // exclusion never touches, returns both documents.
    interactiveHits = await waitFor(
      "both lantern documents indexed",
      async () => {
        await bench.harness.refreshSearchSnapshot();
        const response = await bench.harness.gatewayJson<{
          results: Array<{ documentId?: string; id?: string }>;
        }>("/search", { method: "POST", body: JSON.stringify({ text: QUERY, limit: 10 }) });
        const ids = response.results.map((hit) => hit.documentId ?? hit.id ?? "");
        return ids.includes(excludedLiveId) && ids.includes(allowedContextId) ? ids : null;
      },
      120_000,
    );
    [probeId] = await bench.pushAndSettle([
      {
        externalId: "allowed-lantern-probe",
        title: "Lantern rehearsal probe",
        content: "Who is bringing the lanterns to the rehearsal?",
        documentType: "document",
      },
    ]);
  }, 600_000);
  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a live arrival from an excluded source is never admitted", async () => {
    expect(knowledgeWork(bench, excludedLiveId)).toBe(0);
    expect(await bench.obs.runsForSource(excludedLiveId)).toHaveLength(0);
    expect(await bench.obs.runsForSource(allowedContextId)).not.toHaveLength(0);
  });

  test("a Brain run's search omits it and a fetch of it is refused", async () => {
    // Every attempt of every run that interpreted the probe, so a retried
    // attempt cannot hide a step.
    const steps = (
      await Promise.all(
        (await bench.obs.runsForSource(probeId)).map((run) => bench.obs.executedTools(run.id)),
      )
    ).flat();
    const searches = steps.filter((step) => step.tool === "search_many");
    expect(searches.length).toBeGreaterThan(0);
    for (const search of searches) {
      expect(search.result?.kind).toBe("search.batch");
      const found = JSON.stringify(search.result);
      expect(found).toContain(allowedContextId);
      expect(found).not.toContain(excludedLiveId);
    }
    const fetches = steps.filter(
      (step) => step.tool === "fetch_many" && JSON.stringify(step.args).includes(excludedLiveId),
    );
    expect(fetches.length).toBeGreaterThan(0);
    for (const fetch of fetches)
      expect(fetch.result).toMatchObject({ kind: "error", code: "excluded_source" });
  });

  test("ordinary search, outside the Brain, still finds it", () => {
    expect(interactiveHits).toContain(excludedLiveId);
  });

  test("historical review never admits it while it is excluded", async () => {
    excludedHistoryId = seedHistory(bench, {
      id: "history-excluded-lantern",
      title: "Lantern workshop session log",
      content: "Earlier session notes about the lantern workshop.",
      at: Date.now() - 8 * DAY,
      sourceId: EXCLUDED_SOURCE,
    });
    allowedHistoryId = seedHistory(bench, {
      id: "history-allowed-lantern",
      title: "Lantern workshop booking",
      content: "The lantern workshop booking for the north hall is confirmed.",
      at: Date.now() - 8 * DAY,
      sourceId: ARCHIVE,
    });
    await bench.obs.startBootstrap();
    await waitFor(
      "the allowed historical admission",
      () =>
        historicalAdmissions(bench).some((w) => w.subject_id === allowedHistoryId) ? true : null,
      120_000,
    );
    await bench.drainUntilQuiet();
    const admitted = historicalAdmissions(bench).map((w) => w.subject_id);
    expect(admitted).not.toContain(excludedHistoryId);
    expect(admitted).not.toContain(excludedLiveId);
    expect(knowledgeWork(bench, excludedHistoryId)).toBe(0);
    expect((await bench.obs.bootstrapStatus()).excludedSources).toEqual([EXCLUDED_TYPE]);
    const timeline = await bench.obs.bootstrapTimeline();
    const excluded = timeline.months.reduce((sum, month) => sum + month.interpretation.excluded, 0);
    expect(excluded).toBeGreaterThanOrEqual(2);
  }, 300_000);

  test("removing the exclusion makes its documents eligible again without a restart", async () => {
    await bench.patchConfig({ brain: { excludedSources: [] } });
    await waitFor(
      "the formerly excluded history to be admitted",
      () =>
        historicalAdmissions(bench).some((w) => w.subject_id === excludedHistoryId) ? true : null,
      120_000,
    );
    await bench.drainUntilQuiet();
    expect(await bench.obs.runsForSource(excludedHistoryId)).not.toHaveLength(0);
  }, 300_000);
});
