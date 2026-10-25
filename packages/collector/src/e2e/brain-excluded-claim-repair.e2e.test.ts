// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Repairing a page that partly rests on a source excluded from the Brain, end
 * to end. A wiki page has six claims: three cite a session log whose source the
 * operator then excludes, and one cites a document that changes. The
 * maintenance run is not offered the excluded-source claims (it may not read
 * that source, and being unable to re-check a claim is not evidence against
 * it); its attempt to gut the page, removing four claims with one boilerplate
 * reason under a new title, is refused and saves nothing; its targeted edit of
 * the changed claim leaves the page current rather than stale; and it settles
 * the remaining readable claim by review. Every claim survives.
 *
 * Fixture data is invented — no corpus content.
 */

import "./synth-env.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  note,
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

const pageId = "community-garden-guide";
const TITLE = "Community garden guide";
const SUPPORT_TITLE = "Garden tool rota";
const LOG_TITLE = "Garden planning session log";
const MAIN_TITLE = "Community garden plan";
const EXCLUDED_TYPE = "assistant-log";
const LOG_CLAIMS = ["beds", "compost", "watering"];
const BOILERPLATE =
  "Removed from this bounded repair because its cited source cannot be re-grounded in this run.";

const section = (id: string, refs: string, heading: string, text: string) =>
  [`<claim id="${id}" refs="${refs}">`, `## ${heading}`, "", text, "</claim>"].join("\n");
const overview = (mainId: string, supportId: string, month: string) =>
  [
    `<claim id="overview" refs="source:${mainId} source:${supportId}">`,
    `The community garden is run by volunteers and opens each ${month}.`,
    "</claim>",
  ].join("\n");
const opening = (mainId: string, month: string) =>
  section("opening", `source:${mainId}`, "Opening", `The garden opens in ${month}.`);
const logSections = (logId: string) => [
  section("beds", `source:${logId}`, "Beds", "The raised beds face south."),
  section("compost", `source:${logId}`, "Compost", "The compost bins sit by the gate."),
  section("watering", `source:${logId}`, "Watering", "Watering runs at dawn."),
];
const tools = (supportId: string) =>
  section(
    "tools",
    `source:${supportId}`,
    "Tools",
    "Volunteers return the tools to the shed on Sundays.",
  );
const created = (mainId: string, supportId: string, logId: string) =>
  [
    overview(mainId, supportId, "April"),
    ...logSections(logId),
    opening(mainId, "April"),
    tools(supportId),
    "",
  ].join("\n\n");

const MAIN = email({
  externalId: "garden-plan",
  title: MAIN_TITLE,
  content:
    "The community garden is run by volunteers and opens each April. The garden opens in April.",
});

let bench: BrainBench;
let mainId = "";
let supportId = "";
let logId = "";
let excluded = false;
let repairRun: string | undefined;

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

const placementAssessment = {
  status: "standalone",
  reason: "Self-contained community garden reference.",
};

const maintain = knowledgePuppet({
  plan(item, ctx, steps) {
    if (item.source) {
      if (item.source.title !== MAIN_TITLE) return { calls: [] };
      const exists = existingPage(steps);
      if (exists === undefined) return { calls: [call("knowledge_list", { kind: "wiki" })] };
      if (exists) return { calls: [] };
      const support = complementaryEvidence(SUPPORT_TITLE, steps);
      if (!support.evidence) return { calls: support.calls };
      const log = complementaryEvidence(LOG_TITLE, steps);
      if (!log.evidence) return { calls: [...support.calls, ...log.calls] };
      mainId = item.source.id;
      supportId = support.evidence.id;
      logId = log.evidence.id;
      return {
        calls: [
          ...support.calls,
          ...log.calls,
          call("knowledge_list", { kind: "wiki" }),
          call("knowledge_candidates", {}),
          call("knowledge_propose_page", {
            identityKey: pageId,
            title: TITLE,
            scope: "How the volunteer-run community garden is laid out and kept",
            evidenceVersions: {
              [mainId]: item.source.contentHash,
              [supportId]: support.evidence.revision,
              [logId]: log.evidence.revision,
            },
          }),
          call("knowledge_save", {
            candidateId: ref("knowledge_propose_page", "id"),
            creationAssessment: {
              reason: "The plan, the session log and the tool rota together describe the garden.",
              relatedPageIds: [],
            },
            node: {
              id: pageId,
              kind: "wiki",
              title: TITLE,
              expectedRevision: 0,
              markdown: created(mainId, supportId, logId),
              inputVersions: {
                [`source:${mainId}`]: item.source.contentHash,
                [`source:${supportId}`]: support.evidence.revision,
                [`source:${logId}`]: log.evidence.revision,
              },
            },
          }),
        ],
      };
    }
    if (item.id === pageId && item.node) {
      // The repair offered after the session log's source is excluded and the
      // plan changes: edit the two claims that cite the plan, and review them.
      if (excluded && item.pendingClaimIds?.includes("opening"))
        return {
          calls: [
            call("knowledge_list", { kind: "wiki" }),
            call("knowledge_reference", { ref: `source:${mainId}` }),
            call("knowledge_reference", { ref: `source:${supportId}` }),
            call("knowledge_edit", {
              inputFingerprint: item.inputFingerprint,
              placementAssessment,
              reviewedClaimIds: ["opening", "overview"],
              node: {
                id: pageId,
                expectedRevision: item.node.revision,
                edits: [
                  { op: "replace_text", old: "opens each April", new: "opens each May" },
                  {
                    op: "replace_text",
                    old: "The garden opens in April.",
                    new: "The garden opens in May.",
                  },
                ],
              },
            }),
          ],
        };
      // Anything else offered on the page is reviewed and kept as it is.
      return {
        calls: [
          call("knowledge_list", { kind: "wiki" }),
          call("knowledge_edit", {
            inputFingerprint: item.inputFingerprint,
            placementAssessment,
            reviewedClaimIds: item.pendingClaimIds ?? [],
            node: { id: pageId, expectedRevision: item.node.revision, edits: [] },
          }),
        ],
      };
    }
    return preserveCurrentOwner(item, ctx, steps);
  },
  targets: (item) => (item.source?.title === MAIN_TITLE ? [pageId] : []),
});

