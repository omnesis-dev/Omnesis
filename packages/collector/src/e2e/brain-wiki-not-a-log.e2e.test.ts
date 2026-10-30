// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A wiki page states the current understanding of a subject, under a name for
 * that subject. Driven by a stream of automated build-status notifications
 * from an invented build service:
 *
 * - publishing a page titled with a cited notification's subject line is
 *   refused, and the page is saved under a name for its subject;
 * - when a later batch of notifications reaches the page, an edit that
 *   appends another date-named section to a page whose sections are mostly
 *   date-named is refused, the page is queued for whole-page review, and the
 *   run updates the page's current-state passage in place instead.
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

const pageId = "atlas-web-nightly-builds";
const SUBJECT_TITLE = "Atlas-web nightly builds";
const SUPPORT = email({
  externalId: "harbor-ci-failures",
  title: "Harbor CI: atlas-web nightly build failed twice",
  content:
    "Harbor CI (builds.example.com) reports that the atlas-web nightly build failed on 3 March and again on 5 March: the integration stage timed out on runner pool east.",
});
const RECOVERY = email({
  externalId: "harbor-ci-recovery",
  title: "Harbor CI: atlas-web nightly build recovered after runner restart",
  content:
    "Harbor CI (builds.example.com) reports that the atlas-web nightly build passed on 4 March after runner pool east was restarted.",
});
const LATER_BATCH = email({
  externalId: "harbor-ci-failure-again",
  title: "Harbor CI: atlas-web nightly build failed again",
  content:
    "Harbor CI (builds.example.com) reports that the atlas-web nightly build failed on 6 March: the integration stage timed out on runner pool east again.",
});

const OLD_OVERVIEW =
  "The atlas-web nightly build runs on Harbor CI. Its integration stage has timed out on runner pool east; the build last recovered after that pool was restarted.";
const NEW_OVERVIEW =
  "The atlas-web nightly build runs on Harbor CI. Its integration stage keeps timing out on runner pool east: a restart restored it on 4 March, and it failed the same way again on 6 March.";
const overviewClaim = (refs: string[], text: string) =>
  [
    `<claim id="overview" refs="${refs.map((id) => `source:${id}`).join(" ")}">`,
    text,
    "</claim>",
  ].join("\n");
const datedSection = (id: string, sourceId: string, heading: string, text: string) =>
  [`<claim id="${id}" refs="source:${sourceId}">`, `## ${heading}`, "", text, "</claim>"].join(
    "\n",
  );
const created = (supportId: string, recoveryId: string) =>
  [
    overviewClaim([supportId, recoveryId], OLD_OVERVIEW),
    "",
    datedSection("mar-3", supportId, "3 March failure", "The integration stage timed out."),
    "",
    datedSection("mar-4", recoveryId, "4 March recovery", "The build passed after a restart."),
    "",
    datedSection("mar-5", supportId, "5 March failure", "The integration stage timed out again."),
    "",
  ].join("\n");
const APPENDED_HEADING = "6 March failure";

let bench: BrainBench;
let supportId = "";
let recoveryId = "";
let laterId = "";
let appendRun: string | undefined;

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

/** Whether this run completed the later notification batch's discovery. */
const laterBatchDiscovered = (steps: readonly ToolStep[]) =>
  !!laterId &&
  steps.some(
    (step) =>
      step.name === "knowledge_discovery_complete" &&
      step.args?.id === `source:${laterId}` &&
      !isError(step),
  );

const placementAssessment = { status: "standalone", reason: "Self-contained build reference." };

