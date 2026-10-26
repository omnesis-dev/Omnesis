// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const studio = [
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
const mooring = [
  email({
    externalId: "subject-mooring-invoice",
    title: "Mooring invoice",
    content: "The marina invoiced the annual mooring fee for berth 14.",
  }),
  email({
    externalId: "subject-mooring-contract",
    title: "Mooring contract",
    content: "The mooring contract for berth 14 renews at the end of April.",
  }),
];
const createdLoop = z.object({ loop: z.object({ id: z.string() }) });
const wikiId = "wiki_fixture_garden_studio";
/** Minor outcomes the mooring invoice also supports, which widen its maintenance region. */
const MINOR_MOORING_OUTCOMES = 6;

interface Scenario {
  bench: BrainBench;
  /** Source revisions as offered, by document id. */
  versions: Record<string, string>;
  /** Important outcomes created, by matter. */
  loops: { studio: string[]; mooring: string[] };
  /** Subject loop references offered to the organize step. */
  subjects: string[];
}

/**
 * Each document of a matter yields one important outcome joined to the matter's
 * first document. Only the garden studio subject publishes a page; any other
 * cohort declines. The mooring invoice also supports several minor outcomes.
 */
async function startScenario(
  knowledge: Record<string, unknown>,
  { mooringOutcomes = true }: { mooringOutcomes?: boolean } = {},
): Promise<Scenario> {
  const versions: Record<string, string> = {};
  const loops: Scenario["loops"] = { studio: [], mooring: [] };
  const subjects: string[] = [];
  const known: Record<"studio" | "mooring", string[]> = { studio: [], mooring: [] };
  const matterOf = (title: string) => (title.startsWith("Mooring") ? "mooring" : "studio");
  const bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    entailment: "accept-all",
    gatewayLogLevel: "info",
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "6h", ...knowledge },
    },
    behaviors: {
      dynamic: knowledgePuppet({
        // A matter's documents are read by concurrent runs, so one run's
        // outcome can be refused because another just wrote the outcome
        // collection; it reads again instead of waiting a run backoff.
        maxRevisionConflictRetries: 8,
        plan(item, ctx, steps) {
          if (item.source) {
            const matter = matterOf(item.source.title);
            const first = known[matter].find((id) => id !== item.source!.id);
            if (!known[matter].includes(item.source.id)) known[matter].push(item.source.id);
            versions[item.source.id] = item.source.sourceRevision ?? item.source.contentHash;
            // The invoice also supports minor outcomes, widening its region past the bound.
            const minor =
              item.source.title === "Mooring invoice"
                ? Array.from({ length: MINOR_MOORING_OUTCOMES }, (_, i) =>
                    call("open_loop_create", {
                      title: `Mooring paperwork ${i + 1}`,
                      description: "File the mooring paperwork.",
                      confidence: 0.9,
                      importance: 0.2,
                      docs: [item.source!.id],
                    }),
                  )
                : [];
            if (matter === "mooring" && !mooringOutcomes) return { calls: [] };
            // Two important outcomes about one matter, joined by the document they share.
            return {
              calls: [
                call("open_loop_search", { query: matter }),
                call("open_loop_create", {
                  title: `${matter === "studio" ? "Garden studio" : "Mooring"} step ${known[matter].length}`,
                  description: "Move the matter forward.",
                  confidence: 0.9,
                  importance: matter === "studio" ? 0.9 : 0.95,
                  docs: [...(first ? [first] : []), item.source.id],
                }),
                ...minor,
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
          // The important outcome is the first create of a source's plan.
          const created = steps.find((step) => step.name === "open_loop_create");
          if (item.source && created)
            loops[matterOf(item.source.title)].push(
              createdLoop.parse(structuredData(created.result)).loop.id,
            );
          return [];
        },
        organize(cohort, _ctx, steps) {
          if (!cohort.subject) return { calls: [] };
          subjects.push(cohort.subject.loopRef);
          if (!loops.studio.includes(cohort.subject.loopRef.slice("loop:".length)))
            return { calls: [] };
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
          return cohort.subject &&
            loops.studio.includes(cohort.subject.loopRef.slice("loop:".length))
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
  return { bench, versions, loops, subjects };
}

function subjectCohorts(bench: BrainBench) {
  return bench.sql
    .prepare<[], { subject: string; status: string; outcome: string | null }>(
      `SELECT subject_loop_id AS subject,status,outcome_json AS outcome FROM knowledge_organization_cohorts
      WHERE subject_loop_id IS NOT NULL ORDER BY created_at`,
    )
    .all();
}

async function waitForPublishedSubject(
  bench: BrainBench,
  drain = true,
  timeoutMs = 180_000,
): Promise<void> {
  await waitFor(
    "subject cohort disposition",
    () =>
      bench.sql
        .prepare(
          "SELECT 1 FROM knowledge_organization_cohorts WHERE subject_loop_id IS NOT NULL AND status='completed' LIMIT 1",
        )
        .get() ?? null,
    timeoutMs,
  ).catch((error: unknown) => {
    const lines = gatewayLog(bench)
      .split("\n")
      .filter((line) => /rganization cohort|knowledge/.test(line));
    throw new Error(`${String(error)}\n${lines.slice(-30).join("\n")}`);
  });
  if (drain) await bench.drainUntilQuiet();
}

function gatewayLog(bench: BrainBench): string {
  return readFileSync(bench.harness.getGatewayLogPath(), "utf8");
}

describe("a matter without a page", () => {
  let scenario: Scenario;
  beforeAll(async () => {
    scenario = await startScenario({});
  }, 300_000);
  afterAll(async () => {
    await scenario?.bench.destroy();
  }, 60_000);

  it("groups an important matter without a page into its own cohort and publishes it once", async () => {
    const { bench, loops, subjects } = scenario;
    for (const document of studio) await bench.push(document);
    await waitForPublishedSubject(bench);
    expect(loops.studio).toHaveLength(2);
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
    expect(loops.studio).toContain(cohorts[0]!.subject);
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
    // The start is logged by id and count only, and the status route counts it.
    expect(gatewayLog(bench)).toContain(
      `Organization cohort started: subject anchored on loop ${cohorts[0]!.subject}, 2 source(s)`,
    );
    const status = await bench.harness.gatewayJson<{
      organization: Array<{ kind: string; status: string; outcome: string | null; count: number }>;
    }>("/admin/brain/knowledge/status");
    expect(status.organization).toContainEqual(
      expect.objectContaining({
        kind: "subject",
        status: "completed",
        outcome: "organized",
        count: 1,
      }),
    );
    // Once a page cites the matter, it is covered and offers no further subject cohort.
    await bench.drainUntilQuiet();
    expect(subjectCohorts(bench)).toHaveLength(1);
  }, 300_000);
});

describe("a matter whose evidence does not fit the maintenance bound", () => {
  let scenario: Scenario;
  beforeAll(async () => {
    // A bound the minor outcomes on the mooring invoice exceed, while the
    // garden studio's two documents and two outcomes fit it.
    scenario = await startScenario({ maxVisitedPerSeed: MINOR_MOORING_OUTCOMES });
  }, 300_000);
  afterAll(async () => {
    await scenario?.bench.destroy();
  }, 60_000);

  it("reports why an outranking matter cannot start and still organizes the next one", async () => {
    const { bench, loops } = scenario;
    // The mooring matter outranks the garden studio, but its invoice's region
    // exceeds the bound, so the invoice is never considered and the subject
    // has one usable document.
    for (const document of mooring) await bench.push(document);
    // The mooring matter outranks the garden studio only once both of its
    // documents have yielded an important outcome. Their runs race, and the
    // invoice's is refused at its bound and retried on the run backoff, so
    // the first report can count a single outcome. The studio arrives only
    // after a report counts at least two, all of them the mooring's;
    // otherwise its own runs race the mooring's retries.
    // Retried invoice plans may add outcomes, so only the lacking count is pinned.
    const report =
      /Subject organization cohorts: none started; ([2-9]|[1-9]\d+) important outcome\(s\), ([2-9]|[1-9]\d+) without a page, in 1 subject\(s\); 0 waiting their retry, 0 passed over after a failed start, 1 with fewer than two considered documents/;
    await waitFor(
      "the mooring matter to outrank",
      () => (loops.mooring.length >= 2 ? report.exec(gatewayLog(bench)) : null),
      300_000,
    ).catch((error: unknown) => {
      const lines = gatewayLog(bench)
        .split("\n")
        .filter((line) => /rganization cohort/.test(line));
      throw new Error(
        `${String(error)}; mooring outcomes planned: ${loops.mooring.length}\n${lines.slice(-20).join("\n")}`,
      );
    });
    for (const document of studio) await bench.push(document);
    // The invoice's maintenance stays pending behind the bound, so the queue never drains.
    await waitForPublishedSubject(bench, false, 480_000);
    expect(loops.studio).toHaveLength(2);
    const cohorts = subjectCohorts(bench);
    expect(cohorts).toHaveLength(1);
    expect(loops.studio).toContain(cohorts[0]!.subject);
    expect(JSON.parse(cohorts[0]!.outcome!)).toMatchObject({
      outcome: "organized",
      targetIds: [wikiId],
    });
    expect(gatewayLog(bench)).toContain(
      `Organization cohort started: subject anchored on loop ${cohorts[0]!.subject}, 2 source(s)`,
    );
  }, 900_000);
});

describe("a publication retry that cannot start", () => {
  let scenario: Scenario;
  beforeAll(async () => {
    // The mooring documents yield no outcomes here: they only form the retry.
    scenario = await startScenario({}, { mooringOutcomes: false });
  }, 300_000);
  afterAll(async () => {
    await scenario?.bench.destroy();
  }, 60_000);

  it("passes over a retry that conflicts so a subject still publishes", async () => {
    const { bench, loops } = scenario;
    for (const document of mooring) await bench.push(document);
    const declined = await waitFor(
      "the mooring documents' chronological cohort",
      () =>
        bench.sql
          .prepare<[], { id: string; member: string }>(
            `SELECT c.id,MIN(m.source_id) AS member FROM knowledge_organization_cohorts c
            JOIN knowledge_organization_members m ON m.cohort_id=c.id
            WHERE c.subject_loop_id IS NULL AND c.status='completed' GROUP BY c.id LIMIT 1`,
          )
          .get() ?? null,
      180_000,
    );
    // A published search gap reopens it, while another active batch holds part
    // of its region, so every attempt to start it conflicts.
    bench.withWriteHandle((db) => {
      db.prepare(
        "UPDATE knowledge_organization_cohorts SET retrieval_reconsider_at=0 WHERE id=?",
      ).run(declined.id);
      // A queued run keeps the batch from being recovered as orphaned.
      const later = Date.now() + 365 * 86_400_000;
      db.prepare(
        `INSERT INTO cognition_runs(id,kind,payload_json,dedupe_key,status,attempts,next_attempt_at,enqueued_at,cycle_anchor_at)
        VALUES('cog_fixture_busy','synthesis','{}',NULL,'pending',0,?,?,?)`,
      ).run(later, Date.now(), Date.now());
      db.prepare(
        `INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at)
        VALUES('kb_fixture_busy','cog_fixture_busy','fixture','routine','running',0,0)`,
      ).run();
      db.prepare(
        "INSERT INTO knowledge_batch_regions(batch_id,node_id) VALUES('kb_fixture_busy',?)",
      ).run(`source:${declined.member}`);
    });
    await waitFor(
      "the conflicting retry passed over",
      () =>
        /Organization cohort not started: retry, 2 source\(s\), reason revision_conflict \(Maintenance region overlaps an active batch\); passing over it/.exec(
          gatewayLog(bench),
        ),
      180_000,
    ).catch((error: unknown) => {
      const lines = gatewayLog(bench)
        .split("\n")
        .filter((line) => /rganization cohort|abandon/i.test(line));
      throw new Error(`${String(error)}\n${lines.slice(-20).join("\n")}`);
    });
    for (const document of studio) await bench.push(document);
    await waitForPublishedSubject(bench, false, 300_000);
    const cohorts = subjectCohorts(bench);
    expect(cohorts).toHaveLength(1);
    expect(loops.studio).toContain(cohorts[0]!.subject);
    expect(JSON.parse(cohorts[0]!.outcome!)).toMatchObject({
      outcome: "organized",
      targetIds: [wikiId],
    });
  }, 900_000);
});
