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

/**
 * A resync or migration that rewrites stored rows the Brain never read must
 * not turn each into reactive maintenance: the rewrite of an old document is
 * history, while an edit its provider dates now stays a live change.
 */
it("leaves rewrites of unread old documents to historical admission and keeps live edits reactive", async () => {
  bench = await BrainBench.start({
    experimental: true,
    initialInventory: "pre-existing",
    brain: {
      bootstrap: { enabled: false, horizon: "3650d" },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "0s", routineDelay: "0s" },
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
  await bench.drainUntilQuiet();
  const cutoff = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const stored = bench.sql
    .prepare<
      [string],
      {
        id: string;
        externalId: string;
        sourceId: string;
        providerId: string;
        title: string;
        content: string;
        at: string;
      }
    >(
      `SELECT id,external_id AS externalId,source_id AS sourceId,provider_id AS providerId,title,content,source_created_at AS at
      FROM documents WHERE content IS NOT NULL AND source_created_at<? ORDER BY source_created_at,id LIMIT 2`,
    )
    .all(cutoff);
  expect(stored).toHaveLength(2);
  const [rewritten, edited] = stored as [(typeof stored)[0], (typeof stored)[0]];
  // The rewrite keeps the document's own dates, as a renormalizing resync does.
  await bench.push({
    externalId: rewritten.externalId,
    sourceId: rewritten.sourceId,
    providerId: rewritten.providerId,
    title: rewritten.title,
    content: `${rewritten.content}\nRenormalized by a fictional resync.`,
    at: Date.parse(rewritten.at),
  });
  // The provider dates this edit now: the owner changed it.
  await bench.push({
    externalId: edited.externalId,
    sourceId: edited.sourceId,
    providerId: edited.providerId,
    title: edited.title,
    content: `${edited.content}\nA fictional correction made today.`,
  });
  await bench.drainUntilQuiet();
  const work = (id: string) =>
    bench!.sql
      .prepare("SELECT reason FROM knowledge_work WHERE subject_kind='source' AND subject_id=?")
      .all(id);
  // The row really was rewritten: its source revision moved on.
  expect(
    bench.sql
      .prepare(
        "SELECT generation>0 AS rewritten FROM knowledge_source_revisions WHERE document_id=?",
      )
      .get(rewritten.id),
  ).toEqual({ rewritten: 1 });
  expect(work(rewritten.id)).toEqual([]);
  expect(work(edited.id)).toEqual([{ reason: "change" }]);
  expect(
    bench.sql
      .prepare<[string], { count: number }>(
        "SELECT COUNT(*) AS count FROM knowledge_decisions WHERE purpose='urgency' AND node_id=?",
      )
      .get(`source:${rewritten.id}`),
  ).toEqual({ count: 0 });
  // The journal holds nothing for it: intake acknowledged the rewrite.
  expect(
    bench.sql.prepare("SELECT 1 FROM knowledge_changes WHERE entity_id=?").get(rewritten.id),
  ).toBeUndefined();
  expect((await bench.obs.runs({ status: "failed" })).items).toEqual([]);
}, 180_000);
