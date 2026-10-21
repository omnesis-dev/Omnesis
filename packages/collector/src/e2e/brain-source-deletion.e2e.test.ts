// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Deleting a cited source end to end: the wiki page that cites it is not
 * deleted. Its claims that relied on the source turn stale, the page is
 * invalidated and offered to maintenance, and the deleted source can never be
 * read again. The maintenance run then reviews the page and, as a deliberate
 * act, retires it with `knowledge_retire` and a reason; the page and its whole
 * history stay on record.
 *
 * Fixture data is invented — no corpus content.
 */

import "./synth-env.js";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  ref,
  structuredData,
  type ToolStep,
} from "./brain-bench/index.js";
import {
  complementaryEvidence,
  waitForComplementaryEvidence,
} from "./brain-bench/complementary-evidence.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";

compressCognitionCadences();

const pageId = "allotment-shed-guide";
const SUPPORT_TITLE = "Shed rota";
const REASON =
  "The rota behind the overview and the rota section was deleted; the remaining labels note does not warrant a page.";
const created = (sourceId: string, supportId: string) =>
  [
    `<claim id="overview" refs="source:${sourceId} source:${supportId}">`,
    "The allotment shed holds shared tools and a weekly cleaning rota.",
    "</claim>",
    "",
    `<claim id="labels" refs="source:${sourceId}">`,
    "## Labels",
    "",
    "Green tags mark the shared tools.",
    "</claim>",
    "",
    `<claim id="rota" refs="source:${supportId}">`,
    "## Rota",
    "",
    "Plot holders clean the shed in turn each Saturday.",
    "</claim>",
    "",
  ].join("\n");

let bench: BrainBench;
let sourceId = "";
let supportId = "";
let supportDeleted = false;

/** Whether the latest wiki listing in this frontier already shows the page. */
function existingPage(steps: readonly ToolStep[]): boolean | undefined {
  const frontier = steps.findLastIndex((step) => step.name === "knowledge_next_frontier");
  const listed = [...steps.slice(frontier + 1)]
    .reverse()
    .find((step) => step.name === "knowledge_list");
  if (!listed) return undefined;
  const pages = z.array(z.object({ id: z.string() })).parse(structuredData(listed.result));
  return pages.some((page) => page.id === pageId);
}

const maintain = knowledgePuppet({
  plan(item, ctx, steps) {
    if (item.source) {
      if (item.source.title === SUPPORT_TITLE || supportDeleted) return { calls: [] };
      // A later review of the same source must not try to create the page again.
      const exists = existingPage(steps);
      if (exists === undefined) return { calls: [call("knowledge_list", { kind: "wiki" })] };
      if (exists) return { calls: [] };
      const support = complementaryEvidence(SUPPORT_TITLE, steps);
      if (!support.evidence) return { calls: support.calls };
      supportId = support.evidence.id;
      sourceId = item.source.id;
      return {
        calls: [
          call("knowledge_list", { kind: "wiki" }),
          call("knowledge_candidates", {}),
          call("knowledge_propose_page", {
            identityKey: pageId,
            title: "Allotment shed guide",
            scope: "How the shared allotment shed is organised and kept clean",
            evidenceVersions: {
              [sourceId]: item.source.contentHash,
              [supportId]: support.evidence.revision,
            },
          }),
          call("knowledge_save", {
            candidateId: ref("knowledge_propose_page", "id"),
            creationAssessment: {
              reason: "Tool labels and the cleaning rota together explain how the shed works.",
              relatedPageIds: [],
            },
            node: {
              id: pageId,
              kind: "wiki",
              title: "Allotment shed guide",
              expectedRevision: 0,
              markdown: created(sourceId, supportId),
              inputVersions: {
                [`source:${sourceId}`]: item.source.contentHash,
                [`source:${supportId}`]: support.evidence.revision,
              },
            },
          }),
        ],
      };
    }
    if (item.id === pageId && item.node) {
      // Reviewing the page after its rota source was deleted: retire it.
      if (supportDeleted)
        return {
          calls: [
            call("knowledge_retire", {
              id: pageId,
              expectedRevision: item.node.revision,
              reason: REASON,
            }),
          ],
        };
      return {
        calls: [
          call("knowledge_list", { kind: "wiki" }),
          call("knowledge_save", {
            inputFingerprint: item.inputFingerprint,
            placementAssessment: {
              status: "standalone",
              reason: "Self-contained allotment shed reference.",
            },
            node: {
              id: pageId,
              kind: "wiki",
              title: item.node.title,
              expectedRevision: item.node.revision,
              markdown: item.node.markdown,
              inputVersions: item.inputVersions,
            },
          }),
        ],
      };
    }
    return preserveCurrentOwner(item, ctx, steps);
  },
  // Once the page is retired it is no longer a discovery target.
  targets: (item) =>
    item.source && item.source.title !== SUPPORT_TITLE && !supportDeleted ? [pageId] : [],
});

beforeAll(async () => {
  bench = await BrainBench.start({
    experimental: true,
    embedder: true,
    syncSources: false,
    entailment: "accept-all",
    gatewayLogLevel: "info",
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
      workerConcurrency: 1,
      // Review of a page invalidated by a deleted source is routine work.
      knowledge: { soonDelay: "1s", routineDelay: "1s" },
    },
    behaviors: { dynamic: maintain },
  });
}, 300_000);

afterAll(async () => {
  await bench?.destroy();
}, 60_000);

