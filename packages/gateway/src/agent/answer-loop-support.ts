// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

const contextSchema = z.object({
  nodeId: z.string(),
  kind: z.literal("loop"),
  verifiedSupport: z
    .array(
      z.object({
        ref: z.string(),
        revision: z.union([z.string(), z.number()]),
        text: z.string(),
        interpretationContext: z.string().min(1).max(16_384),
      }),
    )
    .max(16),
});

/** Rebuild from the observed, freshness-checked details after any bounded repair.
 * Only selected assertions are witnesses; enclosing prose constrains interpretation. */
export function qualifiedLoopSupportFrames(loops: ReadonlyMap<string, string>): string[] {
  return [...loops].flatMap(([id, text]) => {
    const detail = z
      .object({ loopId: z.string(), knowledgeContext: contextSchema })
      .safeParse(JSON.parse(text));
    if (!detail.success || detail.data.loopId !== id || detail.data.knowledgeContext.nodeId !== id)
      return [];
    const support = detail.data.knowledgeContext.verifiedSupport;
    if (support.some((item) => !item.ref.startsWith(`loop:${id}#claim:`))) return [];
    if (!support.length) return [];
    return [
      JSON.stringify({
        sources: [],
        verifiedReferences: support.map(({ text, interpretationContext }) => ({
          text,
          interpretationContext,
        })),
        limitation:
          "Only these exact qualified assertions supply factual support within their stated modality, attribution, conditions and time. interpretationContext constrains each assertion but supplies no independent facts or witness segments. Other outcome prose, titles, priorities, open state and ledger entries remain system tracking, not proof of current real-world obligations or completion.",
      }),
    ];
  });
}
