// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Organization cohorts regroup evidence interpreted earlier, often under an
 * older discovery rubric. Before a cohort starts, each member without a worth
 * verdict under the current rubric is judged once through the discovery gate:
 *
 * - routine status notifications interpreted under the previous rubric are
 *   judged low, their organization coverage turns `gated`, they join no cohort
 *   and wake no page maintenance, so the page about their service gains no
 *   revision;
 * - members still worth organizing start a chronological cohort as before;
 * - every judgement lands in the decision ledger under the current rubric.
 *
 * The scripted decision model answers low only for the routine stream and only
 * when the request carries the status-notification rubric; the bench checks
 * what the engine does with that verdict, not its quality. Fixture data is
 * invented — no corpus content.
 */

import "./synth-env.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  note,
  preserveCurrentOwner,
  ref,
  seedHistory,
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
/** The rubric clause the scripted decision model keys its low verdict on. */
const STATUS_RUBRIC = "When it only reports another routine outcome of that kind";
/** The rubric the seeded evidence was admitted under, before the current one. */
const PREVIOUS_RUBRIC = "knowledge-discovery-value-v7";
const HISTORY_SOURCE = "synthetic:builds@example.com";

const ROUTINE = [201, 202, 203, 204].map((run) => ({
  id: `status-${run}`,
  title: `${STATUS_PREFIX} atlas-web nightly build #${run} ${run % 2 ? "failed" : "passed"}`,
  content: `This is an automated message from builds.example.com. Workflow nightly for atlas-web ${run % 2 ? "failed at the integration stage" : "passed in 41 minutes"}.`,
}));
const WORTH = [
  {
    id: "pool-expansion",
    title: "Runner pool east expansion approved",
    content:
      "Runner pool east grows from four to eight runners next week, approved by the platform team.",
  },
  {
    id: "timeout-change",
    title: "Integration stage timeout raised",
    content: "The integration stage timeout for atlas-web was raised from 30 to 60 minutes.",
  },
];

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
              markdown: [
                `<claim id="overview" refs="source:${supportId} source:${creatorId}">`,
                "Atlas-web builds nightly on Harbor CI, on runner pool east; integration-stage failures are usually runner timeouts.",
                "</claim>",
              ].join("\n"),
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

const pageRevision = () =>
  (
    bench.sql.prepare("SELECT revision FROM knowledge_nodes WHERE id=?").get(pageId) as
      | { revision: number }
      | undefined
  )?.revision;
const organizationCoverage = (id: string) =>
  (
    bench.sql
      .prepare(
        "SELECT status FROM knowledge_discovery_coverage WHERE subject_id=? AND phase='organization'",
      )
      .get(id) as { status: string } | undefined
  )?.status;
const cohortMembers = () =>
  bench.sql
    .prepare<[], { id: string }>("SELECT source_id AS id FROM knowledge_organization_members")
    .all()
    .map((row) => row.id);

/**
 * Evidence the Brain interpreted under the previous rubric: the document,
 * its considered coverage in both discovery phases, and the earlier verdict
 * that admitted it.
 */
function seedInterpreted(doc: { id: string; title: string; content: string }, at: number) {
  seedHistory(bench, { ...doc, at, sourceId: HISTORY_SOURCE });
  const revision = createHash("sha256").update(doc.content).digest("hex");
  bench.withWriteHandle((db) => {
    const coverage = db.prepare(
      `INSERT INTO knowledge_discovery_coverage(subject_id,input_revision,phase,policy_version,status,reviewed_at)
      VALUES(?,?,?,'knowledge-discovery-v1','considered',?)`,
    );
    coverage.run(doc.id, revision, "interpretation", at);
    coverage.run(doc.id, revision, "organization", at);
    db.prepare(
      `INSERT INTO knowledge_decisions(id,purpose,input_fingerprint,score,model_id,latency_ms,input_tokens,rubric_version,created_at,node_id,threshold)
      VALUES(?,'discovery',?,1,'scripted',1,1,?,?,?,0.25)`,
    ).run(`kd_seed_${doc.id}`, `seed-${doc.id}`, PREVIOUS_RUBRIC, at, `source:${doc.id}`);
  });
}

it("withdraws routine status evidence from organization and keeps it off the page", async () => {
  await bench.push(SUPPORT);
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  await waitForComplementaryEvidence(bench, SUPPORT.title);
  await bench.push(CREATOR);
  await expect.poll(() => pageRevision(), { timeout: 120_000 }).toBeGreaterThan(0);
  // The page cites the setup notes, so their own organization may maintain it;
  // let that settle before the stream arrives.
  await expect
    .poll(() => [supportId, creatorId].every((id) => cohortMembers().includes(id)), {
      timeout: 180_000,
    })
    .toBe(true);
  await bench.drainUntilQuiet({ timeoutMs: 180_000 });
  const before = pageRevision()!;
  const membersBefore = new Set(cohortMembers());

  const { now } = await bench.clock.now();
  [...ROUTINE, ...WORTH].forEach((doc, i) => seedInterpreted(doc, now - (20 - i) * 86_400_000));

  // The next organization pass screens the selection, gates the routine
  // members and starts a cohort with the rest.
  await expect
    .poll(() => ROUTINE.map((doc) => organizationCoverage(doc.id)), { timeout: 180_000 })
    .toEqual(ROUTINE.map(() => "gated"));
  await expect
    .poll(() => WORTH.every((doc) => cohortMembers().includes(doc.id)), { timeout: 180_000 })
    .toBe(true);
  await bench.drainUntilQuiet({ timeoutMs: 180_000 });

  for (const doc of ROUTINE) {
    expect(cohortMembers()).not.toContain(doc.id);
    expect(await bench.obs.runsForSource(doc.id)).toEqual([]);
    expect(
      bench.sql.prepare("SELECT 1 FROM knowledge_discovery_targets WHERE source_id=?").get(doc.id),
    ).toBeUndefined();
  }
  for (const doc of WORTH) expect(organizationCoverage(doc.id)).toBe("considered");
  // The cohort that started holds the members still worth organizing.
  const joined = cohortMembers().filter((id) => !membersBefore.has(id));
  expect(joined).toEqual(expect.arrayContaining(WORTH.map((doc) => doc.id)));
  expect(joined.filter((id) => id.startsWith("status-"))).toEqual([]);

  // Each member was judged once under the current rubric, and the ledger keeps it.
  const ids = [...ROUTINE, ...WORTH].map((doc) => doc.id).sort();
  const verdicts = bench.sql
    .prepare<string[], { node: string; score: number; rubric: string }>(
      `SELECT node_id AS node,score,rubric_version AS rubric FROM knowledge_decisions
      WHERE purpose='discovery' AND rubric_version!=? AND node_id IN (${ids.map(() => "?").join(",")})
      ORDER BY node_id`,
    )
    .all(PREVIOUS_RUBRIC, ...ids.map((id) => `source:${id}`));
  expect(verdicts).toEqual(
    ids.map((id) => ({
      node: `source:${id}`,
      score: id.startsWith("status-") ? 0 : 1,
      rubric: "knowledge-discovery-value-v8",
    })),
  );

  // The page about the service was not maintained because of the stream.
  expect(pageRevision()).toBe(before);
  const log = readFileSync(bench.harness.getGatewayLogPath(), "utf8");
  // Setup evidence not yet organized can share the selection, so only the withdrawn count is fixed.
  expect(log).toMatch(
    new RegExp(
      `Organization cohort screened: chronological, ${ROUTINE.length} of \\d+ source\\(s\\) withdrawn as low worth`,
    ),
  );
}, 600_000);
