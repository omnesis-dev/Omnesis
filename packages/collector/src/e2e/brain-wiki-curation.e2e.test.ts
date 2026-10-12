// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { createOpenLoop } from "../../../gateway/src/brain/storage/open-loops.js";
import { convertKnowledgeOwner } from "../../../gateway/src/brain/knowledge/owner-adapters.js";
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
const loopId = "cabinet-label-outcome";

it("carries wiki curation purpose into a whole-page rewrite while preserving grounded claims", async () => {
  let sourceId = "";
  let supportMarkup = "";
  let supportRef = "";
  let editorialScheduled = false;
  let candidateKeyRefused = false;
  let candidateRevisionRefused = false;
  let filteredScopeRefused = false;
  const editorialGoals: string[] = [];
  const original = () =>
    `<claim id="shelves" refs="source:${sourceId}">The cabinet has three shelves.</claim>` +
    supportMarkup;
  const maintain = knowledgePuppet({
    expectedRefusals: () => [
      { tool: "knowledge_propose_page", code: "reference_invalid" },
      { tool: "knowledge_propose_page", code: "revision_conflict" },
      { tool: "knowledge_save", code: "revision_conflict" },
    ],
    plan(item, ctx, steps) {
      if (item.source) {
        candidateRevisionRefused ||= steps.some(
          (step) =>
            step.name === "knowledge_save" &&
            z
              .object({
                kind: z.literal("error"),
                code: z.literal("revision_conflict"),
                message: z.string().includes("node.expectedRevision: 0"),
              })
              .safeParse(step.result).success,
        );
        filteredScopeRefused ||= steps.some(
          (step) =>
            step.name === "knowledge_propose_page" &&
            z
              .object({ kind: z.literal("error"), code: z.literal("revision_conflict") })
              .safeParse(step.result).success,
        );
        candidateKeyRefused ||= steps.some((step) => {
          if (step.name !== "knowledge_propose_page") return false;
          const result = z
            .object({
              kind: z.literal("error"),
              code: z.literal("reference_invalid"),
              message: z.string(),
            })
            .safeParse(step.result);
          return result.success && result.data.message.includes("bare document IDs");
        });
        if (item.source.title === "Archive cabinet storage rules") return { calls: [] };
        const support = complementaryEvidence("Archive cabinet storage rules", steps);
        if (!support.evidence) return { calls: support.calls };
        supportRef = support.evidence.ref;
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
            call("knowledge_candidates", { status: "proposed" }),
            call("knowledge_propose_page", {
              identityKey: pageId,
              title: "Archive cabinet reference",
              scope: "Cabinet labels and shelf organization",
              evidenceVersions: { [`source:${sourceId}`]: item.source.contentHash },
            }),
            call("knowledge_propose_page", {
              identityKey: pageId,
              title: "Archive cabinet reference",
              scope: "Cabinet labels and shelf organization",
              evidenceVersions: { [sourceId]: item.source.contentHash },
            }),
            call("knowledge_list", { kind: "wiki" }),
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
              candidateId: ref("knowledge_propose_page", "id", 2),
              creationAssessment: {
                reason: "The cabinet facts form a distinct reference scope.",
                relatedPageIds: [],
              },
              node: {
                id: pageId,
                kind: "wiki",
                title: "Archive cabinet reference",
                markdown: original(),
                expectedRevision: ref("knowledge_propose_page", "revision", 2),
                inputVersions: {
                  [`source:${sourceId}`]: item.source.contentHash,
                  [support.evidence.ref]: support.evidence.revision,
                },
              },
            }),
            call("knowledge_save", {
              candidateId: ref("knowledge_propose_page", "id", 2),
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
        const frontierAt = steps.map((step) => step.name).lastIndexOf("knowledge_next_frontier");
        const linkedAt = steps.findIndex(
          (step) =>
            step.name === "knowledge_link" &&
            typeof step.result === "object" &&
            step.result !== null &&
            "kind" in step.result &&
            step.result.kind === "structured",
        );
        const editingPrefix = item.fetchRequired
          ? []
          : [call("knowledge_fetch", { id: pageId, editing: true })];
        const loopRead = [...steps.slice(frontierAt + 1)]
          .reverse()
          .find((step) => step.name === "knowledge_fetch" && step.args?.id === loopId);
        const loopRevision = loopRead ? structuredData(loopRead.result)?.revision : undefined;
        if (linkedAt < 0 || linkedAt > frontierAt)
          return {
            calls: [
              ...editingPrefix,
              call("knowledge_fetch", { id: loopId }),
              call("knowledge_link", {
                fromId: loopId,
                toId: pageId,
                kind: "belongs_to_project",
                fromRevision: loopRevision,
                toRevision: item.node!.revision,
              }),
              call("knowledge_next_frontier", {}),
            ],
          };
        const registered = steps.find((step) => step.name === "knowledge_evidence");
        const evidence = registered
          ? (structuredData(registered.result) as { ref?: string } | null)
          : null;
        const exactRef = evidence?.ref ?? "source:pending#evidence:pending";
        return {
          calls: [
            ...editingPrefix,
            call("knowledge_list", { kind: "wiki" }),
            call("knowledge_reference", { ref: `source:${sourceId}` }),
            call("knowledge_reference", { ref: supportRef }),
            call("knowledge_evidence", {
              documentId: sourceId,
              contentHash: item.inputVersions[`source:${sourceId}`],
              quote: "Blue labels mark the upper shelf.",
            }),
            call("knowledge_reference", { ref: exactRef }),
            call("knowledge_fetch", { id: loopId }),
            call("knowledge_save", {
              inputFingerprint: item.inputFingerprint,
              reviewedClaimIds: item.pendingClaimIds,
              placementAssessment: {
                status: "integrated",
                reason: "The cabinet project contains its label preparation outcome.",
                links: [
                  {
                    fromId: loopId,
                    toId: pageId,
                    kind: "belongs_to_project",
                    otherRevision: loopRevision,
                  },
                ],
              },
              node: {
                id: pageId,
                kind: "wiki",
                title: "Archive cabinet reference",
                expectedRevision: item.node!.revision,
                markdown:
                  `<claim id="overview" refs="source:${sourceId} ${supportRef}">The three-shelf cabinet stores dry folders; liquids belong in the utility cupboard.</claim>\n\n` +
                  supportMarkup +
                  `<claim id="shelves" refs="source:${sourceId}">The cabinet has three shelves.</claim>` +
                  `<claim id="labels" refs="${exactRef}">Blue labels mark the upper shelf.</claim>`,
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
    entailment: "accept-all",
    judge: "hold-all",
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
    behaviors: { dynamic: maintain },
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
  bench.withWriteHandle((db) =>
    db
      .transaction(() => {
        createOpenLoop(
          db,
          {
            id: loopId,
            title: "Prepare cabinet labels",
            description: "Prepare labels for the cabinet shelves.",
            createdByRun: "fixture-seed",
            docs: [sourceId],
            importance: 0.4,
            confidence: 0.9,
          },
          Date.now(),
        );
        convertKnowledgeOwner(db, "loop", loopId, Date.now());
      })
      .immediate(),
  );
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
  await expect
    .poll(
      () =>
        bench!.sql
          .prepare("SELECT meaning_revision,markdown FROM knowledge_nodes WHERE id=?")
          .get(pageId),
      {
        timeout: 90_000,
      },
    )
    .toMatchObject({
      meaning_revision: 2,
      markdown: expect.stringMatching(/^<claim id="overview"/),
    });
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  expect(
    bench.sql
      .prepare("SELECT status FROM knowledge_work WHERE id='cabinet-editorial-review'")
      .get(),
  ).toMatchObject({ status: "completed" });
  expect(
    bench.sql
      .prepare("SELECT from_id,to_id,kind FROM knowledge_links WHERE from_id=? AND to_id=?")
      .get(loopId, pageId),
  ).toEqual({ from_id: loopId, to_id: pageId, kind: "belongs_to_project" });
  const runs = bench.sql
    .prepare<
      [],
      { run_id: string }
    >("SELECT DISTINCT run_id FROM knowledge_batches WHERE run_id IS NOT NULL")
    .all();
  const executed = (
    await Promise.all(runs.map((run) => bench!.obs.executedTools(run.run_id)))
  ).flat();
  const saves = executed.filter((step) => step.tool === "knowledge_save");
  const refusedSaves = saves.filter((step) => step.result?.kind === "error");
  expect(refusedSaves).toHaveLength(1);
  expect(refusedSaves[0]?.args).toMatchObject({ node: { id: pageId, expectedRevision: 1 } });
  expect(refusedSaves[0]?.result).toMatchObject({
    kind: "error",
    code: "revision_conflict",
    message: expect.stringContaining("node.expectedRevision: 0"),
  });
  const node = bench.sql
    .prepare<
      [string],
      { markdown: string; revision: number }
    >("SELECT markdown,revision FROM knowledge_nodes WHERE id=?")
    .get(pageId)!;
  // The substantive edit must remain the second meaning revision. A later
  // background review may record a proof-only revision during drain; it must
  // not change the saved page or repeat the semantic rewrite.
  const meaning = bench.sql
    .prepare("SELECT meaning_revision FROM knowledge_nodes WHERE id=?")
    .get(pageId) as { meaning_revision: number };
  expect(meaning.meaning_revision).toBe(2);
  const allRevisions = bench.sql
    .prepare<
      [string],
      { revision: number; title: string; markdown: string; fields_json: string }
    >("SELECT revision,title,markdown,fields_json FROM knowledge_revisions WHERE node_id=? AND revision>=2 ORDER BY revision")
    .all(pageId);
  const firstEditorial = allRevisions.findIndex((row) =>
    row.markdown.startsWith('<claim id="overview"'),
  );
  expect(firstEditorial).toBeGreaterThanOrEqual(0);
  const revisions = allRevisions.slice(firstEditorial);
  expect(revisions.at(-1)!.revision).toBe(node.revision);
  const { revision: _revision, ...editedPage } = revisions[0]!;
  for (const revision of revisions) {
    const { revision: _number, ...content } = revision;
    expect(content).toEqual(editedPage);
  }
  expect(candidateKeyRefused).toBe(true);
  expect(candidateRevisionRefused).toBe(true);
  expect(filteredScopeRefused).toBe(true);
  expect(editorialGoals).not.toHaveLength(0);
  expect(node.markdown.startsWith('<claim id="overview"')).toBe(true);
  expect(node.markdown).toContain(supportMarkup);
  expect(node.markdown).toContain(
    `<claim id="shelves" refs="source:${sourceId}">The cabinet has three shelves.</claim>`,
  );
  expect(node.markdown.indexOf('id="storage"')).toBeLessThan(node.markdown.indexOf('id="shelves"'));
  expect(node.markdown).toContain('id="labels"');
}, 180_000);