it("invalidates a page whose cited source is deleted, and a maintenance run retires it", async () => {
  await bench.push(
    email({
      externalId: "shed-rota",
      title: SUPPORT_TITLE,
      content: "Plot holders clean the shed in turn each Saturday.",
    }),
  );
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  await waitForComplementaryEvidence(bench, SUPPORT_TITLE);
  await bench.push(
    email({
      externalId: "shed-labels",
      title: "Allotment shed labels",
      content:
        "Green tags mark the shared tools. The allotment shed holds shared tools and a weekly cleaning rota.",
    }),
  );
  await expect
    .poll(() => bench.sql.prepare("SELECT 1 FROM knowledge_nodes WHERE id=?").get(pageId), {
      timeout: 120_000,
    })
    .toBeDefined();
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  expect(sourceId).toBe(await bench.docId("shed-labels"));
  const beforeDeletion = bench.sql
    .prepare<
      [string],
      { revision: number; markdown: string }
    >("SELECT revision,markdown FROM knowledge_nodes WHERE id=?")
    .get(pageId)!;
  expect(beforeDeletion.markdown).toBe(created(sourceId, supportId));

  // Delete the cited rota through the production route.
  supportDeleted = true;
  await bench.deleteDoc(supportId);

  // The deleted source is tombstoned: unreadable and uncitable from now on.
  expect(
    bench.sql
      .prepare("SELECT deleted FROM knowledge_source_revisions WHERE document_id=?")
      .get(supportId),
  ).toEqual({ deleted: 1 });
  expect(bench.sql.prepare("SELECT 1 FROM documents WHERE id=?").get(supportId)).toBeUndefined();
  expect(
    bench.sql.prepare("SELECT 1 FROM knowledge_evidence WHERE document_id=?").get(supportId),
  ).toBeUndefined();

  // The page is invalidated, never deleted: exactly the claims that relied on
  // the deleted source turn stale, in a new revision of the unchanged page.
  await expect
    .poll(
      () =>
        bench.sql
          .prepare<
            [string, number],
            { revision: number; markdown: string; diff_json: string }
          >("SELECT revision,markdown,diff_json FROM knowledge_revisions WHERE node_id=? AND revision>? AND validity='stale' ORDER BY revision LIMIT 1")
          .get(pageId, beforeDeletion.revision),
      { timeout: 60_000 },
    )
    .toBeDefined();
  const invalidated = bench.sql
    .prepare<
      [string, number],
      { revision: number; markdown: string; diff_json: string }
    >("SELECT revision,markdown,diff_json FROM knowledge_revisions WHERE node_id=? AND revision>? AND validity='stale' ORDER BY revision LIMIT 1")
    .get(pageId, beforeDeletion.revision)!;
  expect(invalidated.revision).toBe(beforeDeletion.revision + 1);
  expect(invalidated.markdown).toBe(beforeDeletion.markdown);
  const diff = JSON.parse(invalidated.diff_json) as {
    changedClaimIds: string[];
    validityChanged: boolean;
  };
  expect([...diff.changedClaimIds].sort()).toEqual(["overview", "rota"]);
  expect(diff.validityChanged).toBe(true);

  // Maintenance reviews the stale page and retires it with its reason.
  await expect
    .poll(
      () =>
        bench.sql
          .prepare<
            [string],
            { withdrawn: number | null }
          >("SELECT json_extract(fields_json,'$.withdrawn') AS withdrawn FROM knowledge_nodes WHERE id=?")
          .get(pageId)?.withdrawn,
      { timeout: 120_000 },
    )
    .toBe(1);
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  const retired = bench.sql
    .prepare<
      [string],
      { revision: number; fields_json: string; markdown: string }
    >("SELECT revision,fields_json,markdown FROM knowledge_nodes WHERE id=?")
    .get(pageId)!;
  expect(retired.revision).toBe(invalidated.revision + 1);
  expect(JSON.parse(retired.fields_json)).toMatchObject({
    withdrawn: true,
    retirementReason: REASON,
  });
  expect(retired.markdown).toBe(beforeDeletion.markdown);
  // Every revision stays on record; nothing was hard-deleted.
  expect(
    bench.sql
      .prepare<[string], { revision: number }>(
        "SELECT revision FROM knowledge_revisions WHERE node_id=? ORDER BY revision",
      )
      .all(pageId)
      .map((row) => row.revision),
  ).toEqual(Array.from({ length: retired.revision }, (_, index) => index + 1));
  expect(
    bench.sql.prepare("SELECT 1 FROM knowledge_node_tombstones WHERE id=?").get(pageId),
  ).toBeUndefined();

  // The retirement was the run's reviewed act, and it settled the page's work.
  const runId = bench.sql
    .prepare<
      [string],
      { run_id: string }
    >("SELECT b.run_id FROM knowledge_work w JOIN knowledge_batches b ON w.batch_id=b.id WHERE w.subject_id=? ORDER BY b.created_at DESC LIMIT 1")
    .get(pageId)!.run_id;
  const steps = await bench.obs.executedTools(runId);
  expect(steps.filter((step) => step.tool === "knowledge_retire")).toEqual([
    expect.objectContaining({
      result: expect.objectContaining({ kind: "structured" }),
    }),
  ]);
  expect(
    bench.sql
      .prepare("SELECT 1 FROM knowledge_work WHERE subject_id=? AND status='pending'")
      .get(pageId),
  ).toBeUndefined();

  const log = readFileSync(bench.harness.getGatewayLogPath(), "utf8");
  expect(log).toContain(
    `Wiki retired via knowledge_retire on ${pageId}: r${invalidated.revision}→r${retired.revision}`,
  );
}, 300_000);
