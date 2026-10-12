// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { expect, test } from "vitest";
import { z } from "zod";
import { proposeKnowledgeCandidate } from "../../../gateway/src/brain/knowledge/discovery.js";
import { readKnowledgeSourceRevision } from "../../../gateway/src/brain/knowledge/source-revision.js";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";
import { emitNextPlanned, structuredData } from "./brain-bench/puppet-plan.js";

compressCognitionCadences();
const candidateId = "candidate-observatory-kit";
const pageId = "wiki-observatory-kit";

test.each([1, 8])(
  "candidate decision work survives restart, defers and publishes with maxSeeds=%i",
  async (maxSeeds) => {
    let publish = false;
    let retryAt = 0;
    let evidenceVersions: Record<string, string> = {};
    const maintain = knowledgePuppet({
      plan: (item, ctx, steps) =>
        item.source ? { calls: [] } : preserveCurrentOwner(item, ctx, steps),
    });
    const bench = await BrainBench.start({
      experimental: true,
      syncSources: false,
      clock: "virtual",
      entailment: "accept-all",
      judge: "hold-all",
      brain: {
        bootstrap: { enabled: false },
        derivationBarrier: "0s",
        knowledge: { soonDelay: "1s", routineDelay: "6h", maxSeeds },
      },
      behaviors: {
        dynamic: (ctx, steps) => {
          const at = steps.map((step) => step.name).lastIndexOf("knowledge_next_frontier");
          const parsed =
            at < 0
              ? null
              : z
                  .object({
                    candidateDecisions: z
                      .array(z.object({ id: z.string(), revision: z.number() }))
                      .min(1),
                  })
                  .safeParse(structuredData(steps[at]!.result));
          if (!parsed?.success) return maintain(ctx, steps);
          const candidate = parsed.data.candidateDecisions[0]!;
          const since = steps.slice(at + 1);
          if (!publish) {
            if (!since.some((step) => step.name === "knowledge_candidates"))
              return { kind: "tool", name: "knowledge_candidates", args: {} };
            if (!since.some((step) => step.name === "knowledge_candidate_decide"))
              return {
                kind: "tool",
                name: "knowledge_candidate_decide",
                args: {
                  id: candidate.id,
                  expectedRevision: candidate.revision,
                  status: "deferred",
                  reconsiderAt: retryAt,
                },
              };
            return { kind: "tool", name: "knowledge_next_frontier", args: {} };
          }
          const ids = Object.keys(evidenceVersions);
          const next = emitNextPlanned(
            {
              calls: [
                call("knowledge_list", { kind: "wiki" }),
                call("knowledge_candidates", {}),
                call("knowledge_reference", { refs: ids.map((id) => `source:${id}`) }),
                call("knowledge_candidate_decide", {
                  id: candidate.id,
                  expectedRevision: candidate.revision,
                  status: "proposed",
                }),
                call("knowledge_save", {
                  candidateId: candidate.id,
                  creationAssessment: {
                    reason:
                      "The assembled kit location and operating restriction form a distinct reusable reference.",
                    relatedPageIds: [],
                  },
                  node: {
                    id: pageId,
                    kind: "wiki",
                    title: "Observatory kit reference",
                    expectedRevision: 0,
                    markdown: `<claim id="location" refs="source:${ids[0]}">The telescope kit is stored in cabinet four.</claim>\n\n<claim id="restriction" refs="source:${ids[1]}">Use the telescope kit only with the protective filter installed.</claim>`,
                    inputVersions: Object.fromEntries(
                      ids.map((id) => [`source:${id}`, evidenceVersions[id]]),
                    ),
                  },
                }),
              ],
            },
            since,
            false,
          );
          return next.kind === "tool"
            ? next
            : { kind: "tool", name: "knowledge_next_frontier", args: {} };
        },
      },
    });
    try {
      await bench.drainUntilQuiet();
      const documents = [
        email({
          externalId: "observatory-kit-location",
          title: "Telescope kit location",
          content: "The telescope kit is stored in cabinet four.",
        }),
        email({
          externalId: "observatory-kit-restriction",
          title: "Telescope kit operation",
          content: "Use the telescope kit only with the protective filter installed.",
        }),
      ];
      await bench.pushAll(documents);
      await expect
        .poll(
          () =>
            bench.sql
              .prepare("SELECT COUNT(*) AS n FROM knowledge_work WHERE subject_kind='source'")
              .get(),
          { timeout: 30_000 },
        )
        .toMatchObject({ n: 2 });
      await bench.clock.advance(2_000);
      await bench.drainUntilQuiet({ includeUpcoming: false });
      const ids = await Promise.all(documents.map((document) => bench.docId(document.externalId)));
      const { now } = await bench.clock.now();
      retryAt = now + 86_400_000;
      bench.withWriteHandle((db) => {
        evidenceVersions = Object.fromEntries(
          ids.map((id) => [id, readKnowledgeSourceRevision(db, id)!]),
        );
        proposeKnowledgeCandidate(
          db,
          {
            id: candidateId,
            identityKey: "reference:observatory-kit",
            title: "Observatory kit reference",
            scope: "Kit storage and protective setup",
            evidenceVersions,
          },
          now,
        );
      });
      await bench.restartGateway();
      await bench.clock.advance(2_000);
      await expect
        .poll(
          () =>
            bench.sql
              .prepare("SELECT status FROM knowledge_candidates WHERE id=?")
              .get(candidateId),
          { timeout: 60_000 },
        )
        .toEqual({ status: "deferred" });
      await bench.drainUntilQuiet({ includeUpcoming: false });
      const admissions = () =>
        bench.sql
          .prepare<
            [string],
            { count: number }
          >("SELECT COUNT(DISTINCT generation) AS count FROM knowledge_candidate_decision_work WHERE candidate_id=?")
          .get(candidateId)?.count;
      expect(
        bench.sql
          .prepare(
            `SELECT COUNT(DISTINCT w.batch_id) AS count
      FROM knowledge_candidate_decision_work cw JOIN knowledge_work w ON w.id=cw.work_id
      WHERE cw.candidate_id=? AND cw.generation=1`,
          )
          .get(candidateId),
      ).toEqual({ count: maxSeeds === 1 ? 2 : 1 });
      expect(admissions()).toBe(1);
      await bench.clock.advance(10_000);
      await bench.drainUntilQuiet({ includeUpcoming: false });
      expect(admissions()).toBe(1);
      publish = true;
      await bench.clock.set(retryAt + 1);
      await expect
        .poll(
          () =>
            bench.sql
              .prepare("SELECT status,node_id FROM knowledge_candidates WHERE id=?")
              .get(candidateId),
          { timeout: 90_000 },
        )
        .toEqual({ status: "published", node_id: pageId });
      expect(admissions()).toBe(2);
      expect(
        bench.sql.prepare("SELECT plain_text FROM knowledge_nodes WHERE id=?").get(pageId),
      ).toEqual({ plain_text: expect.stringContaining("protective filter installed") });
    } finally {
      await bench.destroy();
    }
  },
  180_000,
);
