// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Headline live-swap E2E for the double-buffered embedder swap.
 *
 * This is the criterion the epic names first: a live, spawned-gateway swap that
 * proves vector (semantic) search NEVER goes offline while the embedding model
 * changes to a different-dimension one — and then serves from the NEW model's
 * index after the rebuild flips, all WITHOUT a gateway restart. The
 * deterministic four-transition matrix in
 * `packages/gateway/src/indexer/indexer-lifecycle.test.ts`
 * ("embedder swap — four-transition graceful matrix") pins the orchestration of
 * all four {local,http}-old × {local,http}-new transitions with mock embedders;
 * this complements it by exercising the real machinery end-to-end against a
 * real embedder over HTTP — the read-registry's live dim adoption, the
 * mid-rebuild query embedder staying pointed at the active generation, the
 * atomic flip, and the `/index/stats` two-readout — none of which a unit test
 * with mocks can prove.
 *
 * The swap exercised live is `http → http`:
 *   - OLD / active model: the real local `:8001` Qwen3-Embedding endpoint
 *     (1024-dim), populated with an invented corpus and serving vector search.
 *   - NEW / target model: a controllable, GATED fake HTTP embedder at a
 *     DIFFERENT dimension (512-dim). Gating the target is the honest, race-free
 *     way to hold the rebuild mid-flight: we let the dimension PROBE through but
 *     block the corpus re-embed until the test has observed that vector search
 *     is still live on the active (old) index — then release and watch the
 *     atomic flip land the new generation.
 *
 * The other three transitions (`http→local`, `local→http`, `local→local`)
 * require a real in-process GGUF embedder, which CUDA-crashes on this box (see
 * project memory: "Native backends must be subprocess-isolated"; the gateway's
 * own local embedder cannot be loaded here). They are NOT loaded live; they are
 * covered by the deterministic matrix above and called out with explicit
 * `it.skip`s below so the gap is visible rather than silently green.
 *
 * Dependency policy (mirrors `search-quality.e2e.ts`): the
 * `:8001` embedder is a REQUIRED dependency. On a CI runner an unreachable
 * `:8001` FAILS the job loudly; only on a developer's local box does it skip.
 *
 * The corpus is INVENTED (fictional docs — no operator corpus, per the repo
 * privacy rules).
 */

import "./synth-env.js";

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fakeEmbed } from "./fake-embedder.js";
import { usearchMappings } from "./process-maps.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { AddressInfo } from "node:net";

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

/** The probe input `probeHttpEmbedder` POSTs to discover a backend's dimension. */
const PROBE_INPUT = "dimension probe";

interface GatedEmbedderServer {
  url: string;
  modelId: string;
  dim: number;
  /** How many non-probe (corpus/query) embedding inputs have been served. */
  servedInputs: () => number;
  /** Open the gate so all held + future corpus-embed requests proceed. */
  release: () => void;
  close: () => Promise<void>;
}

/**
 * A controllable OpenAI-compatible fake embedder used as the SWAP TARGET. It
 * speaks the same `/v1/models` + `/v1/embeddings` subset as `fake-embedder.ts`
 * (reusing its deterministic `fakeEmbed`), with one addition: a GATE. The
 * dimension-probe request (`input: ["dimension probe"]`) always passes so the
 * swap can discover the target dim; every other (corpus re-embed) request
 * BLOCKS until `release()` is called. That lets the test hold the graceful
 * rebuild open, assert search is still live on the old index, then release and
 * watch the flip — with no timing races.
 */
