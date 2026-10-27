// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Targeted wiki edits end to end: a maintenance run enriches an existing page
 * with `knowledge_edit` (one section replaced, one sentence changed) instead of
 * resending it, and every refusal arm — no editing read, a missing heading, a
 * removed claim without removal intent, a new reference at a stale version — is a
 * tool error that leaves the page untouched.
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
import { knowledgePuppet, type PuppetKnowledgeItem } from "./brain-bench/knowledge-puppet.js";

compressCognitionCadences();

const pageId = "workshop-cabinet-guide";
const TOOLS_SECTION = (supportId: string, text: string) =>
  [`<claim id="tools" refs="source:${supportId}">`, "## Tools", "", text, "</claim>"].join("\n");
const created = (sourceId: string, supportId: string) =>
  [
    `<claim id="overview" refs="source:${sourceId} source:${supportId}">`,
    "The workshop keeps paint and tools in two labelled cabinets.",
    "</claim>",
    "",
    `<claim id="labels" refs="source:${sourceId}">`,
    "## Labels",
    "",
    "Blue labels identify the first cabinet.",
    "</claim>",
    "",
    TOOLS_SECTION(supportId, "Tools belong in the second cabinet."),
    "",
  ].join("\n");
const ENRICHED_TOOLS = "Tools belong in the second cabinet, sorted by size on three shelves.";
const OLD_LABEL = "Blue labels identify the first cabinet.";
const NEW_LABEL = "Blue labels identify the first cabinet, the one nearest the door.";
const edited = (sourceId: string, supportId: string) =>
  created(sourceId, supportId)
    .replace(
      TOOLS_SECTION(supportId, "Tools belong in the second cabinet."),
      TOOLS_SECTION(supportId, ENRICHED_TOOLS),
    )
    .replace(OLD_LABEL, NEW_LABEL);

let bench: BrainBench;
let sourceId = "";
let supportId = "";
let editRun: string | undefined;

const isError = (step: ToolStep) =>
  !!step.result &&
  typeof step.result === "object" &&
  "kind" in step.result &&
  step.result.kind === "error";

