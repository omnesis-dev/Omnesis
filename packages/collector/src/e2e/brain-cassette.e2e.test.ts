// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain cassettes — Lane B of the bench.
 *
 * Where the puppet decides each turn from a behavior table, a cassette
 * replays ONE recorded reasoning verbatim. Its tool calls are live (no
 * recorded result), so the real tool layer executes and the writes land
 * for real — which is what makes a cassette a regression net over
 * everything downstream of the model: prompts feeding tools, gate
 * behavior, cascade wiring, id threading.
 *
 * The mechanism this suite exists to prove is `capture`: a live call's
 * result is REAL, so the loop id the recording saw no longer exists. The
 * cassette lifts the id the gateway actually minted and threads it into
 * the calls that follow.
 *
 * A cassette pins one reasoning forever; it does NOT test the current
 * model. Keep the golden set small (one per major workflow) and re-record
 * when tool schemas move.
 */

import "./synth-env.js";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BrainBench, compressCognitionCadences, email } from "./brain-bench/index.js";

compressCognitionCadences();

const CASSETTE_DIR = join(
  process.cwd().replace(/\/packages\/collector$/, ""),
  // Cassettes for every role live in `agent-demos` — the directory's
  // `.meta.json` files carry the role, which is how the privacy-reviewer
  // cassettes already share it with the chat agent's.
  "evals/universes/loops-test-life/agent-demos",
);

/**
 * The document the golden cassette was recorded against. Its external id
 * is what the cassette's `$DOC_…` placeholder resolves through, so the
 * two must stay in step.
 */
const DEPOSIT = email({
  externalId: "bench-cassette-deposit",
  title: "Harvest fair stand — deposit outstanding",
  content:
    "Hi Alex,\n\nWe are holding your stand at the harvest fair. The stand is held until the deposit is sent.\n\nCedar Grove Supplies",
});

describe("Brain cassettes (background-agent replay)", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({ experimental: true, cassetteDir: CASSETTE_DIR });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the background-agent replay lane is wired and the engine is active", async () => {
    const status = await bench.obs.status();
    // A cassette directory declaring a `background-agent` scenario satisfies
    // the model-assigned half of the gate exactly as a real backend does.
    expect(status.briefs.modelAssigned).toBe(true);
    expect(status.briefs.active).toBe(true);
  }, 60_000);

  test("a cassette drives a real datum run and its writes land", async () => {
    const [docId] = await bench.pushAndSettle([DEPOSIT]);

    const runs = await bench.obs.settledRuns("data");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("completed");

    const loops = await bench.obs.loops();
    expect(loops.items).toHaveLength(1);
    expect(loops.items[0]!.title).toContain("harvest fair stand");
    // The `$DOC_…` placeholder resolved against the live document row.
    expect(loops.items[0]!.docs).toEqual([docId]);

    const briefs = await bench.obs.briefs();
    expect(briefs.items).toHaveLength(1);
    expect(briefs.items[0]!.title).toContain("harvest fair stand");
  }, 120_000);

  test("capture threads the gateway-minted loop id into the calls that follow", async () => {
    const loops = await bench.obs.loops();
    const loop = loops.items[0]!;

    // The ledger append and the brief both addressed the loop the gateway
    // minted during THIS replay — no `$CAP_` placeholder survived, and no
    // recorded id leaked through.
    const detail = await bench.obs.loop(loop.id);
    expect(detail.ledger).toHaveLength(1);
    expect(detail.ledger[0]!.note).toContain("Stand held pending the deposit");

    const briefs = await bench.obs.briefs();
    expect(briefs.items[0]!.relatedLoopIds).toEqual([loop.id]);
  }, 60_000);

  test("no placeholder survives into any persisted row", async () => {
    const persisted = JSON.stringify({
      loops: (await bench.obs.loops()).items,
      briefs: (await bench.obs.briefs()).items,
      ledger: (await bench.obs.ledger((await bench.obs.loops()).items[0]!.id)).items,
    });
    expect(persisted).not.toMatch(/\$(?:DOC|PERSON|CAP|SESSION|MSG)[_A-Za-z]*/);
    expect(persisted).not.toContain("__CAPTURE_MISS_");
  }, 60_000);

  test("the replayed run recorded a transcript with its real tool results", async () => {
    const runs = await bench.obs.settledRuns("data");
    const refs = await bench.obs.transcripts({ runId: runs[0]!.id });
    expect(refs.items.length).toBeGreaterThan(0);
    const { transcript } = await bench.obs.transcript(refs.items.at(-1)!.fileName);

    const toolResults = transcript.events.filter((e) => e.type === "agent.tool.result");
    expect(toolResults.length).toBeGreaterThanOrEqual(4);
    // A live call's result is the real tool's, so the created loop's id is
    // in the transcript — the recording could not have supplied it.
    const loopId = (await bench.obs.loops()).items[0]!.id;
    expect(JSON.stringify(toolResults)).toContain(loopId);
  }, 60_000);
});
