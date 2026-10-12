// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hasSourceInventoryTables } from "../../data/repositories/SourceInventoryRepository.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery-policy.js";
import { knowledgeSourceRevisionSql } from "./source-revision.js";
import { knowledgeWorkParkedSql } from "./work-retry.js";
import type Database from "better-sqlite3";

/**
 * Coverage of the explicitly observed import, never a claim about unseen provider history.
 * Revisions dated before the history horizon floor (`notBefore`) form their own
 * `beyond-horizon` window: review never admits them, so they are out of scope
 * rather than pending.
 */
export function readKnowledgeInventoryStatus(
  db: Database.Database,
  recentWindowMs: number,
  notBefore: string,
) {
  if (!hasSourceInventoryTables(db)) return [];
  return db
    .prepare<
      [string, number, string],
      {
        sourceId: string;
        inventoryId: string;
        cursorRow: string;
        startedAt: string;
        firstReceivedAt: number;
        observedAt: number;
        completedAt: number | null;
        window: string;
        phase: "interpretation" | "organization";
        observed: number;
        considered: number;
        gated: number;
        deferred: number;
        failed: number;
        pending: number;
        /** Observed revisions whose maintenance is parked until the source changes. */
        parked: number;
        earliestSourceDate: string | null;
        latestSourceDate: string | null;
      }
    >(
      `WITH inventory AS (
    SELECT i.*, d.id AS document_id,d.source_created_at,c.status,ph.phase,
      CASE WHEN d.id IS NULL THEN 'empty'
        WHEN julianday(d.source_created_at) IS NULL THEN 'undated'
        WHEN d.source_created_at<? THEN 'beyond-horizon'
        WHEN julianday(d.source_created_at)>=julianday(i.first_received_at/1000.0,'unixepoch')-? THEN 'recent' ELSE 'history' END AS window,
      EXISTS(SELECT 1 FROM knowledge_work w WHERE w.subject_kind='source' AND w.subject_id=d.id AND w.input_revision=${knowledgeSourceRevisionSql()} AND w.status IN ('pending','batched')) AS pending,
      ${knowledgeWorkParkedSql("'source'", "d.id", knowledgeSourceRevisionSql())} AS parked
    FROM source_inventories i
    CROSS JOIN (SELECT 'interpretation' AS phase UNION ALL SELECT 'organization') ph
    LEFT JOIN source_inventory_documents si ON si.inventory_id=i.id
    LEFT JOIN documents d ON d.id=si.document_id AND d.content_hash=si.input_revision
    LEFT JOIN knowledge_discovery_coverage c ON c.subject_id=d.id AND c.input_revision=${knowledgeSourceRevisionSql()} AND c.phase=ph.phase AND c.policy_version=?
    WHERE NOT EXISTS(SELECT 1 FROM removed_sources r WHERE r.id=i.source_id)
  ) SELECT source_id AS sourceId,id AS inventoryId,cursor_row AS cursorRow,started_at AS startedAt,
    first_received_at AS firstReceivedAt,observed_at AS observedAt,completed_at AS completedAt,window,phase,COUNT(document_id) AS observed,
    COALESCE(SUM(status='considered'),0) AS considered,COALESCE(SUM(status='gated'),0) AS gated,
    COALESCE(SUM(status='deferred'),0) AS deferred,COALESCE(SUM(status='failed'),0) AS failed,
    SUM(pending) AS pending,SUM(parked) AS parked,MIN(source_created_at) AS earliestSourceDate,MAX(source_created_at) AS latestSourceDate
    FROM inventory GROUP BY id,window,phase ORDER BY source_id,started_at DESC,window,phase`,
    )
    .all(notBefore, recentWindowMs / 86_400_000, KNOWLEDGE_DISCOVERY_POLICY)
    .map((row) => ({
      ...row,
      importState: row.completedAt === null ? "importing" : "complete",
      // Beyond the horizon, what was never reviewed is out of scope, not owed.
      unconsidered:
        row.window === "beyond-horizon"
          ? 0
          : Math.max(0, row.observed - row.considered - row.gated),
      outOfScope:
        row.window === "beyond-horizon"
          ? Math.max(0, row.observed - row.considered - row.gated)
          : 0,
      coverageScope: "observed-inventory-revisions",
    }));
}
