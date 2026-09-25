// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { fuzzyMatchModelId } from "./fuzzy-match.js";

describe("fuzzyMatchModelId", () => {
  it("matches every whitespace-separated token as a case-insensitive substring", () => {
    expect(fuzzyMatchModelId("deepseek-ai/DeepSeek-V4-Flash-0731", "deepseek flash")).toBe(true);
  });

  it("keeps exact-substring queries matching", () => {
    expect(fuzzyMatchModelId("gpt-4o", "gpt-4o")).toBe(true);
    expect(fuzzyMatchModelId("gpt-4o-mini", "gpt-4o")).toBe(true);
  });

  it("is case-insensitive on both sides", () => {
    expect(fuzzyMatchModelId("Qwen/Qwen3-8B", "qwen 8b")).toBe(true);
    expect(fuzzyMatchModelId("gpt-4o", "GPT")).toBe(true);
  });

  it("requires every token to match", () => {
    expect(fuzzyMatchModelId("deepseek-ai/DeepSeek-V4-Flash-0731", "deepseek grok")).toBe(false);
    expect(fuzzyMatchModelId("gpt-4o", "gpt claude")).toBe(false);
  });

  it("treats an empty or blank query as a match", () => {
    expect(fuzzyMatchModelId("anything", "")).toBe(true);
    expect(fuzzyMatchModelId("anything", "   ")).toBe(true);
  });

  it("ignores extra whitespace between tokens", () => {
    expect(fuzzyMatchModelId("deepseek-ai/DeepSeek-V4-Flash-0731", "  deepseek   flash  ")).toBe(
      true,
    );
  });
});
