// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-model retrieval encoding for embedding models (#718).
 *
 * Embedding models express query/document asymmetry in one of three ways,
 * captured by the `EmbedderEncoding` union:
 *
 *   - `text-prefix` — the model is trained with a leading instruction that the
 *     caller prepends to the text itself (nomic, bge/mxbai, e5, qwen). This is
 *     the open-model contract; detection is family-based (see below).
 *   - `api-param` — the asymmetry is a request field, not text. The same
 *     embedder sends e.g. `input_type: "query"` vs `input_type: "document"` as
 *     a top-level body field per call (Voyage). Only HTTP embedders can carry
 *     this; local GGUF embedders treat it as a no-op.
 *   - `none` — the model is symmetric: query and document are embedded
 *     identically (OpenAI, Mistral, Gemini via the OpenAI-compat shim). This is
 *     ALSO the safe default for any model we don't recognise — embedding an
 *     unknown model symmetrically on both sides can never corrupt retrieval,
 *     whereas gluing a guessed prefix onto it would.
 *
 * Family detection (for the `text-prefix` branch) is by lowercase prefix of the
 * model id OR its basename (the segment after the final `/`, so org-prefixed
 * aggregator ids like `BAAI/bge-large-en-v1.5` still match):
 *   - `nomic*`  → prefix BOTH sides (search_query / search_document).
 *   - `bge*`    → query-side only (doc side trained on raw text).
 *   - `mxbai*`  → query-side only (same contract as BGE).
 *   - `multilingual-e5*` or `e5*` → prefix BOTH sides (query: / passage:).
 *   - `qwen*`   → query-side instruction only (asymmetric; doc side raw).
 *   - anything else → `unknown` → `none` encoding (symmetric, safe fallback).
 *
 * Symmetric-default rule: a model whose family is `unknown` and whose provider
 * has no api-param contract resolves to `none`. Never apply a prefix or param
 * we aren't sure of.
 *
 * Some providers (native Gemini's `taskType`, Cohere's `input_type`) are
 * asymmetric but do NOT ride the OpenAI-compatible `{ model, input, …param }`
 * body shape, so they need a separate non-OpenAI client and are out of scope
 * here; see #718.
 *
 * Changing the document-side encoding for an already-indexed corpus puts the
 * corpus and future queries into different embedding spaces and silently tanks
 * recall, so any change requires rebuilding the vector index (resync or wipe
 * `index.db`). The family-aware path is gated by `search.embedderPrefixes.enabled`
 * (default `false`, which preserves the legacy nomic-style prefixes for
 * un-reindexed installs); flip it on and reindex on the same operator action.
 */

export type EmbedderFamily = "nomic" | "bge" | "mxbai" | "e5" | "qwen" | "unknown";

/**
 * How a single embedder encodes the query/document distinction (#718).
 *
 *   - `none` — symmetric; embed both sides identically.
 *   - `text-prefix` — prepend `query`/`document` to the text before embedding.
 *   - `api-param` — set a top-level request field `param` to `queryValue` on
 *     the query path and `documentValue` on the document path.
 */
export type EmbedderEncoding =
  | { kind: "none" }
  | { kind: "text-prefix"; query: string; document: string }
  | { kind: "api-param"; param: string; queryValue: string; documentValue: string };

/** Symmetric no-op encoding — the safe default. */
export const NO_ENCODING: EmbedderEncoding = { kind: "none" };

export interface EmbedderPrefixes {
  /** Prefix prepended to query text before embedding. */
  query: string;
  /** Prefix prepended to document text before embedding. */
  document: string;
}

/** No-op prefixes — used when the feature is disabled or the family is unknown. */
export const NO_EMBEDDER_PREFIXES: EmbedderPrefixes = { query: "", document: "" };

