// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseClaimMarkup } from "@omnesis/gateway/src/brain/knowledge/claims.js";
import { uncoveredKnowledgeSpans } from "@omnesis/gateway/src/brain/knowledge/coverage.js";

/** Fixture preservation is explicit unsupported context, never newly discovered evidence. */
export function coverLegacyProse(markdown: string) {
  const parsed = parseClaimMarkup(markdown);
  if (!uncoveredKnowledgeSpans(parsed).length)
    return { markdown, addedClaims: [] as Array<{ id: string; epistemicStatus: "unsupported" }> };
  const ids = new Set(parsed.claims.map((claim) => claim.id));
  let serial = 0;
  while (ids.has(`legacy-context-${serial}`)) serial++;
  const id = `legacy-context-${serial}`;
  return {
    markdown: `<claim id="${id}" refs="">${markdown}</claim>`,
    addedClaims: [{ id, epistemicStatus: "unsupported" as const }],
  };
}
