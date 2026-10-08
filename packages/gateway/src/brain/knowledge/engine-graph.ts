// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { MaintenancePlanLimitError, type MaintenanceArc } from "./planner.js";
import type Database from "better-sqlite3";

/** Indexed adjacency, never a materialized copy of the whole brain graph. */
export class KnowledgeGraph {
  constructor(
    private readonly db: Database.Database,
    private readonly bound: () => number,
  ) {}
  page(input: string, after: string, limit: number): MaintenanceArc[] {
    const source = input.startsWith("source:");
    const id = source ? input.slice(7) : input;
    const rows = this.db
      .prepare<[string, string, string, string, string, number], { dependent: string }>(
        `
      SELECT dependent FROM (
        SELECT node_id AS dependent FROM knowledge_dependencies
          WHERE target_kind=? AND target_id=? AND relation!='context'
        UNION SELECT node_id AS dependent FROM knowledge_operational_arcs WHERE input_id=?
        UNION SELECT t.node_id AS dependent FROM knowledge_discovery_targets t
          JOIN documents d ON d.id=t.source_id AND d.content_hash=t.source_revision WHERE t.source_id=?
      ) WHERE dependent>? ORDER BY dependent LIMIT ?`,
      )
      .all(source ? "source" : "node", id, source ? "" : id, source ? id : "", after, limit);
    return rows.map((row) => ({ input, dependent: row.dependent }));
  }
  arcs(input: string): MaintenanceArc[] {
    const max = this.bound();
    const rows = this.page(input, "", max + 1);
    if (rows.length > max) throw new MaintenancePlanLimitError("region");
    return rows;
  }
}
