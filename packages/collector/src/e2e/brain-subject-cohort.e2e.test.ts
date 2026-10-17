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
    externalId: "subject-permission",
    title: "Garden studio permission",
    content: "Planning permission for the garden studio was granted on 2 March.",
  }),
  email({
    externalId: "subject-quote",
    title: "Garden studio quote",
    content: "The builder quoted for the garden studio foundations and timber frame.",
  }),
];
const createdLoop = z.object({ loop: z.object({ id: z.string() }) });
const wikiId = "wiki_fixture_garden_studio";
const versions: Record<string, string> = {};
const loops: string[] = [];
const subjects: string[] = [];
let bench: BrainBench;

beforeAll(async () => {
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    entailment: "accept-all",
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "6h" },
    },
    behaviors: {
      dynamic: knowledgePuppet({
        plan(item, ctx, steps) {
          if (item.source) {
            const known = Object.keys(versions);
            versions[item.source.id] = item.source.sourceRevision ?? item.source.contentHash;
            // Two important outcomes about one matter, joined by the document they share.
            return {
              calls: [
                call("open_loop_search", { query: "garden studio" }),
                call("open_loop_create", {
                  title: `Garden studio step ${known.length + 1}`,
                  description: "Move the garden studio build forward.",
                  confidence: 0.9,
                  importance: 0.9,
                  docs: [...known.slice(0, 1), item.source.id],
                }),
              ],
            };
          }
          if (item.node?.id === wikiId)
            return {
              calls: [
                call("knowledge_list", { kind: "wiki" }),
                call("knowledge_save", {
                  inputFingerprint: item.inputFingerprint,
                  reviewedClaimIds: item.pendingClaimIds,
                  placementAssessment: {
                    status: "standalone",
                    reason: "The garden studio build is a self-contained reference page.",
                  },
                  node: {
                    id: wikiId,
                    kind: "wiki",
                    title: item.node.title,
                    markdown: item.node.markdown,
                    expectedRevision: item.node.revision,
                    inputVersions: item.inputVersions,
                  },
                }),
              ],
            };
          return preserveCurrentOwner(item, ctx, steps);
        },
        targets(item, steps) {
          const created = steps.findLast((step) => step.name === "open_loop_create");
          if (item.source && created)
            loops.push(createdLoop.parse(structuredData(created.result)).loop.id);
          return [];
        },
        organize(cohort, _ctx, steps) {
          // Only a subject cohort publishes; any chronological one declines.
          if (!cohort.subject) return { calls: [] };
          subjects.push(cohort.subject.loopRef);
          const candidate = steps.find((step) => step.name === "knowledge_propose_page");
          const candidateId = candidate
            ? z.object({ id: z.string() }).parse(structuredData(candidate.result)).id
            : undefined;
          const ids = cohort.sourceIds;
          return {
            calls: [
              call("fetch_many", { documents: ids.map((documentId) => ({ documentId })) }),
              call("knowledge_list", { kind: "wiki", limit: 20 }),
              call("knowledge_candidates", {}),
              call("knowledge_propose_page", {
                identityKey: "fixture:garden-studio",
                title: "Garden studio build",
                scope: "The permitted garden studio and its build.",
                evidenceVersions: Object.fromEntries(ids.map((id) => [id, versions[id]!])),
              }),
              ...(candidateId
                ? [
                    call("knowledge_save", {
                      candidateId,
                      creationAssessment: {
                        reason:
                          "Permission and the builder's quote describe one ongoing build with no existing page.",
                        relatedPageIds: [],
                      },
                      node: {
                        id: wikiId,
                        kind: "wiki",
                        title: "Garden studio build",
                        markdown: `<claim id="build" refs="${ids.map((id) => `source:${id}`).join(" ")}">The garden studio has planning permission and a builder's quote.</claim>`,
                        expectedRevision: 0,
                        inputVersions: Object.fromEntries(
                          ids.map((id) => [`source:${id}`, versions[id]!]),
                        ),
                      },
                    }),
                  ]
                : []),
            ],
          };
        },
        organizationOutcome(cohort) {
          return cohort.subject
            ? {
                outcome: "organized",
                reasonCode: "new_context_published",
                targetIds: [wikiId],
                targetVersions: { [wikiId]: 1 },
              }
            : { outcome: "no_page", reasonCode: "insufficient_shared_context" };
        },
      }),
    },
  });
}, 300_000);

afterAll(async () => {
  await bench?.destroy();
}, 60_000);

it("groups an important matter without a page into its own cohort and publishes it once", async () => {
  for (const document of documents) await bench.push(document);
  await waitFor(
    "subject cohort disposition",
    () =>
      bench.sql
        .prepare(
          "SELECT 1 FROM knowledge_organization_cohorts WHERE subject_loop_id IS NOT NULL AND status='completed' LIMIT 1",
        )
        .get() ?? null,
    180_000,
  );
  await bench.drainUntilQuiet();
  expect(loops).toHaveLength(2);
  const cohorts = bench.sql
    .prepare<
      [],
      { subject: string | null; outcome: string }
    >("SELECT subject_loop_id AS subject,outcome_json AS outcome FROM knowledge_organization_cohorts WHERE status='completed' ORDER BY created_at")
    .all();
  // The subject pass is chosen before a chronological one, and having reviewed
  // both documents jointly it leaves no first-pass chronological cohort to run.
  expect(cohorts).toHaveLength(1);
  expect(JSON.parse(cohorts[0]!.outcome)).toMatchObject({
    outcome: "organized",
    targetIds: [wikiId],
  });
  expect(loops).toContain(cohorts[0]!.subject);
  expect(new Set(subjects)).toEqual(new Set([`loop:${cohorts[0]!.subject}`]));
  const members = bench.sql
    .prepare(
      "SELECT m.source_id FROM knowledge_organization_members m JOIN knowledge_organization_cohorts c ON c.id=m.cohort_id WHERE c.subject_loop_id IS NOT NULL",
    )
    .all();
  expect(members).toHaveLength(2);
  const page = await bench.harness.gatewayJson<{
    kind: string;
    claims: Array<{ verification: string }>;
  }>(`/admin/brain/knowledge/${wikiId}`);
  expect(page.kind).toBe("wiki");
  expect(page.claims).toEqual([expect.objectContaining({ verification: "verified" })]);
  // Once a page cites the matter, it is covered and offers no further subject cohort.
  await bench.drainUntilQuiet();
  expect(
    bench.sql
      .prepare(
        "SELECT COUNT(*) AS n FROM knowledge_organization_cohorts WHERE subject_loop_id IS NOT NULL",
      )
      .get(),
  ).toEqual({ n: 1 });
}, 300_000);
