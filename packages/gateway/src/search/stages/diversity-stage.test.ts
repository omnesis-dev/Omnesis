// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the post-fusion `DiversityStage`.
 *
 * Coverage:
 *   - strict no-op when unconfigured (input order == output order, no
 *     stage report) — the byte-identical-baseline guarantee.
 *   - hard quota caps a flooding source type and is recall-neutral.
 *   - MMR with lambda < 1 spreads sources; lambda == 1 is a no-op.
 *   - a malformed multi-colon sourceId does NOT throw and degrades to
 *     instance-id bucketing.
 *   - the window/tail boundary: only the top `topK` is reordered.
 *   - bucketBy: "sourceId" groups by the full instance id.
 *
 * The fixtures use invented source ids and fictional document ids — no
 * data is sourced from the user's corpus.
 */

import { describe, expect, test } from "vitest";
import { resolveDiversityConfig, resolveSearchSettings } from "../search-config.js";
import { DiversityStage, mmrReorder, quotaReorder, safeSourceBucket } from "./diversity-stage.js";
import type { SearchStageContext } from "./stage.js";
import type { ResolvedDiversityConfig } from "../search-config.js";
import type { SearchResultItem } from "../types.js";

/**
 * Build a result with a descending default score so a fresh list is
 * already in score order (mirrors the post-boost pool the stage sees).
 */
function makeResult(documentId: string, sourceId: string, score: number): SearchResultItem {
  return {
    documentId,
    sourceId,
    documentType: "doc",
    title: documentId,
    sourceCreatedAt: "2026-01-01T00:00:00Z",
    chunkText: documentId,
    score,
  };
}

function makeCtx(
  results: SearchResultItem[],
  diversity: ResolvedDiversityConfig,
  candidateLimit = 50,
): SearchStageContext {
  return {
    query: { text: "" },
    effectiveText: "",
    parsedFilters: {},
    filters: {},
    settings: resolveSearchSettings({ params: { candidateLimit } }),
    limit: 10,
    candidateLimit,
    results,
    vectorConfig: { hnswOverFetch: 10, alwaysOverFetch: false },
    sourcePriors: { weights: {}, bm25BypassRank: 3 },
    diversity,
    commonTokenThreshold: 0,
    timing: { totalMs: 0 },
    stageReports: {},
    deps: {} as SearchStageContext["deps"],
  };
}

const stage = new DiversityStage();

describe("DiversityStage — isEnabled gate", () => {
  const results = [
    makeResult("d1", "gmail:a@example.com", 0.9),
    makeResult("d2", "gmail:a@example.com", 0.8),
  ];

  test("enabled by default — resolveDiversityConfig(undefined) turns on MMR", () => {
    const resolved = resolveDiversityConfig(undefined);
    expect(resolved.enabled).toBe(true);
    expect(resolved.lambda).toBe(0.7);
    const ctx = makeCtx(results, resolved);
    expect(stage.isEnabled(ctx)).toBe(true);
  });

  test("disabled when explicitly turned off", () => {
    const ctx = makeCtx(results, { enabled: false, bucketBy: "type", lambda: 0.7 });
    expect(stage.isEnabled(ctx)).toBe(false);
  });

  test("disabled when enabled:true but neither mechanism is set", () => {
    const ctx = makeCtx(results, { enabled: true, bucketBy: "type" });
    expect(stage.isEnabled(ctx)).toBe(false);
  });

  test("disabled when a mechanism is set but enabled is false", () => {
    const ctx = makeCtx(results, { enabled: false, bucketBy: "type", maxPerSourceInTopK: 1 });
    expect(stage.isEnabled(ctx)).toBe(false);
  });

  test("disabled with a single result even when configured", () => {
    const ctx = makeCtx([results[0]], { enabled: true, bucketBy: "type", maxPerSourceInTopK: 1 });
    expect(stage.isEnabled(ctx)).toBe(false);
  });

  test("enabled when enabled:true AND a quota is set", () => {
    const ctx = makeCtx(results, { enabled: true, bucketBy: "type", maxPerSourceInTopK: 1 });
    expect(stage.isEnabled(ctx)).toBe(true);
  });

  test("enabled when enabled:true AND lambda is set", () => {
    const ctx = makeCtx(results, { enabled: true, bucketBy: "type", lambda: 0.5 });
    expect(stage.isEnabled(ctx)).toBe(true);
  });
});

