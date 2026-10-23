// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Automated status streams and log-shaped pages, end to end:
 *
 * - a page about a build service that already reads as a log (most of its
 *   sections named by dates) gets exactly one whole-page consolidation review
 *   queued the first time a maintenance pass touches it, and never another;
 * - a stream of routine build-status notifications about that service, judged
 *   low-information by the discovery worth gate, wakes no page maintenance:
 *   no run interprets them, no work reaches the page and it gains no revision,
 *   while the decision ledger records every judgement.
 *
 * The scripted decision model answers the discovery question low only for the
 * routine stream and only when the request carries the status-notification
 * rubric; the bench checks what the engine does with that verdict, not its
 * quality. Fixture data is invented — no corpus content.
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
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";

compressCognitionCadences();

const pageId = "atlas-web-build-pipeline";
const SUPPORT = note({
  externalId: "runner-pool-plan",
  title: "Runner pool east migration plan",
  content:
    "The atlas-web nightly build moves to runner pool east on Harbor CI (builds.example.com) in March; its integration stage is the slowest step.",
});
const CREATOR = note({
  externalId: "atlas-web-onboarding",
  title: "Atlas-web build onboarding",
  content:
    "Atlas-web builds nightly on Harbor CI. Failures in the integration stage are usually runner timeouts on runner pool east.",
});
const STATUS_PREFIX = "Harbor CI status:";
const STREAM = [
  ["status-101", "atlas-web nightly build #101 failed", "failed at the integration stage"],
  ["status-102", "atlas-web nightly build #102 passed", "passed in 41 minutes"],
  ["status-103", "atlas-web nightly build #103 failed", "failed at the integration stage"],
].map(([externalId, subject, outcome]) =>
  email({
    externalId: externalId!,
    title: `${STATUS_PREFIX} ${subject}`,
    content: `This is an automated message from builds.example.com. Workflow nightly for atlas-web ${outcome}. View the run at https://builds.example.com/atlas-web/runs.`,
  }),
);
/** The rubric clause the scripted decision model keys its low verdict on. */
const STATUS_RUBRIC = "When it only reports another routine outcome of that kind";

const section = (id: string, sourceId: string, heading: string) =>
  [
    `<claim id="${id}" refs="source:${sourceId}">`,
    `## ${heading}`,
    "",
    "The build ran.",
    "</claim>",
  ].join("\n");
const logShaped = (supportId: string, creatorId: string) =>
  [
    `<claim id="overview" refs="source:${supportId} source:${creatorId}">`,
    "Atlas-web builds nightly on Harbor CI, on runner pool east.",
    "</claim>",
    "",
    section("mar-2", supportId, "2 March build results"),
    "",
    section("mar-3", creatorId, "3 March build results"),
    "",
    section("mar-4", supportId, "4 March build results"),
    "",
    section("mar-5", creatorId, "5 March build results"),
    "",
  ].join("\n");

let bench: BrainBench;
let supportId = "";
let creatorId = "";

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
      if (item.source.title !== CREATOR.title) return { calls: [] };
      const exists = existingPage(steps);
      if (exists === undefined) return { calls: [call("knowledge_list", { kind: "wiki" })] };
      if (exists) return { calls: [] };
      const support = complementaryEvidence(SUPPORT.title, steps);
      if (!support.evidence) return { calls: support.calls };
      supportId = support.evidence.id;
      creatorId = item.source.id;
      return {
        calls: [
          call("knowledge_list", { kind: "wiki" }),
          call("knowledge_candidates", {}),
          call("knowledge_propose_page", {
            identityKey: pageId,
            title: "Atlas-web build pipeline",
            scope: "How the atlas-web nightly build runs and fails",
            evidenceVersions: {
              [supportId]: support.evidence.revision,
              [creatorId]: item.source.contentHash,
            },
          }),
          call("knowledge_save", {
            candidateId: ref("knowledge_propose_page", "id"),
            creationAssessment: {
              reason: "The migration plan and onboarding together describe the build.",
              relatedPageIds: [],
            },
            node: {
              id: pageId,
              kind: "wiki",
              title: "Atlas-web build pipeline",
              expectedRevision: 0,
              markdown: logShaped(supportId, creatorId),
              inputVersions: {
                [`source:${supportId}`]: support.evidence.revision,
                [`source:${creatorId}`]: item.source.contentHash,
              },
            },
          }),
        ],
      };
    }
    if (item.id === pageId && item.node)
      return {
        calls: [
          call("knowledge_list", { kind: "wiki" }),
          call("knowledge_save", {
            inputFingerprint: item.inputFingerprint,
            placementAssessment: { status: "standalone", reason: "Self-contained build page." },
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
    return preserveCurrentOwner(item, ctx, steps);
  },
  // The creating source names the page, so a maintenance pass touches it.
  targets: (item) => (item.source?.title === CREATOR.title ? [pageId] : []),
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
            const source = (request.state as { source?: { title?: string } }).source;
            const routineStatus =
              key === "discovery" &&
              String(question.instructions).includes(STATUS_RUBRIC) &&
              !!source?.title?.startsWith(STATUS_PREFIX);
            return [
              key,
              {
                type: "score" as const,
                score: routineStatus ? 0 : question.criteria.length - 1,
                confidence: 1,
              },
            ];
          }),
        ),
    },
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      workerConcurrency: 1,
      knowledge: { soonDelay: "1s", routineDelay: "6h" },
    },
    behaviors: { dynamic: maintain },
  });
}, 300_000);

