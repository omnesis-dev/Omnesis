// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import {
  NO_EMBEDDER_PREFIXES,
  NO_ENCODING,
  detectEmbedderFamily,
  getEmbedderPrefixes,
  resolveEmbedderEncoding,
} from "./embedder-prefixes.js";
import { LlamaCppEmbedder } from "./embedder.js";
import type { LlamaEmbedding, LlamaEmbeddingContext } from "node-llama-cpp";

describe("detectEmbedderFamily", () => {
  test("nomic catalog id maps to nomic", () => {
    expect(detectEmbedderFamily("nomic-embed-text-v1.5.Q8_0")).toBe("nomic");
  });

  test("bge small/large both map to bge", () => {
    expect(detectEmbedderFamily("bge-small-en-v1.5.Q8_0")).toBe("bge");
    expect(detectEmbedderFamily("bge-large-en-v1.5.Q8_0")).toBe("bge");
  });

  test("mxbai maps to mxbai", () => {
    expect(detectEmbedderFamily("mxbai-embed-large-v1.Q8_0")).toBe("mxbai");
  });

  test("e5 non-instruct maps to e5", () => {
    expect(detectEmbedderFamily("multilingual-e5-large.Q8_0")).toBe("e5");
    expect(detectEmbedderFamily("e5-small-v2")).toBe("e5");
  });

  test("e5 instruct maps to unknown (uses instruction format, not simple prefixes)", () => {
    expect(detectEmbedderFamily("multilingual-e5-large-instruct.Q8_0")).toBe("unknown");
  });

  test("qwen3-embedding maps to qwen (asymmetric instruction on the query side)", () => {
    expect(detectEmbedderFamily("qwen3-embedding-0.6b.Q8_0")).toBe("qwen");
    expect(detectEmbedderFamily("qwen3-embedding-4b.Q8_0")).toBe("qwen");
    expect(detectEmbedderFamily("Qwen/Qwen3-Embedding-0.6B")).toBe("qwen");
  });

  test("undefined / empty / unknown ids map to unknown", () => {
    expect(detectEmbedderFamily(undefined)).toBe("unknown");
    expect(detectEmbedderFamily("")).toBe("unknown");
    expect(detectEmbedderFamily("some-sideloaded-model")).toBe("unknown");
    expect(detectEmbedderFamily("voyage-large-2")).toBe("unknown");
  });

  test("case-insensitive", () => {
    expect(detectEmbedderFamily("Nomic-Embed-Text-v1.5")).toBe("nomic");
    expect(detectEmbedderFamily("BGE-large-en-v1.5")).toBe("bge");
    expect(detectEmbedderFamily("MXBAI-embed-large-v1")).toBe("mxbai");
    expect(detectEmbedderFamily("Multilingual-E5-large")).toBe("e5");
    expect(detectEmbedderFamily("Multilingual-E5-large-Instruct")).toBe("unknown");
  });

  test("basename-aware: org-prefixed aggregator ids match on the last path segment", () => {
    // Cloud aggregators (Together, Fireworks, vLLM serving HF ids) serve
    // org-prefixed model ids. `startsWith` on the full id would miss these.
    expect(detectEmbedderFamily("BAAI/bge-large-en-v1.5")).toBe("bge");
    expect(detectEmbedderFamily("nomic-ai/nomic-embed-text-v1.5")).toBe("nomic");
    expect(detectEmbedderFamily("Qwen/Qwen3-Embedding-0.6B")).toBe("qwen");
    expect(detectEmbedderFamily("intfloat/multilingual-e5-large")).toBe("e5");
    expect(detectEmbedderFamily("mixedbread-ai/mxbai-embed-large-v1")).toBe("mxbai");
  });
});