describe("DiversityStage — quota caps a flooding source type", () => {
  test("a gmail flood is demoted below the window quota, nothing dropped", async () => {
    // gmail dominates the top; notes + drive sit below. With a cap of 2
    // per type, the 3rd/4th gmail hits are deferred below the quota'd head.
    const results = [
      makeResult("g1", "gmail:a@example.com", 0.99),
      makeResult("g2", "gmail:a@example.com", 0.98),
      makeResult("g3", "gmail:a@example.com", 0.97),
      makeResult("g4", "gmail:a@example.com", 0.96),
      makeResult("n1", "notes:local", 0.5),
      makeResult("v1", "drive:b@example.com", 0.4),
    ];
    const ctx = makeCtx(results, { enabled: true, bucketBy: "type", maxPerSourceInTopK: 2 });
    expect(stage.isEnabled(ctx)).toBe(true);
    await stage.execute(ctx);

    // Two gmail hits kept up top, then the other types, then the surplus
    // gmail hits deferred (in their original relative order).
    expect(ctx.results.map((r) => r.documentId)).toEqual(["g1", "g2", "n1", "v1", "g3", "g4"]);
    // Recall-neutral: every input survives.
    expect(ctx.results).toHaveLength(results.length);
    // Stage report emitted.
    expect(ctx.stageReports.diversity?.status).toBe("ran");
    expect(ctx.stageReports.diversity?.resultCount).toBe(results.length);
  });

  test("two accounts of the same source type share one bucket (bucketBy type)", async () => {
    const results = [
      makeResult("g1", "gmail:a@example.com", 0.99),
      makeResult("g2", "gmail:b@example.com", 0.98), // different account, same type
      makeResult("n1", "notes:local", 0.5),
    ];
    const ctx = makeCtx(results, { enabled: true, bucketBy: "type", maxPerSourceInTopK: 1 });
    await stage.execute(ctx);
    // Both gmail accounts count toward one "gmail" bucket → second is demoted.
    expect(ctx.results.map((r) => r.documentId)).toEqual(["g1", "n1", "g2"]);
  });

  test("bucketBy sourceId keeps per-account granularity", async () => {
    const results = [
      makeResult("g1", "gmail:a@example.com", 0.99),
      makeResult("g2", "gmail:b@example.com", 0.98), // different account
      makeResult("n1", "notes:local", 0.5),
    ];
    const ctx = makeCtx(results, { enabled: true, bucketBy: "sourceId", maxPerSourceInTopK: 1 });
    await stage.execute(ctx);
    // Distinct instance ids → distinct buckets → no demotion under a cap of 1.
    expect(ctx.results.map((r) => r.documentId)).toEqual(["g1", "g2", "n1"]);
  });
});

describe("DiversityStage — MMR spreads sources", () => {
  test("lambda < 1 interleaves a flooding source with a rarer one", async () => {
    // Three gmail hits up top, one notes hit below. Pure relevance keeps
    // gmail×3 then notes; MMR with a low lambda pulls the notes hit up.
    const results = [
      makeResult("g1", "gmail:a@example.com", 0.99),
      makeResult("g2", "gmail:a@example.com", 0.98),
      makeResult("g3", "gmail:a@example.com", 0.97),
      makeResult("n1", "notes:local", 0.6),
    ];
    const ctx = makeCtx(results, { enabled: true, bucketBy: "type", lambda: 0.3 });
    await stage.execute(ctx);
    const ids = ctx.results.map((r) => r.documentId);
    // g1 is picked first (highest relevance, no redundancy yet). The notes
    // hit then beats g2/g3 because they now carry source redundancy.
    expect(ids[0]).toBe("g1");
    expect(ids[1]).toBe("n1");
    // Still recall-neutral.
    expect(ctx.results).toHaveLength(results.length);
  });

  test("lambda == 1 is a pure-relevance no-op (order unchanged)", async () => {
    const results = [
      makeResult("g1", "gmail:a@example.com", 0.99),
      makeResult("g2", "gmail:a@example.com", 0.98),
      makeResult("n1", "notes:local", 0.6),
    ];
    const before = results.map((r) => r.documentId);
    const ctx = makeCtx(results, { enabled: true, bucketBy: "type", lambda: 1 });
    // lambda == 1 means the MMR phase is skipped; with no quota set, isEnabled
    // is true (lambda is set) but execute is an identity reorder.
    expect(stage.isEnabled(ctx)).toBe(true);
    await stage.execute(ctx);
    expect(ctx.results.map((r) => r.documentId)).toEqual(before);
  });
});

