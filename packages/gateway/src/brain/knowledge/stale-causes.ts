// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { knowledgeNodeStaleAncestors } from "./storage-fence.js";
import { getKnowledgeNode } from "./storage-read.js";
import type { KnowledgeNode } from "./types.js";
import type Database from "better-sqlite3";

/** How many changed records a stale page lists before summarising the rest. */
export const KNOWLEDGE_STALE_CAUSE_LIMIT = 10;

export type KnowledgeStaleCauseItem =
  | {
      kind: "source";
      id: string;
      /** Null when the document is gone. */
      title: string | null;
      sourceId: string | null;
      change: "changed" | "deleted";
    }
  | {
      kind: "node";
      id: string;
      /** Null when the page is no longer readable. */
      nodeKind: KnowledgeNode["kind"] | null;
      title: string | null;
      change: "changed" | "owner_changed";
    };

export interface KnowledgeStaleCauses {
  /** Changed records, sources first, at most {@link KNOWLEDGE_STALE_CAUSE_LIMIT}. */
  items: KnowledgeStaleCauseItem[];
  /** Every changed record found, including those past the limit. */
  total: number;
  /**
   * Why the page is stale beyond the records it reads: its owner was withdrawn,
   * or, when no record it reads changed, some of its claims wait for another
   * verification.
   */
  reason: "withdrawn" | "claims_pending" | null;
}

/**
 * Why a stale page needs another look: the sources and pages it reads that
 * changed since it was written, by the same rule that marks it stale.
 */
export function readKnowledgeStaleCauses(
  db: Database.Database,
  node: KnowledgeNode,
): KnowledgeStaleCauses {
  const ancestors = knowledgeNodeStaleAncestors(db, node.id, KNOWLEDGE_STALE_CAUSE_LIMIT);
  const document = db.prepare<[string], { title: string; source_id: string }>(
    "SELECT title,source_id FROM documents WHERE id=?",
  );
  const items = ancestors.items.map((ancestor): KnowledgeStaleCauseItem => {
    if (ancestor.kind === "source") {
      const row = ancestor.cause === "source_deleted" ? undefined : document.get(ancestor.id);
      return {
        kind: "source",
        id: ancestor.id,
        title: row?.title ?? null,
        sourceId: row?.source_id ?? null,
        change: row ? "changed" : "deleted",
      };
    }
    const upstream = ancestor.id === node.id ? node : getKnowledgeNode(db, ancestor.id);
    return {
      kind: "node",
      id: ancestor.id,
      nodeKind: upstream?.kind ?? null,
      title: upstream?.title ?? null,
      change: ancestor.cause === "owner_changed" ? "owner_changed" : "changed",
    };
  });
  return {
    items,
    total: ancestors.total,
    reason:
      node.canonicalFields.withdrawn === true
        ? "withdrawn"
        : ancestors.total > 0
          ? null
          : "claims_pending",
  };
}
