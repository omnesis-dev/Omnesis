// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { KnowledgeFrontierView } from "./engine.js";
// Eight complete reads plus individual settlements leave room for synthesis and repair
// within the background tool budget. This caps presentation, not batch membership.
export const MAX_SOURCE_FRONTIER_ITEMS = 8;
// Reserved for the run-local sourceRead status and a MAX_SAFE_INTEGER offset.
export const SOURCE_READ_PROGRESS_CHARS = 96;

/** A settled source frontier can still owe an explicit joint organization decision. */
export function knowledgeFrontierPreflight(
  frontier: Pick<
    KnowledgeFrontierView,
    "done" | "items" | "organization" | "continuation" | "candidateDecisions"
  >,
): "complete" | "continue" | "yield" | "defer" {
  if (frontier.done) return "complete";
  if (
    frontier.items.length ||
    frontier.organization?.readyToComplete ||
    frontier.candidateDecisions?.length
  )
    return "continue";
  return frontier.continuation ? "yield" : "defer";
}

type Item = KnowledgeFrontierView["items"][number];

/** Never return incomplete claim markup as if it were a complete editable node. */
export function fitKnowledgeFrontierItem(
  item: Item,
  remaining: number,
  first: boolean,
): Item | null {
  if (JSON.stringify(item).length <= remaining) return item;
  if (!first) return null;
  const compact: Item = {
    id: item.id,
    inputFingerprint: item.inputFingerprint,
    pendingClaimIds: [...item.pendingClaimIds],
    inputVersions: {},
    inputVersionsOmitted: true,
    depth: item.depth,
    review: item.review,
    maintenanceGoal: item.maintenanceGoal,
    maintenanceTask: item.maintenanceTask,
    completionRequirements: item.completionRequirements,
    ...(item.recoverableNavigation
      ? {
          recoverableNavigation: {
            ...item.recoverableNavigation,
            candidates: [...item.recoverableNavigation.candidates],
          },
        }
      : {}),
    fetchRequired: {
      id: item.node?.id ?? item.source?.id ?? item.id,
      kind: item.node?.kind ?? "source",
      title: (item.node?.title ?? item.source?.title ?? "").slice(0, 200),
      revision: item.node?.revision ?? item.source?.sourceRevision ?? "",
      instruction:
        "Fetch the full node with knowledge_fetch(editing=true), or the source with fetch_many. Page knowledge_maintenance_inputs for this offered id to recover omitted input versions, including newly discovered sources; fetch their content before saving. Use knowledge_list for root orientation. Read the whole page for orientation or curation; settle only the listed pending claims when their list is bounded. Later frontier calls expose the remainder, and the maintenance goal never expands mutation authority.",
    },
    ...(item.source
      ? {
          source: {
            ...item.source,
            title: item.source.title.slice(0, 200),
            content: item.source.content.slice(0, 512),
          },
        }
      : {}),
  };
  while (
    compact.recoverableNavigation?.candidates.length &&
    JSON.stringify(compact).length > remaining
  ) {
    compact.recoverableNavigation.candidates.pop();
    compact.recoverableNavigation.incomplete = true;
  }
  while (compact.pendingClaimIds.length > 1 && JSON.stringify(compact).length > remaining) {
    compact.pendingClaimIds.pop();
    compact.pendingClaimIdsOmitted = true;
  }
  return JSON.stringify(compact).length <= remaining ? compact : null;
}

/** Decision debt stays durable when only a bounded prefix can be presented. */
export function fitCandidateDecisions(
  frontier: KnowledgeFrontierView,
  maxChars: number,
): KnowledgeFrontierView {
  if (!frontier.candidateDecisions?.length) return frontier;
  const result = { ...frontier, candidateDecisions: [...frontier.candidateDecisions] };
  while (
    result.candidateDecisions.length &&
    JSON.stringify({ kind: "structured", resultType: "knowledge_next_frontier", data: result })
      .length > maxChars
  )
    result.candidateDecisions.pop();
  return result;
}
