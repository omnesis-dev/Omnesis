// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi } from "vitest";
import { embeddingWindow, LlamaCppEmbedder, pickIndexerSlotIndex } from "./embedder.js";

describe("pickIndexerSlotIndex", () => {
  test("routes indexer tasks onto slots 1..N-1 (default pool of 4)", () => {
    const poolSize = 4;
    const assignments = Array.from({ length: 12 }, (_, i) => pickIndexerSlotIndex(poolSize, i));
    expect(assignments).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3]);
    for (const slot of assignments) {
      expect(slot).toBeGreaterThanOrEqual(1);
      expect(slot).toBeLessThanOrEqual(3);
    }
  });

  test("never returns slot 0 when pool size > 1 (reserved for embedQuery)", () => {
    for (const poolSize of [2, 3, 4, 8, 16]) {
      for (let i = 0; i < 100; i++) {
        expect(pickIndexerSlotIndex(poolSize, i)).not.toBe(0);
      }
    }
  });

  test("falls back to slot 0 when pool size <= 1", () => {
    expect(pickIndexerSlotIndex(1, 0)).toBe(0);
    expect(pickIndexerSlotIndex(1, 7)).toBe(0);
    expect(pickIndexerSlotIndex(0, 0)).toBe(0);
  });

  test("distributes evenly across indexer slots", () => {
    const poolSize = 4;
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 300; i++) counts[pickIndexerSlotIndex(poolSize, i)]++;
    expect(counts[0]).toBe(0);
    expect(counts[1]).toBe(100);
    expect(counts[2]).toBe(100);
    expect(counts[3]).toBe(100);
  });
});

describe("embeddingWindow", () => {
  test("caps the configured context at the model's training window", () => {
    expect(embeddingWindow(2048, 512)).toBe(512);
    expect(embeddingWindow(2048, 8192)).toBe(2048);
  });

  test("keeps the configured context when the model reports no window", () => {
    expect(embeddingWindow(2048, 0)).toBe(2048);
    expect(embeddingWindow(2048, undefined)).toBe(2048);
  });
});

/**
 * A stand-in for a loaded GGUF: one token per whitespace-separated word, and
 * two special tokens (CLS/SEP) added around every input, as a BERT model does.
 */
function fakeModel(trainContextSize: number) {
  const created: Array<{ contextSize: number; batchSize?: number }> = [];
  const inputs: Array<string | number[]> = [];
  const gates: Array<() => void> = [];
  let holdCalls = false;
  const model = {
    trainContextSize,
    tokenize: (text: string) => text.split(" ").map((_, i) => i + 10),
    createEmbeddingContext: (opts: { contextSize: number; batchSize?: number }) => {
      created.push(opts);
      return Promise.resolve({
        calculateInputLength: (text: string) => (text ? text.split(" ").length : 0) + 2,
        getEmbeddingFor: async (input: string | number[]) => {
          inputs.push(input);
          if (holdCalls) await new Promise<void>((resolve) => gates.push(resolve));
          return { vector: [0.1, 0.2] };
        },
        dispose: vi.fn(async () => {}),
      });
    },
    dispose: vi.fn(async () => {}),
  };
  return {
    model,
    created,
    inputs,
    gates,
    hold: () => {
      holdCalls = true;
    },
  };
}

const llama = vi.hoisted(() => ({ model: null as unknown }));
vi.mock("../llama-instance.js", () => ({
  getLlamaInstance: () => Promise.resolve({ loadModel: () => Promise.resolve(llama.model) }),
}));

describe("LlamaCppEmbedder context window", () => {
  test("a 512-token model gets a 512-token context and batch, and long inputs are cut to it", async () => {
    const fake = fakeModel(512);
    llama.model = fake.model;
    const embedder = new LlamaCppEmbedder("/fake/bge-small.gguf", { concurrency: 2 });

    await embedder.embed(["short text", Array.from({ length: 900 }, () => "word").join(" ")]);

    // Before: a 2048-token context let position 512+ index past the model's
    // position table and abort the process in ggml.
    expect(fake.created).toEqual([
      { contextSize: 512, batchSize: 512 },
      { contextSize: 512, batchSize: 512 },
    ]);
    expect(fake.inputs[0]).toBe("short text");
    // 512 - 1 (node-llama-cpp needs input < context) - 2 special tokens.
    expect(fake.inputs[1]).toHaveLength(509);
    await embedder.dispose();
  });

  test("a long-context model keeps the configured context, with the batch holding a whole input", async () => {
    const fake = fakeModel(8192);
    llama.model = fake.model;
    const embedder = new LlamaCppEmbedder("/fake/nomic.gguf", { concurrency: 1 });
    await embedder.embedQuery(Array.from({ length: 700 }, () => "word").join(" "));
    // A 512-token default batch split a 700-token chunk, and an encoder model
    // then returned the embedding of its last batch only.
    expect(fake.created).toEqual([{ contextSize: 2048, batchSize: 2048 }]);
    expect(typeof fake.inputs[0]).toBe("string");
    await embedder.dispose();
  });
});

describe("LlamaCppEmbedder shutdown", () => {
  test("dispose waits for running native calls and fails the queued ones", async () => {
    const fake = fakeModel(512);
    llama.model = fake.model;
    const embedder = new LlamaCppEmbedder("/fake/model.gguf", { concurrency: 2 });
    await embedder.embedQuery("warm up");
    fake.hold();

    // Pool of two: slot 0 is the query slot, so all three inputs queue on slot 1.
    const batch = embedder.embed(["one", "two", "three"]);
    await vi.waitFor(() => expect(fake.gates).toHaveLength(1));

    let disposed = false;
    const disposing = embedder.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The context must not be freed while llama.cpp is still evaluating on it.
    expect(disposed).toBe(false);

    fake.gates[0]();
    await disposing;
    await expect(batch).rejects.toThrow("embedder is shutting down");
    // Only the input already running reached the model.
    expect(fake.inputs.slice(1)).toEqual(["one"]);
  });
});