const maintain = knowledgePuppet({
  plan(item, ctx, steps) {
    if (item.source) {
      if (item.source.title === SUPPORT.title) return { calls: [] };
      if (item.source.title === LATER_BATCH.title) laterId = item.source.id;
      const exists = existingPage(steps);
      if (exists === undefined) return { calls: [call("knowledge_list", { kind: "wiki" })] };
      if (exists) return { calls: [] };
      const support = complementaryEvidence(SUPPORT.title, steps);
      if (!support.evidence) return { calls: support.calls };
      supportId = support.evidence.id;
      recoveryId = item.source.id;
      const save = (title: string) =>
        call("knowledge_save", {
          candidateId: ref("knowledge_propose_page", "id"),
          creationAssessment: {
            reason: "The failures and the recovery together describe how the nightly build fares.",
            relatedPageIds: [],
          },
          node: {
            id: pageId,
            kind: "wiki",
            title,
            expectedRevision: 0,
            markdown: created(supportId, recoveryId),
            inputVersions: {
              [`source:${supportId}`]: support.evidence!.revision,
              [`source:${recoveryId}`]: item.source!.contentHash,
            },
          },
        });
      return {
        calls: [
          call("knowledge_list", { kind: "wiki" }),
          call("knowledge_candidates", {}),
          call("knowledge_propose_page", {
            identityKey: pageId,
            title: SUBJECT_TITLE,
            scope: "How the atlas-web nightly build currently fares and why it fails",
            evidenceVersions: {
              [supportId]: support.evidence.revision,
              [recoveryId]: item.source.contentHash,
            },
          }),
          // The notification's own subject line first, refused; then a name for the subject.
          save(RECOVERY.title),
          save(SUBJECT_TITLE),
        ],
      };
    }
    if (item.id === pageId && item.node) {
      if (laterBatchDiscovered(steps) && !item.node.markdown.includes(NEW_OVERVIEW))
        return {
          calls: [
            call("knowledge_list", { kind: "wiki" }),
            // The edited overview cites all three notifications again, so all are read.
            // Progress counts per tool name: the refused append already read the later one.
            call("knowledge_reference", { ref: `source:${laterId}` }),
            call("knowledge_reference", { ref: `source:${supportId}` }),
            call("knowledge_reference", { ref: `source:${recoveryId}` }),
            call("knowledge_edit", {
              inputFingerprint: item.inputFingerprint,
              placementAssessment,
              node: {
                id: pageId,
                expectedRevision: item.node.revision,
                edits: [
                  {
                    op: "replace_text",
                    old: overviewClaim([supportId, recoveryId], OLD_OVERVIEW),
                    new: overviewClaim([supportId, recoveryId, laterId], NEW_OVERVIEW),
                  },
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
  expectedRefusals: (item) =>
    item.source?.title === RECOVERY.title
      ? [{ tool: "knowledge_save", code: "claim_invalid" }]
      : [],
  targets: (item) => (item.source?.title === LATER_BATCH.title ? [pageId] : []),
});

/**
 * When the later batch reaches the page, the run first appends the batch as
 * one more date-named section, as a log would. The refused edit is hidden from
 * the maintenance policy, which then updates the current state in place.
 */
function appendArm(item: PuppetKnowledgeItem, steps: readonly ToolStep[]) {
  if (steps.some((step) => step.name === "knowledge_edit" && isError(step))) return null;
  const since = steps.slice(steps.findLastIndex((step) => step.name === "knowledge_next_frontier"));
  if (
    !since.some(
      (step) =>
        step.name === "knowledge_fetch" && step.args?.id === pageId && step.args?.editing === true,
    )
  )
    return { kind: "tool" as const, name: "knowledge_fetch", args: { id: pageId, editing: true } };
  const laterRef = `source:${laterId}`;
  if (!since.some((step) => step.name === "knowledge_reference" && step.args?.ref === laterRef))
    return { kind: "tool" as const, name: "knowledge_reference", args: { ref: laterRef } };
  return {
    kind: "tool" as const,
    name: "knowledge_edit",
    args: {
      inputFingerprint: item.inputFingerprint,
      reviewedClaimIds: item.pendingClaimIds ?? [],
      placementAssessment,
      node: {
        id: pageId,
        expectedRevision: item.node!.revision,
        edits: [
          {
            op: "insert_section",
            at: "end",
            markdown: datedSection(
              "mar-6",
              laterId,
              APPENDED_HEADING,
              "The integration stage timed out again.",
            ),
          },
        ],
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
      // Serialized runs keep the scripted refusal and its recovery inside one run.
      workerConcurrency: 1,
      knowledge: { soonDelay: "1s", routineDelay: "6h" },
    },
    behaviors: {
      dynamic(ctx, steps) {
        const item = offeredPage(steps);
        if (item?.node && laterBatchDiscovered(steps) && (appendRun ?? ctx.runId) === ctx.runId) {
          appendRun = ctx.runId;
          const arm = appendArm(item, steps);
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

const datedHeadings = (markdown: string) =>
  [...markdown.matchAll(/^## (\d{1,2} March .+)$/gm)].map((match) => match[1]);

it("names a page for its subject and keeps a notification stream out of dated sections", async () => {
  await bench.push(SUPPORT);
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  await waitForComplementaryEvidence(bench, SUPPORT.title);

  // The first notifications publish the page, under a name for its subject.
  await bench.push(RECOVERY);
  await expect
    .poll(() => bench.sql.prepare("SELECT title FROM knowledge_nodes WHERE id=?").get(pageId), {
      timeout: 120_000,
    })
    .toEqual({ title: SUBJECT_TITLE });
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  expect(recoveryId).toBe(await bench.docId(RECOVERY.externalId));

  let saves: Awaited<ReturnType<typeof bench.obs.executedTools>> = [];
  for (const run of await bench.obs.runsForSource(recoveryId)) {
    saves = (await bench.obs.executedTools(run.id)).filter(
      (step) => step.tool === "knowledge_save" && step.args?.candidateId !== undefined,
    );
    if (saves.length) break;
  }
  expect(saves).toHaveLength(2);
  expect(saves[0]!.args).toMatchObject({ node: { title: RECOVERY.title } });
  expect(saves[0]!.result).toMatchObject({
    kind: "error",
    code: "claim_invalid",
    message: expect.stringContaining(`repeats the title of cited source ${recoveryId}`),
  });
  expect(saves[1]!.result).toMatchObject({ kind: "structured", data: { node: { id: pageId } } });
  expect(
    bench.sql
      .prepare("SELECT 1 FROM knowledge_revisions WHERE node_id=? AND title=?")
      .get(pageId, RECOVERY.title),
  ).toBeUndefined();

  // A later batch of the same stream reaches the page.
  await bench.push(LATER_BATCH);
  await expect
    .poll(
      () =>
        (
          bench.sql.prepare("SELECT markdown FROM knowledge_nodes WHERE id=?").get(pageId) as {
            markdown: string;
          }
        ).markdown.includes(NEW_OVERVIEW),
      { timeout: 120_000 },
    )
    .toBe(true);
  // The refusal queued the page for a whole-page review (its log line is checked
  // below), which then runs.
  await expect
    .poll(
      () =>
        bench.sql
          .prepare(
            "SELECT 1 FROM knowledge_work WHERE subject_kind='node' AND subject_id=? AND reason='review'",
          )
          .get(pageId),
      { timeout: 120_000 },
    )
    .toBeDefined();
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  expect(laterId).toBe(await bench.docId(LATER_BATCH.externalId));

  // The appended dated section was refused; the in-place update landed.
  const edits = (await bench.obs.executedTools(appendRun!)).filter(
    (step) => step.tool === "knowledge_edit",
  );
  expect(edits.map((step) => (step.result?.kind === "error" ? step.result.code : "saved"))).toEqual(
    ["claim_invalid", "saved"],
  );
  expect(edits[0]!.result).toMatchObject({
    message: expect.stringContaining(
      `adds another section named by a date (${JSON.stringify([APPENDED_HEADING])}), after which 4 of the page's 4 sections`,
    ),
  });

  // No revision ever grew the log; the current state carries the later batch.
  const revisions = bench.sql
    .prepare<[string], { revision: number; title: string; markdown: string }>(
      "SELECT revision,title,markdown FROM knowledge_revisions WHERE node_id=? ORDER BY revision",
    )
    .all(pageId);
  for (const revision of revisions) {
    expect(revision.title).toBe(SUBJECT_TITLE);
    expect(datedHeadings(revision.markdown)).toEqual([
      "3 March failure",
      "4 March recovery",
      "5 March failure",
    ]);
  }
  const current = revisions.at(-1)!.markdown;
  expect(current).toBe(
    created(supportId, recoveryId).replace(
      overviewClaim([supportId, recoveryId], OLD_OVERVIEW),
      overviewClaim([supportId, recoveryId, laterId], NEW_OVERVIEW),
    ),
  );

  const log = readFileSync(bench.harness.getGatewayLogPath(), "utf8");
  expect(log).toContain(`Wiki edit refused on ${pageId} (claim_invalid): insert_section`);
  expect(log).toContain(
    `Wiki ${pageId} queued for review: 4 of its 4 sections would be named by dates`,
  );
}, 300_000);