afterAll(async () => {
  await bench?.destroy();
}, 60_000);

const queuedLines = () =>
  readFileSync(bench.harness.getGatewayLogPath(), "utf8")
    .split("\n")
    .filter((line) => line.includes(`Wiki ${pageId} queued for review:`));
const pageRow = () =>
  bench.sql
    .prepare<
      [string],
      { revision: number; metadata_json: string }
    >("SELECT revision,metadata_json FROM knowledge_nodes WHERE id=?")
    .get(pageId);

it("queues one consolidation review for a log-shaped page and keeps a routine status stream off it", async () => {
  await bench.push(SUPPORT);
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  await waitForComplementaryEvidence(bench, SUPPORT.title);
  await bench.push(CREATOR);
  await expect.poll(() => pageRow()?.revision, { timeout: 120_000 }).toBeGreaterThan(0);
  await bench.drainUntilQuiet({ timeoutMs: 180_000 });
  expect(creatorId).toBe(await bench.docId(CREATOR.externalId));

  // The pass that touched the log-shaped page queued one consolidation review.
  expect(queuedLines()).toHaveLength(1);
  expect(queuedLines()[0]).toContain("most of its sections are named by dates");
  const requested = JSON.parse(pageRow()!.metadata_json) as {
    reviewRequests?: Record<string, number>;
  };
  expect(requested.reviewRequests?.chronological_log).toEqual(expect.any(Number));
  const reviewRuns = bench.sql
    .prepare(
      "SELECT 1 FROM knowledge_work WHERE subject_kind='node' AND subject_id=? AND reason='review' AND tier='immediate'",
    )
    .all(pageId);
  expect(reviewRuns.length).toBeGreaterThanOrEqual(1);

  // A routine status stream arrives in several batches.
  const before = pageRow()!.revision;
  const pageWork = () =>
    (
      bench.sql
        .prepare("SELECT COUNT(*) AS n FROM knowledge_work WHERE subject_id=?")
        .get(pageId) as { n: number }
    ).n;
  const workBefore = pageWork();
  const streamIds: string[] = [];
  for (const doc of STREAM) {
    await bench.push(doc);
    await bench.drainUntilQuiet({ timeoutMs: 120_000 });
    streamIds.push(await bench.docId(doc.externalId));
  }

  for (const id of streamIds) {
    // Judged and gated: no model run interpreted it, nothing named the page.
    expect(
      bench.sql
        .prepare(
          "SELECT status FROM knowledge_discovery_coverage WHERE subject_id=? AND phase='organization'",
        )
        .get(id),
    ).toEqual({ status: "gated" });
    expect(await bench.obs.runsForSource(id)).toEqual([]);
    expect(
      bench.sql.prepare("SELECT 1 FROM knowledge_discovery_targets WHERE source_id=?").get(id),
    ).toBeUndefined();
    // The ledger keeps each judgement, under the current rubric.
    expect(
      bench.sql
        .prepare(
          "SELECT purpose,score,rubric_version FROM knowledge_decisions WHERE node_id=? AND purpose='discovery'",
        )
        .all(`source:${id}`),
    ).toEqual([{ purpose: "discovery", score: 0, rubric_version: "knowledge-discovery-value-v8" }]);
  }
  expect(pageRow()!.revision).toBe(before);
  expect(pageWork()).toBe(workBefore);
  // Still exactly one consolidation request for the page.
  expect(queuedLines()).toHaveLength(1);
}, 600_000);