/**
 * Before its real edit, the repair run tries to gut the page once: keep the
 * two plan claims, remove the other four with one boilerplate reason, and
 * retitle the page. The refused save is hidden from the maintenance policy.
 */
function guttingArm(item: PuppetKnowledgeItem, steps: readonly ToolStep[]) {
  if (steps.some((step) => step.name === "knowledge_save" && isError(step))) return null;
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
  if (!since.some((step) => step.name === "knowledge_reference"))
    return {
      kind: "tool" as const,
      name: "knowledge_reference",
      args: { ref: `source:${mainId}` },
    };
  return {
    kind: "tool" as const,
    name: "knowledge_save",
    args: {
      inputFingerprint: item.inputFingerprint,
      placementAssessment,
      reviewedClaimIds: ["opening", "overview"],
      node: {
        id: pageId,
        kind: "wiki",
        title: "Garden opening dates",
        expectedRevision: item.node!.revision,
        markdown: [overview(mainId, supportId, "April"), opening(mainId, "April"), ""].join("\n\n"),
        claimRemovals: [...LOG_CLAIMS, "tools"].map((id) => ({ id, reason: BOILERPLATE })),
      },
    },
  };
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
      // Serialized runs keep the scripted repair inside one run.
      workerConcurrency: 1,
      knowledge: { soonDelay: "1s", routineDelay: "6h" },
    },
    behaviors: {
      dynamic(ctx, steps) {
        const item = offeredPage(steps);
        if (
          excluded &&
          item?.node &&
          item.pendingClaimIds?.includes("opening") &&
          (repairRun ?? ctx.runId) === ctx.runId
        ) {
          repairRun = ctx.runId;
          const arm = guttingArm(item, steps);
          if (arm) return arm;
        }
        return maintain(
          ctx,
          steps.filter((step) => !(step.name === "knowledge_save" && isError(step))),
        );
      },
    },
  });
}, 300_000);

afterAll(async () => {
  await bench?.destroy();
}, 60_000);

