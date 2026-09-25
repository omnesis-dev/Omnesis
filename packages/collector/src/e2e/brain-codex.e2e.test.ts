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
      brain: { judge: { enabled: true } },
      extraInference: {
        allowRemoteInference: true,
        assignments: {
          "background-agent": "codex/fixture-parent",
          "entailment-verifier": "codex/fixture-verifier",
          "brief-judge": "codex/fixture-judge",
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

  test("persists accepted briefs and holds rejected ones while the Codex parent waits for Codex gates", async () => {
    const [docId] = await bench.pushAndSettle([
      email({
        externalId: "codex-gates-fixture",
        title: "Fictional registration reminder",
        content: "The fictional workshop registration closes on Friday.",
      }),
    ]);
    const run = await bench.obs.runForDoc(docId!);
    const calls = await bench.obs.executedTools(run.id);
    const briefs = await bench.obs.briefsMatching("codex-bench-");
    expect(briefs.map((brief) => brief.title)).toEqual(["codex-bench-accepted"]);
    expect(
      calls
        .filter((call) => call.tool === "brief_create")
        .map((call) => call.result?.resultType ?? call.result?.code),
    ).toEqual(["brief.created", "brief.held_by_judge", "evidence_does_not_entail_claim"]);
    const events = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            event: string;
            model: string;
            threadId: string;
          },
      );
    const parentStart = events.findIndex(
      (event) => event.event === "start" && event.model === "fixture-parent",
    );
    const parentEnd = events.findIndex(
      (event, index) =>
        index > parentStart && event.event === "complete" && event.model === "fixture-parent",
    );
    expect(parentStart).toBeGreaterThanOrEqual(0);
    expect(parentEnd).toBeGreaterThan(parentStart);
    const nested = events.slice(parentStart + 1, parentEnd);
    expect(nested.some((event) => event.model === "fixture-verifier")).toBe(true);
    expect(nested.some((event) => event.model === "fixture-judge")).toBe(true);
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
