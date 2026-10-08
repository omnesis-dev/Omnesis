// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
import type { KnowledgeNode } from "./types.js";

/** Historical attention snapshots retain their prose, provenance and privacy obligations. */
export function historicalBriefFields(fields: Record<string, unknown>, now: number): boolean {
  const state = fields.state;
  return (
    (typeof state === "string" &&
      (state.startsWith("dismissed_") || ["retired", "archived", "expired"].includes(state))) ||
    (typeof fields.relevantUntil === "number" && fields.relevantUntil <= now)
  );
}

/** Read the canonical lifecycle even before the owner reconciliation queue catches up. */
export function isHistoricalKnowledgeBrief(
  db: Database.Database,
  node: Pick<KnowledgeNode, "id" | "ownerId" | "kind" | "canonicalFields">,
  now: number,
): boolean {
  if (node.kind !== "brief") return false;
  const hasBriefs = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='briefs'")
    .get();
  const owner = hasBriefs
    ? db
        .prepare<
          [string],
          { state: string; relevantUntil: number | null }
        >("SELECT state,relevant_until AS relevantUntil FROM briefs WHERE id=?")
        .get(node.ownerId ?? node.id)
    : undefined;
  return historicalBriefFields(owner ?? node.canonicalFields, now);
}
