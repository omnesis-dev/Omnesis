// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { KnowledgeFrontierView } from "./engine.js";
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
    fetchRequired: {
      id: item.node?.id ?? item.source?.id ?? item.id,
      kind: item.node?.kind ?? "source",
      title: (item.node?.title ?? item.source?.title ?? "").slice(0, 200),
      revision: item.node?.revision ?? item.source?.contentHash ?? "",
      instruction:
        "Fetch the full node with knowledge_fetch(editing=true), or the source with fetch_many. Page knowledge_maintenance_inputs for this offered id to recover omitted input versions, including newly discovered sources; fetch their content before saving. Use knowledge_list for root orientation. Review only the listed pending claims when their list is bounded; later frontier calls expose the remainder.",
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
  while (compact.pendingClaimIds.length > 1 && JSON.stringify(compact).length > remaining) {
    compact.pendingClaimIds.pop();
    compact.pendingClaimIdsOmitted = true;
  }
  return JSON.stringify(compact).length <= remaining ? compact : null;
}
