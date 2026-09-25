// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  DEFAULT_SOURCE_PRIORS_BM25_BYPASS_RANK,
  resolveSearchSettings,
  type SearchConfig,
} from "../search-config.js";
import { BoostStage } from "./boost-stage.js";
import type { SearchStageContext } from "./stage.js";
import type { ResolvedSourcePriorsConfig, ScoreBreakdown, SearchResultItem } from "../types.js";

function makeResult(
  documentId: string,
  sourceId: string,
  score: number,
  overrides: { bm25Rank?: number } = {},
): SearchResultItem {
  const breakdown: ScoreBreakdown = { rrfScore: score, finalScore: score };
  if (overrides.bm25Rank !== undefined) breakdown.bm25Rank = overrides.bm25Rank;
  return {
    documentId,
    sourceId,
    documentType: "doc",
    title: documentId,
    sourceCreatedAt: "2026-01-01T00:00:00Z",
    chunkText: documentId,
    score,
    scoreBreakdown: breakdown,
  };
}

function makeCtx(
  results: SearchResultItem[],
  sourcePriors: ResolvedSourcePriorsConfig,
  searchConfig?: SearchConfig,
): SearchStageContext {
  return {
    query: { text: "" },
    effectiveText: "",
    parsedFilters: {},
    filters: {},
    // Resolve through the production resolver so the fixture carries the same
    // defaults a live request would.
    settings: resolveSearchSettings(searchConfig),
    limit: 10,
    candidateLimit: 50,
    results,
    vectorConfig: { hnswOverFetch: 10, alwaysOverFetch: false },
    sourcePriors,
    diversity: { enabled: false, bucketBy: "type" },
    commonTokenThreshold: 0,
    timing: { totalMs: 0 },
    stageReports: {},
    // Tests don't exercise stage deps — cast through unknown to keep
    // the fixture readable.
    deps: {} as SearchStageContext["deps"],
  };
}

