// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  waitFor,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";
import { structuredData } from "./brain-bench/puppet-plan.js";

compressCognitionCadences();
const documents = [
  email({
    externalId: "joint-studio-location",
    title: "Studio arrangement",
    content: "The ceramics workshop uses the community studio.",
  }),
  email({
    externalId: "joint-studio-supply",
    title: "Studio supplies",
    content: "The community studio supplies the clay for the ceramics workshop.",
  }),
];
const versions: Record<string, string> = {};
const wikiId = "wiki_fixture_studio_arrangement";
let bench: BrainBench;
let initialCohortId: string | undefined;
beforeAll(async () => {
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    entailment: "accept-all",
    judge: "hold-all",
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "6h" },
    },
    behaviors: {
      dynamic: knowledgePuppet({
        plan(item, ctx, steps) {
          if (item.source) {
            versions[item.source.id] = item.source.contentHash;
            return { calls: [] };
          }
          return preserveCurrentOwner(item, ctx, steps);
        },
        organize(cohort, _ctx, steps) {
          expect(cohort.sourceIds).toHaveLength(2);
          initialCohortId ??= cohort.id;
          if (cohort.id !== initialCohortId) return { calls: [] };
          const candidate = steps.find((step) => step.name === "knowledge_propose_page");
          const candidateId = candidate
            ? z.object({ id: z.string() }).parse(structuredData(candidate.result)).id
            : undefined;
          const refs = cohort.sourceIds.map((id) => `source:${id}`);
          return {
            calls: [
              call("fetch_many", {
                documents: cohort.sourceIds.map((documentId) => ({ documentId })),
              }),
              call("knowledge_list", { kind: "wiki", limit: 20 }),
              call("knowledge_candidates", {}),
              call("knowledge_propose_page", {
                identityKey: "fixture:studio-arrangement",
                title: "Ceramics workshop arrangement",
                scope: "The established location and supplies for the ceramics workshop.",
                evidenceVersions: Object.fromEntries(
                  cohort.sourceIds.map((id) => [id, versions[id]!]),
                ),
              }),
              ...(candidateId
                ? [
                    call("knowledge_save", {
                      candidateId,
                      node: {
                        id: wikiId,
                        kind: "wiki",
                        title: "Ceramics workshop arrangement",
                        markdown: `<claim id="arrangement" refs="${refs.join(" ")}">The ceramics workshop uses the community studio, which supplies the clay.</claim>`,
                        expectedRevision: 0,
                        inputVersions: Object.fromEntries(
                          cohort.sourceIds.map((id) => [`source:${id}`, versions[id]!]),
                        ),
                      },
                    }),
                  ]
                : []),
            ],
          };
        },
        organizationOutcome(cohort) {
          if (cohort.id !== initialCohortId)
            return { outcome: "no_page", reasonCode: "insufficient_shared_context" };
          return {
            outcome: "organized",
            reasonCode: "new_context_published",
            targetIds: [wikiId],
            targetVersions: { [wikiId]: 1 },
          };
        },
      }),
    },
  });
}, 300_000);
afterAll(async () => {
  await bench?.destroy();
}, 60_000);
it("jointly organizes already-considered disjoint sources into grounded wiki context", async () => {
  for (const document of documents) await bench.push(document);
  await waitFor(
    "joint organization disposition",
    () =>
      bench.sql
        .prepare("SELECT 1 FROM knowledge_organization_cohorts WHERE status='completed' LIMIT 1")
        .get() ?? null,
    90_000,
  );
  await bench.drainUntilQuiet();
  const cohort = bench.sql
    .prepare<
      [],
      { batchId: string; outcome: string }
    >("SELECT batch_id AS batchId,outcome_json AS outcome FROM knowledge_organization_cohorts WHERE status='completed'")
    .get()!;
  expect(JSON.parse(cohort.outcome)).toMatchObject({ outcome: "organized", targetIds: [wikiId] });
  const members = bench.sql.prepare("SELECT source_id FROM knowledge_organization_members").all();
  expect(members).toHaveLength(2);
  const page = await bench.harness.gatewayJson<{
    kind: string;
    claims: Array<{ verification: string }>;
  }>(`/admin/brain/knowledge/${wikiId}`);
  expect(page.kind).toBe("wiki");
  expect(page.claims).toEqual([expect.objectContaining({ verification: "verified" })]);
  const run = bench.sql
    .prepare<
      [string],
      { runId: string }
    >("SELECT run_id AS runId FROM knowledge_batches WHERE id=?")
    .get(cohort.batchId)!;
  const tools = await bench.obs.executedTools(run.runId);
  expect(tools.filter((step) => step.tool === "knowledge_discovery_complete")).toHaveLength(2);
  expect(tools.some((step) => step.tool === "knowledge_organization_complete")).toBe(true);
  expect(tools.some((step) => step.result?.kind === "error")).toBe(false);

  // A fresh pair gets its first joint review without the six-hour repeat gap.
  for (const document of [
    email({
      externalId: "joint-new-library",
      title: "Library notice",
      content: "The library has added a map cabinet.",
    }),
    email({
      externalId: "joint-new-pottery",
      title: "Pottery notice",
      content: "The pottery fair has a new display stand.",
    }),
  ])
    await bench.push(document);
  await waitFor(
    "next initial organization disposition",
    () =>
      bench.sql
        .prepare(
          "SELECT 1 FROM knowledge_organization_cohorts WHERE status='completed' AND id!=? LIMIT 1",
        )
        .get(initialCohortId!) ?? null,
    90_000,
  );
  await bench.drainUntilQuiet();
  const cohorts = bench.sql
    .prepare<
      [],
      { createdAt: number; outcome: string }
    >("SELECT created_at AS createdAt,outcome_json AS outcome FROM knowledge_organization_cohorts ORDER BY created_at")
    .all();
  expect(cohorts).toHaveLength(2);
  expect(cohorts[1]!.createdAt - cohorts[0]!.createdAt).toBeLessThan(6 * 60 * 60 * 1000);
  expect(JSON.parse(cohorts[1]!.outcome)).toMatchObject({ outcome: "no_page" });
  expect(
    bench.sql.prepare("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE kind='wiki'").get(),
  ).toEqual({ n: 1 });
}, 300_000);
