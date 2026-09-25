// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How an embedder failure should be handled by the resilient orchestrator
 * (`resilient-embed.ts`):
 *  - `overflow`   — the input exceeds the model's token window; shrink and retry.
 *  - `malformed`  — the tokenizer rejected the bytes; the chunk is dropped.
 *  - `transient`  — timeout / network / server / unrecognised; leave the
 *                   document pending for a later retry.
 */
export type EmbedFailureKind = "overflow" | "malformed" | "transient";

/** Token-window overflow, across both embedder backends. */
const OVERFLOW_PATTERNS = [
  "maximum context length", // vLLM / OpenAI-compatible HTTP embedder
  "longer than the context size", // node-llama-cpp local embedder
];

/** Tokenizer rejected the input outright (control bytes, invalid sequences). */
const MALFORMED_PATTERNS = [
  "TextEncodeInput", // HF / Rust `tokenizers` backend
];

/**
 * Classify an embedder error so the resilient orchestrator can decide whether
 * to shrink-and-retry the input, drop the chunk, or leave the document pending.
 *
 * Only the two deterministic classes we know how to recover from are matched
 * explicitly. Everything else — timeouts, network and server (5xx) errors, and
 * anything unrecognised — is `transient`, so an unfamiliar failure never
 * silently drops content: the document is retried, exactly as before.
 */
export function classifyEmbedError(err: unknown): EmbedFailureKind {
  const msg = err instanceof Error ? err.message : String(err);
  if (OVERFLOW_PATTERNS.some((p) => msg.includes(p))) return "overflow";
  if (MALFORMED_PATTERNS.some((p) => msg.includes(p))) return "malformed";
  return "transient";
}

/**
 * Scan a raw embedder HTTP error body for a known overflow/malformed marker and
 * return the fixed, non-sensitive marker substring (a server-generated template
 * phrase from our own pattern lists — never a slice of the body itself).
 *
 * The HTTP embedder appends this marker to its thrown error so `classifyEmbedError`
 * can recognise a 4xx it would otherwise see as opaque, without echoing the
 * (possibly document-bearing) response body into logs. Returns `null` when the
 * body carries no recognised marker, so the error stays `transient`.
 */
export function embedErrorMarkerFromBody(body: string): string | null {
  return (
    OVERFLOW_PATTERNS.find((p) => body.includes(p)) ??
    MALFORMED_PATTERNS.find((p) => body.includes(p)) ??
    null
  );
}
