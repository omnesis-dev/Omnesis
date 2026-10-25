// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
import type { KnowledgeNode } from "./types.js";

/**
 * Observations are short-lived notes for the morning brief. A closed one, or
 * one whose window has passed, is historical: it keeps its prose and privacy
 * obligations but is never reviewed again.
 */
export function historicalObservationFields(fields: Record<string, unknown>, now: number): boolean {
  const state = fields.state;
  return (
    (typeof state === "string" && (state === "shipped" || state === "dropped")) ||
    (typeof fields.relevantUntil === "number" && fields.relevantUntil <= now)
  );
}

/**
 * Canonical retirement is authoritative even while its readable mirror is
 * catching up. Observations are never repaired by synthesis: the morning
 * brief recheck drops or rescores them when their evidence moves, so
 * maintenance settles them without a model turn.
 */
export function isHistoricalKnowledgeOwner(
  db: Database.Database,
  node: Pick<KnowledgeNode, "id" | "ownerId" | "kind" | "canonicalFields">,
  _now: number,
): boolean {
  if (node.kind === "observation") return true;
  if (node.kind === "loop") {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('open_loops','retired_loops')",
      )
      .all();
    if (tables.length !== 2) return false;
    const id = node.ownerId ?? node.id;
    // Resolution can retain both rows. Only archival removal makes the owner
    // immutable; an ordinary done/dismissed loop can still be corrected.
    return (
      !db.prepare("SELECT 1 FROM open_loops WHERE id=?").get(id) &&
      !!db.prepare("SELECT 1 FROM retired_loops WHERE id=?").get(id)
    );
  }
  const table =
    node.kind === "doc_annotation"
      ? "doc_annotations"
      : node.kind === "person_annotation"
        ? "person_annotations"
        : null;
  if (!table) return false;
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const owner = exists
    ? db
        .prepare<
          [string],
          { invalidatedAt: number | null; supersededBy: string | null }
        >(`SELECT invalidated_at AS invalidatedAt,superseded_by AS supersededBy FROM ${table} WHERE id=?`)
        .get(node.ownerId ?? node.id)
    : undefined;
  // Missing owners alone are not evidence of retirement. Explicit historical
  // snapshots survive intentional owner withdrawal, without becoming editable.
  if (!owner) return node.canonicalFields.withdrawn === true;
  return owner.invalidatedAt !== null || owner.supersededBy !== null;
}
