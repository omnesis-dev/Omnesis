// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ClaimSpan, ParsedClaimMarkup } from "./claims.js";

/**
 * Structural coverage is independent of entailment. Requiring every nonblank
 * span to be tagged avoids guessing which untagged sentence asserts a fact.
 * This says nothing about whether a tagged assertion is true or supported.
 */
export function uncoveredKnowledgeSpans(parsed: ParsedClaimMarkup): ClaimSpan[] {
  const claims = parsed.claims
    .filter((claim) => claim.parentId === null)
    .sort((a, b) => a.textSpan.start - b.textSpan.start);
  const gaps: ClaimSpan[] = [];
  let cursor = 0;
  const gap = (end: number) => {
    if (parsed.text.slice(cursor, end).trim()) gaps.push({ start: cursor, end });
  };
  for (const claim of claims) {
    gap(claim.textSpan.start);
    cursor = claim.textSpan.end;
  }
  gap(parsed.text.length);
  return gaps;
}
