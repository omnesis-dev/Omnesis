// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { createLogger } from "@omnesis/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BrainBench, compressCognitionCadences } from "./brain-bench/bench.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";
import { nextGenDecisionPolicy, nextGenPolicy } from "./brain-bench/next-gen-policy.js";
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
      judge: "hold-all",
      decision: { policy: nextGenDecisionPolicy },
      behaviors: { dynamic: knowledgePuppet(nextGenPolicy) },
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

  it("repairs actual evidence changes, discovers new links and fences privacy deletion", async () => {
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
    let gatheringRevision = 0;
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
        gatheringRevision = (await page("demo-gathering"))!.revision;
        arrivalRevision = await claimRevision("demo-gathering", "guest-arrival");
        expect(arrivalRevision).toBeDefined();
        originalSupplyHash = bench.sql
          .prepare<
            [string],
            { content_hash: string }
          >("SELECT content_hash FROM documents WHERE id=?")
          .get(documentIds.get("party-supplies")!)!.content_hash;
        expect(
          (await batches()).filter((entry) => entry.status === "completed").length,
        ).toBeGreaterThanOrEqual(2);
      } else if (step.id === "unchanged-replay") {
        await bench.drainUntilQuiet({ includeUpcoming: false });
        expect((await page("demo-gathering"))!.revision).toBe(gatheringRevision);
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
            .prepare<
              [string],
              { content_hash: string }
            >("SELECT content_hash FROM documents WHERE id=?")
            .get(documentIds.get("party-supplies")!)!.content_hash,
        ).not.toBe(originalSupplyHash);
        await expect
          .poll(
            async () => {
              const status = await bench.harness.gatewayJson<Status>(
                "/admin/brain/knowledge/status",
              );
              return status.work.some(
                (entry) => entry.status === "pending" && entry.tier === "soon",
              );
            },
            { timeout: 60_000 },
          )
          .toBe(true);
        expect((await page("demo-gathering"))!.validity).toBe("stale");
      } else if (step.id === "late-historic-evidence") {
        const beforeRestart = await page("demo-gathering");
        await bench.restartGateway();
        expect((await page("demo-gathering"))?.revision).toBe(beforeRestart?.revision);
        expect((await page("demo-gathering"))?.validity).toBe("stale");
        expect(
          (await bench.harness.gatewayJson<Status>("/admin/brain/knowledge/status")).work.some(
            (entry) => entry.status === "pending" && entry.tier === "soon",
          ),
        ).toBe(true);
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
        expect(await page("demo-access")).toBeUndefined();
        expect((await pages()).some((entry) => entry.markdown.includes("amber-paper-boat"))).toBe(
          false,
        );
        expect(await page("demo-gathering")).toBeDefined();
        expect((await accessSearch()).results).toHaveLength(0);
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
        await expect
          .poll(async () => (await pages()).find((entry) => entry.kind === "root")?.markdown, {
            timeout: 120_000,
          })
          .toContain("08:00");
        const all = await pages();
        const root = all.find((entry) => entry.kind === "root")!;
        expect(root.markdown.length).toBeLessThanOrEqual(2000);
        expect(root.markdown).not.toContain("<claim");
        expect(all.filter((entry) => entry.kind === "wiki")).toHaveLength(2);
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
