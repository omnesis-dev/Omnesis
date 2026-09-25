// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Content hash for the capture content plane.
 *
 * Drives two decisions:
 *   - it is the `contentHash` field on the pushed `web-page` document, and
 *   - it gates re-extraction: the capture engine re-pushes a page only when
 *     its extracted-text hash differs from the last hash pushed for that
 *     normalized URL, so a live dashboard / infinite-scroll feed mutating the
 *     DOM doesn't churn the corpus.
 *
 * SHA-256 hex via the Web Crypto `crypto.subtle` API — present in the content
 * script, the MV3 service worker, AND Node (so the same code is unit-tested
 * under Node). It is byte-for-byte identical to the gateway's
 * `computeContentHash` (`@omnesis/core`, `node:crypto` SHA-256 hex), so the
 * extension's hash and the gateway's agree — important because the gateway
 * uses `contentHash` to decide whether an upsert is a no-op.
 *
 * `crypto.subtle.digest` is async; the capture state machine is built around
 * an async hasher so this is not a problem.
 */
export async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
