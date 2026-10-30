// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FAKE_EMBEDDER_DIM,
  FAKE_EMBEDDER_MODEL_ID,
  fakeEmbed,
  startFakeEmbedderServer,
  type FakeEmbedderServer,
} from "./fake-embedder.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function embedOverHttp(baseUrl: string, input: string | string[], model: string) {
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, model }),
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as {
    object: string;
    data: Array<{ object: string; index: number; embedding: number[] }>;
    model: string;
    usage: { prompt_tokens: number; total_tokens: number };
  };
}

describe("fake embedder server", () => {
  let server: FakeEmbedderServer;

  beforeAll(async () => {
    server = await startFakeEmbedderServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("advertises the fake model via GET /v1/models", async () => {
    const res = await fetch(`${server.url}/v1/models`);
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(json.object).toBe("list");
    expect(json.data.map((m) => m.id)).toContain(FAKE_EMBEDDER_MODEL_ID);
    expect(server.modelId).toBe(FAKE_EMBEDDER_MODEL_ID);
  });

  it("returns 768-dim, L2-normalized embeddings in OpenAI shape", async () => {
    const json = await embedOverHttp(server.url, "river otters forage at dawn", server.modelId);
    expect(json.object).toBe("list");
    expect(json.model).toBe(server.modelId);
    expect(json.data).toHaveLength(1);
    const entry = json.data[0];
    expect(entry.object).toBe("embedding");
    expect(entry.index).toBe(0);
    expect(entry.embedding).toHaveLength(FAKE_EMBEDDER_DIM);
    expect(server.dim).toBe(768);

    const norm = Math.sqrt(entry.embedding.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("handles batched (array) input and indexes results in order", async () => {
    const json = await embedOverHttp(
      server.url,
      ["alpha beta gamma", "delta epsilon zeta"],
      server.modelId,
    );
    expect(json.data).toHaveLength(2);
    expect(json.data[0].index).toBe(0);
    expect(json.data[1].index).toBe(1);
    expect(json.usage.total_tokens).toBeGreaterThan(0);
  });

  it("scores a related document above an unrelated one (semantic ordering)", async () => {
    // Fictional, invented content — no personal data.
    const query = "quarterly budget review meeting agenda finance";
    const related = "agenda for the quarterly finance budget review meeting next week";
    const unrelated = "marathon training plan hydration shoes weekly mileage";

    const json = await embedOverHttp(server.url, [query, related, unrelated], server.modelId);
    const [qv, rv, uv] = json.data.map((d) => d.embedding);

    const simRelated = cosine(qv, rv);
    const simUnrelated = cosine(qv, uv);

    expect(simRelated).toBeGreaterThan(simUnrelated);
    expect(simRelated).toBeGreaterThan(0.6);
    expect(simUnrelated).toBeLessThan(0.2);
  });

  it("is deterministic across calls", async () => {
    const a = await embedOverHttp(server.url, "stable hash determinism check", server.modelId);
    const b = await embedOverHttp(server.url, "stable hash determinism check", server.modelId);
    expect(a.data[0].embedding).toEqual(b.data[0].embedding);
  });
});

it("a gated HTTP backend refuses real probes without embedding, then serves after release", async () => {
  const backend = await startFakeEmbedderServer({ initiallyUnavailable: true, dim: 8 });
  try {
    const unavailableModels = await fetch(`${backend.url}/v1/models`);
    expect(unavailableModels.status).toBe(503);
    await unavailableModels.json();
    const request = () =>
      fetch(`${backend.url}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: backend.modelId, input: ["invented prism ledger"] }),
      });
    const unavailableVector = await request();
    expect(unavailableVector.status).toBe(503);
    await unavailableVector.json();
    expect(backend.embeddingRequestCount()).toBe(1);
    expect(backend.embedCount()).toBe(0);
    backend.release();
    backend.release();
    const models = await fetch(`${backend.url}/v1/models`);
    expect(models.status).toBe(200);
    expect(await models.json()).toMatchObject({ data: [{ id: backend.modelId }] });
    const vectors = await request();
    expect(vectors.status).toBe(200);
    expect(await vectors.json()).toMatchObject({
      data: [{ embedding: fakeEmbed("invented prism ledger", 8) }],
    });
    expect(backend.embeddingRequestCount()).toBe(2);
    expect(backend.embedCount()).toBe(1);
  } finally {
    await backend.close();
  }
});

it("the ordinary fake backend remains immediately ready by default", async () => {
  const backend = await startFakeEmbedderServer({ dim: 4 });
  try {
    const response = await fetch(`${backend.url}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "invented violet telescope" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [{ embedding: fakeEmbed("invented violet telescope", 4) }],
    });
    expect(backend.embeddingRequestCount()).toBe(1);
    expect(backend.embedCount()).toBe(1);
  } finally {
    await backend.close();
  }
});
