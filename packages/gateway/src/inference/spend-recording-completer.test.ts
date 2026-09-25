// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { withSpendRecording, type CompleterUsageSample } from "./spend-recording-completer.js";
import type { CompleteCapability } from "@omnesis/core";

function httpStyleCompleter(usage: { promptTokens: number; completionTokens: number } | null): {
  provider: CompleteCapability;
  calls: string[];
  disposed: () => boolean;
} {
  const calls: string[] = [];
  let disposed = false;
  const provider: CompleteCapability = {
    name: "http",
    modelId: "test-model",
    complete: async (prompt) => {
      calls.push(prompt);
      return "TEXT";
    },
    completeWithUsage: async (prompt) => {
      calls.push(prompt);
      return { text: "TEXT", usage };
    },
    dispose: async () => {
      disposed = true;
    },
  };
  return { provider, calls, disposed: () => disposed };
}

describe("withSpendRecording", () => {
  it("reports usage once per complete() call, with the provider's model id", async () => {
    const { provider } = httpStyleCompleter({ promptTokens: 12, completionTokens: 3 });
    const samples: CompleterUsageSample[] = [];
    const wrapped = withSpendRecording(provider, (s) => samples.push(s));

    await expect(wrapped.complete("expand this")).resolves.toBe("TEXT");
    await wrapped.complete("expand that");

    expect(samples).toEqual([
      { modelId: "test-model", promptTokens: 12, completionTokens: 3 },
      { modelId: "test-model", promptTokens: 12, completionTokens: 3 },
    ]);
  });

  it("reports usage through completeWithUsage() too, and preserves the result", async () => {
    const { provider } = httpStyleCompleter({ promptTokens: 7, completionTokens: 1 });
    const samples: CompleterUsageSample[] = [];
    const wrapped = withSpendRecording(provider, (s) => samples.push(s));

    const result = await wrapped.completeWithUsage!("classify tokens");
    expect(result).toEqual({ text: "TEXT", usage: { promptTokens: 7, completionTokens: 1 } });
    expect(samples).toHaveLength(1);
  });

  it("reports nothing when the backend returned no usage", async () => {
    const { provider } = httpStyleCompleter(null);
    const samples: CompleterUsageSample[] = [];
    const wrapped = withSpendRecording(provider, (s) => samples.push(s));

    await wrapped.complete("expand");
    expect(samples).toEqual([]);
  });

  it("returns a usage-less provider (local GGUF) unwrapped", async () => {
    const provider: CompleteCapability = {
      name: "local",
      modelId: "local-model",
      complete: async () => "TEXT",
      dispose: async () => {},
    };
    const wrapped = withSpendRecording(provider, () => {
      throw new Error("must never be called");
    });
    expect(wrapped).toBe(provider);
  });

  it("survives a throwing recorder and delegates dispose", async () => {
    const { provider, disposed } = httpStyleCompleter({ promptTokens: 1, completionTokens: 1 });
    const wrapped = withSpendRecording(provider, () => {
      throw new Error("recorder fell over");
    });

    await expect(wrapped.complete("expand")).resolves.toBe("TEXT");
    await wrapped.dispose();
    expect(disposed()).toBe(true);
  });
});
