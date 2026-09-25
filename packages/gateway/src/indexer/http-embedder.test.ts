// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { HttpEmbedder, probeHttpEmbedder } from "./http-embedder.js";
import { classifyEmbedError } from "./embed-failures.js";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function embedResponse(vectors: number[][]): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((v, i) => ({ embedding: v, index: i })),
      model: "test-model",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("HttpEmbedder", () => {
  test("embed() sends batch and returns Float32Arrays", async () => {
    mockFetch.mockResolvedValueOnce(
      embedResponse([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]),
    );

    const embedder = new HttpEmbedder({ baseUrl: "http://localhost:8001", model: "m" });
    const result = await embedder.embed(["hello", "world"]);

    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(result[0].length).toBe(3);
    expect(result[1].length).toBe(3);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("m");
    expect(body.input).toEqual(["hello", "world"]);
  });

  test("embed() returns empty array for empty input", async () => {
    const embedder = new HttpEmbedder({ baseUrl: "http://localhost:8001", model: "m" });
    const result = await embedder.embed([]);
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("embed() splits into batches when input exceeds batchSize", async () => {
    // Respond based on the request's input count, not call order: the embedder
    // may dispatch the two batches concurrently, so a fixed `mockResolvedValueOnce`
    // sequence would race (the 1-input batch could land the 2-vector response).
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const { input } = JSON.parse(init.body) as { input: string[] };
      return embedResponse(input.map((_, i) => [0.1 * (i + 1)]));
    });

    const embedder = new HttpEmbedder({
      baseUrl: "http://localhost:8001",
      model: "m",
      batchSize: 2,
    });
    const result = await embedder.embed(["a", "b", "c"]);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(3);
    expect(result[2].length).toBe(1);
  });

  test("embed() bounds concurrent requests to maxConcurrentRequests", async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    mockFetch.mockImplementation(() => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => {
        releases.push(() => {
          inFlight--;
          resolve(embedResponse([[0.1]]));
        });
      });
    });

    const embedder = new HttpEmbedder({
      baseUrl: "http://127.0.0.1:8001",
      model: "m",
      batchSize: 1, // one request per input
      maxConcurrentRequests: 2,
    });
    const p = embedder.embed(["a", "b", "c", "d", "e", "f"]); // 6 requests
    await new Promise((r) => setTimeout(r, 0)); // let the first wave dispatch

    // Only 2 may be in flight; the other 4 wait on the semaphore.
    expect(inFlight).toBe(2);
    expect(peak).toBe(2);

    // Drain one at a time; each release lets exactly one queued request start.
    for (let i = 0; i < 6; i++) {
      releases.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    const result = await p;
    expect(result).toHaveLength(6);
    expect(mockFetch).toHaveBeenCalledTimes(6);
    expect(peak).toBeLessThanOrEqual(2); // never exceeded the cap
  });

  test("maxConcurrentRequests=Infinity leaves the path unbounded (interactive search)", async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    mockFetch.mockImplementation(() => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => {
        releases.push(() => {
          inFlight--;
          resolve(embedResponse([[0.1]]));
        });
      });
    });

    const embedder = new HttpEmbedder({
      baseUrl: "http://127.0.0.1:8001",
      model: "m",
      batchSize: 1,
      maxConcurrentRequests: Infinity,
    });
    const p = embedder.embed(["a", "b", "c", "d", "e"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(peak).toBe(5); // all 5 fired at once
    releases.forEach((fn) => fn());
    await p;
  });

  test("embedQuery() sends single text and returns one vector", async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[1.0, 2.0]]));

    const embedder = new HttpEmbedder({ baseUrl: "http://localhost:8001", model: "m" });
    const result = await embedder.embedQuery("test query");

    expect(result).toBeInstanceOf(Float32Array);
    expect(Array.from(result)).toEqual([1.0, 2.0]);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toEqual(["test query"]);
  });

  test("applies document prefix on embed()", async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[0.1]]));

    const embedder = new HttpEmbedder({
      baseUrl: "http://localhost:8001",
      model: "m",
      prefixes: { query: "query: ", document: "passage: " },
    });
    await embedder.embed(["hello"]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toEqual(["passage: hello"]);
  });

  test("applies query prefix on embedQuery()", async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[0.1]]));

    const embedder = new HttpEmbedder({
      baseUrl: "http://localhost:8001",
      model: "m",
      prefixes: { query: "query: ", document: "passage: " },
    });
    await embedder.embedQuery("test");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toEqual(["query: test"]);
  });

  test("text-prefix encoding prepends the document prefix on embed()", async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[0.1]]));

    const embedder = new HttpEmbedder({
      baseUrl: "http://localhost:8001",
      model: "m",
      encoding: { kind: "text-prefix", query: "query: ", document: "passage: " },
    });
    await embedder.embed(["hello"]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toEqual(["passage: hello"]);
    // Text-prefix never sets an api-param field.
    expect(Object.keys(body).sort()).toEqual(["input", "model"]);
  });

  test("api-param encoding sets input_type=query on embedQuery() (no text prefix)", async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[0.1]]));

    const embedder = new HttpEmbedder({
      baseUrl: "http://localhost:8001",
      model: "m",
      encoding: {
        kind: "api-param",
        param: "input_type",
        queryValue: "query",
        documentValue: "document",
      },
    });
    await embedder.embedQuery("find restaurants");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toEqual(["find restaurants"]); // text untouched
    expect(body.input_type).toBe("query");
  });

  test("api-param encoding sets input_type=document on embed()", async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[0.1]]));

    const embedder = new HttpEmbedder({
      baseUrl: "http://localhost:8001",
      model: "m",
      encoding: {
        kind: "api-param",
        param: "input_type",
        queryValue: "query",
        documentValue: "document",
      },
    });
    await embedder.embed(["a corpus passage"]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toEqual(["a corpus passage"]); // text untouched
    expect(body.input_type).toBe("document");
  });

  test("none encoding sends a bare { model, input } body on both paths", async () => {
    mockFetch
      .mockResolvedValueOnce(embedResponse([[0.1]]))
      .mockResolvedValueOnce(embedResponse([[0.2]]));

    const embedder = new HttpEmbedder({
      baseUrl: "http://localhost:8001",
      model: "m",
      encoding: { kind: "none" },
    });
    await embedder.embedQuery("q");
    await embedder.embed(["d"]);

    const queryBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const docBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(Object.keys(queryBody).sort()).toEqual(["input", "model"]);
    expect(Object.keys(docBody).sort()).toEqual(["input", "model"]);
    expect(queryBody.input).toEqual(["q"]);
    expect(docBody.input).toEqual(["d"]);
  });

  test("encoding takes precedence over the legacy prefixes option", async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[0.1]]));

    const embedder = new HttpEmbedder({
      baseUrl: "http://localhost:8001",
      model: "m",
      encoding: { kind: "none" },
      prefixes: { query: "query: ", document: "passage: " },
    });
    await embedder.embed(["hello"]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toEqual(["hello"]); // none wins → no prefix
  });

  test("truncates vectors when outputDim is set", async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[0.1, 0.2, 0.3, 0.4, 0.5]]));

    const embedder = new HttpEmbedder({
      baseUrl: "http://localhost:8001",
      model: "m",
      outputDim: 2,
    });
    const result = await embedder.embedQuery("test");

    expect(result.length).toBe(2);
  });

  test("throws on non-200 response", async () => {
    mockFetch.mockResolvedValueOnce(new Response("bad request", { status: 400 }));

    const embedder = new HttpEmbedder({ baseUrl: "http://localhost:8001", model: "m" });
    await expect(embedder.embed(["test"])).rejects.toThrow("HTTP embedder 400");
  });

  test("retries a rate limit twice before succeeding", async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(embedResponse([[0.1, 0.2]]));
    const embedder = new HttpEmbedder({
      baseUrl: "http://localhost:8001",
      model: "m",
      maxConcurrentRequests: 1,
    });

    const pending = embedder.embed(["test"]);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test("does not leak the upstream error body into the thrown error (SEC-16)", async () => {
    // A hostile/misconfigured backend can echo the submitted chunk back in its
    // error body — the thrown (and logged) error must never include it.
    const echoed = "SENSITIVE-DOC-CHUNK-marker";
    mockFetch.mockResolvedValueOnce(new Response(echoed, { status: 500 }));
    const embedder = new HttpEmbedder({ baseUrl: "http://localhost:8001", model: "m" });
    await expect(embedder.embed(["test"])).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(echoed) }),
    );
  });

  test("surfaces a token-overflow marker so the resilient path can shrink-and-retry", async () => {
    // vLLM's 400 for an over-long input. SEC-16 strips the body, so without the
    // marker classifyEmbedError sees an opaque 400 and leaves the doc pending
    // forever. The embedder appends only the recognised marker phrase.
    const vllmBody = JSON.stringify({
      error: {
        message:
          "This model's maximum context length is 2048 tokens. However, you requested 0 " +
          "output tokens and your prompt contains at least 2049 input tokens.",
        code: 400,
      },
    });
    mockFetch.mockResolvedValueOnce(
      new Response(vllmBody, { status: 400, headers: { "Content-Type": "application/json" } }),
    );
    const embedder = new HttpEmbedder({ baseUrl: "http://localhost:8001", model: "m" });
    const err = await embedder.embed(["test"]).then(
      () => null,
      (e) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(classifyEmbedError(err)).toBe("overflow");
  });

  test("appends the overflow marker without echoing surrounding body content (SEC-16)", async () => {
    // Even when the overflow body also carries document text, only the fixed
    // marker phrase is surfaced — never the echoed chunk.
    const echoed = "SENSITIVE-DOC-CHUNK-marker";
    mockFetch.mockResolvedValueOnce(
      new Response(`${echoed}: maximum context length exceeded`, { status: 400 }),
    );
    const embedder = new HttpEmbedder({ baseUrl: "http://localhost:8001", model: "m" });
    const err = await embedder.embed(["test"]).then(
      () => null,
      (e) => e as Error,
    );
    expect(err?.message).toContain("maximum context length");
    expect(err?.message).not.toContain(echoed);
  });

  test("blocks non-loopback inference URLs by default before sending text", async () => {
    const embedder = new HttpEmbedder({ baseUrl: "https://203.0.113.10", model: "m" });
    await expect(embedder.embedQuery("private query")).rejects.toThrow(/allowRemoteInference=true/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("allows non-loopback inference URLs with explicit remote opt-in", async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[0.1]]));

    const embedder = new HttpEmbedder({
      baseUrl: "https://203.0.113.10",
      model: "m",
      allowRemoteInference: true,
    });
    await embedder.embedQuery("query");

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toBe("https://203.0.113.10/v1/embeddings");
  });

  test("throws on vector count mismatch", async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[0.1]]));

    const embedder = new HttpEmbedder({ baseUrl: "http://localhost:8001", model: "m" });
    await expect(embedder.embed(["a", "b"])).rejects.toThrow("1 vectors for 2 inputs");
  });

  test("strips trailing slashes from baseUrl", async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[0.1]]));

    const embedder = new HttpEmbedder({ baseUrl: "http://localhost:8001///", model: "m" });
    await embedder.embedQuery("test");

    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:8001/v1/embeddings");
  });

  test("honors a custom apiPathPrefix in the embeddings URL", async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[0.1]]));

    const embedder = new HttpEmbedder({
      baseUrl: "http://localhost:8001",
      apiPathPrefix: "/v1beta/openai",
      model: "m",
    });
    await embedder.embedQuery("test");

    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:8001/v1beta/openai/embeddings");
  });

  test("sorts response by index when server returns out of order", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { embedding: [0.2], index: 1 },
            { embedding: [0.1], index: 0 },
          ],
          model: "m",
        }),
        { status: 200 },
      ),
    );

    const embedder = new HttpEmbedder({ baseUrl: "http://localhost:8001", model: "m" });
    const result = await embedder.embed(["first", "second"]);
    expect(result[0].length).toBe(1);
    expect(result[1].length).toBe(1);
    expect(result[0][0]).toBeCloseTo(0.1, 4);
    expect(result[1][0]).toBeCloseTo(0.2, 4);
  });
});

