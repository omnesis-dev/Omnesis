// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LlamaCppEmbedder } from "./embedder.js";

const native = vi.hoisted(() => ({ createContext: vi.fn() }));

// Substitute the production model-loading seam; no native model is loaded.
vi.mock("../llama-instance.js", () => ({
  getLlamaInstance: async () => ({
    loadModel: async () => ({
      createEmbeddingContext: native.createContext,
      dispose: async () => {},
    }),
  }),
}));

function fixture(concurrency: number) {
  const calls: Array<{ slot: number; input: string }> = [];
  const inputs = new Map<
    string,
    {
      started: ReturnType<typeof Promise.withResolvers<void>>;
      result: ReturnType<typeof Promise.withResolvers<{ vector: number[] }>>;
    }
  >();
  const input = (text: string) => {
    let entry = inputs.get(text);
    if (!entry) {
      entry = {
        started: Promise.withResolvers<void>(),
        result: Promise.withResolvers<{ vector: number[] }>(),
      };
      inputs.set(text, entry);
    }
    return entry;
  };
  let slot = 0;
  native.createContext.mockImplementation(async () => {
    const index = slot++;
    return {
      getEmbeddingFor: (text: string) => {
        calls.push({ slot: index, input: text });
        input(text).started.resolve();
        return input(text).result.promise;
      },
      dispose: async () => {},
    };
  });
  return {
    embedder: new LlamaCppEmbedder("invented-embedding.gguf", { concurrency }),
    calls,
    started: (text: string) => input(text).started.promise,
    finish: (text: string, value: number) => input(text).result.resolve({ vector: [value] }),
    fail: (text: string) =>
      input(text).result.reject(new Error("scripted native embedding failure")),
  };
}

describe("local embedding dispatch", () => {
  beforeEach(() => {
    native.createContext.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test("a query sharing one context runs between inputs of an indexing batch", async () => {
    const f = fixture(1);
    let settled = false;
    const batch = f.embedder.embed(["doc-a", "doc-b", "doc-c"]).then((vectors) => {
      settled = true;
      return vectors;
    });
    await f.started("doc-a");
    const query = f.embedder.embedQuery("query");
    // Allow embedQuery's loaded-model await to enqueue on the busy context.
    await Promise.resolve();
    f.finish("doc-a", 1);
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    expect(f.calls.map(({ input }) => input)).toEqual(["doc-a", "query"]);
    expect(settled).toBe(false);
    f.finish("query", 99);
    expect(Array.from(await query)).toEqual([99]);
    await f.started("doc-b");
    f.finish("doc-b", 2);
    await f.started("doc-c");
    expect(settled).toBe(false);
    f.finish("doc-c", 3);
    expect((await batch).map((vector) => Array.from(vector))).toEqual([[1], [2], [3]]);
    await f.embedder.dispose();
  });

  test("indexing slots make independent progress while the query context stays reserved", async () => {
    const f = fixture(3);
    let settled = false;
    const batch = f.embedder.embed(["doc-a", "doc-b", "doc-c", "doc-d"]).then((vectors) => {
      settled = true;
      return vectors;
    });
    await Promise.all([f.started("doc-a"), f.started("doc-b")]);
    expect(f.calls).toEqual([
      { slot: 1, input: "doc-a" },
      { slot: 2, input: "doc-b" },
    ]);
    const query = f.embedder.embedQuery("query");
    await f.started("query");
    expect(f.calls.at(-1)).toEqual({ slot: 0, input: "query" });
    f.finish("query", 99);
    await query;
    f.finish("doc-b", 2);
    await f.started("doc-d");
    expect(f.calls.at(-1)).toEqual({ slot: 2, input: "doc-d" });
    f.finish("doc-d", 4);
    expect(settled).toBe(false);
    f.finish("doc-a", 1);
    await f.started("doc-c");
    expect(f.calls.at(-1)).toEqual({ slot: 1, input: "doc-c" });
    f.finish("doc-c", 3);
    expect((await batch).map((vector) => Array.from(vector))).toEqual([[1], [2], [3], [4]]);
    await f.embedder.dispose();
  });

  test("a failed input rejects its batch without wedging subsequent queries or batches", async () => {
    const f = fixture(1);
    const batch = f.embedder.embed(["bad-doc", "doc-b"]);
    const rejected = expect(batch).rejects.toThrow("scripted native embedding failure");
    await f.started("bad-doc");
    const query = f.embedder.embedQuery("query");
    await Promise.resolve();
    f.fail("bad-doc");
    await rejected;
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    expect(f.calls.at(-1)?.input).toBe("query");
    f.finish("query", 99);
    expect(Array.from(await query)).toEqual([99]);
    const next = f.embedder.embed(["recovered-doc"]);
    await f.started("recovered-doc");
    f.finish("recovered-doc", 3);
    expect((await next).map((vector) => Array.from(vector))).toEqual([[3]]);
    await f.embedder.dispose();
  });

  test("overlapping indexing batches preserve their own results without queuing whole pages ahead of a query", async () => {
    const f = fixture(1);
    const first = f.embedder.embed(["doc-a", "doc-b"]);
    await f.started("doc-a");
    const second = f.embedder.embed(["doc-c", "doc-d"]);
    await Promise.resolve();
    const query = f.embedder.embedQuery("query");
    await Promise.resolve();
    f.finish("doc-a", 1);
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    expect(f.calls.at(-1)?.input).toBe("doc-c");
    f.finish("doc-c", 3);
    await vi.waitFor(() => expect(f.calls).toHaveLength(3));
    expect(f.calls.at(-1)?.input).toBe("query");
    f.finish("query", 99);
    await query;
    await f.started("doc-b");
    f.finish("doc-b", 2);
    expect((await first).map((vector) => Array.from(vector))).toEqual([[1], [2]]);
    await f.started("doc-d");
    f.finish("doc-d", 4);
    expect((await second).map((vector) => Array.from(vector))).toEqual([[3], [4]]);
    await f.embedder.dispose();
  });

  test("a batch failure reaches its caller while another context is still in flight", async () => {
    const f = fixture(3);
    const batch = f.embedder.embed(["bad-doc", "slow-doc", "doc-c"]);
    const rejected = expect(batch).rejects.toThrow("scripted native embedding failure");
    await Promise.all([f.started("bad-doc"), f.started("slow-doc")]);
    f.fail("bad-doc");
    await rejected;
    const query = f.embedder.embedQuery("query");
    await f.started("query");
    f.finish("query", 99);
    await query;
    f.finish("slow-doc", 2);
    await f.embedder.dispose();
  });
});