/**
 * Detect the embedder family from a model id. Matching is by lowercase
 * `startsWith` so each model in a family (e.g. `bge-small-en-v1.5`,
 * `bge-large-en-v1.5`) maps to the same family without enumerating ids.
 *
 * Cloud aggregators (Together, Fireworks, …) serve org-prefixed ids such as
 * `BAAI/bge-large-en-v1.5`, `nomic-ai/nomic-embed-text-v1.5`, or
 * `Qwen/Qwen3-Embedding-0.6B`. `startsWith` on the full id would miss `bge`
 * (the id starts with `baai/`), so detection runs against BOTH the full id
 * and its basename (the segment after the final `/`).
 *
 * Returns `unknown` for undefined / empty strings and for any id that
 * doesn't match a known family — callers will then get the symmetric no-op.
 */
export function detectEmbedderFamily(modelId: string | undefined): EmbedderFamily {
  if (!modelId) return "unknown";
  const lower = modelId.toLowerCase();
  const basename = lower.slice(lower.lastIndexOf("/") + 1);
  const matches = (prefix: string): boolean =>
    lower.startsWith(prefix) || basename.startsWith(prefix);
  if (matches("nomic")) return "nomic";
  if (matches("bge")) return "bge";
  if (matches("mxbai")) return "mxbai";
  if (matches("qwen")) return "qwen";
  if (matches("multilingual-e5") || matches("e5")) {
    return lower.includes("instruct") ? "unknown" : "e5";
  }
  return "unknown";
}

/**
 * Look up the family-appropriate prefixes. Use the family produced by
 * `detectEmbedderFamily(modelId)` — splitting detection from lookup
 * keeps both pieces independently testable.
 */
export function getEmbedderPrefixes(family: EmbedderFamily): EmbedderPrefixes {
  switch (family) {
    case "nomic":
      return { query: "search_query: ", document: "search_document: " };
    case "bge":
    case "mxbai":
      return {
        query: "Represent this sentence for searching relevant passages: ",
        document: "",
      };
    case "e5":
      return { query: "query: ", document: "passage: " };
    case "qwen":
      // Qwen3-Embedding is asymmetric: the query carries a one-line task
      // instruction, the document is embedded raw. Format per the model card:
      // `Instruct: {task}\nQuery: {query}`.
      return {
        query:
          "Instruct: Given a search query, retrieve relevant documents that answer it\nQuery: ",
        document: "",
      };
    case "unknown":
      return NO_EMBEDDER_PREFIXES;
  }
}

/**
 * Resolve the retrieval encoding for an embedder (#718). Family-first: a
 * recognised open-model family carries its text-prefix regardless of which
 * provider serves it (an aggregator serving nomic still needs nomic's
 * prefixes, applied caller-side). Provider only matters as the api-param
 * fallback for symmetric-on-the-text-but-asymmetric-on-the-wire models.
 *
 * Resolution order:
 *   1. Known family → `text-prefix` (from `getEmbedderPrefixes`).
 *   2. else provider `voyage` → `api-param` (`input_type` query/document).
 *   3. else → `none` (symmetric — OpenAI, Mistral, Gemini-via-OpenAI-shim,
 *      and every unrecognised model). Gluing a guessed encoding onto an
 *      unknown model would corrupt retrieval; symmetric is the safe default.
 *
 * Gemini through the OpenAI-compat shim (`…/v1beta/openai/embeddings`) is
 * intentionally `none`: empirically the shim rejects `task_type` / `taskType`
 * / `extra_body` with HTTP 400. True query/document asymmetry on Gemini needs
 * the native `embedContent` API via a separate non-OpenAI client (#718).
 */
export function resolveEmbedderEncoding(args: {
  /** Served model name (HTTP probe) or local catalogId. */
  modelId: string | undefined;
  /** Backend provider brand id ("openai" | "google" | "voyage" | …). Undefined for raw local/vLLM. */
  providerId?: string;
}): EmbedderEncoding {
  const family = detectEmbedderFamily(args.modelId);
  if (family !== "unknown") {
    const prefixes = getEmbedderPrefixes(family);
    return { kind: "text-prefix", query: prefixes.query, document: prefixes.document };
  }
  if (args.providerId === "voyage") {
    return {
      kind: "api-param",
      param: "input_type",
      queryValue: "query",
      documentValue: "document",
    };
  }
  return NO_ENCODING;
}
