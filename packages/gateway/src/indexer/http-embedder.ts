// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createLogger,
  classifyModelRoles,
  normalizeApiPathPrefix,
  extractModelIds,
  fetchWithInferenceUrlPolicy,
  retryRateLimitedRequest,
} from "@omnesis/core";
import { NO_ENCODING, type EmbedderEncoding, type EmbedderPrefixes } from "./embedder-prefixes.js";
import { embedErrorMarkerFromBody } from "./embed-failures.js";
import type { Embedder } from "./types.js";

const log = createLogger("indexer:http-embedder");

const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * How an embedding server is shared between search and indexing. A server
 * such as vLLM queues every input of a request as its own sequence and serves
 * them first come, first served, so a query embed waits for every background
 * input already sent to it. The gateway cannot reorder that queue; it keeps it
 * short. Query embeds (`embedQuery`) are interactive and go out at once,
 * never waiting behind queued background requests. Document batches (`embed`)
 * are background: at most `maxBackgroundRequests` are in flight, the rest wait
 * in the gateway, in order, and are sent as slots free.
 *
 * The defaults are the shallowest queue that keeps the server busy. Measured
 * against a local vLLM serving a 0.6B embedding model with inputs of about a
 * thousand tokens: 4 requests of 32 inputs in flight served 41 inputs/s while
 * a query waited 2.7 s; 2 requests of 16 served 39–42 inputs/s while a query
 * waited 0.5 s. Override with OMNESIS_EMBED_BATCH_SIZE and
 * OMNESIS_EMBED_BULK_CONCURRENCY, e.g. raise both for a remote API that serves
 * requests concurrently and whose round trip dominates.
 */
