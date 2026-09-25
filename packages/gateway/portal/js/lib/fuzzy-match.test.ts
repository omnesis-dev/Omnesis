// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { fuzzyMatchModelId, fuzzyMatchFields } from "./fuzzy-match.js";

describe("fuzzyMatchModelId", () => {
  it("matches every whitespace-separated token as a case-insensitive substring", () => {
    expect(fuzzyMatchModelId("deepseek-ai/DeepSeek-V4-Flash-0731", "deepseek flash")).toBe(true);
  });

  it("keeps exact-substring queries matching", () => {
    expect(fuzzyMatchModelId("gpt-4o-mini", "gpt-4o")).toBe(true);
  });

  it("requires every token to match", () => {
    expect(fuzzyMatchModelId("deepseek-ai/DeepSeek-V4-Flash-0731", "deepseek grok")).toBe(false);
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

describe("fuzzyMatchFields", () => {
  it("lets tokens match across different fields", () => {
    expect(fuzzyMatchFields(["gpt-4o", "GPT Example", "Example chat model"], "example 4o")).toBe(
      true,
    );
  });

  it("requires every token to match at least one field", () => {
    expect(fuzzyMatchFields(["gpt-4o", "GPT Example"], "example grok")).toBe(false);
  });

  it("tolerates missing fields", () => {
    expect(fuzzyMatchFields(["gpt-4o", undefined, null], "gpt")).toBe(true);
  });
});