it("keeps excluded-source claims through a repair and refuses gutting the page", async () => {
  await bench.pushAll([
    email({
      externalId: "garden-tool-rota",
      title: SUPPORT_TITLE,
      content: "Volunteers return the tools to the shed on Sundays.",
    }),
    note({
      externalId: "garden-session-log",
      title: LOG_TITLE,
      content:
        "Session notes: the raised beds face south. The compost bins sit by the gate. Watering runs at dawn.",
      sourceId: `${EXCLUDED_TYPE}:workstation`,
      providerId: `${EXCLUDED_TYPE}:workstation`,
    }),
  ]);
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  await waitForComplementaryEvidence(bench, SUPPORT_TITLE);
  await waitForComplementaryEvidence(bench, LOG_TITLE);
  await bench.push(MAIN);
  await expect
    .poll(() => bench.sql.prepare("SELECT 1 FROM knowledge_nodes WHERE id=?").get(pageId), {
      timeout: 120_000,
    })
    .toBeDefined();
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  expect(mainId).toBe(await bench.docId("garden-plan"));
  const original = created(mainId, supportId, logId);
  expect(bench.sql.prepare("SELECT markdown FROM knowledge_nodes WHERE id=?").get(pageId)).toEqual({
    markdown: original,
  });

  // The operator excludes the session log's source; then the plan changes.
  excluded = true;
  await bench.patchConfig({ brain: { excludedSources: [EXCLUDED_TYPE] } });
  await bench.update(
    MAIN,
    "The community garden is run by volunteers and opens each May. The garden opens in May.",
  );
  await expect
    .poll(
      () =>
        (
          bench.sql
            .prepare<
              [string],
              { markdown: string }
            >("SELECT markdown FROM knowledge_nodes WHERE id=?")
            .get(pageId)?.markdown ?? ""
        ).includes("The garden opens in May."),
      { timeout: 180_000 },
    )
    .toBe(true);
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  expect(repairRun).toBeDefined();
  const steps = await bench.obs.executedTools(repairRun!);
  const frontiers = steps
    .filter((step) => step.tool === "knowledge_next_frontier")
    .map((step) =>
      z
        .object({
          items: z.array(z.object({ id: z.string(), pendingClaimIds: z.array(z.string()) })),
        })
        .passthrough()
        .parse(structuredData(step.result)),
    )
    .flatMap((frontier) => frontier.items.filter((item) => item.id === pageId));

  // The excluded-source claims were never offered for review.
  expect(frontiers.length).toBeGreaterThanOrEqual(2);
  expect([...frontiers[0]!.pendingClaimIds].sort()).toEqual(["opening", "overview", "tools"]);
  for (const offered of frontiers)
    for (const id of LOG_CLAIMS) expect(offered.pendingClaimIds).not.toContain(id);

  // The gutting save was refused as a tool error, naming the right paths.
  const saves = steps.filter((step) => step.tool === "knowledge_save");
  expect(saves).toEqual([
    expect.objectContaining({
      result: expect.objectContaining({
        kind: "error",
        code: "claim_invalid",
        message: expect.stringMatching(/removes 4 of the page's 6 claims.*knowledge_retire/),
      }),
    }),
  ]);

  // The targeted edit left the page current, and its successor offered only
  // the readable claim the edit did not review; review settled it.
  const edits = steps.filter((step) => step.tool === "knowledge_edit");
  expect(edits.map((step) => step.result?.kind)).toEqual(["structured", "structured"]);
  expect(edits[0]!.result).toMatchObject({
    data: { node: { id: pageId, validity: "current" } },
  });
  expect(frontiers.at(-1)!.pendingClaimIds).toEqual(["tools"]);
  expect(edits[1]!.args).toMatchObject({ reviewedClaimIds: ["tools"] });

  // Every claim survives; the excluded-source claims are byte-identical and
  // still rest on the session log.
  const page = bench.sql
    .prepare<
      [string],
      { title: string; markdown: string; validity: string }
    >("SELECT title,markdown,validity FROM knowledge_nodes WHERE id=?")
    .get(pageId)!;
  expect(page.title).toBe(TITLE);
  expect(page.markdown).toBe(
    original
      .replace("opens each April", "opens each May")
      .replace("The garden opens in April.", "The garden opens in May."),
  );
  for (const span of logSections(logId)) expect(page.markdown).toContain(span);
  expect(
    bench.sql
      .prepare<[string], { id: string }>(
        "SELECT id FROM knowledge_claims WHERE node_id=? ORDER BY id",
      )
      .all(pageId)
      .map((row) => row.id),
  ).toEqual(["beds", "compost", "opening", "overview", "tools", "watering"]);
  expect(
    bench.sql
      .prepare<[string, string], { claim_id: string }>(
        "SELECT claim_id FROM knowledge_dependencies WHERE node_id=? AND target_id=? ORDER BY claim_id",
      )
      .all(pageId, logId)
      .map((row) => row.claim_id),
  ).toEqual(LOG_CLAIMS);
  // No revision ever removed a claim.
  for (const revision of bench.sql
    .prepare<
      [string],
      { diff_json: string }
    >("SELECT diff_json FROM knowledge_revisions WHERE node_id=?")
    .all(pageId))
    expect(JSON.parse(revision.diff_json).claimRemovals).toBeUndefined();
  // The excluded-source claims were settled as not examined, never as verified by review.
  expect(
    bench.sql
      .prepare<[string, string], { claim_id: string; status: string }>(
        `SELECT DISTINCT o.claim_id,o.status FROM knowledge_claim_outcomes o JOIN knowledge_batches b ON b.id=o.batch_id
         WHERE o.node_id=? AND b.run_id=? AND o.claim_id IN ('beds','compost','watering') ORDER BY o.claim_id`,
      )
      .all(pageId, repairRun!),
  ).toEqual(LOG_CLAIMS.map((claim_id) => ({ claim_id, status: "skipped" })));
}, 400_000);
