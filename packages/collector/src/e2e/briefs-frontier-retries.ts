// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ExecutedTool } from "./brain-bench/obs.js";

const itemSchema = z.object({
  id: z.string(),
  inputFingerprint: z.string().min(1),
  inputVersions: z.record(z.string(), z.union([z.string(), z.number()])),
  node: z.object({ revision: z.number() }).nullable().optional(),
});
const frontierSchema = z.object({
  batchId: z.string(),
  done: z.boolean(),
  continuation: z.boolean().optional(),
  interrupted: z.boolean().optional(),
  items: z.array(itemSchema),
});
const saveSchema = z.object({
  inputFingerprint: z.string(),
  node: z.object({
    id: z.string(),
    expectedRevision: z.number(),
    inputVersions: z.record(z.string(), z.union([z.string(), z.number()])),
  }),
});
const savedSchema = z.object({ node: z.object({ id: z.string(), revision: z.number() }) });
function savedNode(step: ExecutedTool, item: z.infer<typeof itemSchema>): boolean {
  if (step.result?.kind !== "structured" || step.result.resultType !== "knowledge_save")
    return false;
  const saved = savedSchema.safeParse(step.result.data);
  return (
    saved.success &&
    saved.data.node.id === item.id &&
    item.node !== null &&
    item.node !== undefined &&
    saved.data.node.revision > item.node.revision
  );
}
function frontier(step: ExecutedTool | undefined) {
  return frontierSchema.safeParse(
    step?.tool === "knowledge_next_frontier" && step.result?.kind === "structured"
      ? step.result.data
      : null,
  );
}
function matches(args: unknown, item: z.infer<typeof itemSchema>): boolean {
  const save = saveSchema.safeParse(args);
  return (
    save.success &&
    save.data.node.id === item.id &&
    save.data.inputFingerprint === item.inputFingerprint &&
    save.data.node.expectedRevision === item.node?.revision &&
    isDeepStrictEqual(save.data.node.inputVersions, item.inputVersions)
  );
}

/** Failed-save ordinals with a complete observed stale-frontier recovery, never generic CAS exemptions. */
export function verifiedFrontierRetries(steps: readonly ExecutedTool[]): Set<number> {
  const verified = new Set<number>();
  let ordinal = 0;
  for (const [index, step] of steps.entries()) {
    if (step.tool !== "knowledge_save" || step.result?.kind !== "error") continue;
    const current = ordinal++;
    if (
      step.result.code !== "revision_conflict" ||
      step.result.message !== "Frontier inputs changed; request the next frontier again"
    )
      continue;
    const before = frontier(
      steps.slice(0, index).findLast((entry) => entry.tool === "knowledge_next_frontier"),
    );
    if (!before.success || before.data.done || before.data.interrupted) continue;
    const offered = before.data.items.find((item) => matches(step.args, item));
    if (!offered) continue;
    let retryIndex = steps.findIndex(
      (entry, i) => i > index && entry.tool === "knowledge_next_frontier",
    );
    let retry = frontier(steps[retryIndex]);
    let continued = false;
    // A bounded engine pass may only replace a stale offer, returning an empty
    // continuation before the next pass offers its refreshed version.
    while (
      retry.success &&
      retry.data.batchId === before.data.batchId &&
      !retry.data.done &&
      !retry.data.interrupted &&
      retry.data.continuation === true &&
      retry.data.items.length === 0
    ) {
      continued = true;
      retryIndex = steps.findIndex(
        (entry, i) => i > retryIndex && entry.tool === "knowledge_next_frontier",
      );
      retry = frontier(steps[retryIndex]);
    }
    if (
      !retry.success ||
      retry.data.batchId !== before.data.batchId ||
      retry.data.done ||
      retry.data.interrupted ||
      // Only consecutive frontier requests prove this continuation protocol;
      // an intervening write must not gain an exemption from the empty reads.
      (continued &&
        steps
          .slice(index + 1, retryIndex)
          .some((entry) => entry.tool !== "knowledge_next_frontier"))
    )
      continue;
    const fresh = retry.data.items.find(
      (item) => item.id === offered.id && item.inputFingerprint !== offered.inputFingerprint,
    );
    if (!fresh) continue;
    const nextFrontier = steps.findIndex(
      (entry, i) => i > retryIndex && entry.tool === "knowledge_next_frontier",
    );
    if (nextFrontier < 0) continue;
    const saved = steps
      .slice(retryIndex + 1, nextFrontier)
      .some(
        (entry) =>
          entry.tool === "knowledge_save" && savedNode(entry, fresh) && matches(entry.args, fresh),
      );
    const complete = steps.slice(nextFrontier).some((entry) => {
      const parsed = frontier(entry);
      return (
        parsed.success &&
        parsed.data.batchId === before.data.batchId &&
        parsed.data.done &&
        !parsed.data.interrupted
      );
    });
    if (saved && complete) verified.add(current);
  }
  return verified;
}
