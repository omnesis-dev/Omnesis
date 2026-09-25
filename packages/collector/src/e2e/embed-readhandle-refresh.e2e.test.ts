// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Regression net for the main-thread HNSW read handle picking up the indexer
 * worker's saves WITHOUT a gateway restart.
 *
 * The gateway boots its `UsearchReadHandle` before the first index exists, then
 * the indexer worker embeds documents and saves `index.usearch` asynchronously.
 * Historically the read handle was opened once and never re-viewed, so vector
 * search stayed empty (and, after a dimension-changing embedder swap, threw a
 * dim-mismatch) until the next restart — the reason the fake embedder defaulted
 * to the gateway's hardcoded 768 dimension.
 *
 * This test runs the fake embedder at a NON-768 dimension (1024). That only
 * yields vector results if the read handle (a) self-fills after boot and (b)
 * adopts the file's stored dimension. Both are what `maybeRefresh()` provides.
 */

import "./synth-env.js";

import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { usearchMappings } from "./process-maps.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface VectorStageReport {
  status?: "ran" | "skipped";
  candidates?: number;
  reason?: string;
}
interface SearchResponse {
  results?: Array<{ documentId: string }>;
  stages?: { vector?: VectorStageReport };
}
interface IndexStats {
  totalIndexed?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("HNSW read handle self-refreshes to pick up the worker's index (no restart)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      embedderBackend: "fake",
      // Deliberately NOT 768: a non-default dimension only searches cleanly if
      // the read handle adopts the index file's dimension on (re)view.
      fakeEmbedderOptions: { dim: 1024 },
      // Exercise the gateway's main-thread read handle directly. Worker-pool
      // generation adoption is covered by embedder-swap.e2e.test.ts.
      extraGatewayEnv: { OMNESIS_SEARCH_WORKER_CONCURRENCY: "0" },
    });
    await harness.start();
    expect(harness.getFakeEmbedder()?.dim).toBe(1024);
    await harness.syncAllSources();
  }, 300_000);

  afterAll(async () => {
    await harness.destroy();
  });

  test("vector stage runs with candidates once the worker has saved the index", async () => {
    // The read handle opened empty at boot; embedding + the HNSW backfill that
    // persists index.usearch happen asynchronously. Poll the search pipeline
    // until the read handle picks up the save — this is exactly what never
    // happened before the fix (it would stay skipped/empty until a gateway
    // restart).
    const deadline = Date.now() + 120_000;
    let last: SearchResponse = {};
    let vector: VectorStageReport | undefined;
    while (Date.now() < deadline) {
      await harness.refreshSearchSnapshot();
      last = await harness.gatewayJson<SearchResponse>("/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "fitness running training",
          verbose: true,
        }),
      });
      vector = last.stages?.vector;
      if (vector?.status === "ran" && (vector.candidates ?? 0) > 0) break;
      await sleep(2000);
    }

    // The decisive assertions: the vector stage actually ran (no dim-mismatch
    // throw at 1024 vs the 768 boot shell) and returned candidates from the
    // worker-built index the main thread never restarted to load.
    expect(vector?.status, `vector stage report: ${JSON.stringify(vector)}`).toBe("ran");
    expect(vector?.candidates ?? 0).toBeGreaterThan(0);
    expect((last.results ?? []).length).toBeGreaterThan(0);
  }, 140_000);

  test("ordinary indexing publications replace, rather than accumulate, mapped index files", async () => {
    // A worker can publish again after a search refreshes its view but before
    // /proc is inspected. Retry that single deleted snapshot, never an extra
    // mapping: waiting for GC here would hide the native ownership regression.
    async function searchPublishedMapping(text: string, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      let result: SearchResponse = {};
      let mappings: ReturnType<typeof usearchMappings> = null;
      while (Date.now() < deadline) {
        await harness.refreshSearchSnapshot();
        result = await harness.gatewayJson<SearchResponse>("/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, verbose: true }),
        });
        mappings = usearchMappings(harness.gatewayPid);
        if (result.stages?.vector?.status === "ran") {
          if (process.platform !== "linux") break;
          expect(mappings, "a vector search must own exactly one native mapping").toMatchObject({
            total: 1,
          });
          if (mappings?.deleted === 0) break;
        } else if (mappings) {
          expect(mappings.total, "a retry must not hide extra native mappings").toBeLessThanOrEqual(
            1,
          );
        }
        await sleep(50);
      }
      expect(result.stages?.vector?.status).toBe("ran");
      if (process.platform === "linux") {
        expect(mappings, "the read handle did not adopt the published index").toMatchObject({
          total: 1,
          deleted: 0,
        });
      }
      return mappings;
    }

    // Establish the initial mapping here so selecting only this test still
    // exercises adoption from startup, including publications during the search.
    let currentMappings = await searchPublishedMapping("fitness running training", 120_000);

    const initial = await harness.gatewayJson<IndexStats>("/index/stats");
    let indexed = initial.totalIndexed ?? 0;

    for (let publication = 0; publication < 5; publication++) {
      const beforePublication = indexed;
      const beforeInodes = currentMappings?.liveInodes;
      await harness.pushDocument({
        externalId: `mapping-cycle-${publication}`,
        title: `Mapping cycle ${publication}`,
        content: `Fictional observatory field note number ${publication} about a distant comet.`,
      });

      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const stats = await harness.gatewayJson<IndexStats>("/index/stats");
        if ((stats.totalIndexed ?? 0) > indexed) {
          indexed = stats.totalIndexed ?? indexed;
          break;
        }
        await sleep(500);
      }
      expect(indexed, `publication ${publication} was not indexed`).toBeGreaterThan(
        beforePublication,
      );

      // SQLite progress can become visible just before the worker's final
      // atomic rename. Wait for the old mapped inode to become deleted so the
      // assertion below is synchronized to the actual index publication.
      if (process.platform === "linux") {
        const publicationDeadline = Date.now() + 30_000;
        while (Date.now() < publicationDeadline) {
          if ((usearchMappings(harness.gatewayPid)?.deleted ?? 0) > 0) break;
          await sleep(50);
        }
        expect(usearchMappings(harness.gatewayPid)?.deleted ?? 0).toBeGreaterThan(0);
      }

      const mappings = await searchPublishedMapping(
        `distant comet field note ${publication}`,
        30_000,
      );
      currentMappings = mappings;
      if (mappings) {
        expect(mappings, `publication ${publication} leaked a stale mmap`).toMatchObject({
          total: 1,
          deleted: 0,
        });
        expect(
          mappings.liveInodes,
          `publication ${publication} did not adopt a new inode`,
        ).not.toEqual(beforeInodes);
      }
    }
  }, 180_000);
});
