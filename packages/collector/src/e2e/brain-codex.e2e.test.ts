// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { BrainBench, compressCognitionCadences, email } from "./brain-bench/index.js";

compressCognitionCadences();

describe("Codex inference through the Brain engine", () => {
  let bench: BrainBench;
  let dir: string;
  let logPath: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-brain-codex-"));
    logPath = join(dir, "calls.jsonl");
    const fixture = join(import.meta.dirname, "brain-bench/codex-fixture.mjs");
    vi.stubEnv("OMNESIS_CODEX_COMMAND", process.execPath);
    vi.stubEnv("OMNESIS_CODEX_ARGS_JSON", JSON.stringify([fixture]));
    vi.stubEnv("OMNESIS_CODEX_VERSION_ARGS_JSON", JSON.stringify([fixture, "--version"]));
    vi.stubEnv("OMNESIS_FAKE_CODEX_LOG", logPath);
    // Deliberately disable the interactive pool: nested gates must still progress.
    vi.stubEnv("OMNESIS_CODEX_INTERACTIVE_POOL_SIZE", "0");
    vi.stubEnv("OMNESIS_CODEX_INFERENCE_POOL_SIZE", "1");
    bench = await BrainBench.start({
      experimental: true,
      brain: {
        knowledge: { soonDelay: "0s", routineDelay: "0s", maxSeeds: 1, maxFrontierNodes: 1 },
      },
      extraInference: {
        allowRemoteInference: true,
        assignments: {
          "background-agent": "codex/fixture-parent",
          "entailment-verifier": "codex/fixture-verifier",
          ocr: "codex/fixture-ocr",
        },
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
    vi.unstubAllEnvs();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test("notes an observation, keeps a supported annotation and refuses an unsupported one while the Codex parent waits for its Codex verifier", async () => {
    const [docId] = await bench
      .pushAndSettle([
        email({
          externalId: "codex-gates-fixture",
          title: "Fictional registration reminder",
          content: "The fictional workshop registration closes on Friday.",
        }),
      ])
      .catch(async (error: unknown) => {
        const runs = await bench.obs.runs({ kind: "synthesis", limit: 10 });
        const diagnostics = await Promise.all(
          runs.items.map(async (run) => ({
            id: run.id,
            tools: (await bench.obs.executedTools(run.id)).slice(-12),
          })),
        );
        throw new Error(`${String(error)}; final tools=${JSON.stringify(diagnostics)}`, {
          cause: error,
        });
      });
    const run = await bench.obs.interpretationForSource(docId!);
    const calls = await bench.obs.executedTools(run.id);
    const diagnostics = JSON.stringify(
      calls.map((call) => ({ tool: call.tool, result: call.result })),
    );
    const observations = await bench.obs.observationsMatching("codex-bench-");
    expect(
      observations.map((observation) => observation.summary),
      diagnostics,
    ).toEqual(["codex-bench-accepted: the workshop registration closes on Friday."]);
    expect(
      calls
        .filter((call) => call.tool.startsWith("observation_") || call.tool === "annotate_durable")
        .map((call) => [call.tool, call.result?.resultType ?? call.result?.code]),
      diagnostics,
    ).toEqual([
      ["observation_list", "observation.list"],
      ["observation_note", "observation.noted"],
      ["annotate_durable", "annotation.created"],
      ["annotate_durable", "evidence_does_not_entail_claim"],
    ]);
    const { annotations } = await bench.obs.docAnnotations(docId!);
    expect(annotations.map((annotation) => annotation.claimType)).toEqual(["codex-bench-accepted"]);
    const events = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            event: string;
            processId: number;
            model: string;
            threadId: string;
            runId: string | null;
          },
      );
    const parentStart = events.findIndex(
      (event) =>
        event.event === "start" && event.model === "fixture-parent" && event.runId === run.id,
    );
    const parentEnd = events.findIndex(
      (event, index) =>
        index > parentStart &&
        event.event === "complete" &&
        // Thread IDs are local to each app-server process; nested gates can
        // independently create the same ID as their waiting parent.
        event.processId === events[parentStart]?.processId &&
        event.model === "fixture-parent" &&
        event.threadId === events[parentStart]?.threadId,
    );
    expect(parentStart).toBeGreaterThanOrEqual(0);
    expect(parentEnd).toBeGreaterThan(parentStart);
    const nested = events.slice(parentStart + 1, parentEnd);
    expect(
      nested.filter((event) => event.model === "fixture-verifier").length,
    ).toBeGreaterThanOrEqual(2);
  }, 120_000);

  test("recognizes an image through the spawned gateway's Codex OCR assignment", async () => {
    const response = await fetch(`${bench.harness.gatewayUrl}/inference/ocr`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bench.harness.apiKey}`, "Content-Type": "image/png" },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      signal: AbortSignal.timeout(20_000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: true, text: "Synthetic image label" });
  }, 30_000);
});
