// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

/** One indexed cohort removal per cascade step; each has at most eight members and 32 targets. */
export function purgeNextOrganizationCohort(
  db: Database.Database,
  targetId: string,
  kind: "source" | "node" = "source",
): boolean {
  const row = db
    .prepare<
      [string],
      { cohort_id: string }
    >(kind === "source" ? "SELECT cohort_id FROM knowledge_organization_members WHERE source_id=? LIMIT 1" : "SELECT cohort_id FROM knowledge_organization_targets WHERE node_id=? LIMIT 1")
    .get(targetId);
  if (!row) return false;
  // The whole organization disposition loses its provenance when either a
  // member or a linked synthesis target is erased.
  db.prepare("DELETE FROM knowledge_organization_cohorts WHERE id=?").run(row.cohort_id);
  db.prepare("DELETE FROM knowledge_organization_members WHERE cohort_id=?").run(row.cohort_id);
  db.prepare("DELETE FROM knowledge_organization_targets WHERE cohort_id=?").run(row.cohort_id);
  return true;
}
