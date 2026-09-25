// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi } from "vitest";
import { AnthropicCompleter } from "./anthropic-completer.js";

// Mock the Anthropic SDK
const mockCreate = vi.fn(() =>
  Promise.resolve({
    content: [{ type: "text" as const, text: "expanded keywords here" }],
  }),
);

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

describe("AnthropicCompleter", () => {
  test("complete() calls messages.create with correct params", async () => {
    const provider = new AnthropicCompleter("claude-haiku-4-5-20251001", "test-key");

    const result = await provider.complete("test prompt", { maxTokens: 100, temperature: 0.5 });

    expect(result).toBe("expanded keywords here");
    expect(mockCreate).toHaveBeenCalledWith({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      temperature: 0.5,
      messages: [{ role: "user", content: "test prompt" }],
    });
  });

  test("complete() uses default maxTokens and temperature", async () => {
    const provider = new AnthropicCompleter("claude-haiku-4-5-20251001", "test-key");

    await provider.complete("test prompt");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 150,
        temperature: 0.3,
      }),
    );
  });

  test("name is 'anthropic'", () => {
    const provider = new AnthropicCompleter("claude-haiku-4-5-20251001", "test-key");
    expect(provider.name).toBe("anthropic");
  });

  test("dispose() is a no-op", async () => {
    const provider = new AnthropicCompleter("claude-haiku-4-5-20251001", "test-key");
    await expect(provider.dispose()).resolves.toBeUndefined();
  });

  test("complete() returns empty string for non-text blocks", async () => {
    mockCreate.mockImplementationOnce(() =>
      Promise.resolve({
        content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
      }),
    );

    const provider = new AnthropicCompleter("claude-haiku-4-5-20251001", "test-key");
    const result = await provider.complete("test");
    expect(result).toBe("");
  });
});
