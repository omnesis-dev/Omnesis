// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, expect, it } from "vitest";
import { BrainBench, compressCognitionCadences } from "./brain-bench/bench.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
afterAll(async () => {
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