const DEFAULT_BATCH_SIZE = (() => {
  const env = Number(process.env.OMNESIS_EMBED_BATCH_SIZE);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : 16;
})();
const DEFAULT_MAX_BACKGROUND_REQUESTS = (() => {
  const env = Number(process.env.OMNESIS_EMBED_BULK_CONCURRENCY);
  return Number.isFinite(env) && env > 0 ? env : 2;
})();
const DEFAULT_MAX_INPUT_CHARS = 2048 * 2;

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export class HttpEmbedder implements Embedder {
  private baseUrl: string;
  private apiPathPrefix: string;
  private model: string;
  private outputDim: number | undefined;
  private timeoutMs: number;
  private batchSize: number;
  private maxInputChars: number;
  /** Per-model retrieval encoding: none | text-prefix | api-param. */
  private encoding: EmbedderEncoding;
  private apiKey?: string;
  private allowRemoteInference: boolean;

  /** Background requests allowed in flight at once (Infinity = unbounded). */
  private readonly maxBackgroundRequests: number;
  private backgroundInFlight = 0;
  private readonly backgroundWaiters: Array<() => void> = [];

  constructor(opts: {
    baseUrl: string;
    apiPathPrefix?: string;
    model: string;
    outputDim?: number;
    timeoutMs?: number;
    batchSize?: number;
    maxInputChars?: number;
    /**
     * Per-model retrieval encoding. Takes precedence over `prefixes`.
     * When omitted, falls back to `prefixes` (back-compat) or `none`.
     */
    encoding?: EmbedderEncoding;
    /**
     * Legacy text-prefix option. Equivalent to passing
     * `{ kind: "text-prefix", ...prefixes }` as `encoding`. Kept so existing
     * callers and tests that pass `prefixes` keep working.
     */
    prefixes?: EmbedderPrefixes;
    apiKey?: string;
    /** Permit non-loopback HTTP inference. Defaults off. */
    allowRemoteInference?: boolean;
    /**
     * Cap on background (`embed`) requests in flight at the embedding server.
     * Query embeds are never counted or held.
     */
    maxBackgroundRequests?: number;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiPathPrefix = normalizeApiPathPrefix(opts.apiPathPrefix);
    this.model = opts.model;
    this.outputDim = opts.outputDim;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxInputChars = opts.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    this.encoding =
      opts.encoding ??
      (opts.prefixes
        ? { kind: "text-prefix", query: opts.prefixes.query, document: opts.prefixes.document }
        : NO_ENCODING);
    this.apiKey = opts.apiKey;
    this.allowRemoteInference = opts.allowRemoteInference === true;
    this.maxBackgroundRequests = opts.maxBackgroundRequests ?? DEFAULT_MAX_BACKGROUND_REQUESTS;
  }

  /** A background slot, waiting in order behind earlier background requests when none is free. */
  private acquireBackgroundSlot(): Promise<void> {
    if (this.backgroundInFlight < this.maxBackgroundRequests) {
      this.backgroundInFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.backgroundWaiters.push(() => {
        this.backgroundInFlight++;
        resolve();
      });
    });
  }

  private releaseBackgroundSlot(): void {
    this.backgroundInFlight--;
    this.backgroundWaiters.shift()?.();
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    // Transport-level backstop only: cap absurdly long inputs (surrogate-safe).
    // Character length can't guarantee a token bound, so genuine overflow on
    // dense/non-Latin text surfaces as a 400 and is recovered (shrink, or drop
    // as a last resort) by the resilient orchestrator in `resilient-embed.ts`.
    const cap = this.maxInputChars;
    const capped =
      cap > 0
        ? texts.map((t) => {
            if (t.length <= cap) return t;
            let end = cap;
            if (t.charCodeAt(end - 1) >= 0xd800 && t.charCodeAt(end - 1) <= 0xdbff) {
              end--;
            }
            return t.slice(0, end);
          })
        : texts;
    const prefix = this.encoding.kind === "text-prefix" ? this.encoding.document : "";
    const prefixed = prefix ? capped.map((t) => prefix + t) : capped;

    const batches: string[][] = [];
    for (let start = 0; start < prefixed.length; start += this.batchSize) {
      batches.push(prefixed.slice(start, start + this.batchSize));
    }
    const batchResults = await Promise.all(batches.map((b) => this.request(b, "document")));
    const results = new Array<Float32Array>(texts.length);
    let offset = 0;
    for (const vectors of batchResults) {
      for (const vec of vectors) {
        results[offset++] = this.truncate(vec);
      }
    }
    return results;
  }

  async embedQuery(query: string): Promise<Float32Array> {
    const cap = this.maxInputChars;
    let capped = query;
    if (cap > 0 && query.length > cap) {
      let end = cap;
      if (query.charCodeAt(end - 1) >= 0xd800 && query.charCodeAt(end - 1) <= 0xdbff) {
        end--;
      }
      capped = query.slice(0, end);
    }
    const prefix = this.encoding.kind === "text-prefix" ? this.encoding.query : "";
    const input = prefix ? prefix + capped : capped;
    const vectors = await this.request([input], "query");
    return this.truncate(vectors[0]);
  }

  async dispose(): Promise<void> {}

  private truncate(vec: Float32Array): Float32Array {
    if (this.outputDim && vec.length > this.outputDim) {
      return vec.slice(0, this.outputDim);
    }
    return vec;
  }

  private async request(input: string[], kind: "query" | "document"): Promise<Float32Array[]> {
    const background = kind === "document";
    if (background) await this.acquireBackgroundSlot();
    try {
      const url = `${this.baseUrl}${this.apiPathPrefix}/embeddings`;
      const body: Record<string, unknown> = { model: this.model, input };
      // API-param encodings (e.g. Voyage `input_type`) select the
      // query/document role via a top-level body field set per call.
      if (this.encoding.kind === "api-param") {
        body[this.encoding.param] =
          kind === "query" ? this.encoding.queryValue : this.encoding.documentValue;
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
      const deadline = AbortSignal.timeout(this.timeoutMs);
      const res = await retryRateLimitedRequest(
        () =>
          fetchWithInferenceUrlPolicy(
            url,
            {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: deadline,
            },
            { allowRemoteInference: this.allowRemoteInference },
          ),
        {
          signal: deadline,
          onRetry: ({ attempt, delayMs }) =>
            log.warn(
              `embedding rate-limited for model=${this.model}; ` +
                `retrying attempt ${attempt} after ${delayMs}ms`,
            ),
        },
      );
      if (!res.ok) {
        // Never put the upstream response body in the thrown/logged error: a
        // malicious or misconfigured backend can echo the submitted document
        // chunks back in its 4xx/5xx body, which would then persist in logs.
        // Drain the body (to free the socket) but report only non-sensitive
        // metadata. The one exception is a recognised, fixed overflow/malformed
        // marker (a server template phrase from our own pattern list, never a
        // slice of the body): appending it lets the resilient orchestrator
        // shrink-and-retry a token-window overflow instead of leaving the doc
        // permanently pending on an opaque 400.
        const body = await res.text().catch(() => "");
        const contentType = res.headers.get("content-type") ?? "?";
        const marker = embedErrorMarkerFromBody(body);
        throw new Error(
          `HTTP embedder ${res.status} (model=${this.model}, ${body.length} bytes, ${contentType})` +
            (marker ? ` [${marker}]` : ""),
        );
      }
      const json = (await res.json()) as EmbeddingResponse;
      if (!json.data || json.data.length !== input.length) {
        throw new Error(
          `HTTP embedder returned ${json.data?.length ?? 0} vectors for ${input.length} inputs`,
        );
      }
      const sorted = json.data.sort((a, b) => a.index - b.index);
      return sorted.map((d) => new Float32Array(d.embedding));
    } finally {
      if (background) this.releaseBackgroundSlot();
    }
  }
}

/**
 * Probe an OpenAI-compatible embedding server to discover the model name
 * and output dimension. Used for gateway boot readiness and model swaps when
 * `inference.assignments.embedder` resolves to an HTTP backend.
 */
export async function probeHttpEmbedder(
  baseUrl: string,
  configModel?: string,
  apiKey?: string,
  apiPathPrefix?: string,
  allowRemoteInference = false,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ model: string; dim: number }> {
  const base = baseUrl.replace(/\/+$/, "");
  const prefix = normalizeApiPathPrefix(apiPathPrefix);
  const authHeaders: Record<string, string> = {};
  if (apiKey) authHeaders["Authorization"] = `Bearer ${apiKey}`;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const requestSignal = (ms: number): AbortSignal => {
    const timeout = AbortSignal.timeout(ms);
    return opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  };

  let model = configModel ?? "";
  if (!model) {
    const res = await fetchWithInferenceUrlPolicy(
      `${base}${prefix}/models`,
      {
        signal: requestSignal(Math.min(timeoutMs, 10_000)),
        headers: authHeaders,
      },
      { allowRemoteInference },
    );
    if (!res.ok)
      throw new Error(`Failed to list models at ${base}${prefix}/models: HTTP ${res.status}`);
    const ids = extractModelIds(await res.json());
    if (!ids.length) throw new Error(`No models available at ${base}${prefix}/models`);
    // `/models` advertises only ids, never purpose — picking the first id binds
    // a chat/image model on any multi-model provider and the embeddings call
    // then fails. Filter to ids the name-heuristic recognizes as embedders.
    const embedders = ids.filter((id) => classifyModelRoles(id).includes("embedder"));
    if (embedders.length === 1) {
      model = embedders[0];
    } else if (embedders.length === 0) {
      throw new Error(
        `No embedding model found among ${ids.length} served model(s) at ${base}${prefix} ` +
          `— set the embedder model explicitly (assignment "<backend>/<model>").`,
      );
    } else {
      throw new Error(
        `Multiple embedding models served at ${base}${prefix} (${embedders.join(", ")}) ` +
          `— set the embedder model explicitly (assignment "<backend>/<model>").`,
      );
    }
    log.info(`Auto-discovered embedding model: ${model}`);
  }

  const probeRes = await fetchWithInferenceUrlPolicy(
    `${base}${prefix}/embeddings`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ model, input: ["dimension probe"] }),
      signal: requestSignal(timeoutMs),
    },
    { allowRemoteInference },
  );
  if (!probeRes.ok) {
    const body = await probeRes.text().catch(() => "");
    const contentType = probeRes.headers.get("content-type") ?? "unknown content type";
    throw new Error(
      `Embedding probe failed: HTTP ${probeRes.status} (${contentType}; ${Buffer.byteLength(body)} bytes)`,
    );
  }
  const probeJson = (await probeRes.json()) as EmbeddingResponse;
  const dim = probeJson.data?.[0]?.embedding?.length;
  if (!dim) throw new Error("Embedding probe returned no vector — is this an embedding model?");
  log.info(`Probed embedding dimension: ${dim} (model=${model})`);

  return { model, dim };
}
