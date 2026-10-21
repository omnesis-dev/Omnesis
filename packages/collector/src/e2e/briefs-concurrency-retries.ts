// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isDeepStrictEqual } from "node:util";
import type { ExecutedTool } from "./brain-bench/obs.js";

function hits(step: ExecutedTool | undefined): Array<{ id: string; title: string }> | null {
  const rows = step?.result?.kind === "structured" ? step.result.data?.loops : null;
  if (!Array.isArray(rows)) return null;
  if (rows.some((row) => !row || typeof row.id !== "string" || typeof row.title !== "string"))
    return null;
  return rows;
}

/** Prove a collection-CAS refusal was followed by a fresh read and identical successful create. */
export function verifiedCollectionCreateRetries(steps: readonly ExecutedTool[]): Set<number> {
  const verified = new Set<number>();
  for (const [index, step] of steps.entries()) {
    if (
      step.tool !== "open_loop_create" ||
      step.result?.kind !== "error" ||
      step.result.code !== "revision_conflict" ||
      !step.result.message?.startsWith(
        "The reconciled collection changed or its read receipt is missing: loop.",
      )
    )
      continue;
    const initial = steps.slice(0, index).findLast((item) => item.tool === "open_loop_search");
    const initialHits = hits(initial);
    const limit = initial?.args.limit ?? 8;
    if (
      !initialHits ||
      typeof initial?.args.query !== "string" ||
      typeof step.args.title !== "string" ||
      typeof limit !== "number" ||
      initialHits.length >= limit ||
      initialHits.some((row) => row.title === step.args.title) ||
      steps
        .slice(steps.indexOf(initial) + 1, index)
        .some((item) =>
          [
            "open_loop_create",
            "open_loop_update",
            "open_loop_ledger_append",
            "open_loop_delete",
          ].includes(item.tool),
        )
    )
      continue;
    let cursor = index;
    while (cursor < steps.length) {
      const next = steps.findIndex((item, i) => i > cursor && item.tool === "open_loop_create");
      if (next < 0 || !isDeepStrictEqual(steps[next]!.args, step.args)) break;
      const between = steps.slice(cursor + 1, next);
      const reread = between.findLast((item) => item.tool === "open_loop_search");
      const refreshedHits = hits(reread);
      if (
        !isDeepStrictEqual(reread?.args, initial.args) ||
        !refreshedHits ||
        refreshedHits.length >= limit ||
        refreshedHits.some((row) => row.title === step.args.title) ||
        between.some((item) =>
          ["open_loop_update", "open_loop_ledger_append", "open_loop_delete"].includes(item.tool),
        )
      )
        break;
      const result = steps[next]!.result;
      const loop = result?.data?.loop;
      if (
        result?.kind === "structured" &&
        loop !== null &&
        typeof loop === "object" &&
        "id" in loop &&
        typeof loop.id === "string" &&
        "title" in loop &&
        loop.title === step.args.title
      ) {
        verified.add(index);
        break;
      }
      if (
        result?.kind !== "error" ||
        result.code !== "revision_conflict" ||
        result.message !== step.result.message
      )
        break;
      cursor = next;
    }
  }
  return verified;
}

/**
 * Failed-create ordinals within ONE attempt that demonstrably lost a concurrent
 * create race and adopted its winner. This is an expected CAS retry, not a
 * malformed call. Missing reads, stale-owner writes and unrecovered conflicts
 * remain errors. Raw refusal counts/evidence always retain these calls too.
 */
export function verifiedConcurrentCreateRetries(
  steps: readonly ExecutedTool[],
  /** Sole winners created by another run of a deliberately concurrent fixture. */
  permittedWinnerIds: ReadonlySet<string>,
): Set<number> {
  const verified = new Set<number>();
  let failedCreateOrdinal = 0;
  for (const [index, step] of steps.entries()) {
    if (step.tool !== "open_loop_create" || step.result?.kind !== "error") continue;
    const ordinal = failedCreateOrdinal++;
    const title = step.args.title;
    if (
      typeof title !== "string" ||
      step.result.code !== "revision_conflict" ||
      !step.result.message?.startsWith(
        "The reconciled collection changed or its read receipt is missing: loop.",
      )
    )
      continue;
    const initialIndex = steps
      .slice(0, index)
      .findLastIndex((item) => item.tool === "open_loop_search");
    const initial = steps[initialIndex];
    if (
      steps
        .slice(initialIndex + 1, index)
        .some((item) =>
          ["open_loop_create", "open_loop_update", "open_loop_ledger_append"].includes(item.tool),
        )
    )
      continue;
    const initialHits = hits(initial);
    const limit = initial?.args.limit ?? 8;
    // A full page might have omitted an existing owner; do not call that a race.
    if (
      !initialHits ||
      typeof limit !== "number" ||
      initialHits.length >= limit ||
      initialHits.some((row) => row.title === title)
    )
      continue;
    const retryIndex = steps.findIndex((item, i) => i > index && item.tool === "open_loop_search");
    if (retryIndex < 0) continue;
    const retry = steps[retryIndex]!;
    if (typeof initial?.args.query !== "string" || !isDeepStrictEqual(retry.args, initial.args))
      continue;
    const winners = hits(retry)?.filter((row) => row.title === title);
    if (winners?.length !== 1) continue;
    const winner = winners[0]!;
    if (!permittedWinnerIds.has(winner.id)) continue;
    if (initialHits.some((row) => row.id === winner.id)) continue;
    // Any successful duplicate in this attempt invalidates the classification.
    if (
      steps.some(
        (item) =>
          item.tool === "open_loop_create" &&
          item.args.title === title &&
          item.result?.kind === "structured",
      )
    )
      continue;
    const adoption = steps
      .slice(retryIndex + 1)
      .find(
        (item) =>
          ["open_loop_ledger_append", "open_loop_update"].includes(item.tool) &&
          item.args.id === winner.id,
      );
    const fetched = steps
      .slice(retryIndex + 1)
      .find(
        (item) =>
          item.tool === "open_loop_fetch" &&
          item.args.id === winner.id &&
          item.result?.kind === "structured" &&
          item.result.data?.id === winner.id &&
          item.result.data?.title === title,
      );
    const routed =
      fetched &&
      steps
        .slice(steps.indexOf(fetched) + 1)
        .some(
          (item) =>
            item.tool === "knowledge_discovery_complete" &&
            typeof item.args.id === "string" &&
            item.args.id.startsWith("source:") &&
            Array.isArray(step.args.docs) &&
            step.args.docs.includes(item.args.id.slice(7)) &&
            typeof item.args.inputFingerprint === "string" &&
            item.args.inputFingerprint.length > 0 &&
            Array.isArray(item.args.targets) &&
            item.args.targets.includes(winner.id) &&
            item.result?.kind === "structured",
        );
    if (adoption?.result?.kind === "structured" || routed) verified.add(ordinal);
  }
  return verified;
}