describe("BoostStage — source priors", () => {
  test("empty weights map: candidates pass through unchanged", async () => {
    const results = [makeResult("a", "web", 0.5), makeResult("b", "notion:workspace", 0.4)];
    const ctx = makeCtx(results, {
      weights: {},
      bm25BypassRank: DEFAULT_SOURCE_PRIORS_BM25_BYPASS_RANK,
    });
    await new BoostStage().execute(ctx);
    expect(ctx.results[0].score).toBeCloseTo(0.5, 6);
    expect(ctx.results[1].score).toBeCloseTo(0.4, 6);
    expect(ctx.results[0].scoreBreakdown?.sourcePrior).toBeUndefined();
    expect(ctx.results[1].scoreBreakdown?.sourcePrior).toBeUndefined();
  });

  test("matching prefix downweights and re-sorts", async () => {
    // Web at 0.55 narrowly leads Notion at 0.52; after a -0.05 prior on web
    // the ordering flips.
    const results = [
      makeResult("page", "web", 0.55),
      makeResult("notion", "notion:workspace", 0.52),
    ];
    const ctx = makeCtx(results, {
      weights: { web: -0.05 },
      bm25BypassRank: DEFAULT_SOURCE_PRIORS_BM25_BYPASS_RANK,
    });
    await new BoostStage().execute(ctx);
    expect(ctx.results[0].documentId).toBe("notion");
    expect(ctx.results[1].documentId).toBe("page");
    expect(ctx.results[1].score).toBeCloseTo(0.55 - 0.05, 6);
    expect(ctx.results[1].scoreBreakdown?.sourcePrior).toBeCloseTo(-0.05, 6);
    // Non-matching candidate: prior is `0`, not omitted, so eval
    // tooling can tell the feature is on.
    expect(ctx.results[0].scoreBreakdown?.sourcePrior).toBe(0);
  });

  test("longest-prefix wins: a full source-id prior beats a bare source-type prior", async () => {
    // A bare-type default (`gmail`) and a full-id prior (`gmail:acct`, e.g. an
    // auto inverse-frequency entry) both match `gmail:acct`. The more specific
    // key must win regardless of object key order.
    const results = [makeResult("m", "gmail:acct", 0.5)];
    const ctx = makeCtx(results, {
      weights: { gmail: -0.04, "gmail:acct": 0.02 },
      bm25BypassRank: 0,
    });
    await new BoostStage().execute(ctx);
    expect(ctx.results[0].scoreBreakdown?.sourcePrior).toBeCloseTo(0.02, 6);
    expect(ctx.results[0].score).toBeCloseTo(0.52, 6);
  });

  test("strong BM25 hit bypasses the prior (default bypassRank=3)", async () => {
    const results = [
      makeResult("page", "web", 0.55, { bm25Rank: 1 }),
      makeResult("notion", "notion:workspace", 0.52),
    ];
    const ctx = makeCtx(results, {
      weights: { web: -0.05 },
      bm25BypassRank: DEFAULT_SOURCE_PRIORS_BM25_BYPASS_RANK,
    });
    await new BoostStage().execute(ctx);
    // bm25Rank=1 → bypass → the page keeps its 0.55 and stays on top.
    expect(ctx.results[0].documentId).toBe("page");
    expect(ctx.results[0].score).toBeCloseTo(0.55, 6);
    expect(ctx.results[0].scoreBreakdown?.sourcePrior).toBe(0);
  });

  test("bm25BypassRank=0 disables the bypass — even rank-1 gets penalised", async () => {
    const results = [
      makeResult("page", "web", 0.55, { bm25Rank: 1 }),
      makeResult("notion", "notion:workspace", 0.52),
    ];
    const ctx = makeCtx(results, {
      weights: { web: -0.05 },
      bm25BypassRank: 0,
    });
    await new BoostStage().execute(ctx);
    expect(ctx.results[0].documentId).toBe("notion");
    expect(ctx.results[1].documentId).toBe("page");
    expect(ctx.results[1].score).toBeCloseTo(0.55 - 0.05, 6);
    expect(ctx.results[1].scoreBreakdown?.sourcePrior).toBeCloseTo(-0.05, 6);
  });

  test("prefix matching covers nested sub-sources", async () => {
    const results = [
      makeResult("safari", "browser-history:safari", 0.5),
      makeResult("chrome", "browser-history:chrome", 0.48),
      makeResult("notion", "notion:workspace", 0.45),
    ];
    const ctx = makeCtx(results, {
      weights: { "browser-history": -0.1 },
      bm25BypassRank: DEFAULT_SOURCE_PRIORS_BM25_BYPASS_RANK,
    });
    await new BoostStage().execute(ctx);
    const safari = ctx.results.find((r) => r.documentId === "safari")!;
    const chrome = ctx.results.find((r) => r.documentId === "chrome")!;
    const notion = ctx.results.find((r) => r.documentId === "notion")!;
    // Both browser-history flavours match the same prefix — neither
    // exact-match enumeration is required.
    expect(safari.score).toBeCloseTo(0.5 - 0.1, 6);
    expect(chrome.score).toBeCloseTo(0.48 - 0.1, 6);
    expect(notion.score).toBeCloseTo(0.45, 6);
    expect(safari.scoreBreakdown?.sourcePrior).toBeCloseTo(-0.1, 6);
    expect(chrome.scoreBreakdown?.sourcePrior).toBeCloseTo(-0.1, 6);
    expect(notion.scoreBreakdown?.sourcePrior).toBe(0);
    // Notion is now top after browser-history is dragged down.
    expect(ctx.results[0].documentId).toBe("notion");
  });

  test("source prior is additive on top of the configured type boosts", async () => {
    // Verify the multiplicative typeBoost composes with the additive
    // sourcePrior in the documented order (boosts first, then prior).
    const results = [makeResult("page", "web", 0.5)];
    results[0].documentType = "webpage";
    const ctx = makeCtx(
      results,
      {
        weights: { web: -0.05 },
        bm25BypassRank: DEFAULT_SOURCE_PRIORS_BM25_BYPASS_RANK,
      },
      {
        boosts: { typeBoosts: { webpage: 2.0 } },
      },
    );
    await new BoostStage().execute(ctx);
    expect(ctx.results[0].score).toBeCloseTo(0.5 * 2.0 - 0.05, 6);
    expect(ctx.results[0].scoreBreakdown?.typeBoost).toBe(2.0);
    expect(ctx.results[0].scoreBreakdown?.sourcePrior).toBeCloseTo(-0.05, 6);
    expect(ctx.results[0].scoreBreakdown?.finalScore).toBeCloseTo(0.5 * 2.0 - 0.05, 6);
  });
});

describe("BoostStage — cognitive mirror down-weight (F3)", () => {
  test("halves a surfaced open-loop mirror's score and sorts it below an equal-scored real doc", async () => {
    const doc = makeResult("real", "gmail:user", 0.5);
    const mirror: SearchResultItem = {
      ...makeResult("mirror", "open-loops", 0.5),
      documentType: "open-loop",
    };
    const ctx = makeCtx([mirror, doc], {
      weights: {},
      bm25BypassRank: DEFAULT_SOURCE_PRIORS_BM25_BYPASS_RANK,
    });
    await new BoostStage().execute(ctx);
    // The mirror is down-weighted (0.5 -> 0.25); the real doc is untouched and leads.
    expect(ctx.results[0].documentId).toBe("real");
    expect(ctx.results[0].score).toBeCloseTo(0.5, 6);
    expect(ctx.results[1].documentId).toBe("mirror");
    expect(ctx.results[1].score).toBeCloseTo(0.25, 6);
  });

  test("leaves ordinary document types untouched", async () => {
    const doc = makeResult("real", "gmail:user", 0.4);
    const ctx = makeCtx([doc], {
      weights: {},
      bm25BypassRank: DEFAULT_SOURCE_PRIORS_BM25_BYPASS_RANK,
    });
    await new BoostStage().execute(ctx);
    expect(ctx.results[0].score).toBeCloseTo(0.4, 6);
  });
});