describe("resolveEmbedderEncoding", () => {
  test("known open-model families resolve to text-prefix (family-first, provider-agnostic)", () => {
    expect(resolveEmbedderEncoding({ modelId: "nomic-embed-text-v1.5" })).toEqual({
      kind: "text-prefix",
      query: "search_query: ",
      document: "search_document: ",
    });
    expect(resolveEmbedderEncoding({ modelId: "bge-large-en-v1.5" })).toEqual({
      kind: "text-prefix",
      query: "Represent this sentence for searching relevant passages: ",
      document: "",
    });
    expect(resolveEmbedderEncoding({ modelId: "multilingual-e5-large" })).toEqual({
      kind: "text-prefix",
      query: "query: ",
      document: "passage: ",
    });
    const qwen = resolveEmbedderEncoding({ modelId: "Qwen/Qwen3-Embedding-0.6B" });
    expect(qwen.kind).toBe("text-prefix");
    if (qwen.kind === "text-prefix") {
      expect(qwen.query.startsWith("Instruct: ")).toBe(true);
      expect(qwen.document).toBe("");
    }
  });

  test("a recognised family wins even when an api-param provider serves it", () => {
    // An aggregator branded as voyage that still serves a known open model
    // gets the model's text prefix, not the provider's api-param.
    expect(
      resolveEmbedderEncoding({ modelId: "nomic-embed-text-v1.5", providerId: "voyage" }),
    ).toEqual({
      kind: "text-prefix",
      query: "search_query: ",
      document: "search_document: ",
    });
  });

  test("symmetric providers resolve to none", () => {
    expect(
      resolveEmbedderEncoding({ modelId: "text-embedding-3-small", providerId: "openai" }),
    ).toEqual(NO_ENCODING);
    expect(resolveEmbedderEncoding({ modelId: "mistral-embed", providerId: "mistral" })).toEqual(
      NO_ENCODING,
    );
  });

  test("Gemini via the OpenAI-compat shim resolves to none (shim rejects task_type)", () => {
    // Empirically the shim 400s on task_type / taskType / extra_body, so the
    // only correct OpenAI-compat encoding is symmetric. Native asymmetry needs
    // a separate non-OpenAI client.
    expect(
      resolveEmbedderEncoding({ modelId: "gemini-embedding-001", providerId: "google" }),
    ).toEqual(NO_ENCODING);
  });

  test("voyage resolves to an input_type api-param", () => {
    expect(resolveEmbedderEncoding({ modelId: "voyage-3-large", providerId: "voyage" })).toEqual({
      kind: "api-param",
      param: "input_type",
      queryValue: "query",
      documentValue: "document",
    });
  });

  test("CRITICAL: an unrecognised model resolves to none, NOT nomic prefixes", () => {
    // The historical bug: an unknown model used to inherit nomic prefixes,
    // corrupting retrieval. Symmetric is the only safe default.
    expect(resolveEmbedderEncoding({ modelId: "some-sideloaded-model" })).toEqual(NO_ENCODING);
    expect(resolveEmbedderEncoding({ modelId: undefined })).toEqual(NO_ENCODING);
    expect(resolveEmbedderEncoding({ modelId: "", providerId: "http" })).toEqual(NO_ENCODING);
  });
});

describe("getEmbedderPrefixes", () => {
  test("nomic returns search_query / search_document", () => {
    expect(getEmbedderPrefixes("nomic")).toEqual({
      query: "search_query: ",
      document: "search_document: ",
    });
  });

  test("bge returns the BGE query prefix and empty document prefix", () => {
    expect(getEmbedderPrefixes("bge")).toEqual({
      query: "Represent this sentence for searching relevant passages: ",
      document: "",
    });
  });

  test("mxbai uses the same contract as bge (query-side only)", () => {
    expect(getEmbedderPrefixes("mxbai")).toEqual({
      query: "Represent this sentence for searching relevant passages: ",
      document: "",
    });
  });

  test("e5 returns query: / passage: on both sides", () => {
    expect(getEmbedderPrefixes("e5")).toEqual({
      query: "query: ",
      document: "passage: ",
    });
  });

  test("qwen returns an Instruct query prefix and a raw (empty) document prefix", () => {
    const p = getEmbedderPrefixes("qwen");
    expect(p.query.startsWith("Instruct: ")).toBe(true);
    expect(p.query.includes("\nQuery: ")).toBe(true);
    expect(p.document).toBe("");
  });

  test("unknown returns empty / empty (no-op)", () => {
    expect(getEmbedderPrefixes("unknown")).toEqual({ query: "", document: "" });
    expect(getEmbedderPrefixes("unknown")).toEqual(NO_EMBEDDER_PREFIXES);
  });
});