/** The page as offered by the run's latest frontier, if it is offered. */
function offeredPage(steps: readonly ToolStep[]): PuppetKnowledgeItem | undefined {
  const frontier = [...steps].reverse().find((step) => step.name === "knowledge_next_frontier");
  const parsed = z
    .object({ items: z.array(z.object({ id: z.string() }).passthrough()) })
    .safeParse(frontier ? structuredData(frontier.result) : null);
  return parsed.success
    ? (parsed.data.items.find((item) => item.id === pageId) as PuppetKnowledgeItem | undefined)
    : undefined;
}

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
      if (item.source.title === "Tool storage allocation") return { calls: [] };
      const exists = existingPage(steps);
      if (exists === undefined) return { calls: [call("knowledge_list", { kind: "wiki" })] };
      if (exists) return { calls: [] };
      const support = complementaryEvidence("Tool storage allocation", steps);
      if (!support.evidence) return { calls: support.calls };
      supportId = support.evidence.id;
      sourceId = item.source.id;
      return {
        calls: [
          call("knowledge_list", { kind: "wiki" }),
          call("knowledge_candidates", {}),
          call("knowledge_propose_page", {
            identityKey: pageId,
            title: "Workshop cabinet guide",
            scope: "Where workshop materials are kept and how the cabinets are marked",
            evidenceVersions: {
              [sourceId]: item.source.contentHash,
              [supportId]: support.evidence.revision,
            },
          }),
          call("knowledge_save", {
            candidateId: ref("knowledge_propose_page", "id"),
            creationAssessment: {
              reason: "Cabinet labelling and tool allocation together answer where things go.",
              relatedPageIds: [],
            },
            node: {
              id: pageId,
              kind: "wiki",
              title: "Workshop cabinet guide",
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
      const placementAssessment = {
        status: "standalone",
        reason: "Self-contained workshop cabinet reference.",
      };
      if (item.node.revision === 1)
        return {
          calls: [
            call("knowledge_list", { kind: "wiki" }),
            // Both edited claims cite their evidence again, so both are read.
            call("knowledge_reference", { ref: `source:${sourceId}` }),
            call("knowledge_reference", { ref: `source:${supportId}` }),
            call("knowledge_edit", {
              inputFingerprint: item.inputFingerprint,
              placementAssessment,
              node: {
                id: pageId,
                expectedRevision: 1,
                edits: [
                  {
                    op: "replace_section",
                    heading: "Tools",
                    markdown: TOOLS_SECTION(supportId, ENRICHED_TOOLS),
                  },
                  { op: "replace_text", old: OLD_LABEL, new: NEW_LABEL },
                ],
              },
            }),
          ],
        };
      return {
        calls: [
          call("knowledge_list", { kind: "wiki" }),
          call("knowledge_save", {
            inputFingerprint: item.inputFingerprint,
            placementAssessment,
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
  targets: (item) =>
    item.source && item.source.title !== "Tool storage allocation" ? [pageId] : [],
});

/**
 * Before the scripted edit, the first run offered the page tries each refusal
 * arm once. Refused edits are hidden from the maintenance policy, which then
 * settles the page with the real edit.
 */
function refusalArm(item: PuppetKnowledgeItem, steps: readonly ToolStep[]) {
  const refused = steps.filter((step) => step.name === "knowledge_edit" && isError(step));
  const base = {
    reviewedClaimIds: item.pendingClaimIds ?? [],
    placementAssessment: { status: "standalone", reason: "Self-contained cabinet reference." },
  };
  const edit = (edits: unknown[], extra: Record<string, unknown> = {}) => ({
    kind: "tool" as const,
    name: "knowledge_edit",
    args: { ...base, node: { id: pageId, expectedRevision: 1, edits, ...extra } },
  });
  if (refused.length === 0) return edit([{ op: "replace_text", old: OLD_LABEL, new: NEW_LABEL }]);
  const since = steps.slice(steps.findLastIndex((step) => step.name === "knowledge_next_frontier"));
  if (!since.some((step) => step.name === "knowledge_list"))
    return { kind: "tool" as const, name: "knowledge_list", args: { kind: "wiki" } };
  if (
    !since.some(
      (step) =>
        step.name === "knowledge_fetch" && step.args?.id === pageId && step.args?.editing === true,
    )
  )
    return { kind: "tool" as const, name: "knowledge_fetch", args: { id: pageId, editing: true } };
  if (refused.length === 1)
    return edit([{ op: "replace_section", heading: "Paint", markdown: "## Paint\n\nx" }]);
  if (refused.length === 2) return edit([{ op: "delete_section", heading: "Tools" }]);
  if (refused.length === 3)
    return edit(
      [
        {
          op: "replace_text",
          old: `<claim id="labels" refs="source:${sourceId}">`,
          new: `<claim id="labels" refs="source:${sourceId} source:${supportId}">`,
        },
      ],
      { inputVersions: { [`source:${supportId}`]: "not-the-read-version" } },
    );
  return null;
}

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
      // Serialized runs keep the scripted refusal sequence inside one run.
      workerConcurrency: 1,
      knowledge: { soonDelay: "1s", routineDelay: "6h" },
    },
    behaviors: {
      dynamic(ctx, steps) {
        const item = offeredPage(steps);
        if (item?.node && item.node.revision === 1 && (editRun ?? ctx.runId) === ctx.runId) {
          editRun = ctx.runId;
          const arm = refusalArm(item, steps);
          if (arm) return arm;
        }
        return maintain(
          ctx,
          steps.filter((step) => !(step.name === "knowledge_edit" && isError(step))),
        );
      },
    },
  });
}, 300_000);

afterAll(async () => {
  await bench?.destroy();
}, 60_000);

it("enriches an existing page with targeted edits and refuses each unsafe edit", async () => {
  await bench.push(
    email({
      externalId: "tool-storage-allocation",
      title: "Tool storage allocation",
      content: "Tools belong in the second cabinet, sorted by size on three shelves.",
    }),
  );
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  await waitForComplementaryEvidence(bench, "Tool storage allocation");
  await bench.push(
    email({
      externalId: "cabinet-labels",
      title: "Workshop cabinet labels",
      content:
        "Blue labels identify the first cabinet, the one nearest the door. Paint and tools are kept in two labelled cabinets.",
    }),
  );
  const docId = await bench.docId("cabinet-labels");
  await expect
    .poll(
      () =>
        bench.sql.prepare("SELECT revision FROM knowledge_nodes WHERE id=?").get(pageId) as
          { revision: number } | undefined,
      { timeout: 120_000 },
    )
    .toMatchObject({ revision: expect.any(Number) });
  await expect
    .poll(
      () =>
        bench.sql
          .prepare("SELECT 1 FROM knowledge_revisions WHERE node_id=? AND revision=2")
          .get(pageId),
      {
        timeout: 120_000,
      },
    )
    .toBeDefined();
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  expect(sourceId).toBe(docId);

  // The stored revision is exactly the scripted edits applied to revision 1.
  const revisions = bench.sql
    .prepare<[string], { revision: number; markdown: string; diff_json: string }>(
      "SELECT revision,markdown,diff_json FROM knowledge_revisions WHERE node_id=? ORDER BY revision",
    )
    .all(pageId);
  const original = created(sourceId, supportId);
  expect(revisions[0]).toMatchObject({ revision: 1, markdown: original });
  expect(revisions[1]).toMatchObject({ revision: 2, markdown: edited(sourceId, supportId) });
  // Later proof reviews may add revisions; none loses the edit.
  for (const revision of revisions.slice(2))
    expect(revision.markdown).toBe(edited(sourceId, supportId));
  // The untouched overview is byte-identical; only the two edited claims changed.
  const overview = (markdown: string) => markdown.slice(0, markdown.indexOf('<claim id="labels"'));
  expect(overview(revisions[1]!.markdown)).toBe(overview(original));
  const diff = JSON.parse(revisions[1]!.diff_json) as { changedClaimIds?: string[] };
  expect([...(diff.changedClaimIds ?? [])].sort()).toEqual(["labels", "tools"]);
  expect(
    bench.sql
      .prepare<[string], { id: string }>(
        "SELECT id FROM knowledge_claims WHERE node_id=? ORDER BY id",
      )
      .all(pageId)
      .map((row) => row.id),
  ).toEqual(["labels", "overview", "tools"]);
  expect(
    bench.sql
      .prepare<[string], { inputs: string }>(
        "SELECT group_concat(DISTINCT target_id) AS inputs FROM knowledge_dependencies WHERE node_id=? AND claim_id='tools'",
      )
      .get(pageId)!.inputs,
  ).toBe(supportId);

  // Every refusal arm is a structured tool error, in order, then one edit lands.
  const tools = await bench.obs.executedTools(editRun!);
  const edits = tools.filter((step) => step.tool === "knowledge_edit");
  expect(edits.map((step) => (step.result?.kind === "error" ? step.result.code : "saved"))).toEqual(
    ["revision_conflict", "edit_target_not_found", "claim_invalid", "revision_conflict", "saved"],
  );
  expect(edits[0]!.result).toMatchObject({
    message: expect.stringContaining("knowledge_fetch({id, editing:true})"),
  });
  expect(edits[1]!.result).toMatchObject({
    message: expect.stringContaining("Available headings: ## Labels | ## Tools"),
  });
  expect(edits[2]!.result).toMatchObject({
    message: expect.stringContaining(
      'omits existing claims without explicit removal intent: ["tools"]',
    ),
  });
  expect(edits[3]!.result).toMatchObject({
    code: "revision_conflict",
    // Whichever reference of the edited claim has no version read in this run
    // is named; the stale override never stands in for a read.
    message: expect.stringMatching(
      new RegExp(`dependency version for "source:(${sourceId}|${supportId})"`),
    ),
  });
  expect(edits[4]!.result).toMatchObject({
    kind: "structured",
    data: {
      node: { id: pageId, revision: 2 },
      edit: {
        changedSections: ["## Tools", "## Labels"],
        charsBefore: original.length,
        charsAfter: edited(sourceId, supportId).length,
      },
    },
  });
  // A receipt, not the page.
  expect(JSON.stringify(edits[4]!.result)).not.toContain(ENRICHED_TOOLS);

  // The review the edit settled is complete, as after a full knowledge_save.
  expect(
    bench.sql
      .prepare<[string, string], { status: string }>(
        "SELECT DISTINCT w.status FROM knowledge_work w JOIN knowledge_batches b ON w.batch_id=b.id WHERE w.subject_id=? AND b.run_id=?",
      )
      .all(pageId, editRun!),
  ).toEqual([{ status: "completed" }]);

  // One content-free adoption line per write and refusal.
  const log = readFileSync(bench.harness.getGatewayLogPath(), "utf8");
  expect(log).toContain(
    `Wiki write via knowledge_edit[replace_section,replace_text] on ${pageId}: r1→r2, ${original.length}→${edited(sourceId, supportId).length} chars`,
  );
  expect(log).toContain(`Wiki edit refused on ${pageId} (edit_target_not_found): replace_section`);
  expect(log).toContain(`Wiki edit refused on ${pageId} (claim_invalid): delete_section`);
  expect(log).toContain(`Wiki write via knowledge_save on ${pageId}: r0→r1`);
  expect(log).not.toContain(ENRICHED_TOOLS);
}, 300_000);
