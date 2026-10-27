// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, expect, it } from "vitest";
import { scheduleKnowledgeReview } from "../../../gateway/src/brain/knowledge/work-lifecycle.js";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  ref,
  structuredData,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";

import {
  complementaryEvidence,
  waitForComplementaryEvidence,
} from "./brain-bench/complementary-evidence.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
afterAll(async () => {
  await bench?.destroy();
}, 60_000);
const pageId = "archive-cabinet-reference";

it("rejects an unchanged factual claim moved to an unsupported page scope through the real writer", async () => {
  let sourceId = "";
  let supportMarkup = "";
  let editorialScheduled = false;
  let refusedPlacement = false;
  const editorialGoals: string[] = [];
  const original = () =>
    `<claim id="shelves" refs="source:${sourceId}">The cabinet has three shelves.</claim>` +
    supportMarkup;
  const maintain = knowledgePuppet({
    plan(item, ctx, steps) {
      if (item.source) {
        if (item.source.title === "Archive cabinet storage rules") return { calls: [] };
        const support = complementaryEvidence("Archive cabinet storage rules", steps);
        if (!support.evidence) return { calls: support.calls };
        supportMarkup = `<claim id="storage" refs="${support.evidence.ref}">${support.evidence.text}</claim>`;
        sourceId = item.source.id;
        const frontierAt = steps.map((step) => step.name).lastIndexOf("knowledge_next_frontier");
        const libraryRead = steps
          .slice(frontierAt + 1)
          .find((step) => step.name === "knowledge_list");
        const library = libraryRead ? structuredData(libraryRead.result) : null;
        const prefix = [...support.calls, call("knowledge_list", { kind: "wiki" })];
        if (
          Array.isArray(library) &&
          library.some(
            (node) => node && typeof node === "object" && (node as { id?: string }).id === pageId,
          )
        )
          return { calls: prefix };
        return {
          calls: [
            ...prefix,
            call("knowledge_candidates", {}),
            call("knowledge_propose_page", {
              identityKey: pageId,
              title: "Archive cabinet reference",
              scope: "Cabinet labels and shelf organization",
              evidenceVersions: {
                [sourceId]: item.source.contentHash,
                [support.evidence.id]: support.evidence.revision,
              },
            }),
            call("knowledge_save", {
              candidateId: ref("knowledge_propose_page", "id"),
              creationAssessment: {
                reason:
                  "The cabinet layout and storage restrictions form one reference topic not present in the inspected library.",
                relatedPageIds: [],
              },
              node: {
                id: pageId,
                kind: "wiki",
                title: "Archive cabinet reference",
                markdown: original(),
                expectedRevision: 0,
                inputVersions: {
                  [`source:${sourceId}`]: item.source.contentHash,
                  [support.evidence.ref]: support.evidence.revision,
                },
              },
            }),
          ],
        };
      }
      if (item.id === pageId) {
        if (!editorialScheduled || !item.review)
          return {
            calls: [
              call("knowledge_list", { kind: "wiki" }),
              call("knowledge_save", {
                inputFingerprint: item.inputFingerprint,
                reviewedClaimIds: item.pendingClaimIds,
                placementAssessment: {
                  status: "standalone",
                  reason: "Self-contained cabinet reference.",
                },
                node: {
                  id: pageId,
                  kind: "wiki",
                  title: item.node!.title,
                  markdown: item.node!.markdown,
                  expectedRevision: item.node!.revision,
                },
              }),
            ],
          };
        if (item.review) {
          if (item.maintenanceGoal !== "wiki_curation")
            throw new Error("Expected the explicit wiki curation purpose");
          expect(item.maintenanceTask).toContain("even in an organization batch");
          editorialGoals.push(item.maintenanceGoal);
        }
        return {
          calls: [
            call("knowledge_list", { kind: "wiki" }),
            call("knowledge_save", {
              inputFingerprint: item.inputFingerprint,
              reviewedClaimIds: item.pendingClaimIds,
              placementAssessment: {
                status: "standalone",
                reason: "One grounded equipment reference.",
              },
              node: {
                id: pageId,
                kind: "wiki",
                title: refusedPlacement ? item.node!.title : "Unrelated orbital mission",
                markdown: item.node!.markdown,
                expectedRevision: item.node!.revision,
              },
            }),
          ],
        };
      }
      return preserveCurrentOwner(item, ctx, steps);
    },
    targets: () => [],
  });
  bench = await BrainBench.start({
    experimental: true,
    embedder: true,
    syncSources: false,
    entailment: ({ context }) =>
      context?.includes("Unrelated orbital mission") ? "neutral" : "entailment",
    decision: {
      policy: (request) =>
        Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => {
            if (question.type !== "score") throw new Error(`Unexpected decision ${key}`);
            return [
              key,
              { type: "score" as const, score: question.criteria.length - 1, confidence: 1 },
            ];
          }),
        ),
    },
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "6h" },
    },
    behaviors: {
      dynamic: (ctx, steps) => {
        const last = steps.at(-1);
        if (
          last?.name === "knowledge_save" &&
          last.result &&
          typeof last.result === "object" &&
          "code" in last.result &&
          last.result.code === "claim_invalid"
        ) {
          refusedPlacement = true;
          return { kind: "tool", name: "knowledge_next_frontier", args: {} };
        }
        return maintain(ctx, steps);
      },
    },
  });
  await bench.pushAndSettle([
    email({
      externalId: "archive-cabinet-storage",
      title: "Archive cabinet storage rules",
      content: "Store only dry folders in the cabinet; liquids belong in the utility cupboard.",
    }),
  ]);
  await waitForComplementaryEvidence(bench, "Archive cabinet storage rules");
  await bench.push(
    email({
      externalId: "archive-cabinet-note",
      title: "Archive cabinet guide",
      content: "The cabinet has three shelves. Blue labels mark the upper shelf.",
    }),
  );
  await expect
    .poll(() => bench!.sql.prepare("SELECT id FROM knowledge_nodes WHERE id=?").get(pageId), {
      timeout: 90_000,
    })
    .toMatchObject({ id: pageId });
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  editorialScheduled = true;
  bench.withWriteHandle((db) => {
    const current = db.prepare("SELECT revision FROM knowledge_nodes WHERE id=?").get(pageId) as {
      revision: number;
    };
    const now = Date.now();
    scheduleKnowledgeReview(
      db,
      {
        id: pageId,
        expectedRevision: current.revision,
        nextReviewAt: now,
        decision: "now",
        workId: "cabinet-editorial-review",
      },
      now,
    );
  });
  await expect.poll(() => refusedPlacement, { timeout: 90_000 }).toBe(true);
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  expect(
    bench.sql
      .prepare("SELECT status FROM knowledge_work WHERE id='cabinet-editorial-review'")
      .get(),
  ).toMatchObject({ status: "completed" });
  const runs = bench.sql
    .prepare<[], { run_id: string }>(
      "SELECT DISTINCT run_id FROM knowledge_batches WHERE run_id IS NOT NULL",
    )
    .all();
  const executed = (
    await Promise.all(runs.map((run) => bench!.obs.executedTools(run.run_id)))
  ).flat();
  const saves = executed.filter((step) => step.tool === "knowledge_save");
  expect(saves.filter((step) => step.result?.kind === "error")).toHaveLength(1);
  expect(saves.find((step) => step.result?.kind === "error")?.result).toMatchObject({
    code: "claim_invalid",
  });
  const node = bench.sql
    .prepare("SELECT title,markdown,meaning_revision FROM knowledge_nodes WHERE id=?")
    .get(pageId) as { title: string; markdown: string; meaning_revision: number };
  expect(node.title).toBe("Archive cabinet reference");
  expect(node.markdown).toBe(original());
  expect(node.meaning_revision).toBe(1);
  expect(
    bench.entailmentCalls.some(
      (entry) =>
        entry.assessment === "contextual_segments" &&
        entry.context?.includes('"pageTitle":"Unrelated orbital mission"') &&
        entry.answer.includes('"verdict":"unsupported"'),
    ),
  ).toBe(true);
  expect(
    bench.entailmentCalls.some(
      (entry) =>
        entry.assessment === "contextual_segments" &&
        entry.context?.includes('"pageTitle":"Archive cabinet reference"') &&
        entry.answer.includes('"verdict":"supported"'),
    ),
  ).toBe(true);
  expect(editorialGoals).not.toHaveLength(0);
}, 240_000);
