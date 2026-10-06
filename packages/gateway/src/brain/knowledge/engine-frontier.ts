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
        "Fetch the full node with knowledge_fetch(editing=true), or the source with fetch_many. Resolve current evidence references before saving. Use knowledge_list for root orientation.",
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
  return JSON.stringify(compact).length <= remaining ? compact : null;
}
