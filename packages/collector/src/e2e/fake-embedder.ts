// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Deterministic, dependency-free fake embedding server for E2E tests of
 * semantic search and semantic triggers. Speaks the OpenAI-compatible
 * subset that the gateway's {@link HttpEmbedder} + `probeHttpEmbedder()`
 * exercise:
 *
 *   GET  /v1/models      -> { object, data: [{ id, object, owned_by }] }
 *   POST /v1/embeddings  -> { object, data: [{ object, index, embedding }], model, usage }
 *
 * Embeddings are produced by a stable, token-based hashing scheme (no model
 * weights, no GGUF download). Texts that share many tokens land in the same
 * buckets and therefore have high cosine similarity; texts with disjoint
 * vocabularies land in near-disjoint buckets and are near-orthogonal. The
 * gateway uses the SAME embedder for the document corpus and for the
 * query/trigger text, so determinism + a consistent dimension is all that
 * semantic search and JS-cosine semantic triggers require.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Default embedding dimension — matches the gateway's hardcoded EMBEDDING_DIM. */
export const FAKE_EMBEDDER_DIM = 768;

/** Default model id this server advertises. */
export const FAKE_EMBEDDER_MODEL_ID = "fake-embed-test-v1";

export interface FakeEmbedderOptions {
  /** Embedding dimension. Defaults to 768 so the /search HNSW read handle works. */
  dim?: number;
  /** Model id advertised via /v1/models and echoed in /v1/embeddings. */
  modelId?: string;
}

export interface FakeEmbedderServer {
  /** Base URL (no trailing slash), e.g. http://127.0.0.1:54321 */
  url: string;
  /** The model id this server advertises. */
  modelId: string;
  /** The embedding dimension this server produces. */
  dim: number;
  /**
   * Total number of text inputs embedded across all `/v1/embeddings` POSTs
   * since boot (probe + corpus + query/trigger calls). A monotonic counter
   * tests read before/after an action to prove how many chunks were
   * (re-)embedded — e.g. the #586 O(1)-re-embed assertion that a backfill
   * which re-emits N day-docs re-embeds only the changed one's chunks.
   */
  embedCount: () => number;
  /** Stop the server and resolve once fully closed. */
  close: () => Promise<void>;
}

/**
 * Stable FNV-1a-style 32-bit string hash. Deterministic across runs and
 * platforms (pure integer math, no locale/Math.random dependence).
 */
function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    // FNV prime multiply, kept in 32-bit unsigned range.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Lowercase + split on non-alphanumeric runs, dropping empties. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Deterministic embedding: bucket each token by its hash into [0, dim),
 * accumulate per-bucket weight, then L2-normalize. Shared tokens -> shared
 * buckets -> high cosine; disjoint tokens -> disjoint buckets -> near-zero
 * cosine. Empty/blank input yields a zero vector (norm 0) — callers in tests
 * always pass non-empty content.
 */
export function fakeEmbed(text: string, dim: number = FAKE_EMBEDDER_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  for (const token of tokenize(text)) {
    const bucket = hashToken(token) % dim;
    // A second, decorrelated bucket per token spreads signal so that two
    // texts sharing a single token still register meaningful overlap while
    // keeping unrelated vocabularies near-orthogonal.
    const bucket2 = hashToken(token + "#") % dim;
    vec[bucket] += 1;
    vec[bucket2] += 0.5;
  }
  let normSq = 0;
  for (const v of vec) normSq += v * v;
  const norm = Math.sqrt(normSq);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm;
  }
  return vec;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

/**
 * Start the fake embedding server on a free port (listens on port 0 and reads
 * back the OS-assigned port). Resolves once the server is accepting
 * connections.
 */
export function startFakeEmbedderServer(
  opts: FakeEmbedderOptions = {},
): Promise<FakeEmbedderServer> {
  const dim = opts.dim ?? FAKE_EMBEDDER_DIM;
  const modelId = opts.modelId ?? FAKE_EMBEDDER_MODEL_ID;

  // Total inputs embedded across all /v1/embeddings POSTs. Boxed so the
  // request handler mutates the same counter the returned `embedCount()` reads.
  const embedCounter = { n: 0 };

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, dim, modelId, embedCounter);
  });

  return new Promise<FakeEmbedderServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        modelId,
        dim,
        embedCount: () => embedCounter.n,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  dim: number,
  modelId: string,
  embedCounter: { n: number },
): Promise<void> {
  const url = req.url ?? "";
  const path = url.split("?")[0];

  if (req.method === "GET" && path === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: [{ id: modelId, object: "model", owned_by: "omnesis-test" }],
    });
    return;
  }

  if (req.method === "POST" && path === "/v1/embeddings") {
    let parsed: { input?: string | string[]; model?: string };
    try {
      parsed = JSON.parse(await readBody(req)) as typeof parsed;
    } catch {
      sendJson(res, 400, { error: { message: "invalid JSON body" } });
      return;
    }
    const rawInput = parsed.input;
    const inputs: string[] =
      typeof rawInput === "string" ? [rawInput] : Array.isArray(rawInput) ? rawInput : [];
    if (inputs.length === 0) {
      sendJson(res, 400, { error: { message: "input is required" } });
      return;
    }
    embedCounter.n += inputs.length;
    let totalTokens = 0;
    const data = inputs.map((text, index) => {
      totalTokens += tokenize(text).length;
      return { object: "embedding", index, embedding: fakeEmbed(text, dim) };
    });
    sendJson(res, 200, {
      object: "list",
      data,
      model: parsed.model ?? modelId,
      usage: { prompt_tokens: totalTokens, total_tokens: totalTokens },
    });
    return;
  }

  sendJson(res, 404, { error: { message: `no route for ${req.method} ${path}` } });
}
