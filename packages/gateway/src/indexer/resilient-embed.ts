// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertNever } from "@omnesis/core";
import { classifyEmbedError, type EmbedFailureKind } from "./embed-failures.js";
import type { Embedder } from "./types.js";

/** Below this input length an overflowing chunk is dropped rather than shrunk further. */
const MIN_SHRINK_CHARS = 128;

/** Why a chunk was dropped from the index. */
export type DropReason = Exclude<EmbedFailureKind, "transient">;

export interface ResilientEmbedHooks {
  /** A chunk's input was shrunk to fit the model's token window before embedding. */
  onTruncate?: (index: number, finalChars: number, origChars: number) => void;
  /** A chunk could not be embedded and was dropped from the index. */
  onDrop?: (index: number, reason: DropReason, origChars: number) => void;
}

/**
 * Embed a document's chunk inputs with a guarantee of forward progress — the
 * single place embedder-failure recovery lives, uniform across both backends.
 *
 *  - Happy path: one batch `embed()` call; vectors returned unchanged.
 *  - Deterministic batch failure (overflow / malformed): the inputs are retried
 *    one at a time to isolate the offender(s) — this also de-poisons an HTTP
 *    batch where one bad input fails the whole request. An overflowing input is
 *    shrunk (halved, surrogate-safe) until it fits; a malformed input, or one
 *    that still overflows at the shrink floor, is dropped (`null`).
 *  - Transient failure (timeout, network, 5xx, anything unrecognised): rethrown,
 *    so the caller leaves the document pending for a later retry. Transient
 *    errors never drop content.
 *
 * Returns one entry per input, in order: a vector, or `null` for a dropped chunk.
 */
export async function embedChunksResilient(
  embedder: Embedder,
  inputs: string[],
  hooks?: ResilientEmbedHooks,
): Promise<Array<Float32Array | null>> {
  if (inputs.length === 0) return [];
  const vectors = await embedder.embed(inputs).catch((err: unknown): null => {
    // A transient batch failure leaves the document pending (rethrow). A
    // deterministic one falls through to per-input isolation below.
    if (classifyEmbedError(err) === "transient") throw err;
    return null;
  });
  // Use the batch result only if its length lines up with the positional
  // mapping the caller relies on; a misaligned return would silently drop
  // chunks, so isolate per-input instead (each chunk is then accounted for).
  if (vectors && vectors.length === inputs.length) return vectors;
  return Promise.all(inputs.map((input, i) => embedOne(embedder, input, i, hooks)));
}

async function embedOne(
  embedder: Embedder,
  input: string,
  index: number,
  hooks?: ResilientEmbedHooks,
): Promise<Float32Array | null> {
  const origChars = input.length;
  let current = input;
  let shrunk = false;
  for (;;) {
    try {
      const [vec] = await embedder.embed([current]);
      // A missing vector for a single input is a backend contract violation,
      // not a reason to silently drop the chunk — surface it for retry.
      if (!vec) throw new Error("embedder returned no vector for one input");
      if (shrunk) hooks?.onTruncate?.(index, current.length, origChars);
      return vec;
    } catch (err) {
      const kind = classifyEmbedError(err);
      switch (kind) {
        case "transient":
          throw err;
        case "malformed":
          hooks?.onDrop?.(index, "malformed", origChars);
          return null;
        case "overflow":
          // Shrink and retry, dropping only once we hit the floor.
          if (current.length <= MIN_SHRINK_CHARS) {
            hooks?.onDrop?.(index, "overflow", origChars);
            return null;
          }
          current = shrinkToHalf(current);
          shrunk = true;
          break;
        default:
          assertNever(kind);
      }
    }
  }
}

/** Halve a string without leaving a lone high surrogate at the cut. */
function shrinkToHalf(s: string): string {
  let end = Math.max(MIN_SHRINK_CHARS, Math.floor(s.length / 2));
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return s.slice(0, end);
}