function startGatedEmbedderServer(dim: number, modelId: string): Promise<GatedEmbedderServer> {
  let released = false;
  const waiters: Array<() => void> = [];
  const counter = { n: 0 };

  const gate = (): Promise<void> => {
    if (released) return Promise.resolve();
    return new Promise<void>((resolve) => waiters.push(resolve));
  };
  const release = (): void => {
    released = true;
    while (waiters.length) waiters.shift()!();
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && path === "/v1/models") {
        sendJson(res, 200, {
          object: "list",
          data: [{ id: modelId, object: "model", owned_by: "omnesis-test" }],
        });
        return;
      }
      if (req.method === "POST" && path === "/v1/embeddings") {
        let parsed: { input?: string | string[]; model?: string };
        try {
          parsed = JSON.parse(await readBody(req)) as typeof parsed;
        } catch {
          sendJson(res, 400, { error: { message: "invalid JSON body" } });
          return;
        }
        const raw = parsed.input;
        const inputs: string[] = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
        if (inputs.length === 0) {
          sendJson(res, 400, { error: { message: "input is required" } });
          return;
        }
        const isProbe = inputs.length === 1 && inputs[0] === PROBE_INPUT;
        // Everything except the dimension probe is held until the test releases
        // the gate — that is the mid-rebuild window the headline assertion runs in.
        if (!isProbe) {
          counter.n += inputs.length;
          await gate();
        }
        sendJson(res, 200, {
          object: "list",
          data: inputs.map((text, index) => ({
            object: "embedding",
            index,
            embedding: fakeEmbed(text, dim),
          })),
          model: parsed.model ?? modelId,
          usage: { prompt_tokens: 0, total_tokens: 0 },
        });
        return;
      }
      sendJson(res, 404, { error: { message: `no route for ${req.method} ${path}` } });
    })();
  });

  return new Promise<GatedEmbedderServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        modelId,
        dim,
        servedInputs: () => counter.n,
        release,
        close: () =>
          new Promise<void>((res, rej) => {
            release(); // never leave a request hanging on close
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

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

// Invented fictional corpus — no operator data. A handful of docs so the
// rebuild has real work to re-embed and BM25/fusion have a pool to rank over.
const CORPUS: ReadonlyArray<{ externalId: string; title: string; content: string }> = [
  {
    externalId: "swap-feline",
    title: "Whiskers Nutrition Guide",
    content:
      "A grown house cat thrives on a protein-rich diet. Offer small portions of cooked poultry " +
      "or quality wet kibble twice daily and always leave fresh water within reach.",
  },
  {
    externalId: "swap-umbrella",
    title: "Forecast Companion Note",
    content:
      "Grey clouds gathering over the bay usually mean a downpour by afternoon. Pack a folding " +
      "parasol and waterproof boots before you head out.",
  },
  {
    externalId: "swap-tuning",
    title: "Six String Setup",
    content:
      "When a fretted instrument sounds sour, turn each peg slowly while plucking the open course " +
      "until the pitch matches a reference tone.",
  },
  {
    externalId: "swap-pasta",
    title: "Weeknight Pasta Idea",
    content:
      "Toss cooked spaghetti with garlic, chilli flakes, and a handful of grated cheese for a fast " +
      "midweek dinner.",
  },
  {
    externalId: "swap-coast",
    title: "Coastal Trip Plan",
    content:
      "We rented a small cottage near the harbour for the long weekend and walked the cliff path " +
      "each morning.",
  },
  {
    externalId: "swap-standup",
    title: "Standup Recap",
    content:
      "Quick sync this morning: the design review slipped to Thursday and the analytics dashboard " +
      "is in QA.",
  },
];

// One query whose answer is a corpus doc. We assert the vector LANE answers it
// (candidates > 0), not exact ranking — this is a liveness net, not a quality net.
const PROBE_QUERY = "feeding a house cat";

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
    //    whole test ran against). Three searches visit every default-pool
    //    worker so each reader adopts the new generation.
    for (let worker = 0; worker < 3; worker++) {
      const afterSearch = await search(h, PROBE_QUERY);
      expect(afterSearch.stages?.vector?.status).toBe("ran");
      expect(afterSearch.stages?.vector?.candidates ?? 0).toBeGreaterThan(0);
    }

    // Each worker owns one live mapping. The idle main-thread fallback may
    // retain its one prior-generation mapping until it next serves a request,
    // but repeated publications must not leave an unbounded mmap chain.
    const mappings = usearchMappings(h.gatewayPid);
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

  // The three local-involving transitions need a real in-process GGUF embedder,
  // which CUDA-crashes on this box (project memory: native backends must be
  // subprocess-isolated; the gateway's local embedder cannot be loaded here).
  // Their orchestration is covered deterministically by the four-transition
  // matrix in packages/gateway/src/indexer/indexer-lifecycle.test.ts
  // ("embedder swap — four-transition graceful matrix"). Marked skip rather than
  // omitted so the live-coverage gap is explicit.
  test.skip("http→local: covered by the deterministic four-transition matrix (no live GGUF on this box)", () => {});
  test.skip("local→http: covered by the deterministic four-transition matrix (no live GGUF on this box)", () => {});
  test.skip("local→local: covered by the deterministic four-transition matrix (no live GGUF on this box)", () => {});
});
