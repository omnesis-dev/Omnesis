// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { runBench, type SearchClient, type SearchResponseLite } from "./runner.js";
import { ProgressEmitter } from "./progress.js";
import type { Suite } from "./types.js";

function suite(): Suite {
  return {
    description: "test",
    version: 1,
    defaultTopK: 10,
    sourcePath: "/tmp/suite.yaml",
    sha256: "0".repeat(64),
    queries: [
      {
        id: "q1",
        query: "budget",
        topK: 10,
        expectedDocs: [{ urls: ["https://x/a"] }],
        unexpectedUrls: [],
        type: "exact",
        difficulty: "easy",
      },
      {
        id: "q2",
        query: "kickoff meeting",
        topK: 10,
        expectedDocs: [{ urls: ["https://x/b"] }],
        unexpectedUrls: [],
        type: "semantic",
        difficulty: "hard",
      },
    ],
  };
}

class StubClient implements SearchClient {
  callCount = 0;
  responses: Record<string, SearchResponseLite>;
  constructor(responses: Record<string, SearchResponseLite>) {
    this.responses = responses;
  }
  async search(req: { text: string; limit: number; verbose: boolean }) {
    this.callCount++;
    return (
      this.responses[req.text] ?? {
        results: [],
        timing: { totalMs: 1 },
      }
    );
  }
  async getSystemSnapshot() {
    return {
      gateway: { url: "http://localhost:7600", version: "0.1.0" },
      search_config: { hybrid: true },
      index_snapshot: { document_count: 100 },
    };
  }
}

function makeProgress() {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-eval-run-"));
  return {
    progress: new ProgressEmitter(join(dir, "progress.jsonl"), join(dir, "progress.txt")),
    dir,
  };
}

