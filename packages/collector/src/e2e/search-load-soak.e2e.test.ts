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
  stages?: { vector?: { status?: "ran" | "skipped"; candidates?: number } };
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
function noiseDocs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    externalId: `n${i}`,
    title: `Note ${i}`,
    content: `unrelated filler document number ${i} about gardening tools, marathon training, and cooking ideas`,
  }));
}

const rank = (r: SearchResponse): string[] => (r.results ?? []).map((x) => x.documentId);

describe("search read-isolation soak (encrypted gateway under concurrent load)", () => {
  let harness: SyntheticE2EHarness;
  let priorSecretStore: string | undefined;

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

  async function waitForVectorHits(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await harness.refreshSearchSnapshot();
      const res = await search();
      const vec = res.stages?.vector;
      if (vec?.status === "ran" && (vec.candidates ?? 0) > 0 && (res.results?.length ?? 0) > 0)
        return;
      await sleep(1500);
    }
    throw new Error("soak: vector stage never produced candidates within timeout");
  }

  beforeAll(async () => {
    priorSecretStore = process.env.OMNESIS_SECRET_STORE;
    process.env.OMNESIS_SECRET_STORE = "file";
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      embedderBackend: "fake",
    });
    await ensureInstallRootKey({ backend: "file", configDir: harness.getConfigDir() });
    await harness.start();
    await harness.pushDocuments(
      [...GOLD, ...noiseDocs(200)].map((doc) => ({ ...doc, sourceId: READ_SOURCE })),
    );
    await harness.pushDocuments(noiseDocs(25).map((doc) => ({ ...doc, sourceId: WRITE_SOURCE })));
    await waitForVectorHits();
  }, 180_000);

  afterAll(async () => {
    await harness?.destroy();
    if (priorSecretStore === undefined) delete process.env.OMNESIS_SECRET_STORE;
    else process.env.OMNESIS_SECRET_STORE = priorSecretStore;
  }, 30_000);

  it("keeps results correct and latency bounded under concurrent search + write load", async () => {
    // Quiet baseline: the golden ranking the soak must never diverge from.
    const golden = rank(await search());
    expect(golden.length).toBeGreaterThan(0);

    // Background writer: keep re-pushing docs from a source outside the search
    // filter. These are real content-changing UPDATEs, so the shared indexer +
    // backfill churn while the searched corpus itself stays immutable.
    let writing = true;
    const writer = (async () => {
      let round = 0;
      while (writing) {
        round++;
        await harness.pushDocuments(
          noiseDocs(25).map((d) => ({
            ...d,
            sourceId: WRITE_SOURCE,
            content: `${d.content} rev${round}`,
          })),
        );
        await sleep(50);
      }
    })();

    // Concurrent readers: waves of parallel searches, measuring each latency.
    const latencies: number[] = [];
    const mismatches: string[][] = [];
    const WAVES = 12;
    const PARALLEL = 8;
    for (let w = 0; w < WAVES; w++) {
      const wave = await Promise.all(
        Array.from({ length: PARALLEL }, async () => {
          const t0 = Date.now();
          const res = await search();
          latencies.push(Date.now() - t0);
          return rank(res);
        }),
      );
      for (const r of wave) {
        if (JSON.stringify(r) !== JSON.stringify(golden)) mismatches.push(r);
      }
    }
    writing = false;
    await writer;

    // (1) CORRECTNESS: every one of WAVES*PARALLEL concurrent searches matched
    // the quiet-baseline ranking despite the write churn.
    expect(mismatches).toEqual([]);
    expect(latencies.length).toBe(WAVES * PARALLEL);

    // (2) BOUNDED LATENCY: a loose p99 tripwire. A synchronous read-path stall
    // under write contention (the failure mode this guards) would blow past it.
    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.99))];
    expect(p99).toBeLessThan(10_000);
  }, 180_000);
});
