// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Characterization net for the embedder swap path (`applyEmbedSwap` →
 * `runEmbedSwap` → wipe vector index → respawn-or-skip the indexer worker),
 * driven the way an operator drives it: POST /admin/index/rebuild.
 *
 * This path has no other coverage — boot is exercised by every spawned-gateway
 * e2e, but nothing drives a rebuild/swap. It pins that the swap orchestration
 * runs end-to-end without error and leaves the indexer state consistent, so
 * the in-progress extraction of the indexer lifecycle out of the composition
 * root can be proven to preserve it.
 *
 * NOTE: the synthetic universe ships no embedder model, so the indexer reports
 * `model-missing` and search is BM25-only. The swap ORCHESTRATION (applyEmbedSwap
 * → wipe → re-run startIndexer) still executes — that's the code moving into
 * `IndexerLifecycle`. The live-worker re-embed and the indexer-proxy reads need
 * a real embedder the synthetic harness doesn't provide; those are pinned by the
 * `IndexerLifecycle` mocked unit test instead (see the lifecycle plan).
 */

import "./synth-env.js";

import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { SyntheticE2EHarness } from "./synth-harness.js";

interface IndexStats {
  enabled?: boolean;
  state?: string;
  totalChunks?: number;
  totalGatewayDocs?: number;
}

describe("embed swap (POST /admin/index/rebuild) runs the orchestration end-to-end", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.syncAllSources();
  }, 300_000);

  afterAll(async () => {
    await harness.destroy();
  });

  const indexStats = (): Promise<IndexStats> => harness.gatewayJson<IndexStats>("/index/stats");

  test("rebuild completes without error and leaves indexer state consistent", async () => {
    const before = await indexStats();

    // Drive the real embed swap. The route awaits applyEmbedSwap → runEmbedSwap
    // (wipe vector index, drop the proxy ref, re-run startIndexer) before
    // returning, so a thrown/hung swap surfaces here.
    const rebuild = await harness.gatewayJson<{ ok?: boolean }>("/admin/index/rebuild", {
      method: "POST",
    });
    expect(rebuild.ok).toBe(true);

    // State is consistent across the swap (same model-presence verdict) and the
    // /index/stats endpoint still answers cleanly — the wipe-and-recreate left a
    // valid index rather than a half-torn-down one.
    const after = await indexStats();
    expect(after.state).toBe(before.state);
  }, 120_000);
});
