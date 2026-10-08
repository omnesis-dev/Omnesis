// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterEach, expect, it } from "vitest";
import { BrainBench, compressCognitionCadences } from "./brain-bench/bench.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
afterEach(async () => {
  await bench?.destroy();
});

it("keeps pre-existing inventory searchable while admitting new arrivals and edits normally", async () => {
  bench = await BrainBench.start({
    experimental: true,
    initialInventory: "pre-existing",
    brain: { bootstrap: { enabled: false }, derivationBarrier: "0s" },
    decision: {
      policy: (request) =>
        Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => {
            if (question.type !== "score") throw new Error("Expected a score question");
            return [
              key,
              {
                type: "score",
                score: key === "urgency" ? question.criteria.length - 1 : 0,
                confidence: 1,
              },
            ];
          }),
        ),
    },
  });
  expect(bench.initialInventory!.documentCount).toBeGreaterThan(0);
  expect(bench.initialInventory!.sourceChangeCount).toBeGreaterThan(0);
  await bench.drainUntilQuiet();
  expect(bench.sql.prepare("SELECT COUNT(*) AS count FROM cognition_runs").get()).toEqual({
    count: 0,
  });
  expect(
    bench.sql.prepare("SELECT COUNT(*) AS count FROM knowledge_discovery_coverage").get(),
  ).toEqual({ count: 0 });
  const existing = bench.sql
    .prepare<
      [],
      { externalId: string; sourceId: string; providerId: string; title: string; content: string }
    >("SELECT external_id AS externalId,source_id AS sourceId,provider_id AS providerId,title,content FROM documents WHERE content IS NOT NULL LIMIT 1")
    .get()!;
  const search = await bench.harness.gatewayJson<{ results: unknown[] }>(
    `/documents/search?q=${encodeURIComponent(existing.title)}&limit=1`,
  );
  expect(search.results.length).toBeGreaterThan(0);
  await bench.push({
    ...existing,
    content: `${existing.content}\nA newly arrived fictional update.`,
  });
  await bench.push({
    externalId: "inventory-followup",
    sourceId: existing.sourceId,
    providerId: existing.providerId,
    title: "New inventory followup",
    content: "A fictional workshop followup arrived after activation.",
  });
  await bench.drainUntilQuiet();
  expect(
    bench.sql
      .prepare(
        "SELECT COUNT(DISTINCT subject_id) AS count FROM knowledge_work WHERE subject_kind='source'",
      )
      .get(),
  ).toEqual({ count: 2 });
  expect(
    bench.sql
      .prepare(
        "SELECT COUNT(*) AS count FROM knowledge_discovery_coverage WHERE phase='organization' AND status='gated'",
      )
      .get(),
  ).toEqual({ count: 2 });
  expect((await bench.obs.runs({ status: "failed" })).items).toEqual([]);
}, 180_000);

it.each([
  { recentWindowDays: 3650, discovers: true },
  { recentWindowDays: 1, discovers: false },
])(
  "classifies real collector inventory with a $recentWindowDays-day recent window",
  async ({ recentWindowDays, discovers }) => {
    bench = await BrainBench.start({
      experimental: true,
      syncSources: false,
      brain: {
        bootstrap: { enabled: false },
        derivationBarrier: "0s",
        knowledge: { recentWindowDays, soonDelay: "0s", routineDelay: "0s" },
      },
      decision: {
        policy: (request) =>
          Object.fromEntries(
            Object.entries(request.questions).map(([key, question]) => {
              if (question.type !== "score") throw new Error("Expected a score question");
              return [
                key,
                {
                  type: "score",
                  score: key === "urgency" ? question.criteria.length - 1 : 0,
                  confidence: 1,
                },
              ];
            }),
          ),
      },
    });
    // Exercise the actual SyncEngine/cursor-page protocol, without a fixture-only inventory marker.
    await bench.harness.syncAllSources();
    await bench.drainUntilQuiet();
    const imported = bench.sql
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM source_inventory_documents")
      .get()!.count;
    expect(imported).toBeGreaterThan(0);
    expect(
      bench.sql
        .prepare<
          [],
          { count: number }
        >("SELECT COUNT(*) AS count FROM source_inventories WHERE completed_at IS NOT NULL")
        .get()!.count,
    ).toBeGreaterThan(0);
    const coverage = bench.sql
      .prepare<
        [],
        { count: number }
      >("SELECT COUNT(*) AS count FROM knowledge_discovery_coverage WHERE phase='organization' AND status='gated'")
      .get()!.count;
    if (discovers) expect(coverage).toBeGreaterThan(0);
    else expect(coverage).toBe(0);
    expect((await bench.obs.runs({ status: "failed" })).items).toEqual([]);
  },
  180_000,
);
