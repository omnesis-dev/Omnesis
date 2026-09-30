// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Decision cassettes — recorded typed decisions, replayable with no network.
 *
 * A cassette is a `.jsonl` file of {@link DecisionCassetteEntry} lines. Each
 * entry pairs the request that was sent with the answers that came back,
 * keyed by {@link decisionFingerprint}: a hash of the request's canonical JSON
 * (object keys sorted), over `state` and `questions` only. The model id is left
 * out on purpose, so a cassette recorded against `jev-1.13.0` replays under
 * the `replay` assignment, and a recorded decision stays valid when only the
 * pinned version moves.
 *
 * The gateway's replay backend, the test decision server and the recorder
 * script all hash through this module, so a request fingerprinted anywhere
 * matches everywhere.
 */

import { createHash } from "node:crypto";
import type { DecisionAnswer, DecisionRequest } from "./decision.js";

export interface DecisionCassetteEntry {
  /** `sha256:<hex>` of the canonical request; see {@link decisionFingerprint}. */
  readonly fp: string;
  /** The request as sent, kept so a miss can be diagnosed by diffing. */
  readonly request: DecisionRequest;
  readonly response: {
    readonly model: string;
    readonly answers: Readonly<Record<string, DecisionAnswer>>;
    readonly inputTokens?: number;
  };
}

/** JSON with object keys sorted at every depth; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Stable identity of a decision request, independent of the model id. */
export function decisionFingerprint(request: DecisionRequest): string {
  const canonical = canonicalJson({ state: request.state, questions: request.questions });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Parse cassette text into a fingerprint → entry map. Blank lines are
 * skipped; a malformed line throws with its line number, because a cassette
 * that silently drops entries turns into unexplained misses.
 */
export function parseDecisionCassette(
  text: string,
  source = "cassette",
): Map<string, DecisionCassetteEntry> {
  const entries = new Map<string, DecisionCassetteEntry>();
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`${source}:${index + 1}: not valid JSON`);
    }
    const entry = parsed as Partial<DecisionCassetteEntry>;
    if (
      typeof entry.fp !== "string" ||
      !entry.request ||
      !entry.response ||
      typeof entry.response.model !== "string" ||
      !entry.response.answers
    ) {
      throw new Error(`${source}:${index + 1}: expected {fp, request, response:{model, answers}}`);
    }
    const expected = decisionFingerprint(entry.request);
    if (expected !== entry.fp) {
      throw new Error(
        `${source}:${index + 1}: fp does not match its request (expected ${expected})`,
      );
    }
    entries.set(entry.fp, entry as DecisionCassetteEntry);
  });
  return entries;
}

/** Serialize one entry as a cassette line (no trailing newline). */
export function formatDecisionCassetteEntry(
  request: DecisionRequest,
  response: DecisionCassetteEntry["response"],
): string {
  const entry: DecisionCassetteEntry = { fp: decisionFingerprint(request), request, response };
  return JSON.stringify(entry);
}
