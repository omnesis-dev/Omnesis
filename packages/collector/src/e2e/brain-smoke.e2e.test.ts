// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench smoke — proves the kit itself works end to end before any
 * catalog suite depends on it.
 *
 * If this file is red, nothing else in the bench can be trusted: it
 * exercises the boot path, the `background-agent` seam, envelope parsing,
 * plan execution through the real tool layer, the drain-to-quiet probe and
 * the observation client, in that order.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BrainBench, call, compressCognitionCadences, email, ref } from "./brain-bench/index.js";

compressCognitionCadences();

const TRIGGER = email({
  externalId: "smoke-deposit-request",
  title: "Deposit request for the autumn offsite",
  content:
    "Hi Alex,\n\nWe are holding the date for the autumn offsite. Please send the deposit of 250 to confirm the booking.\n\nStellar Sound",
});

describe("Brain Bench smoke", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      behaviors: {
        behaviors: [
          {
            flavour: "data.created",
            docTitle: TRIGGER.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_search", { query: "autumn offsite deposit" }),
                call("open_loop_create", {
                  title: "Send the deposit for the autumn offsite",
                  description: "Tracked from the booking request.",
                  confidence: 0.9,
                  importance: 0.8,
                  docs: [ctx.subject],
                }),
                call("open_loop_ledger_append", {
                  id: ref("open_loop_create", "loop.id"),
                  note: "Deposit of 250 requested to confirm the booking.",
                }),
                call("brief_create", {
                  kind: "loop",
                  title: "Deposit due for the autumn offsite",
                  description: "The booking is held until the deposit is sent.",
                  citations: [ctx.subject],
                  relatedLoopIds: [ref("open_loop_create", "loop.id")],
                  confidence: 0.9,
                  urgency: 0.6,
                }),
              ],
              finalText: "Tracked the deposit obligation and raised a card.",
            }),
          },
        ],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the engine is active and the ambient corpus woke nothing", async () => {
    const status = await bench.obs.status();
    expect(status.briefs.modelAssigned).toBe(true);
    expect(status.briefs.active).toBe(true);

    // The universe's fixtures are all dated outside the recency window, so
    // seeding them is backfill the waker must consciously skip. Not
    // vacuous: the corpus really landed.
    const docs = bench.sql.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM documents").get();
    expect(docs?.n ?? 0).toBeGreaterThanOrEqual(10);
    const runs = await bench.obs.runs({ kind: "data" });
    expect(runs.items).toHaveLength(0);
  }, 60_000);

  test("a pushed document drives one datum run through the real tool layer", async () => {
    const [docId] = await bench.pushAndSettle([TRIGGER]);

    const runs = await bench.obs.settledRuns("data");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("completed");
    expect(runs[0]!.dedupeKey).toBe(`data:doc:${docId}`);

    // The puppet saw the run, and recognized it from the envelope.
    const calls = bench.puppetCalls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.kind).toBe("data");
    expect(calls[0]!.flavour).toBe("data.created");
    expect(calls[0]!.subject).toBe(docId);
  }, 120_000);

  test("the scripted plan left real rows behind, linked to each other", async () => {
    const loops = await bench.obs.loops();
    expect(loops.items).toHaveLength(1);
    const loop = loops.items[0]!;
    expect(loop.title).toContain("autumn offsite");
    expect(loop.state).toBe("open");

    // The ref() placeholder resolved to the id the gateway actually minted.
    const detail = await bench.obs.loop(loop.id);
    expect(detail.ledger).toHaveLength(1);
    expect(detail.ledger[0]!.note).toContain("Deposit of 250");
    expect(detail.ledger[0]!.runId).toBe(loop.createdByRun);

    const briefs = await bench.obs.briefs();
    expect(briefs.items).toHaveLength(1);
    expect(briefs.items[0]!.relatedLoopIds).toEqual([loop.id]);
    expect(loop.docs).toHaveLength(1);
    // The detail route resolves citations to document refs.
    const detailBrief = await bench.obs.brief(briefs.items[0]!.id);
    expect(detailBrief.brief.citations.map((c) => c.id)).toEqual(loop.docs);

    // And the operator-visible summary agrees with the rows.
    const pulse = await bench.obs.pulse();
    expect(pulse.counts.openLoops).toBe(1);
    expect(pulse.counts.totalBriefs).toBe(1);
    expect(pulse.counts.failedRuns24h).toBe(0);
  }, 60_000);

  test("the run's transcript and spend are recorded", async () => {
    const runs = await bench.obs.settledRuns("data");
    const prompt = await bench.obs.promptFor(runs[0]!.id);
    expect(prompt).toContain(`Loop agent run ${runs[0]!.id} (kind: data, attempt 1).`);

    const spend = await bench.obs.mechanismSpend();
    const datum = spend.rows.filter((r) => r.mechanism === "datum-intake");
    expect(datum.length).toBeGreaterThan(0);
    expect(datum[0]!.promptTokens).toBeGreaterThan(0);
  }, 60_000);
});
