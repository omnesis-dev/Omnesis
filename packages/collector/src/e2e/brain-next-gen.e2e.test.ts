// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { createLogger } from "@omnesis/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BrainBench, compressCognitionCadences } from "./brain-bench/bench.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";
import { nextGenDecisionPolicy, nextGenPolicy } from "./brain-bench/next-gen-policy.js";
import { waitForComplementaryEvidence } from "./brain-bench/complementary-evidence.js";
import { DEMO_LOOPS } from "./brain-bench/next-gen-loops.js";
import { loadNextGenScenario, NextGenScenarioDriver } from "./brain-bench/next-gen-scenario.js";

compressCognitionCadences();
const log = createLogger("collector:brain-bench");
interface Page {
  id: string;
  kind: string;
  markdown: string;
  revision: number;
  meaningRevision: number;
  validity: string;
  canonicalFields?: { withdrawn?: boolean };
  claims?: Array<{ id: string; verification: string; meaningRevision: number }>;
}
interface Batch {
  id: string;
  tier: string;
  status: string;
}
interface Status {
  work: Array<{ status: string; tier: string; count: number; nextDueAt: number }>;
  coverage: Array<{ phase: string; status: string; count: number }>;
}

describe("next generation brain progressive maintenance", () => {
  let bench: BrainBench;
  const scenario = loadNextGenScenario();
  const populatedRootRuns = new Set<string>();
  const rootGoals: unknown[] = [];
  const pages = async () =>
    (await bench.harness.gatewayJson<{ items: Page[] }>("/admin/brain/knowledge?limit=100")).items;
  const page = async (id: string) => (await pages()).find((entry) => entry.id === id);
  const claimRevision = async (id: string, claimId: string) =>
    (await bench.harness.gatewayJson<Page>(`/admin/brain/knowledge/${id}`)).claims?.find(
      (claim) => claim.id === claimId,
    )?.meaningRevision;
  const accessSearch = async () =>
    bench.harness.gatewayJson<{ results: Array<{ id: string }> }>(
      "/documents/search?q=amber-paper-boat&sources=brain-knowledge",
    );
  const batches = async () =>
    (
      await bench.harness.gatewayJson<{ items: Batch[] }>(
        "/admin/brain/knowledge/batches?limit=100",
      )
    ).items;

  beforeAll(async () => {
    bench = await BrainBench.start({
      universe: "sacha-bellamy",
      experimental: true,
      clock: "virtual",
      syncSources: false,
      embedder: true,
      entailment: "accept-all",
      decision: { policy: nextGenDecisionPolicy },
      behaviors: {
        dynamic: knowledgePuppet({
          ...nextGenPolicy,
          plan(item, ctx, steps) {
            if (item.node?.kind === "root") {
              rootGoals.push(item.maintenanceGoal);
              if (item.node.markdown.trim()) populatedRootRuns.add(ctx.runId);
            }
            return nextGenPolicy.plan(item, ctx, steps);
          },
        }),
      },
      brain: {
        bootstrap: { enabled: false },
        derivationBarrier: "0s",
        knowledge: { rootMaxChars: 2000, soonDelay: "1h", routineDelay: "6h" },
      },
    });
    await bench.clock.set(Date.parse(scenario.epoch));
  }, 300_000);
  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);
  afterEach(async ({ task }) => {
    if (task.result?.state !== "fail" || !bench) return;
    const runs = await bench.obs.runs({ limit: 20 });
    log.error(
      `Progressive maintenance failure: ${JSON.stringify({
        runs,
        work: bench.sql.prepare("SELECT * FROM knowledge_work").all(),
        batches: await batches(),
        calls: bench.puppetCalls.map(({ emitted }) => emitted),
        tools: await Promise.all(
          runs.items.map(async (run) => ({
            id: run.id,
            tools: await bench.obs.executedTools(run.id),
          })),
        ),
      })}`,
    );
  });

  it("repairs actual evidence changes, discovers new links and reviews pages whose source is deleted", async () => {
    const sourceId = bench.harness.getSourceIds().find((id) => id.startsWith("gmail:"));
    expect(sourceId).toBeDefined();
    // Model a source whose initial collector sync has already claimed an epoch.
    // Progressive pushes must still land after the ambient universe was loaded.
    const epoch = await bench.harness.gatewayJson<{ wipeEpoch: number }>(
      `/sync-state/${encodeURIComponent(sourceId!)}/begin`,
      { method: "POST" },
    );
    expect(epoch.wipeEpoch).toBeGreaterThan(0);
    const driver = new NextGenScenarioDriver(bench, scenario, {
      providerId: "google",
      sourceId: sourceId!,
    });
    let gatheringMarkdown = "";
    let initialRootMarkdown = "";
    let sourceChanges: unknown[] = [];
    const sourceChangeWork = () =>
      bench.sql
        .prepare(
          "SELECT id,subject_id,input_revision,generation FROM knowledge_work WHERE subject_kind='source' AND reason='change' ORDER BY id",
        )
        .all();
    let gatheringMeaningRevision = 0;
    let originalSupplyHash = "";
    let arrivalRevision: number | undefined;
    for (;;) {
      const checkpoint = await driver.advance();
      if (!checkpoint) break;
      const { step, documentIds } = checkpoint;
      if (step.id === "recent-bootstrap") {
        await expect
          .poll(async () => (await page("demo-gathering"))?.markdown, { timeout: 120_000 })
          .toContain("10:00");
        await expect
          .poll(async () => (await page("demo-camera"))?.markdown, { timeout: 120_000 })
          .toContain("Saturday");
        await bench.drainUntilQuiet({ includeUpcoming: false });
        await expect
          .poll(
            async () => {
              initialRootMarkdown =
                (await pages()).find((entry) => entry.kind === "root")?.markdown ?? "";
              return initialRootMarkdown;
            },
            { timeout: 120_000 },
          )
          .not.toBe("");
        // Advancing time can admit the initial organization cohort independently
        // of an upsert. Finish that scheduled work before measuring replay as a
        // no-op; the replay itself will run at this same virtual-clock instant.
        const replay = scenario.steps.find((entry) => entry.id === "unchanged-replay")!;
        await bench.clock.set(Date.parse(scenario.epoch) + replay.minute * 60_000);
        await expect
          .poll(
            () =>
              bench.sql
                .prepare<[], { count: number }>(
                  "SELECT COUNT(*) AS count FROM knowledge_organization_cohorts WHERE status='completed'",
                )
                .get()!.count,
            { timeout: 120_000 },
          )
          .toBeGreaterThan(0);
        await bench.drainUntilQuiet({ includeUpcoming: false });
        const settledGathering = (await page("demo-gathering"))!;
        gatheringMarkdown = settledGathering.markdown;
        sourceChanges = sourceChangeWork();
        gatheringMeaningRevision = settledGathering.meaningRevision;
        arrivalRevision = await claimRevision("demo-gathering", "guest-arrival");
        expect(arrivalRevision).toBeDefined();
        originalSupplyHash = bench.sql
          .prepare<[string], { content_hash: string }>(
            "SELECT content_hash FROM documents WHERE id=?",
          )
          .get(documentIds.get("party-supplies")!)!.content_hash;
        expect(
          (await batches()).filter((entry) => entry.status === "completed").length,
        ).toBeGreaterThanOrEqual(2);
      } else if (step.id === "unchanged-replay") {
        await bench.drainUntilQuiet({ includeUpcoming: false });
        const replayed = (await page("demo-gathering"))!;
        // Index publication can independently trigger a proof-only review.
        // Replaying identical source bytes must enqueue no new change work
        // and must preserve the page content and semantic revision.
        expect(sourceChangeWork()).toEqual(sourceChanges);
        expect(replayed.markdown).toBe(gatheringMarkdown);
        expect(replayed.meaningRevision).toBe(gatheringMeaningRevision);
      } else if (step.id === "discovered-urgent-correction") {
        await expect
          .poll(async () => (await page("demo-gathering"))?.markdown, { timeout: 120_000 })
          .toContain("08:00");
        expect((await page("demo-gathering"))!.markdown).toContain("18:15");
        expect((await page("demo-camera"))!.markdown).toContain("Saturday");
        expect(await claimRevision("demo-gathering", "guest-arrival")).toBe(arrivalRevision);
      } else if (step.id === "same-document-edit") {
        expect(
          bench.sql
            .prepare<[string], { content_hash: string }>(
              "SELECT content_hash FROM documents WHERE id=?",
            )
            .get(documentIds.get("party-supplies")!)!.content_hash,
        ).not.toBe(originalSupplyHash);
        const editedWork = () =>
          bench.sql
            .prepare<
              [string, number],
              { id: string; inputRevision: string; generation: number; tier: string; dueAt: number }
            >(
              `SELECT id,input_revision AS inputRevision,generation,tier,due_at AS dueAt
               FROM knowledge_work
               WHERE subject_kind='source' AND subject_id=? AND reason='change'
                 AND input_changed_at=?`,
            )
            .get(documentIds.get("party-supplies")!, checkpoint.arrivalTime);
        await expect.poll(editedWork, { timeout: 60_000 }).toMatchObject({ tier: "soon" });
        const beforeRestart = editedWork()!;
        const pageBeforeRestart = (await page("demo-gathering"))!;
        // Overlapping due reviews may batch and repair this edit before its own
        // deadline. Restart must preserve the exact input and its durable owner,
        // whether maintenance is still pending, batched, or already completed.
        await bench.restartGateway();
        expect(
          bench.sql
            .prepare(
              `SELECT id,input_revision AS inputRevision,generation,tier,due_at AS dueAt
               FROM knowledge_work WHERE id=?`,
            )
            .get(beforeRestart.id),
        ).toEqual(beforeRestart);
        expect((await page("demo-gathering"))?.revision).toBeGreaterThanOrEqual(
          pageBeforeRestart.revision,
        );
        const persisted = bench.sql
          .prepare<[string], { status: string; hasBatch: number }>(
            `SELECT w.status,EXISTS(SELECT 1 FROM knowledge_batches b WHERE b.id=w.batch_id) AS hasBatch
             FROM knowledge_work w WHERE w.id=?`,
          )
          .get(beforeRestart.id)!;
        expect(["pending", "batched", "completed"]).toContain(persisted.status);
        if (persisted.status !== "pending") expect(persisted.hasBatch).toBe(1);
      } else if (step.id === "access-context-arrives") {
        await waitForComplementaryEvidence(bench, scenario.documents["access-hours"]!.title);
      } else if (step.id === "one-hour-boundary") {
        await expect
          .poll(async () => (await page("demo-access"))?.markdown, { timeout: 120_000 })
          .toContain("amber-paper-boat");
        await expect
          .poll(async () => (await page("demo-gathering"))?.validity, { timeout: 120_000 })
          .toBe("current");
        await expect.poll(async () => (await accessSearch()).results.length).toBeGreaterThan(0);
      } else if (step.id === "parallel-regions") {
        await expect
          .poll(
            () =>
              bench.sql
                .prepare(
                  "SELECT 1 FROM knowledge_work WHERE subject_id=? AND tier='routine' AND status='pending'",
                )
                .get(documentIds.get("camera-return")!),
            { timeout: 60_000 },
          )
          .toBeDefined();
        expect((await page("demo-camera"))?.markdown).toContain("Saturday");
      } else if (step.id === "shared-batch-frontier") {
        await expect
          .poll(async () => (await page("demo-gathering"))?.markdown, { timeout: 120_000 })
          .toContain("has been collected");
        await expect
          .poll(async () => (await page("demo-camera"))?.markdown, { timeout: 120_000 })
          .toContain("loan is complete");
      } else if (step.id === "privacy-delete" || step.id === "suppressed-resurrection") {
        // The deleted source is tombstoned and cannot come back; the page that
        // cited it is invalidated for review, never deleted.
        expect(
          bench.sql
            .prepare("SELECT deleted FROM knowledge_source_revisions WHERE document_id=?")
            .get(documentIds.get("privacy-detail")!),
        ).toEqual({ deleted: 1 });
        expect(
          bench.sql
            .prepare("SELECT 1 FROM documents WHERE id=?")
            .get(documentIds.get("privacy-detail")!),
        ).toBeUndefined();
        // Stale through the read fence at once, before the bounded cascade runs.
        expect((await page("demo-access"))?.validity).toBe("stale");
        expect(await page("demo-gathering")).toBeDefined();
      } else if (step.id === "conflicting-evidence") {
        await expect
          .poll(async () => (await page("demo-gathering"))?.markdown, { timeout: 120_000 })
          .toContain("unconfirmed guest suggestion");
        expect((await page("demo-gathering"))!.markdown).toContain("08:00");
      } else if (step.id === "resolve-conflict") {
        await expect
          .poll(
            async () => {
              const current = await page("demo-gathering");
              return (
                !!current &&
                current.markdown.includes("08:00") &&
                !current.markdown.includes("unconfirmed guest suggestion")
              );
            },
            { timeout: 120_000 },
          )
          .toBe(true);
      } else if (step.id === "routine-boundary") {
        await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 180_000 });
        // Review retired the page whose source was deleted; it left search.
        expect(
          bench.sql
            .prepare(
              "SELECT json_extract(fields_json,'$.withdrawn') AS withdrawn FROM knowledge_nodes WHERE id='demo-access'",
            )
            .get(),
        ).toEqual({ withdrawn: 1 });
        expect((await accessSearch()).results).toHaveLength(0);
        expect(
          (await pages()).some(
            (entry) => entry.id !== "demo-access" && entry.markdown.includes("amber-paper-boat"),
          ),
        ).toBe(false);
        await expect
          .poll(async () => (await pages()).find((entry) => entry.kind === "root")?.markdown, {
            timeout: 120_000,
          })
          .toContain("08:00");
        const all = await pages();
        const root = all.find((entry) => entry.kind === "root")!;
        expect(initialRootMarkdown).not.toBe("");
        expect(root.markdown).not.toBe(initialRootMarkdown);
        expect(root.markdown).toContain("loan is complete");
        expect(root.markdown).toContain("wiki:demo-gathering");
        expect(root.markdown).toContain("wiki:demo-camera");
        expect(root.markdown.length).toBeLessThanOrEqual(2000);
        expect(root.markdown).not.toContain("<claim");
        expect(rootGoals.length).toBeGreaterThan(0);
        expect(rootGoals.every((goal) => goal === "root_orientation")).toBe(true);
        const rootTools = await Promise.all(
          [...populatedRootRuns].map((id) => bench.obs.executedTools(id)),
        );
        expect(
          rootTools.some(
            (steps) =>
              steps.some(
                (step) => step.tool === "knowledge_fetch" && step.args.id === "demo-gathering",
              ) &&
              steps.some(
                (step) =>
                  step.tool === "knowledge_reference" &&
                  step.args.ref === "wiki:demo-gathering#claim:summary",
              ) &&
              steps.some(
                (step) => step.tool === "knowledge_save" && step.result?.kind === "structured",
              ),
          ),
        ).toBe(true);
        // The retired access page stays on record, withdrawn, beside the two live pages.
        expect(
          all
            .filter((entry) => entry.kind === "wiki" && entry.canonicalFields?.withdrawn !== true)
            .map((entry) => entry.id)
            .sort(),
        ).toEqual(["demo-camera", "demo-gathering"]);
        expect((await page("demo-gathering"))!.markdown).toContain("historical context");
        expect((await page("demo-camera"))!.markdown).toContain("loan is complete");
        const shared = bench.sql
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) AS count FROM knowledge_batches b
          WHERE EXISTS(SELECT 1 FROM knowledge_batch_regions r WHERE r.batch_id=b.id AND r.node_id='demo-gathering')
          AND EXISTS(SELECT 1 FROM knowledge_batch_regions r WHERE r.batch_id=b.id AND r.node_id='demo-camera')`,
          )
          .get()!;
        expect(shared.count).toBeGreaterThan(0);
        await expect
          .poll(
            async () =>
              (
                await bench.harness.gatewayJson<Status>("/admin/brain/knowledge/status")
              ).work.filter(
                (entry) =>
                  entry.status === "pending" &&
                  entry.nextDueAt <= Date.parse(scenario.epoch) + step.minute * 60_000,
              ),
            { timeout: 120_000 },
          )
          .toEqual([]);
        const loops = (await bench.obs.loops()).items;
        expect(loops).toHaveLength(3);
        expect(loops.find((loop) => loop.title === DEMO_LOOPS.setup)?.state).toBe("open");
        expect(loops.find((loop) => loop.title === DEMO_LOOPS.crate)?.state).toBe("done");
        expect(loops.find((loop) => loop.title === DEMO_LOOPS.camera)?.state).toBe("done");
      }
      // A page can expose this step's result before its cohort finishes repairing
      // the remaining frontier. Finish due work before pushing the next scenario
      // step, while keeping intentionally scheduled future reviews parked.
      await bench.drainUntilQuiet({ includeUpcoming: false });
    }
    const decisions = await bench.harness.gatewayJson<{
      items: Array<{ purpose: string; score: number | null }>;
    }>("/admin/brain/knowledge/decisions?limit=100");
    expect(
      decisions.items.some((entry) => entry.purpose === "urgency" && entry.score === 0.5),
    ).toBe(true);
    expect(
      decisions.items.some((entry) => entry.purpose === "discovery" && entry.score === 0),
    ).toBe(true);
    expect(bench.decision.calls.length).toBeGreaterThan(0);
    expect((await bench.obs.runs({ kind: "data" })).items).toHaveLength(0);
  }, 600_000);
});
