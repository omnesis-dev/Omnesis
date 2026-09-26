// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Read-isolation soak: the invariant the whole "fast Omnesis" perf epic rests
 * on — search stays CORRECT and BOUNDED while the system is under load.
 *
 * We boot an ENCRYPTED synthetic gateway (so every read decrypts, the realistic
 * cost), seed a gold + noise corpus, then hammer it with many concurrent
 * searches in one source WHILE continuously re-pushing documents in another
 * (driving the shared indexer's write/backfill path without legitimately
 * changing the searched corpus). Under that contention we assert two things:
 *
 *   1. CORRECTNESS — every concurrent search returns the exact same ranked
 *      result set as a quiet baseline. The deterministic `fake` embedder makes
 *      the vector space stable, so any drift is a real read/write isolation bug
 *      (a torn snapshot, a half-applied index generation), not embedder noise.
 *   2. LATENCY IS BOUNDED — p99 across the whole soak stays under a generous
 *      cap. This is a regression tripwire (a synchronous stall on the read path
 *      would blow it), not a micro-benchmark; the bound is deliberately loose so
 *      it fails only on a real stall, never on CI jitter.
 *
 * A search runs on a search worker until the pool's inflight ceiling, and on
 * the gateway's main thread past it. The soak lowers that ceiling so every wave
 * is answered by both paths, which must read the same index.
 *
 * The baseline is only meaningful once the searched corpus is fully indexed:
 * the indexer embeds in batches and publishes each batch's vectors to the
 * search workers after its SQLite commit, so a search taken while that is
 * still under way legitimately ranks against part of the corpus. The baseline
 * is therefore taken at a fixed point — every pushed document indexed, and the
 * quiet ranking unchanged across several spaced probes — and re-checked after
 * the soak, so a drifting baseline and a wrong result under load fail with
 * different messages. A request that errors is recorded as a failure of its
 * own, never as a wrong ranking.
 *
 * All fixture data is invented — never corpus-derived.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureInstallRootKey } from "@omnesis/core";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface SearchResult {
  documentId: string;
  title: string;
  score: number;
}
interface SearchResponse {
  results?: SearchResult[];
  stages?: {
    bm25?: { status?: "ran" | "skipped"; candidates?: number };
    vector?: { status?: "ran" | "skipped"; candidates?: number; reason?: string };
  };
}
interface IndexStats {
  bySource?: Record<string, { indexedDocs?: number; indexErrors?: number }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const QUERY = "quarterly revenue forecast for the northwest sales region";
const READ_SOURCE = "synthetic:read@example.com";
const WRITE_SOURCE = "synthetic:write@example.com";
// GOLD docs answer the query in disjoint-ish vocabulary; NOISE docs are bulk
// filler so the vector index has real work to search through.
const GOLD = [
  {
    externalId: "g1",
    title: "NW forecast",
    content: "projected income and revenue outlook for the northwest sales territory next quarter",
  },
  {
    externalId: "g2",
    title: "Regional budget",
    content: "quarterly earnings projection and forecast for the north-west region sales team",
  },
];
const READ_NOISE = 200;
const WRITE_DOCS = 25;
function noiseDocs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    externalId: `n${i}`,
    title: `Note ${i}`,
    content: `unrelated filler document number ${i} about gardening tools, marathon training, and cooking ideas`,
  }));
}

// The quiet baseline must hold across this many consecutive probes, spaced so
// a vector publication that trails its SQLite commit lands between them.
const STABLE_PROBES = 3;
const PROBE_GAP_MS = 750;
// The soak runs at least this many waves of PARALLEL searches AND lasts until
// the background writer has completed at least MIN_WRITE_ROUNDS re-pushes, so
// the reads genuinely overlap the write churn however fast the runner is.
const MIN_WAVES = 12;
const PARALLEL = 8;
const MIN_WRITE_ROUNDS = 5;
const SOAK_CAP_MS = 90_000;
// The search-worker pool's inflight ceiling; calls past it run inline on the
// gateway's main thread. Well below PARALLEL, so every wave takes both paths.
const FALLBACK_AFTER = 2;

const rank = (r: SearchResponse): string[] => (r.results ?? []).map((x) => x.documentId);
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

