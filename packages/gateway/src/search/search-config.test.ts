// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  resolveSearchSettings,
  resolveSourcePriorsConfig,
  DEFAULT_SEARCH_BOOSTS,
  DEFAULT_SEARCH_PARAMS,
  DEFAULT_SOURCE_PRIORS_BM25_BYPASS_RANK,
} from "./search-config.js";

describe("resolveSearchSettings", () => {
  test("no config → the shipped defaults, verbatim", () => {
    const settings = resolveSearchSettings();
    expect(settings.params).toEqual(DEFAULT_SEARCH_PARAMS);
    expect(settings.boosts).toEqual(DEFAULT_SEARCH_BOOSTS);
    expect(settings.defaultFilters).toBeUndefined();
  });

  test("an empty config object is the same as no config", () => {
    expect(resolveSearchSettings({})).toEqual(resolveSearchSettings());
  });

  test("`search.params` overrides layer onto the defaults, key by key", () => {
    const settings = resolveSearchSettings({ params: { rrfK: 12, resultLimit: 25 } });
    expect(settings.params.rrfK).toBe(12);
    expect(settings.params.resultLimit).toBe(25);
    // Untouched keys keep their defaults — a partial override merges, it
    // does not replace the whole block.
    expect(settings.params.candidateLimit).toBe(DEFAULT_SEARCH_PARAMS.candidateLimit);
    expect(settings.params.bm25Weight).toBe(DEFAULT_SEARCH_PARAMS.bm25Weight);
    expect(settings.params.vectorWeight).toBe(DEFAULT_SEARCH_PARAMS.vectorWeight);
    expect(settings.params.topRankBonus).toBe(DEFAULT_SEARCH_PARAMS.topRankBonus);
    expect(settings.params.nearTopRankBonus).toBe(DEFAULT_SEARCH_PARAMS.nearTopRankBonus);
  });

  test("an explicit 0 wins over a non-zero default (rank bonuses are disable-able)", () => {
    const settings = resolveSearchSettings({
      params: { topRankBonus: 0, nearTopRankBonus: 0 },
    });
    expect(settings.params.topRankBonus).toBe(0);
    expect(settings.params.nearTopRankBonus).toBe(0);
  });

  test("`search.boosts` overrides the relevance weight and adds type boosts", () => {
    const settings = resolveSearchSettings({
      boosts: { relevanceBoostWeight: 0.5, typeBoosts: { email: 1.4 } },
    });
    expect(settings.boosts.relevanceBoostWeight).toBe(0.5);
    expect(settings.boosts.typeBoosts).toEqual({ email: 1.4 });
  });

  test("a boosts block naming only typeBoosts keeps the default relevance weight", () => {
    const settings = resolveSearchSettings({ boosts: { typeBoosts: { note: 1.2 } } });
    expect(settings.boosts.typeBoosts).toEqual({ note: 1.2 });
    expect(settings.boosts.relevanceBoostWeight).toBe(DEFAULT_SEARCH_BOOSTS.relevanceBoostWeight);
  });

  test("`search.defaultFilters` passes through and leaves params/boosts at defaults", () => {
    const settings = resolveSearchSettings({ defaultFilters: { documentTypes: ["email"] } });
    expect(settings.defaultFilters?.documentTypes).toEqual(["email"]);
    expect(settings.params).toEqual(DEFAULT_SEARCH_PARAMS);
    expect(settings.boosts).toEqual(DEFAULT_SEARCH_BOOSTS);
  });

  test("all three override layers apply together", () => {
    const settings = resolveSearchSettings({
      params: { candidateLimit: 200 },
      boosts: { relevanceBoostWeight: 0.1 },
      defaultFilters: { sourceIds: ["gmail:user@example.com"] },
    });
    expect(settings.params.candidateLimit).toBe(200);
    expect(settings.params.resultLimit).toBe(DEFAULT_SEARCH_PARAMS.resultLimit);
    expect(settings.boosts.relevanceBoostWeight).toBe(0.1);
    expect(settings.defaultFilters?.sourceIds).toEqual(["gmail:user@example.com"]);
  });

  test("resolving does not mutate the shipped defaults", () => {
    const before = { ...DEFAULT_SEARCH_PARAMS };
    resolveSearchSettings({ params: { rrfK: 999 } });
    expect(DEFAULT_SEARCH_PARAMS).toEqual(before);
  });
});