describe("runBench", () => {
  it("runs 1 warmup + N timed repeats per query", async () => {
    const client = new StubClient({});
    const { progress } = makeProgress();
    await runBench({
      suite: suite(),
      resolvedDocIdGroups: [[["doc-a"]], [["doc-b"]]],
      repeats: 3,
      client,
      progress,
    });
    await progress.close();
    // 2 queries × (1 warmup + 3 timed) = 8 calls
    expect(client.callCount).toBe(8);
  });

  it("scores against resolved doc ids and reports hit_any", async () => {
    const client = new StubClient({
      budget: {
        results: [{ documentId: "doc-a", score: 0.9 }],
        timing: { totalMs: 5 },
      },
      "kickoff meeting": {
        results: [{ documentId: "elsewhere", score: 0.1 }],
        timing: { totalMs: 7 },
      },
    });
    const { progress } = makeProgress();
    const out = await runBench({
      suite: suite(),
      resolvedDocIdGroups: [[["doc-a"]], [["doc-b"]]],
      repeats: 1,
      client,
      progress,
    });
    await progress.close();
    expect(out.queries[0]!.result.hit_any).toBe(true);
    expect(out.queries[0]!.result.metrics.hit_at_1).toBe(1);
    expect(out.queries[1]!.result.hit_any).toBe(false);
    expect(out.queries[1]!.result.metrics.hit_at_10).toBe(0);
  });

  it("aggregates by_type and by_difficulty", async () => {
    const client = new StubClient({
      budget: {
        results: [{ documentId: "doc-a" }],
        timing: { totalMs: 5 },
      },
      "kickoff meeting": {
        results: [{ documentId: "doc-b" }],
        timing: { totalMs: 5 },
      },
    });
    const { progress } = makeProgress();
    const out = await runBench({
      suite: suite(),
      resolvedDocIdGroups: [[["doc-a"]], [["doc-b"]]],
      repeats: 1,
      client,
      progress,
    });
    await progress.close();
    expect(out.summary.by_type!["exact"]!.hit_at_1_mean).toBe(1);
    expect(out.summary.by_type!["semantic"]!.hit_at_1_mean).toBe(1);
    expect(out.summary.by_difficulty!["easy"]!.hit_at_1_mean).toBe(1);
    expect(out.summary.by_difficulty!["hard"]!.hit_at_1_mean).toBe(1);
    expect(out.summary.overall.query_count).toBe(2);
  });

  it("searches each judged query exactly once — there is no lane multiplication", async () => {
    const client = new StubClient({});
    const { progress } = makeProgress();
    const out = await runBench({
      suite: suite(),
      resolvedDocIdGroups: [[["doc-a"]], [["doc-b"]]],
      repeats: 1,
      client,
      progress,
    });
    await progress.close();
    // 2 queries × (1 warmup + 1 timed) = 4 calls. Search runs one pipeline, so
    // a query is never re-issued to compare ablation lanes.
    expect(client.callCount).toBe(4);
    expect(out.queries[0]!.result).toBeDefined();
  });

  it("warmupQueries adds N pre-bench calls, untimed and not scored", async () => {
    const client = new StubClient({});
    const { progress } = makeProgress();
    const out = await runBench({
      suite: suite(),
      resolvedDocIdGroups: [[["doc-a"]], [["doc-b"]]],
      repeats: 1,
      warmupQueries: 2,
      client,
      progress,
    });
    await progress.close();
    // Warmup: 2 calls. Bench: 2 queries × (1 per-query warmup + 1 timed) = 4.
    expect(client.callCount).toBe(2 + 4);
    // The output `repeats` count (scored) is unchanged.
    expect(out.repeats).toBe(1);
  });

  it("warmupQueries=0 keeps the current behaviour", async () => {
    const client = new StubClient({});
    const { progress } = makeProgress();
    await runBench({
      suite: suite(),
      resolvedDocIdGroups: [[["doc-a"]], [["doc-b"]]],
      repeats: 1,
      warmupQueries: 0,
      client,
      progress,
    });
    await progress.close();
    // 2 queries × (1 per-query warmup + 1 timed) = 4
    expect(client.callCount).toBe(4);
  });

  it("surfaces failed search calls in failed_queries instead of silently scoring them as misses", async () => {
    class FailingClient extends StubClient {
      override async search(): Promise<SearchResponseLite> {
        this.callCount++;
        throw new Error("simulated gateway 429");
      }
    }
    const client = new FailingClient({});
    const { progress } = makeProgress();
    const out = await runBench({
      suite: suite(),
      resolvedDocIdGroups: [[["doc-a"]], [["doc-b"]]],
      repeats: 1,
      client,
      progress,
      retry: { attempts: 2, baseDelayMs: 0 },
    });
    await progress.close();
    // Both queries' timed calls failed → recorded as measurement failures,
    // not as legitimate zero-result misses.
    expect(out.failed_queries).toBeDefined();
    expect(out.failed_queries!.map((f) => f.query_id).sort()).toEqual(["q1", "q2"]);
    // 2 queries × (1 warmup + 1 timed) × 2 retry attempts each = 8 calls.
    expect(client.callCount).toBe(8);
    // Both failed → excluded from the means, so the scored query_count is 0.
    expect(out.summary.overall.query_count).toBe(0);
  });

  it("excludes a failed query from the aggregate means (not scored as a miss)", async () => {
    // Throws for "budget", succeeds (with a hit) for "kickoff meeting".
    class PartialFailClient extends StubClient {
      override async search(req: {
        text: string;
        limit: number;
        verbose: boolean;
      }): Promise<SearchResponseLite> {
        this.callCount++;
        if (req.text === "budget") throw new Error("simulated 429");
        return { results: [{ documentId: "doc-b" }], timing: { totalMs: 1 } };
      }
    }
    const client = new PartialFailClient({});
    const { progress } = makeProgress();
    const out = await runBench({
      suite: suite(),
      resolvedDocIdGroups: [[["doc-a"]], [["doc-b"]]],
      repeats: 1,
      client,
      progress,
      retry: { attempts: 2, baseDelayMs: 0 },
    });
    await progress.close();
    expect(out.failed_queries).toEqual([{ query_id: "q1" }]);
    // Only the surviving query (q2, a hit) counts toward the means — the
    // failed one is excluded, so recall is 1.0 over 1 scored query rather than
    // 0.5 over 2 (which would falsely report the failure as a miss).
    expect(out.summary.overall.query_count).toBe(1);
    expect(out.summary.overall.recall_at_10_mean).toBe(1);
  });

  it("retries a transient failure and does not flag it once the call recovers", async () => {
    class FlakyClient extends StubClient {
      failsLeft = 1;
      override async search(req: {
        text: string;
        limit: number;
        verbose: boolean;
      }): Promise<SearchResponseLite> {
        this.callCount++;
        if (this.failsLeft > 0) {
          this.failsLeft--;
          throw new Error("transient");
        }
        return super.search(req);
      }
    }
    const client = new FlakyClient({
      budget: { results: [{ documentId: "doc-a" }], timing: { totalMs: 1 } },
      "kickoff meeting": { results: [{ documentId: "doc-b" }], timing: { totalMs: 1 } },
    });
    const { progress } = makeProgress();
    const out = await runBench({
      suite: suite(),
      resolvedDocIdGroups: [[["doc-a"]], [["doc-b"]]],
      repeats: 1,
      client,
      progress,
      retry: { attempts: 3, baseDelayMs: 0 },
    });
    await progress.close();
    // The single transient failure (on the very first call) is retried and
    // recovers, so no failure is recorded and scoring is unaffected.
    expect(out.failed_queries).toBeUndefined();
    expect(out.queries[0]!.result.hit_any).toBe(true);
  });
});