describe("probeHttpEmbedder", () => {
  test("auto-discovers the embedding model and dimension", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "nomic-embed-text-v1.5" }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(embedResponse([[0.1, 0.2, 0.3, 0.4]]));

    const result = await probeHttpEmbedder("http://localhost:8001");
    expect(result.model).toBe("nomic-embed-text-v1.5");
    expect(result.dim).toBe(4);
  });

  test("auto-discovery picks the embedder among chat/image models, not data[0]", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "gpt-4o" }, { id: "dall-e-3" }, { id: "text-embedding-3-small" }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(embedResponse([[0.1, 0.2]]));

    const result = await probeHttpEmbedder("http://localhost:8001");
    expect(result.model).toBe("text-embedding-3-small");
  });

  test("throws an actionable error when no embedder is among served models", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }), {
        status: 200,
      }),
    );
    await expect(probeHttpEmbedder("http://localhost:8001")).rejects.toThrow(
      /No embedding model found.*set the embedder model explicitly/s,
    );
  });

  test("throws when multiple embedders are served (ambiguous)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "text-embedding-3-small" }, { id: "nomic-embed-text" }] }),
        { status: 200 },
      ),
    );
    await expect(probeHttpEmbedder("http://localhost:8001")).rejects.toThrow(
      /Multiple embedding models.*set the embedder model explicitly/s,
    );
  });

  test("uses config model when provided", async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[0.1, 0.2]]));

    const result = await probeHttpEmbedder("http://localhost:8001", "explicit-model");
    expect(result.model).toBe("explicit-model");
    expect(result.dim).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("honors a custom apiPathPrefix for the embeddings probe", async () => {
    mockFetch.mockResolvedValueOnce(embedResponse([[0.1, 0.2]]));

    await probeHttpEmbedder("http://localhost:8001", "m", undefined, "/v1beta/openai");
    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:8001/v1beta/openai/embeddings");
  });

  test("throws on unreachable server", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(probeHttpEmbedder("http://localhost:9999")).rejects.toThrow("ECONNREFUSED");
  });

  test("does not expose an upstream embedding error body", async () => {
    const sentinel = "private-backend-diagnostic";
    mockFetch.mockResolvedValueOnce(
      new Response(sentinel, {
        status: 503,
        headers: { "content-type": "text/plain" },
      }),
    );

    const pending = probeHttpEmbedder("http://localhost:8001", "explicit-model");
    await expect(pending).rejects.toThrow(
      `Embedding probe failed: HTTP 503 (text/plain; ${sentinel.length} bytes)`,
    );
    await expect(pending).rejects.not.toThrow(sentinel);
  });

  test("honors an external abort while probing", async () => {
    const controller = new AbortController();
    mockFetch.mockImplementationOnce((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        if (init.signal?.aborted) {
          reject(init.signal.reason ?? new Error("aborted"));
          return;
        }
        init.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    });

    const pending = probeHttpEmbedder(
      "http://localhost:8001",
      "explicit-model",
      undefined,
      undefined,
      false,
      { signal: controller.signal },
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