// ---------------------------------------------------------------------------
// Integration-ish: the embedder actually applies the configured prefix
// (or doesn't, when the prefix is empty).
//
// We can't load a real GGUF in unit tests — but the embedder owns a pool
// of `LlamaEmbeddingContext` slots and the only thing we need to assert
// is that the text reaching `ctx.getEmbeddingFor(...)` carries the
// expected prefix. We swap in a fake llama model + context pool so the
// call chain runs in-process.
// ---------------------------------------------------------------------------

interface FakeContext {
  ctx: LlamaEmbeddingContext;
  calls: string[];
}

function fakeEmbeddingContext(): FakeContext {
  const calls: string[] = [];
  const ctx = {
    getEmbeddingFor: vi.fn(async (input: string): Promise<LlamaEmbedding> => {
      calls.push(input);
      return { vector: new Float32Array([0.1, 0.2, 0.3]) } as unknown as LlamaEmbedding;
    }),
    dispose: vi.fn(async () => {}),
  } as unknown as LlamaEmbeddingContext;
  return { ctx, calls };
}

/**
 * Install a fake llama model into a fresh `LlamaCppEmbedder` so its
 * `embed()` / `embedQuery()` paths route into our recorder context
 * pool without needing a real GGUF file or Metal device.
 */
async function makeEmbedderWithCapture(
  prefixes: { query: string; document: string },
  poolSize = 2,
  opts?: { outputDim?: number; vectorSize?: number },
): Promise<{ embedder: LlamaCppEmbedder; calls: string[] }> {
  const vecSize = opts?.vectorSize ?? 3;
  const fakes: FakeContext[] = Array.from({ length: poolSize }, () => fakeEmbeddingContext());
  const allCalls: string[] = [];
  for (const f of fakes) {
    f.ctx.getEmbeddingFor = vi.fn(async (input: string): Promise<LlamaEmbedding> => {
      allCalls.push(input);
      const vec = new Float32Array(vecSize);
      for (let i = 0; i < vecSize; i++) vec[i] = (i + 1) * 0.1;
      return { vector: vec } as unknown as LlamaEmbedding;
    });
  }

  const embedder = new LlamaCppEmbedder("/fake/model.gguf", {
    concurrency: poolSize,
    prefixes,
    outputDim: opts?.outputDim,
  });

  // Bypass the real native load — inject the fake slots directly.
  // The internal shape: `slots: Array<{ ctx, busy: Promise<void> }>`.
  // We also short-circuit ensureLoaded() by pre-resolving its promise.
  type EmbedderInternals = {
    slots: Array<{ ctx: LlamaEmbeddingContext; busy: Promise<void> }>;
    loadPromise: Promise<void> | null;
    model: object | null;
  };
  const internals = embedder as unknown as EmbedderInternals;
  internals.slots = fakes.map((f) => ({ ctx: f.ctx, busy: Promise.resolve() }));
  internals.loadPromise = Promise.resolve();
  internals.model = {};

  return { embedder, calls: allCalls };
}

describe("LlamaCppEmbedder prefix application", () => {
  test("applies the configured query prefix on embedQuery", async () => {
    const { embedder, calls } = await makeEmbedderWithCapture({
      query: "search_query: ",
      document: "search_document: ",
    });
    await embedder.embedQuery("hello world");
    expect(calls).toEqual(["search_query: hello world"]);
  });

  test("applies the configured document prefix on embed()", async () => {
    const { embedder, calls } = await makeEmbedderWithCapture({
      query: "search_query: ",
      document: "search_document: ",
    });
    await embedder.embed(["doc one", "doc two"]);
    expect(new Set(calls)).toEqual(
      new Set(["search_document: doc one", "search_document: doc two"]),
    );
  });

  test("BGE: query prefix only, raw doc text", async () => {
    const { embedder, calls } = await makeEmbedderWithCapture({
      query: "Represent this sentence for searching relevant passages: ",
      document: "",
    });
    await embedder.embedQuery("how do I do X");
    await embedder.embed(["passage A", "passage B"]);
    expect(calls).toEqual([
      "Represent this sentence for searching relevant passages: how do I do X",
      "passage A",
      "passage B",
    ]);
  });

  test("empty prefixes: pass raw text through on both sides (no-op fallback)", async () => {
    const { embedder, calls } = await makeEmbedderWithCapture({ query: "", document: "" });
    await embedder.embedQuery("plain query");
    await embedder.embed(["raw chunk"]);
    expect(calls).toEqual(["plain query", "raw chunk"]);
  });
});

