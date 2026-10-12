// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { loopDetailSchema } from "@omnesis/core";
import { z } from "zod";
import type { LoopReadPort } from "@omnesis/agent";

export type LoopFreshnessFailure =
  | "loop_unavailable"
  | "loop_malformed"
  | "loop_proof"
  | "loop_associations"
  | "loop_revision_regressed"
  | "loop_packet_budget";

export interface AnswerLoopSnapshot {
  details: ReadonlyMap<string, string>;
}

const projectedLoopContext = z.object({
  nodeId: z.string(),
  kind: z.literal("loop"),
  revision: z.number().int().positive(),
  validity: z.string(),
  guidance: z.string(),
  verifiedSupport: z.array(z.unknown()),
  provenance: z.record(z.string(), z.unknown()),
  navigation: z.record(z.string(), z.unknown()),
});

/** Storage-only projection revisions do not change support authority. Preserve
 * every other exported field, including unknown future fields and nested versions.
 */
function contextAuthority(value: unknown, id: string): unknown {
  const parsed = projectedLoopContext.safeParse(value);
  if (!parsed.success || parsed.data.nodeId !== id) return value;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.revision;
  return copy;
}

/** New tracking state is usable only for the same bounded, still-accessible records.
 * This grants no source reads or new proof closure; the caller must explicitly
 * present any changed snapshot to repair and recheck every non-loop authority.
 */
export async function readAnswerLoopSnapshot(
  original: AnswerLoopSnapshot,
  port: LoopReadPort | undefined,
  signal: AbortSignal,
  maxBytes: number,
  onRefusal?: (category: LoopFreshnessFailure) => void,
): Promise<{ changed: boolean; snapshot: AnswerLoopSnapshot } | null> {
  if (!original.details.size) return { changed: false, snapshot: original };
  const refuse = (category: LoopFreshnessFailure): null => {
    onRefusal?.(category);
    return null;
  };
  if (!port) return refuse("loop_unavailable");
  let bytes = 0;
  let changed = false;
  const details = new Map<string, string>();
  for (const [id, observed] of original.details) {
    signal.throwIfAborted();
    const current = await port.fetch(id, signal);
    signal.throwIfAborted();
    if (!current) return refuse("loop_unavailable");
    if (current.loopId !== id || !loopDetailSchema.safeParse(current).success)
      return refuse("loop_malformed");
    const previous = loopDetailSchema.safeParse(JSON.parse(observed));
    if (!previous.success) return refuse("loop_malformed");
    const oldContext = projectedLoopContext.safeParse(previous.data.knowledgeContext);
    const newContext = projectedLoopContext.safeParse(current.knowledgeContext);
    if (
      oldContext.success &&
      newContext.success &&
      oldContext.data.nodeId === id &&
      newContext.data.nodeId === id &&
      newContext.data.revision < oldContext.data.revision
    )
      return refuse("loop_revision_regressed");
    // No new source association, qualified proof, or related-record membership.
    // Those require an ordinary agent read, not a system-state-only refresh.
    if (
      JSON.stringify(contextAuthority(current.knowledgeContext, id)) !==
      JSON.stringify(contextAuthority(previous.data.knowledgeContext, id))
    )
      return refuse("loop_proof");
    for (const key of ["docIds", "relatedLoops"] as const)
      if (JSON.stringify(current[key]) !== JSON.stringify(previous.data[key]))
        return refuse("loop_associations");
    const text = JSON.stringify(current);
    bytes += Buffer.byteLength(text);
    if (bytes > maxBytes) return refuse("loop_packet_budget");
    if (text !== observed) changed = true;
    details.set(id, text);
  }
  return { changed, snapshot: { details } };
}

export class AnswerLoopChanged extends Error {
  constructor(readonly snapshot: AnswerLoopSnapshot) {
    super("evidence_changed");
  }
}
