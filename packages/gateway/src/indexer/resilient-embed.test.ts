// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { embedChunksResilient } from "./resilient-embed.js";
import type { Embedder } from "./types.js";

type Behavior = "ok" | "overflow" | "malformed" | "transient";

/**
 * Mock embedder that mirrors the HTTP backend's batch semantics: if any input
 * in a batch fails, the whole `embed()` call throws (batch poisoning). The
 * per-input behavior is decided by the input string.
 */
class MockEmbedder implements Embedder {
  readonly calls: string[][] = [];
  constructor(private readonly behave: (text: string) => Behavior) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    for (const t of texts) {
      const b = this.behave(t);
      if (b === "overflow") {
        throw new Error("HTTP embedder 400: This model's maximum context length is 2048 tokens");
      }
      if (b === "malformed") {
        throw new Error("HTTP embedder 400: TextEncodeInput must be Union[TextInputSequence, ...]");
      }
      if (b === "transient") throw new Error("fetch failed");
    }
    return texts.map(() => new Float32Array([1, 2, 3]));
  }
  async embedQuery(): Promise<Float32Array> {
    return new Float32Array([0]);
  }
  async dispose(): Promise<void> {}
}

describe("embedChunksResilient", () => {
  test("empty input → empty result, no calls", async () => {
    const e = new MockEmbedder(() => "ok");
    expect(await embedChunksResilient(e, [])).toEqual([]);
    expect(e.calls).toHaveLength(0);
  });

  test("happy path: single batch call, no per-input isolation", async () => {
    const e = new MockEmbedder(() => "ok");
    const out = await embedChunksResilient(e, ["a", "b", "c"]);
    expect(out).toHaveLength(3);
    expect(out.every((v) => v instanceof Float32Array)).toBe(true);
    expect(e.calls).toHaveLength(1); // exactly one batch call
    expect(e.calls[0]).toEqual(["a", "b", "c"]);
  });

  test("malformed input is dropped; siblings still embed (batch de-poisoned)", async () => {
    const e = new MockEmbedder((t) => (t.includes("BAD") ? "malformed" : "ok"));
    const onDrop = vi.fn();
    const out = await embedChunksResilient(e, ["good", "BAD", "good2"], { onDrop });

    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[1]).toBeNull();
    expect(out[2]).toBeInstanceOf(Float32Array);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(1, "malformed", "BAD".length);
  });

  test("overflowing input is shrunk to fit", async () => {
    // Fails while longer than 500 chars, succeeds at/below.
    const e = new MockEmbedder((t) => (t.length > 500 ? "overflow" : "ok"));
    const onTruncate = vi.fn();
    const out = await embedChunksResilient(e, ["x".repeat(2000)], { onTruncate });

    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(onTruncate).toHaveBeenCalledTimes(1);
    // 2000 -> 1000 -> 500 (fits): final 500, original 2000.
    expect(onTruncate).toHaveBeenCalledWith(0, 500, 2000);
  });

  test("input that never fits is dropped at the floor", async () => {
    const e = new MockEmbedder(() => "overflow");
    const onDrop = vi.fn();
    const out = await embedChunksResilient(e, ["x".repeat(2000)], { onDrop });

    expect(out[0]).toBeNull();
    expect(onDrop).toHaveBeenCalledWith(0, "overflow", 2000);
  });

  test("transient batch failure rethrows (document stays pending)", async () => {
    const e = new MockEmbedder(() => "transient");
    await expect(embedChunksResilient(e, ["a", "b"])).rejects.toThrow("fetch failed");
    // No isolation attempted on a transient batch failure.
    expect(e.calls).toHaveLength(1);
  });

  test("a misaligned batch length triggers per-input isolation (no silent drop)", async () => {
    // Returns one fewer vector than requested on a multi-input batch, but the
    // correct single vector when isolated — a misaligned batch must not silently
    // drop the unaccounted chunk.
    const e: Embedder = {
      async embed(texts: string[]): Promise<Float32Array[]> {
        const out = texts.map(() => new Float32Array([1, 2, 3]));
        return texts.length > 1 ? out.slice(0, -1) : out;
      },
      async embedQuery() {
        return new Float32Array([0]);
      },
      async dispose() {},
    };
    const out = await embedChunksResilient(e, ["a", "b", "c"]);
    expect(out).toHaveLength(3);
    expect(out.every((v) => v instanceof Float32Array)).toBe(true);
  });

  test("a backend that returns no vector surfaces an error, never a silent drop", async () => {
    const e: Embedder = {
      async embed(): Promise<Float32Array[]> {
        return []; // contract violation: no vectors for the inputs
      },
      async embedQuery() {
        return new Float32Array([0]);
      },
      async dispose() {},
    };
    await expect(embedChunksResilient(e, ["a"])).rejects.toThrow();
  });

  test("transient during isolation rethrows (whole document stays pending)", async () => {
    const e = new MockEmbedder((t) => {
      if (t.includes("MAL")) return "malformed";
      if (t.includes("TMP")) return "transient";
      return "ok";
    });
    // Batch poisoned by MAL (deterministic) → isolate → TMP throws transient.
    // The whole call rejects, so the caller leaves the document pending and the
    // partial result (including any sibling drop) is discarded, not committed.
    await expect(embedChunksResilient(e, ["MAL", "TMP"])).rejects.toThrow("fetch failed");
  });
});