describe("LlamaCppEmbedder encoding application", () => {
  /** Construct a capture-wired LlamaCppEmbedder from an `encoding` option. */
  async function makeFromEncoding(
    encoding: import("./embedder-prefixes.js").EmbedderEncoding,
  ): Promise<{ embedder: LlamaCppEmbedder; calls: string[] }> {
    const fakes = Array.from({ length: 2 }, () => fakeEmbeddingContext());
    const calls: string[] = [];
    for (const f of fakes) {
      f.ctx.getEmbeddingFor = vi.fn(async (input: string): Promise<LlamaEmbedding> => {
        calls.push(input);
        return { vector: new Float32Array([0.1, 0.2, 0.3]) } as unknown as LlamaEmbedding;
      });
    }
    const embedder = new LlamaCppEmbedder("/fake/model.gguf", { concurrency: 2, encoding });
    type EmbedderInternals = {
      slots: Array<{ ctx: LlamaEmbeddingContext; busy: Promise<void> }>;
      loadPromise: Promise<void> | null;
      model: object | null;
    };
    const internals = embedder as unknown as EmbedderInternals;
    internals.slots = fakes.map((f) => ({ ctx: f.ctx, busy: Promise.resolve() }));
    internals.loadPromise = Promise.resolve();
    internals.model = {};
    return { embedder, calls };
  }

  test("text-prefix encoding applies query/document prefixes", async () => {
    const { embedder, calls } = await makeFromEncoding({
      kind: "text-prefix",
      query: "search_query: ",
      document: "search_document: ",
    });
    await embedder.embedQuery("hi");
    await embedder.embed(["doc"]);
    expect(calls).toEqual(["search_query: hi", "search_document: doc"]);
  });

  test("api-param encoding is a no-op locally (no text change)", async () => {
    const { embedder, calls } = await makeFromEncoding({
      kind: "api-param",
      param: "input_type",
      queryValue: "query",
      documentValue: "document",
    });
    await embedder.embedQuery("hi");
    await embedder.embed(["doc"]);
    expect(calls).toEqual(["hi", "doc"]);
  });

  test("none encoding passes raw text through", async () => {
    const { embedder, calls } = await makeFromEncoding({ kind: "none" });
    await embedder.embedQuery("hi");
    await embedder.embed(["doc"]);
    expect(calls).toEqual(["hi", "doc"]);
  });
});

describe("LlamaCppEmbedder MRL truncation", () => {
  test("truncates vectors when outputDim < native dim", async () => {
    const { embedder } = await makeEmbedderWithCapture({ query: "", document: "" }, 2, {
      outputDim: 2,
      vectorSize: 5,
    });
    const result = await embedder.embedQuery("test");
    expect(result.length).toBe(2);
    expect(Array.from(result)).toEqual([0.1, 0.2].map((v) => expect.closeTo(v, 5)));
  });

  test("does not truncate when outputDim matches native dim", async () => {
    const { embedder } = await makeEmbedderWithCapture({ query: "", document: "" }, 2, {
      outputDim: 3,
      vectorSize: 3,
    });
    const result = await embedder.embedQuery("test");
    expect(result.length).toBe(3);
  });

  test("does not truncate when outputDim is not set", async () => {
    const { embedder } = await makeEmbedderWithCapture({ query: "", document: "" }, 2, {
      vectorSize: 5,
    });
    const result = await embedder.embedQuery("test");
    expect(result.length).toBe(5);
  });

  test("truncates document embeddings in embed()", async () => {
    const { embedder } = await makeEmbedderWithCapture({ query: "", document: "" }, 2, {
      outputDim: 2,
      vectorSize: 4,
    });
    const results = await embedder.embed(["a", "b"]);
    expect(results[0].length).toBe(2);
    expect(results[1].length).toBe(2);
  });
});
