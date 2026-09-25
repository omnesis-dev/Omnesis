// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { filterBackendModels, DEFAULT_MODEL_RENDER_CAP } from "./backend-model-filter.js";

/** Build an id → roles map the way the gateway ships `BackendStatus.modelRoles`. */
function roles(map: Record<string, string[]>): Record<string, string[]> {
  return map;
}

describe("filterBackendModels", () => {
  it("buckets candidates into suggested (role match) vs others", () => {
    const r = roles({
      "text-embedding-3-small": ["embedder"],
      "text-embedding-3-large": ["embedder"],
      "gpt-4o": ["agent"],
      "gpt-4o-mini": ["agent"],
    });
    const out = filterBackendModels(r, "embedder", { includeOthers: true });
    expect(out.suggested).toEqual(["text-embedding-3-large", "text-embedding-3-small"]);
    expect(out.others).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(out.suggestedCount).toBe(2);
    expect(out.othersCount).toBe(2);
    expect(out.totalCandidates).toBe(4);
  });

  it("hides others by default (only role-matching models listed)", () => {
    const r = roles({
      "text-embedding-3-small": ["embedder"],
      "gpt-4o": ["agent"],
    });
    const out = filterBackendModels(r, "embedder");
    expect(out.suggested).toEqual(["text-embedding-3-small"]);
    expect(out.others).toEqual([]);
    expect(out.othersCount).toBe(0);
  });

  it("caps each group and reports truncation + pre-cap totals", () => {
    // 120 embedder models — way past the render cap.
    const map: Record<string, string[]> = {};
    for (let i = 0; i < 120; i++) {
      map[`embed-model-${String(i).padStart(3, "0")}`] = ["embedder"];
    }
    const out = filterBackendModels(map, "embedder", { cap: 50 });
    expect(out.suggested).toHaveLength(50);
    expect(out.suggestedCount).toBe(120);
    expect(out.suggestedTruncated).toBe(true);
    // Deterministic, sorted slice — the first 50 ids.
    expect(out.suggested[0]).toBe("embed-model-000");
    expect(out.suggested[49]).toBe("embed-model-049");
  });

  it("caps and reports truncation for the others group too", () => {
    // One embedder + 120 chat models; reveal others and confirm the others
    // list is capped with its own pre-cap total (so the picker can say
    // "showing 50 of 120 other models").
    const map: Record<string, string[]> = { "text-embedding-3-small": ["embedder"] };
    for (let i = 0; i < 120; i++) map[`chat-model-${String(i).padStart(3, "0")}`] = ["agent"];
    const out = filterBackendModels(map, "embedder", { includeOthers: true, cap: 50 });
    expect(out.others).toHaveLength(50);
    expect(out.othersCount).toBe(120);
    expect(out.othersTruncated).toBe(true);
    expect(out.suggestedTruncated).toBe(false);
  });

  it("the 300-models case: a flat dump is curated to a bounded suggested list", () => {
    // Simulate a full OpenAI-style account: 1 relevant embedder among 300 ids.
    const map: Record<string, string[]> = {};
    map["text-embedding-3-small"] = ["embedder"];
    for (let i = 0; i < 299; i++) map[`some-chat-model-${i}`] = ["agent"];

    const out = filterBackendModels(map, "embedder");
    expect(out.totalCandidates).toBe(300);
    // Without searching/toggling, the Embedder picker shows ONLY the one
    // embedder — not all 300 ids. This is the core of the #693 fix.
    expect(out.suggested).toEqual(["text-embedding-3-small"]);
    expect(out.others).toEqual([]);
  });

  it("a query searches across ALL models, even ones the heuristic mis-bucketed", () => {
    const r = roles({
      "text-embedding-3-small": ["embedder"],
      // A custom embedder the name heuristic failed to recognise → bucketed
      // generative. A search for it must still surface it so it's pickable.
      "my-house-embeddings-v2": ["agent"],
      "gpt-4o": ["agent"],
    });
    const out = filterBackendModels(r, "embedder", { query: "embed" });
    // The role-matching one shows under suggested…
    expect(out.suggested).toEqual(["text-embedding-3-small"]);
    // …and the mis-bucketed one is reachable under others (query spans all).
    expect(out.others).toEqual(["my-house-embeddings-v2"]);
  });

  it("query is case-insensitive substring on the id", () => {
    const r = roles({
      "GPT-4O": ["agent"],
      "claude-sonnet": ["agent"],
    });
    const out = filterBackendModels(r, "agent", { query: "gpt" });
    expect(out.suggested).toEqual(["GPT-4O"]);
  });

  it("matches a multi-word query against tokens across the id", () => {
    const r = roles({
      "deepseek-ai/DeepSeek-V4-Flash-0731": ["agent"],
      "deepseek-ai/DeepSeek-V3": ["agent"],
      "gpt-4o": ["agent"],
    });
    const out = filterBackendModels(r, "agent", { query: "deepseek flash" });
    expect(out.suggested).toEqual(["deepseek-ai/DeepSeek-V4-Flash-0731"]);
  });

  it("uses DEFAULT_MODEL_RENDER_CAP when no cap is given", () => {
    const map: Record<string, string[]> = {};
    for (let i = 0; i < DEFAULT_MODEL_RENDER_CAP + 10; i++) map[`m-${i}`] = ["agent"];
    const out = filterBackendModels(map, "agent");
    expect(out.suggested).toHaveLength(DEFAULT_MODEL_RENDER_CAP);
    expect(out.suggestedTruncated).toBe(true);
  });

  it("handles an empty / missing model map gracefully", () => {
    expect(filterBackendModels({}, "embedder").suggested).toEqual([]);
    expect(filterBackendModels(undefined as unknown as Record<string, string[]>, "embedder").totalCandidates).toBe(0);
  });
});
