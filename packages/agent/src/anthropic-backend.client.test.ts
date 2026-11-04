// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";

const constructed: Array<{ apiKey: string }> = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: vi.fn() };
    constructor(opts: { apiKey: string }) {
      constructed.push(opts);
    }
  },
}));

import { AnthropicBackend } from "./anthropic-backend.js";

describe("AnthropicBackend client", () => {
  it("builds the SDK client on first use, once, with the backend's key", async () => {
    const backend = new AnthropicBackend({ apiKey: "sk-test-fixture", model: "claude-test" });
    expect(constructed).toEqual([]);

    const client = (backend as any).anthropicClient.bind(backend) as () => Promise<unknown>;
    const first = await client();
    const second = await client();
    expect(first).toBe(second);
    expect(constructed).toEqual([{ apiKey: "sk-test-fixture" }]);
  });
});