describe("resolveSourcePriorsConfig", () => {
  test("no config + no defaults → empty weights, default bypass rank", () => {
    const resolved = resolveSourcePriorsConfig();
    expect(resolved.weights).toEqual({});
    expect(resolved.bm25BypassRank).toBe(DEFAULT_SOURCE_PRIORS_BM25_BYPASS_RANK);
  });

  test("defaults only → defaults flow through unchanged", () => {
    const resolved = resolveSourcePriorsConfig(undefined, { web: -0.04 });
    expect(resolved.weights).toEqual({ web: -0.04 });
  });

  test("user override wins per key", () => {
    const resolved = resolveSourcePriorsConfig(
      { sourcePriors: { weights: { web: -0.1 } } },
      { web: -0.04 },
    );
    expect(resolved.weights).toEqual({ web: -0.1 });
  });

  test("user adds new key alongside defaults", () => {
    const resolved = resolveSourcePriorsConfig(
      { sourcePriors: { weights: { "browser-history": -0.1 } } },
      { web: -0.04 },
    );
    expect(resolved.weights).toEqual({
      web: -0.04,
      "browser-history": -0.1,
    });
  });

  test("merges defaults with disjoint user keys (both retained)", () => {
    const resolved = resolveSourcePriorsConfig(
      { sourcePriors: { weights: { gmail: 0.05 } } },
      { web: -0.04, "browser-history": -0.04 },
    );
    expect(resolved.weights).toEqual({
      web: -0.04,
      "browser-history": -0.04,
      gmail: 0.05,
    });
  });

  test("user-supplied bypassRank overrides default", () => {
    const resolved = resolveSourcePriorsConfig({
      sourcePriors: { weights: {}, bm25BypassRank: 5 },
    });
    expect(resolved.bm25BypassRank).toBe(5);
  });

  test("empty user weights still merge defaults", () => {
    const resolved = resolveSourcePriorsConfig({ sourcePriors: { weights: {} } }, { web: -0.04 });
    expect(resolved.weights).toEqual({ web: -0.04 });
  });

  test("auto inverse-source-frequency is ON by default — absent config still derives priors", () => {
    const counts = [
      { sourceId: "alpha:x", docCount: 9000 }, // dominant → no boost
      { sourceId: "beta:x", docCount: 90 }, // rarer → positive boost
    ];
    // No autoInverseFrequency block → defaults to enabled → priors derived.
    const resolved = resolveSourcePriorsConfig({ sourcePriors: {} }, undefined, {
      docCounts: counts,
      rrfK: 60,
    });
    expect(resolved.weights["alpha:x"]).toBeUndefined();
    expect(resolved.weights["beta:x"]).toBeGreaterThan(0);
  });

  test("auto inverse-source-frequency can be explicitly disabled", () => {
    const counts = [
      { sourceId: "alpha:x", docCount: 9000 },
      { sourceId: "beta:x", docCount: 90 },
    ];
    const disabled = resolveSourcePriorsConfig(
      { sourcePriors: { autoInverseFrequency: { enabled: false } } },
      undefined,
      { docCounts: counts, rrfK: 60 },
    );
    expect(disabled.weights).toEqual({});
  });

  test("auto inverse-source-frequency is inert without a counts provider", () => {
    // No `auto` arg (e.g. a caller without DB access) → no derived priors even
    // though it is enabled by default.
    const resolved = resolveSourcePriorsConfig({ sourcePriors: {} });
    expect(resolved.weights).toEqual({});
  });

  test("explicit user weights win over the auto inverse-source-frequency prior", () => {
    const counts = [
      { sourceId: "alpha:x", docCount: 9000 },
      { sourceId: "beta:x", docCount: 90 },
    ];
    const resolved = resolveSourcePriorsConfig(
      {
        sourcePriors: {
          weights: { "beta:x": -0.5 },
          autoInverseFrequency: { enabled: true },
        },
      },
      undefined,
      { docCounts: counts, rrfK: 60 },
    );
    // Hand-set weight beats the derived prior for that source.
    expect(resolved.weights["beta:x"]).toBe(-0.5);
  });
});