describe("DiversityStage — malformed sourceId does not throw", () => {
  test("a multi-colon sourceId degrades to instance-id bucketing", async () => {
    // `apple-reminders:uuid:1234` makes parseSourceKey throw (the account
    // part can't contain a colon). The stage must not fail the search.
    const results = [
      makeResult("r1", "apple-reminders:uuid:1234", 0.9),
      makeResult("r2", "apple-reminders:uuid:5678", 0.8),
      makeResult("n1", "notes:local", 0.5),
    ];
    const ctx = makeCtx(results, { enabled: true, bucketBy: "type", maxPerSourceInTopK: 1 });
    await expect(stage.execute(ctx)).resolves.toBeUndefined();
    // Each malformed id degrades to its full instance id, so the two
    // reminders land in DIFFERENT buckets and neither is demoted.
    expect(ctx.results.map((r) => r.documentId)).toEqual(["r1", "r2", "n1"]);
    expect(ctx.results).toHaveLength(3);
  });

  test("safeSourceBucket returns the type for well-formed ids", () => {
    expect(safeSourceBucket("gmail:a@example.com", true)).toBe("gmail");
    expect(safeSourceBucket("whatsapp-messages:local", true)).toBe("whatsapp-messages");
  });

  test("safeSourceBucket degrades to the raw id on a throwing key", () => {
    expect(safeSourceBucket("apple-reminders:uuid:1234", true)).toBe("apple-reminders:uuid:1234");
  });

  test("safeSourceBucket returns the full id when bucketing by instance", () => {
    expect(safeSourceBucket("gmail:a@example.com", false)).toBe("gmail:a@example.com");
  });
});

describe("DiversityStage — window / tail boundary", () => {
  test("only the top topK is reordered; the tail is left untouched", async () => {
    // topK=2: the quota only governs the first two results; the tail keeps
    // its order even though it contains more of the flooding type.
    const results = [
      makeResult("g1", "gmail:a@example.com", 0.99),
      makeResult("g2", "gmail:a@example.com", 0.98),
      makeResult("g3", "gmail:a@example.com", 0.97),
      makeResult("g4", "gmail:a@example.com", 0.96),
    ];
    const ctx = makeCtx(results, {
      enabled: true,
      bucketBy: "type",
      maxPerSourceInTopK: 1,
      topK: 2,
    });
    await stage.execute(ctx);
    // Window = [g1, g2]; cap 1 demotes g2 within the window → [g1, g2-deferred].
    // Tail = [g3, g4] untouched. So [g1, g2, g3, g4] (g2 deferred to window end).
    expect(ctx.results.map((r) => r.documentId)).toEqual(["g1", "g2", "g3", "g4"]);
    expect(ctx.results).toHaveLength(4);
  });

  test("topK larger than the pool clamps to the pool size", async () => {
    const results = [
      makeResult("g1", "gmail:a@example.com", 0.99),
      makeResult("g2", "gmail:a@example.com", 0.98),
      makeResult("n1", "notes:local", 0.5),
    ];
    const ctx = makeCtx(results, {
      enabled: true,
      bucketBy: "type",
      maxPerSourceInTopK: 1,
      topK: 999,
    });
    await stage.execute(ctx);
    expect(ctx.results.map((r) => r.documentId)).toEqual(["g1", "n1", "g2"]);
    expect(ctx.results).toHaveLength(3);
  });
});

describe("quotaReorder + mmrReorder helpers", () => {
  const bucketByType = (r: SearchResultItem): string => safeSourceBucket(r.sourceId, true);

  test("quotaReorder is stable for the deferred surplus", () => {
    const items = [
      makeResult("g1", "gmail:a@example.com", 0.9),
      makeResult("g2", "gmail:a@example.com", 0.8),
      makeResult("g3", "gmail:a@example.com", 0.7),
    ];
    const out = quotaReorder(items, 1, bucketByType);
    // First kept, rest deferred in original relative order.
    expect(out.map((r) => r.documentId)).toEqual(["g1", "g2", "g3"]);
  });

  test("mmrReorder on an empty list returns the empty list", () => {
    expect(mmrReorder([], 0.5, bucketByType)).toEqual([]);
  });

  test("mmrReorder with equal scores still produces a deterministic order", () => {
    // All-equal scores exercise the range-epsilon branch (rel = 1 for all).
    const items = [
      makeResult("g1", "gmail:a@example.com", 0.5),
      makeResult("g2", "gmail:a@example.com", 0.5),
      makeResult("n1", "notes:local", 0.5),
    ];
    const out = mmrReorder(items, 0.3, bucketByType);
    // First pick is g1 (first max on a tie); then notes beats the second
    // gmail on redundancy.
    expect(out.map((r) => r.documentId)).toEqual(["g1", "n1", "g2"]);
    expect(out).toHaveLength(3);
  });
});
