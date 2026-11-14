// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A live HTTP-to-HTTP embedding swap holds corpus rebuilds at a deterministic
 * gate while searches continue on the active generation. The native CPU
 * transitions registered below exercise the same production lifecycle with
 * the verified reference GGUF, without GPU dependencies or chat inference.
 */

import "./synth-env.js";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { usearchMappings } from "./process-maps.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import {
  CORPUS,
  PROBE_QUERY,
  startGatedEmbedderServer,
  type GatedEmbedderServer,
} from "./embedder-swap-fixtures.js";
import { registerNativeEmbedderSwapTests } from "./embedder-swap-native.js";

// Generic, overridable defaults — never an operator-private value. `:8001` is
// the conventional local embedder endpoint documented for this project. The URL
// is the BARE base (no `/v1`): the gateway's HttpEmbedder appends `/v1` itself.
const EMBEDDER_URL = process.env.OMNESIS_TEST_EMBEDDER_URL ?? "http://localhost:8001";
const EMBEDDER_MODEL = process.env.OMNESIS_TEST_EMBEDDER_MODEL ?? "Qwen/Qwen3-Embedding-0.6B";

// A CI runner must FAIL on an unreachable required dependency; a local dev box
// may skip. (GitHub Actions sets CI, GITHUB_ACTIONS and RUNNER_NAME; CI serves
// the embedder with `scripts/test-embedder.sh`.)
const IS_CI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS || process.env.RUNNER_NAME);

// The target (new) model's dimension — deliberately different from the real
// `:8001` embedder's 1024 so the swap is a genuine dimension change (the
// read handle must adopt the new dim with no restart).
const TARGET_DIM = 512;
const TARGET_MODEL_ID = "fake-embed-swap-target-512";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface VectorStageReport {
  status?: "ran" | "skipped";
  candidates?: number;
  reason?: string;
}
interface SearchResponse {
  results?: Array<{ documentId: string; title: string; score: number }>;
  stages?: { vector?: VectorStageReport };
}
interface IndexStats {
  indexVersions?: {
    active: { version: number; embedModel: string; embedDim: number } | null;
    building: {
      version: number;
      embedModel: string;
      embedDim: number;
      docsBuilt: number;
      docsTotal: number;
      percent: number;
    } | null;
  };
}

