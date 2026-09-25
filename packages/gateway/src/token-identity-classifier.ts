// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Token identity classification — labels high-spread email-local tokens as
 * `personal_name` / `role_generic` / `ambiguous` using the model assigned to
 * the `agent` role, so it works with a local GGUF, an OpenAI-compatible HTTP
 * backend, or a cloud API without knowing which.
 *
 * The verdict is the veto half of merge-candidate role-mailbox suppression
 * (see `domain/MergeCandidateDetector.ts`): a token confirmed `personal_name`
 * can never trigger suppression, so a widely-shared family surname — which
 * spreads across many domains exactly like a role word — is protected.
 *
 * Prompt + parse are pure and unit-tested; `classifyTokens` is the thin async
 * batching wrapper around a {@link CompleteCapability}.
 */

import { createLogger, type CompleteCapability } from "@omnesis/core";
import type { TokenLabel } from "./domain/MergeCandidateDetector.js";

const log = createLogger("gateway:token-classifier");

/** Tokens classified per model call. Small enough that even a 1.5B local
 *  model returns a clean line-per-token list. */
export const TOKEN_CLASSIFY_BATCH = 40;

const VALID_LABELS: ReadonlySet<string> = new Set(["personal_name", "role_generic", "ambiguous"]);

/**
 * Build the classification prompt. Asks for one `token: label` line per
 * token — a line format is more robust on small local models than JSON.
 */
export function buildClassifyPrompt(tokens: readonly string[]): string {
  return [
    "You label word-tokens taken from the local-part of email addresses (the part before the @ sign).",
    "For EACH token below, output exactly one line in the form `token: label`.",
    "label must be one of:",
    "- personal_name : a human given name or family/surname, ANY language or origin (e.g. nakamura, rossi, amelia, okafor). Also compound name-like locals (e.g. mariadiaz).",
    "- role_generic : a functional/role mailbox word, common noun, department, system/automated word, language code, or place name (e.g. reservations, info, billing, enquiries, repondre, recrutement, customer, support, paris, noreply, unsubscribe).",
    "- ambiguous : genuinely could be either a name or a common word.",
    "Output only the lines — one per token, nothing else.",
    "",
    "Tokens:",
    ...tokens,
  ].join("\n");
}

/**
 * Parse a model response into a token → label map. Tolerant of bullets,
 * numbering, surrounding prose, and trailing explanations after the label.
 * Only tokens that were requested and labels in the valid set are kept.
 */
export function parseClassifyResponse(
  text: string,
  requested: readonly string[],
): Map<string, TokenLabel> {
  const want = new Set(requested.map((t) => t.toLowerCase()));
  const out = new Map<string, TokenLabel>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    // Strip list markers ("- ", "1. ", "* ") from the token side.
    const token = line
      .slice(0, idx)
      .trim()
      .replace(/^[-*\d.\s]+/, "")
      .toLowerCase();
    // Take the first word of the label side (tolerate "role_generic (a …)").
    const label = line
      .slice(idx + 1)
      .trim()
      .toLowerCase()
      .split(/[\s,(]/)[0];
    if (!want.has(token)) continue;
    if (VALID_LABELS.has(label)) out.set(token, label as TokenLabel);
  }
  return out;
}

/**
 * Classify a list of tokens in batches. Any token the model omits or labels
 * unparseably is returned as `ambiguous` so it is recorded (and not re-sent
 * every cycle) while neither suppressing nor vetoing. A failed batch is
 * skipped — its tokens stay unlabeled and are retried next pass.
 */
export async function classifyTokens(
  provider: CompleteCapability,
  tokens: readonly string[],
  batchSize: number = TOKEN_CLASSIFY_BATCH,
): Promise<Map<string, TokenLabel>> {
  const result = new Map<string, TokenLabel>();
  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);
    let text: string;
    try {
      text = await provider.complete(buildClassifyPrompt(batch), {
        maxTokens: batch.length * 12 + 64,
        temperature: 0,
      });
    } catch (err) {
      log.warn(
        `token classification batch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const parsed = parseClassifyResponse(text, batch);
    for (const t of batch) {
      result.set(t, parsed.get(t) ?? "ambiguous");
    }
  }
  return result;
}
