// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  cognitionAuthoredDocumentTypes,
  cognitionAuthoredSqlExclusion,
} from "../cognition-authored.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery-policy.js";
import type Database from "better-sqlite3";

export interface DiscoveryPhaseCounts {
  considered: number;
  gated: number;
  deferred: number;
  failed: number;
  pending: number;
}
export interface KnowledgeDiscoveryMonth {
  month: string | null;
  interpretation: DiscoveryPhaseCounts;
  organization: DiscoveryPhaseCounts;
}
export interface KnowledgeDiscoveryTimeline {
  mode: "knowledge";
  months: KnowledgeDiscoveryMonth[];
  computedAt: number;
}

/** Full corpus scan: call only on the IO worker. Counts current readable indexed
 * generations, never provider history that has not reached this database. */
export function knowledgeDiscoveryByMonth(db: Database.Database): KnowledgeDiscoveryMonth[] {
  const exclusion = cognitionAuthoredSqlExclusion("d.source_id");
  const types = cognitionAuthoredDocumentTypes();
  const columns = db.prepare<[], { name: string }>("PRAGMA table_info(documents)").all();
  const typeFence =
    columns.some((column) => column.name === "metadata") && types.length
      ? `AND COALESCE(json_extract(d.metadata,'$.documentType'),'') NOT IN (${types.map(() => "?").join(",")})`
      : "";
  const removalFence = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='removed_sources' AND type='table'")
    .get()
    ? "AND NOT EXISTS(SELECT 1 FROM removed_sources s WHERE s.id=d.source_id)"
    : "";
  const rows = db
    .prepare<
      unknown[],
      {
        month: string | null;
        interpretation: keyof DiscoveryPhaseCounts;
        organization: keyof DiscoveryPhaseCounts;
        count: number;
      }
    >(
      `
    SELECT strftime('%Y-%m', d.source_created_at) AS month,
      COALESCE(i.status,'pending') AS interpretation, COALESCE(o.status,'pending') AS organization,
      COUNT(*) AS count
    FROM documents d
    LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id
    LEFT JOIN knowledge_discovery_coverage i ON i.subject_id=d.id AND i.input_revision=d.content_hash AND i.phase='interpretation' AND i.policy_version=?
    LEFT JOIN knowledge_discovery_coverage o ON o.subject_id=d.id AND o.input_revision=d.content_hash AND o.phase='organization' AND o.policy_version=?
    WHERE COALESCE(r.deleted,0)=0 AND ${exclusion.sql || "1"} ${typeFence} ${removalFence}
    GROUP BY month, interpretation, organization ORDER BY month IS NULL, month
  `,
    )
    .all(
      KNOWLEDGE_DISCOVERY_POLICY,
      KNOWLEDGE_DISCOVERY_POLICY,
      ...exclusion.params,
      ...(typeFence ? types : []),
    );
  const months = new Map<string | null, KnowledgeDiscoveryMonth>();
  const empty = (): DiscoveryPhaseCounts => ({
    considered: 0,
    gated: 0,
    deferred: 0,
    failed: 0,
    pending: 0,
  });
  for (const row of rows) {
    let month = months.get(row.month);
    if (!month) {
      month = { month: row.month, interpretation: empty(), organization: empty() };
      months.set(row.month, month);
    }
    const interpretation = Object.hasOwn(month.interpretation, row.interpretation)
      ? row.interpretation
      : "pending";
    const organization = Object.hasOwn(month.organization, row.organization)
      ? row.organization
      : "pending";
    month.interpretation[interpretation] += row.count;
    month.organization[organization] += row.count;
  }
  return [...months.values()];
}