describe("search read-isolation soak (encrypted gateway under concurrent load)", () => {
  let harness: SyntheticE2EHarness;
  let priorSecretStore: string | undefined;
  let golden: string[];

  async function search(text = QUERY): Promise<SearchResponse> {
    return harness.gatewayJson<SearchResponse>("/search", {
      method: "POST",
      body: JSON.stringify({
        text,
        filters: { sourceIds: [READ_SOURCE] },
        limit: 10,
        verbose: true,
      }),
    });
  }

  function fullyIndexed(stats: IndexStats): boolean {
    const read = stats.bySource?.[READ_SOURCE];
    const write = stats.bySource?.[WRITE_SOURCE];
    return (
      read?.indexedDocs === GOLD.length + READ_NOISE &&
      write?.indexedDocs === WRITE_DOCS &&
      (read.indexErrors ?? 0) === 0 &&
      (write.indexErrors ?? 0) === 0
    );
  }

  /**
   * Wait for the fixed point the soak compares against: every pushed document
   * indexed, the vector stage serving candidates, and the ranking identical
   * across STABLE_PROBES spaced quiet probes. A read path that cannot hold a
   * stable answer even without load never settles, and fails here loudly.
   */
  async function settledRanking(timeoutMs = 120_000): Promise<SearchResponse> {
    const deadline = Date.now() + timeoutMs;
    let last = "nothing observed";
    let streak: { ids: string[]; count: number } | undefined;
    while (Date.now() < deadline) {
      const stats = await harness.gatewayJson<IndexStats>("/index/stats");
      const res = await search();
      const vec = res.stages?.vector;
      const ids = rank(res);
      const ready =
        fullyIndexed(stats) && vec?.status === "ran" && (vec.candidates ?? 0) > 0 && ids.length > 0;
      last =
        `read=${JSON.stringify(stats.bySource?.[READ_SOURCE] ?? null)} ` +
        `write=${JSON.stringify(stats.bySource?.[WRITE_SOURCE] ?? null)} ` +
        `vector=${JSON.stringify(vec ?? null)} results=${ids.length}`;
      if (!ready) streak = undefined;
      else if (streak && same(streak.ids, ids)) streak.count++;
      else streak = { ids, count: 1 };
      if (streak && streak.count >= STABLE_PROBES) return res;
      await sleep(PROBE_GAP_MS);
    }
    throw new Error(`soak: the quiet baseline never settled within ${timeoutMs}ms (${last})`);
  }

  beforeAll(async () => {
    priorSecretStore = process.env.OMNESIS_SECRET_STORE;
    process.env.OMNESIS_SECRET_STORE = "file";
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      embedderBackend: "fake",
      // One search worker (the E2E default) admitting at most FALLBACK_AFTER
      // concurrent calls: every wave overflows onto the main-thread fallback,
      // so both candidate-generation paths serve the soak side by side.
      extraGatewayEnv: { OMNESIS_SEARCH_WORKER_MAX_INFLIGHT: String(FALLBACK_AFTER) },
    });
    await ensureInstallRootKey({ backend: "file", configDir: harness.getConfigDir() });
    await harness.start();
    await harness.pushDocuments(
      [...GOLD, ...noiseDocs(READ_NOISE)].map((doc) => ({ ...doc, sourceId: READ_SOURCE })),
    );
    await harness.pushDocuments(
      noiseDocs(WRITE_DOCS).map((doc) => ({ ...doc, sourceId: WRITE_SOURCE })),
    );
    const baseline = await settledRanking();
    golden = rank(baseline);
    // The baseline must actually answer the query, or matching it proves little.
    const titles = (baseline.results ?? []).map((r) => r.title);
    for (const g of GOLD)
      expect(titles, "the settled baseline misses a gold document").toContain(g.title);
  }, 240_000);

  afterAll(async () => {
    await harness?.destroy();
    if (priorSecretStore === undefined) delete process.env.OMNESIS_SECRET_STORE;
    else process.env.OMNESIS_SECRET_STORE = priorSecretStore;
  }, 30_000);

  it("keeps results correct and latency bounded under concurrent search + write load", async () => {
    // Background writer: keep re-pushing docs from a source outside the search
    // filter. These are real content-changing UPDATEs, so the shared indexer +
    // backfill churn while the searched corpus itself stays immutable.
    let writing = true;
    let writeRounds = 0;
    const writer = (async () => {
      while (writing) {
        await harness.pushDocuments(
          noiseDocs(WRITE_DOCS).map((d) => ({
            ...d,
            sourceId: WRITE_SOURCE,
            content: `${d.content} rev${writeRounds + 1}`,
          })),
        );
        writeRounds++;
        await sleep(50);
      }
    })();

    // Concurrent readers: waves of parallel searches, measuring each latency.
    // A request that throws is a failure under load, kept apart from a request
    // that answered with the wrong ranking.
    const latencies: number[] = [];
    const mismatches: Array<{ wave: number; ranking: string[]; stages: SearchResponse["stages"] }> =
      [];
    const failures: Array<{ wave: number; error: string }> = [];
    const soakDeadline = Date.now() + SOAK_CAP_MS;
    let waves = 0;
    try {
      while (waves < MIN_WAVES || writeRounds < MIN_WRITE_ROUNDS) {
        if (Date.now() > soakDeadline) {
          throw new Error(
            `soak: ${waves} waves and only ${writeRounds}/${MIN_WRITE_ROUNDS} write rounds ` +
              `completed within ${SOAK_CAP_MS}ms — the write path stalled under read load`,
          );
        }
        const wave = waves++;
        await Promise.all(
          Array.from({ length: PARALLEL }, async () => {
            const t0 = Date.now();
            try {
              const res = await search();
              latencies.push(Date.now() - t0);
              const ranking = rank(res);
              if (!same(ranking, golden)) mismatches.push({ wave, ranking, stages: res.stages });
            } catch (err) {
              failures.push({ wave, error: err instanceof Error ? err.message : String(err) });
            }
          }),
        );
      }
    } finally {
      writing = false;
      await writer;
    }

    // The searched corpus must be exactly where the baseline left it: a quiet
    // search after the churn still returns the baseline. If it does not, the
    // write load changed a source it never touched.
    expect(rank(await search()), "the quiet ranking after the soak left the baseline").toEqual(
      golden,
    );

    // (1) CORRECTNESS: every concurrent search answered, and every answer
    // matched the quiet baseline ranking despite the write churn.
    expect(failures, "searches failed under load").toEqual([]);
    expect(
      mismatches,
      `${mismatches.length}/${waves * PARALLEL} searches diverged from the baseline ${JSON.stringify(golden)}`,
    ).toEqual([]);
    expect(latencies.length).toBe(waves * PARALLEL);

    // (2) BOUNDED LATENCY: a loose p99 tripwire. A synchronous read-path stall
    // under write contention (the failure mode this guards) would blow past it.
    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.99))];
    expect(p99).toBeLessThan(10_000);
  }, 180_000);
});
