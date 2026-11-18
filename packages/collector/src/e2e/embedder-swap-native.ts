// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { copyFile, link, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, test } from "vitest";
import { CORPUS, PROBE_QUERY, startGatedEmbedderServer } from "./embedder-swap-fixtures.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { createBuildEmbedderDeliveryGate } from "./build-embedder-delivery-gate.js";

interface ReferenceModel {
  id: string;
  file: string;
  sha256: string;
}
const REFERENCE = JSON.parse(
  readFileSync(new URL("../../../../scripts/ci/reference-embedder.json", import.meta.url), "utf8"),
) as ReferenceModel;
const IS_CI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS || process.env.RUNNER_NAME);
const LOCAL_MODEL = "local/qwen3-embedding-0.6b.Q8_0";
// Both files contain the same verified weights. The uncatalogued filename uses
// the product's 768-dimensional output truncation, exercising a real native
// encoding/dimension change without downloading a second model.
const LOCAL_TARGET_FILE = "fixture-embedding-768.gguf";
const TARGET_MODEL = "fixture-http-target-512";

interface Versions {
  active: { version: number; embedModel: string; embedDim: number } | null;
  building: { version: number; embedModel: string; embedDim: number } | null;
}
interface Search {
  stages?: { vector?: { status?: string; candidates?: number } };
}

async function verifiedModelPath(): Promise<string | undefined> {
  const cache =
    process.env.OMNESIS_TEST_EMBEDDER_CACHE ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "omnesis-test-embedder");
  const path = process.env.OMNESIS_TEST_EMBEDDER_MODEL_PATH ?? join(cache, REFERENCE.file);
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || IS_CI) throw error;
    return undefined;
  }
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  if (hash.digest("hex") !== REFERENCE.sha256)
    throw new Error("Native embedding transition reference model checksum mismatch");
  return path;
}

async function stageModel(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination);
  } catch (error) {
    if (!["EXDEV", "EPERM", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw error;
    await copyFile(source, destination);
  }
}

/** Retry transport resets only; an HTTP error or degraded search is a failure. */
async function transport<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof TypeError) || attempt >= 7) throw error;
      await sleep(300);
    }
  }
}

async function versions(harness: SyntheticE2EHarness): Promise<Versions> {
  const result = await transport(() =>
    harness.gatewayJson<{ indexVersions?: Versions }>("/index/stats"),
  );
  if (!result.indexVersions) throw new Error("Gateway did not report index generations");
  return result.indexVersions;
}

async function vectorSearch(harness: SyntheticE2EHarness): Promise<Search> {
  return transport(async () => {
    await harness.refreshSearchSnapshot();
    return harness.gatewayJson<Search>("/search", {
      method: "POST",
      body: JSON.stringify({ text: PROBE_QUERY, limit: 10, verbose: true }),
    });
  });
}

async function search(harness: SyntheticE2EHarness): Promise<void> {
  const result = await vectorSearch(harness);
  expect(result.stages?.vector?.status).toBe("ran");
  expect(result.stages?.vector?.candidates ?? 0).toBeGreaterThan(0);
}

async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(100);
  }
  throw new Error(`Native embedding transition timed out waiting for ${label}`);
}

