// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import {
  detectPromptTruncation,
  promptText,
  promptTokenFloor,
  promptTruncationMessage,
} from "./prompt-truncation.js";

/** Prose-like text of roughly `chars` characters without long repeated runs. */
function prose(chars: number): string {
  const words = ["ledger", "review", "quarterly", "budget", "marathon", "entry", "form", "notes"];
  let out = "";
  for (let i = 0; out.length < chars; i++) out += `${words[i % words.length]} `;
  return out;
}

describe("promptTokenFloor", () => {
  it("is the character count over the floor ratio", () => {
    expect(promptTokenFloor(prose(8_000))).toBeGreaterThanOrEqual(999);
    expect(promptTokenFloor(prose(8_000))).toBeLessThanOrEqual(1_001);
  });

  it("collapses runs of one character, which tokenizers fold into single tokens", () => {
    expect(promptTokenFloor("-".repeat(10_000))).toBe(0);
    expect(promptTokenFloor(`${prose(800)}${" ".repeat(10_000)}\n\n\n\n`)).toBeLessThanOrEqual(101);
  });
});

describe("detectPromptTruncation", () => {
  const request = prose(64_000); // floor 8000; tokenizes to about 14k in practice

  it("flags a reported count below the floor", () => {
    expect(detectPromptTruncation(request, 2_050)).toEqual({
      reportedPromptTokens: 2_050,
      promptTokenFloor: 8_000,
    });
  });

  it("accepts a count at or above the floor", () => {
    expect(detectPromptTruncation(request, 8_000)).toBeUndefined();
    expect(detectPromptTruncation(request, 14_000)).toBeUndefined();
  });

  it("says nothing when the server reported no prompt usage", () => {
    expect(detectPromptTruncation(request, 0)).toBeUndefined();
    expect(detectPromptTruncation(request, undefined)).toBeUndefined();
  });

  it("never judges a request too short for any context window to cut", () => {
    expect(detectPromptTruncation("hi", 600)).toBeUndefined();
    // 8_000 characters floor to 1_000 tokens, under the minimum; 600 reported tokens pass.
    expect(detectPromptTruncation(prose(8_000), 600)).toBeUndefined();
    expect(detectPromptTruncation(prose(8_200), 600)).toBeDefined();
  });

  it("ignores a nominal count from a server that does not meter prompt tokens", () => {
    // Scripted stand-ins and some proxies answer with a fixed token or two; a
    // server that truncated still evaluated a window's worth.
    expect(detectPromptTruncation(request, 1)).toBeUndefined();
    expect(detectPromptTruncation(request, 128)).toBeUndefined();
    expect(detectPromptTruncation(request, 511)).toBeUndefined();
    expect(detectPromptTruncation(request, 512)).toBeDefined();
  });
});

describe("promptText", () => {
  it("joins message text, replayed tool calls and reasoning, without the JSON envelope", () => {
    const text = promptText([
      { content: "system words" },
      { content: null, tool_calls: [{ function: { name: "search", arguments: '{"q":"x"}' } }] },
      { content: "result", reasoning_content: "thought" },
    ]);
    expect(text).toContain("system words");
    expect(text).toContain("search");
    expect(text).toContain('{"q":"x"}');
    expect(text).toContain("thought");
    expect(text).not.toContain("reasoning_content");
  });

  it("counts an empty conversation as nothing", () => {
    expect(promptText([{ content: null }])).toBe("");
  });
});

describe("promptTruncationMessage", () => {
  it("names both counts and the remedy", () => {
    const message = promptTruncationMessage({
      reportedPromptTokens: 2_050,
      promptTokenFloor: 8_000,
    });
    expect(message).toContain("2050");
    expect(message).toContain("8000");
    expect(message).toContain("context length");
  });
});
