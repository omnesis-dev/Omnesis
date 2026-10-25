// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, expect, it } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  waitFor,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";
import { startFakeEmbedderServer, type FakeEmbedderServer } from "./fake-embedder.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
let embedder: FakeEmbedderServer | undefined;
afterAll(async () => {
  await bench?.destroy();
  await embedder?.close();
}, 60_000);

it("reconsiders a joint decision once actual index publication fills its late search gap", async () => {
  embedder = await startFakeEmbedderServer();
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    entailment: "accept-all",
    extraInference: { backends: { publication: { type: "http", url: embedder.url } } },
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "6h" },
    },
    behaviors: {
      dynamic: knowledgePuppet({
        plan: preserveCurrentOwner,
        // Search happens after source frontiers settle: the joint completion
        // must capture this gap even though source completion could not.
        organize: () => ({
          calls: [
            call("search_many", {
              queries: [{ query: "observatory visitor arrangements", limit: 5 }],
            }),
          ],
        }),
        organizationOutcome: () => ({
          outcome: "no_page",
          reasonCode: "insufficient_shared_context",
        }),
      }),
    },
  });
  for (const doc of [
    email({
      externalId: "publication-observatory-access",
      title: "Observatory access",
      content: "The observatory visitor group enters through the east gate.",
    }),
    email({
      externalId: "publication-observatory-equipment",
      title: "Observatory equipment",
      content: "The observatory visitor group may use the portable telescope.",
    }),
  ])
    await bench.push(doc);
  const completed = () =>
    bench!.sql
      .prepare<
        [],
        {
          id: string;
          created_at: number;
          retry_at: number;
          retrieval_boundary: string | null;
          retrieval_reconsidered: number;
          retrieval_reconsider_at: number | null;
        }
      >(
        "SELECT id,created_at,retry_at,retrieval_boundary,retrieval_reconsidered,retrieval_reconsider_at FROM knowledge_organization_cohorts WHERE status='completed' ORDER BY created_at,id",
      )
      .all();
  await waitFor(
    "initial joint decision with unpublished retrieval",
    () => (completed().length === 1 ? true : null),
    90_000,
  );
  await bench.drainUntilQuiet({ includeUpcoming: false });
  const initial = completed()[0]!;
  expect(initial.retrieval_boundary).toEqual(expect.any(String));
  expect(initial.retrieval_reconsidered).toBe(0);
  expect(initial.retry_at - initial.created_at).toBeGreaterThan(24 * 60 * 60 * 1000);

  // Configure the existing fake inference backend through the real operator
  // config path. No index watermark or Brain scheduling row is forged.
  bench.harness.setEmbedderAssignment(`publication/${embedder.modelId}`);
  await waitFor(
    "publication-backed joint reconsideration",
    () => (completed().length >= 2 ? true : null),
    120_000,
  );
  await bench.drainUntilQuiet({ includeUpcoming: false });
  const after = completed();
  expect(after).toHaveLength(2);
  expect(after[0]).toMatchObject({
    id: initial.id,
    retrieval_reconsidered: 1,
    retrieval_reconsider_at: null,
  });
  expect(after[1]!.created_at).toBeLessThan(initial.retry_at);
  expect(after[1]!.created_at - initial.created_at).toBeLessThan(6 * 60 * 60 * 1000);
  const members = (id: string) =>
    bench!.sql
      .prepare(
        "SELECT source_id,content_hash FROM knowledge_organization_members WHERE cohort_id=? ORDER BY source_id",
      )
      .all(id);
  expect(members(after[1]!.id)).toEqual(members(initial.id));
  // Repeated publication/reconciliation ticks must not manufacture another
  // paid cohort, and a reconsidered no-page decision need not create a wiki.
  await bench.harness.refreshSearchSnapshot();
  await bench.drainUntilQuiet({ includeUpcoming: false });
  expect(completed()).toHaveLength(2);
  expect(
    bench.sql.prepare("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE kind='wiki'").get(),
  ).toEqual({ n: 0 });
}, 300_000);