async function probeEmbedderReachable(): Promise<boolean> {
  const base = EMBEDDER_URL.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

let reachable = false;

describe("Live double-buffered embedder swap keeps vector search live (headline)", () => {
  let harness: SyntheticE2EHarness | null = null;
  let target: GatedEmbedderServer | null = null;

  beforeAll(async () => {
    reachable = await probeEmbedderReachable();
    if (!reachable) {
      if (IS_CI) {
        throw new Error(
          `embedder-swap.e2e: required embedder at ${EMBEDDER_URL} is unreachable on a CI ` +
            `runner. This is a REQUIRED dependency — failing loudly rather than skipping. ` +
            `Start the local embedding model (OpenAI-compatible /v1/embeddings) or point ` +
            `OMNESIS_TEST_EMBEDDER_URL at one.`,
        );
      }
      return; // local dev box: short-circuit below
    }

    target = await startGatedEmbedderServer(TARGET_DIM, TARGET_MODEL_ID);

    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      // Declare BOTH embedder backends at boot but assign only the real one.
      // The swap later repoints the assignment at the (already-declared) target
      // backend — the operator's model-change flow, driven via the ConfigStore.
      extraInference: {
        backends: {
          real: { type: "http", url: EMBEDDER_URL },
          target: { type: "http", url: target.url },
        },
        assignments: { embedder: `real/${EMBEDDER_MODEL}` },
      },
      // Pin the pool size this mmap bound deliberately exercises; do not make
      // the regression depend on whichever production default is current.
      extraGatewayEnv: { OMNESIS_SEARCH_WORKER_CONCURRENCY: "3" },
    });
    await harness.start();
    await harness.pushDocuments(CORPUS.map((d) => ({ ...d })));
    await waitForActiveVector(harness);
    // Restart once so the versioned-index adopt-in-place migration runs and the
    // populated index becomes the COMPLETE, adopted `active` generation 1 — the
    // precondition the graceful double-buffered swap requires. (A fresh first
    // boot stamps the index but only adopts version 1 on the next startup; this
    // models a real install that has been running before the operator swaps.)
    await harness.restartGateway();
    await waitForActiveVector(harness);
  }, 360_000);

  afterAll(async () => {
    await harness?.destroy();
    await target?.close();
  }, 30_000);

  // The gateway churns hard through a swap (worker teardown/restart, build
  // embedder, atomic flip), and Node's fetch reuses keep-alive sockets that the
  // server may reset under that load — a transport blip (ECONNRESET / "other
  // side closed"), NOT a search degradation. Retry such blips a few times so the
  // liveness assertions measure the SEARCH RESULT, never a dropped connection.
  async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 8): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        await sleep(300);
      }
    }
    throw new Error(
      `embedder-swap.e2e: ${label} failed after ${attempts} attempts: ${String(lastErr)}`,
    );
  }

  async function search(h: SyntheticE2EHarness, text: string): Promise<SearchResponse> {
    return withRetry(async () => {
      await h.refreshSearchSnapshot();
      return h.gatewayJson<SearchResponse>("/search", {
        method: "POST",
        body: JSON.stringify({ text, limit: 10, verbose: true }),
      });
    }, "search");
  }

  function stats(h: SyntheticE2EHarness): Promise<IndexStats> {
    return withRetry(() => h.gatewayJson<IndexStats>("/index/stats"), "stats");
  }

  /**
   * Poll until the real embedder's index serves vector candidates. Transient
   * network errors (a just-restarted gateway still warming up its TLS/HTTP
   * stack) are swallowed and retried — only a persistent failure to produce
   * candidates within the timeout is fatal.
   */
  async function waitForActiveVector(h: SyntheticE2EHarness, timeoutMs = 180_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await search(h, PROBE_QUERY);
        const vec = res.stages?.vector;
        if (vec?.status === "ran" && (vec.candidates ?? 0) > 0) return;
      } catch {
        /* gateway warming up / transient — retry */
      }
      await sleep(2000);
    }
    throw new Error(
      "embedder-swap.e2e: the real embedder's vector stage never produced candidates — the " +
        "initial index did not come up (fail-loud rather than swap on a cold index).",
    );
  }

  /** Poll `/index/stats` until `pred(versions)` holds, returning that snapshot. */
  async function waitForVersions(
    h: SyntheticE2EHarness,
    pred: (v: NonNullable<IndexStats["indexVersions"]>) => boolean,
    label: string,
    timeoutMs = 120_000,
  ): Promise<NonNullable<IndexStats["indexVersions"]>> {
    const deadline = Date.now() + timeoutMs;
    let last: IndexStats["indexVersions"];
    while (Date.now() < deadline) {
      try {
        last = (await stats(h)).indexVersions;
        if (last && pred(last)) return last;
      } catch {
        /* transient — retry */
      }
      await sleep(500);
    }
    throw new Error(
      `embedder-swap.e2e: timed out waiting for ${label}; last=${JSON.stringify(last)}`,
    );
  }

  test("http→http: vector search never drops to BM25-only during the rebuild, then serves the new model's index — no restart", async () => {
    if (!reachable) {
      process.stdout.write("\nembedder-swap.e2e: :8001 unreachable — skipping (local dev box).\n");
      return;
    }
    const h = harness!;
    const tgt = target!;

    // 1. Baseline: the active generation is the real 1024-dim embedder,
    //    serving vector candidates, with no build in flight.
    const before = await stats(h);
    expect(before.indexVersions?.active, "no active generation at baseline").not.toBeNull();
    expect(before.indexVersions?.active?.embedDim).toBe(1024);
    expect(before.indexVersions?.building, "a build should not be in flight yet").toBeNull();
    const baseSearch = await search(h, PROBE_QUERY);
    expect(baseSearch.stages?.vector?.status).toBe("ran");
    expect(baseSearch.stages?.vector?.candidates ?? 0).toBeGreaterThan(0);

    // 2. Trigger a GRACEFUL swap to the different-dim target. The gate holds
    //    the corpus re-embed, so the rebuild cannot complete until we release
    //    it — giving a deterministic mid-rebuild window.
    h.setEmbedderAssignment(`target/${TARGET_MODEL_ID}`);

    // 3. The building generation appears at the target's dimension while the
    //    active generation is UNCHANGED (still the old 1024-dim index).
    const mid = await waitForVersions(
      h,
      (v) => v.building != null && v.building.embedDim === TARGET_DIM,
      "building generation at target dim",
    );
    expect(mid.active?.embedDim, "active generation must not be repointed mid-build").toBe(1024);
    expect(mid.building?.embedModel).toContain(TARGET_MODEL_ID);

    // 4. THE HEADLINE: throughout the held rebuild, every search keeps
    //    returning vector candidates — never degrading to BM25-only — served
    //    by the still-active old index. Poll several times to span the window.
    for (let i = 0; i < 4; i++) {
      const res = await search(h, PROBE_QUERY);
      expect(
        res.stages?.vector?.status,
        `iteration ${i}: vector stage degraded mid-rebuild: ${JSON.stringify(res.stages?.vector)}`,
      ).toBe("ran");
      expect(
        res.stages?.vector?.candidates ?? 0,
        `iteration ${i}: no vector candidates mid-rebuild`,
      ).toBeGreaterThan(0);
      // The active generation is still the old model the whole time.
      const s = await stats(h);
      expect(s.indexVersions?.active?.embedDim).toBe(1024);
      expect(s.indexVersions?.building, "build should still be in flight").not.toBeNull();
      await sleep(400);
    }

    // 5. Release the gate → the rebuild completes and atomically flips. The
    //    active generation becomes the target model at the new dimension and
    //    no build remains.
    tgt.release();
    const after = await waitForVersions(
      h,
      (v) => v.building == null && v.active != null && v.active.embedDim === TARGET_DIM,
      "atomic flip to the target generation",
    );
    expect(after.active?.embedModel).toContain(TARGET_MODEL_ID);
    expect(
      tgt.servedInputs(),
      "the target embedder must have re-embedded every corpus document",
    ).toBeGreaterThanOrEqual(CORPUS.length);

    // 6. After the flip, search serves vector candidates from the NEW model's
    //    index — all without a gateway restart (this is the same process the
    //    whole test ran against). A worker adopts the new generation when it
    //    next serves a search, and no fixed number of searches reaches them
    //    all: every pool call shares one rotation, so temporal readings and
    //    background searches can skip a worker. Search until the old mappings
    //    are gone; a mapping that adoption fails to release never clears, so
    //    the assertions below still catch it after the bounded wait.
    const adoptionDeadline = Date.now() + 30_000;
    let mappings: ReturnType<typeof usearchMappings>;
    do {
      const afterSearch = await search(h, PROBE_QUERY);
      expect(afterSearch.stages?.vector?.status).toBe("ran");
      expect(afterSearch.stages?.vector?.candidates ?? 0).toBeGreaterThan(0);
      mappings = usearchMappings(h.gatewayPid);
    } while (mappings !== null && mappings.deleted > 1 && Date.now() < adoptionDeadline);

    // Each worker owns one live mapping. The idle main-thread fallback may
    // retain its one prior-generation mapping until it next serves a request,
    // but repeated publications must not leave an unbounded mmap chain.
    if (process.platform === "linux") {
      expect(mappings, "gateway USearch mappings were not observable").not.toBeNull();
      expect(
        mappings!.total,
        `unexpected USearch mappings: ${JSON.stringify(mappings)}`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        mappings!.total,
        `unexpected USearch mappings: ${JSON.stringify(mappings)}`,
      ).toBeLessThanOrEqual(4);
      expect(
        mappings!.deleted,
        `stale USearch mappings: ${JSON.stringify(mappings)}`,
      ).toBeLessThanOrEqual(1);
    }
  }, 300_000);
});

registerNativeEmbedderSwapTests();