/** Registered by the embedder E2E entrypoint so every existing embedding lane runs these cases. */
export function registerNativeEmbedderSwapTests(): void {
  describe("Native CPU embedding transitions preserve live vector search", () => {
    let modelPath: string | undefined;
    beforeAll(async () => {
      modelPath = await verifiedModelPath();
    }, 60_000);

    test.for([
      { from: "http", to: "local" },
      { from: "local", to: "http" },
      { from: "local", to: "local" },
    ] as const)(
      "$from→$to changes generation and dimensions without restarting",
      { timeout: 300_000 },
      async ({ from, to }, context) => {
        if (!modelPath)
          context.skip("Start the reference embedder or supply its verified model path");
        const target = await startGatedEmbedderServer(512, TARGET_MODEL);
        const nativeGate = to === "local" ? await createBuildEmbedderDeliveryGate() : undefined;
        let nativeHeld = false;
        let nativeGateError: unknown;
        void nativeGate?.held.then(
          () => {
            nativeHeld = true;
          },
          (error: unknown) => {
            nativeGateError = error;
          },
        );
        const targetDim = to === "http" ? 512 : 768;
        const harness = new SyntheticE2EHarness({
          gatewayMode: "stable",
          universe: "e2e-minimal",
          extraInference: {
            backends: {
              real: {
                type: "http",
                url: process.env.OMNESIS_TEST_EMBEDDER_URL ?? "http://localhost:8001",
              },
              target: { type: "http", url: target.url },
            },
            assignments: { embedder: from === "local" ? LOCAL_MODEL : `real/${REFERENCE.id}` },
          },
          extraGatewayEnv: {
            OMNESIS_LLAMA_GPU: "false",
            OMNESIS_EMBED_CONCURRENCY: "1",
            OMNESIS_LOG_LEVEL: "info",
            ...nativeGate?.env,
          },
          extraGatewayConfig: { indexer: { embedder: { contextSize: 512 } } },
        });
        let sampling = true;
        let sampleFailed = false;
        let sampleError: unknown;
        let sampler: Promise<void> | undefined;
        let transitionFailure: unknown;
        try {
          const models = join(harness.getConfigDir(), "models");
          await mkdir(models, { recursive: true });
          await stageModel(modelPath!, join(models, REFERENCE.file));
          await stageModel(modelPath!, join(models, LOCAL_TARGET_FILE));
          await harness.start();
          // Distinct short documents prove publication and dimensions. Native
          // inference itself keeps local rebuilds observable; the HTTP target
          // explicitly holds its rebuild until an old-index search completes.
          await harness.pushDocuments([...CORPUS]);
          await waitFor(async () => {
            const result = await vectorSearch(harness);
            return result.stages?.vector?.status === "ran" &&
              (result.stages.vector.candidates ?? 0) > 0
              ? true
              : undefined;
          }, "initial active vector index");
          await harness.restartGateway();
          const before = await waitFor(async () => {
            const current = await versions(harness);
            if (!current.active || current.building) return undefined;
            const result = await vectorSearch(harness);
            return result.stages?.vector?.status === "ran" &&
              (result.stages.vector.candidates ?? 0) > 0
              ? current
              : undefined;
          }, "adopted active index");
          expect(before.active!.embedDim).toBe(1024);
          const pid = harness.gatewayPid;
          let midBuildSamples = 0;
          sampler = (async () => {
            while (sampling) {
              const left = await versions(harness);
              await search(harness);
              const right = await versions(harness);
              if (
                left.active?.version === before.active!.version &&
                right.active?.version === before.active!.version &&
                left.building?.embedDim === targetDim &&
                right.building?.embedDim === targetDim
              )
                midBuildSamples++;
              await sleep(25);
            }
          })().catch((error: unknown) => {
            sampleFailed = true;
            sampleError = error;
          });
          harness.setEmbedderAssignment(
            to === "http" ? `target/${TARGET_MODEL}` : `local/${LOCAL_TARGET_FILE}`,
          );
          if (nativeGate) {
            await waitFor(async () => {
              if (nativeGateError) throw nativeGateError;
              if (sampleFailed) throw sampleError;
              return nativeHeld ? true : undefined;
            }, "real native build result held before publication");
          }
          await waitFor(async () => {
            if (nativeGateError) throw nativeGateError;
            if (sampleFailed) throw sampleError;
            return midBuildSamples > 0 ? true : undefined;
          }, "vector search bracketed by the held rebuild");
          target.release();
          nativeGate?.release();
          const after = await waitFor(async () => {
            if (sampleFailed) throw sampleError;
            const current = await versions(harness);
            return current.active?.embedDim === targetDim && !current.building
              ? current
              : undefined;
          }, "atomic generation flip");
          sampling = false;
          await sampler;
          if (sampleFailed) throw sampleError;
          expect(
            midBuildSamples,
            "a real vector search must complete while the old index is still active and rebuilding",
          ).toBeGreaterThan(0);
          expect(after.active!.version).toBeGreaterThan(before.active!.version);
          expect(harness.gatewayPid).toBe(pid);
          await search(harness);
          if (to === "local")
            expect(readFileSync(harness.getGatewayLogPath(), "utf8")).toContain(
              "build embedder ready:",
            );
        } catch (error) {
          let state: unknown;
          try {
            state = await versions(harness);
          } catch (failure) {
            state = String(failure);
          }
          let log = "";
          try {
            log = readFileSync(harness.getGatewayLogPath(), "utf8").slice(-12_000);
          } catch {
            /* The gateway may have failed before creating its log. */
          }
          const diagnostic = new Error(
            `${String(error)}; index generations=${JSON.stringify(state)}; gateway log:\n${log}`,
            { cause: error },
          );
          transitionFailure = diagnostic;
        } finally {
          sampling = false;
          target.release();
          // Release test-only holds before joining the sampler/gateway, and
          // independently close every owned resource even if teardown fails.
          const cleanupFailures: unknown[] = [];
          try {
            await nativeGate?.close();
          } catch (error) {
            cleanupFailures.push(error);
          }
          const cleanup = await Promise.allSettled([
            (async () => {
              await sampler;
              await harness.destroy();
            })(),
            target.close(),
          ]);
          for (const result of cleanup)
            if (result.status === "rejected") cleanupFailures.push(result.reason);
          if (cleanupFailures.length)
            transitionFailure = new AggregateError(
              [...(transitionFailure ? [transitionFailure] : []), ...cleanupFailures],
              "Native transition cleanup failed",
              { cause: transitionFailure },
            );
        }
        if (transitionFailure) throw transitionFailure;
      },
    );
  });
}
