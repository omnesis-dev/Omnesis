// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;

import { linkStatsByTypeCodec } from "../json-columns.js";

export interface LinkStats {
  totalLinks: number;
  resolvedLinks: number;
  unresolvedLinks: number;
  byType: Record<string, { total: number; resolved: number }>;
}

export interface LinkStatsAggregation {
  totalLinks: number;
  resolvedLinks: number;
  byType: Record<string, { total: number; resolved: number }>;
  capturedVersion: number;
  skipped?: boolean;
}

export function computeLinkStats(db: Db): LinkStatsAggregation {
  db.exec("BEGIN");
  try {
    // OCC version + `needs_refresh` flag in one round-trip — both live
    // on the `refresh_meta` row for the link_graph job after the
    // collapse. `needs_refresh = 0` means a prior pass
    // already landed and no mutation has flipped the flag back, so we
    // can short-circuit and return a skipped aggregation rather than
    // pay the COUNT(*) over `document_links`.
    const stateRow = db
      .prepare<
        [],
        { dirty_version: number; needs_refresh: number }
      >("SELECT dirty_version, needs_refresh FROM refresh_meta WHERE job = 'link_graph'")
      .get();
    const capturedVersion = stateRow?.dirty_version ?? 0;
    if (stateRow && stateRow.needs_refresh === 0) {
      db.exec("COMMIT");
      return {
        totalLinks: 0,
        resolvedLinks: 0,
        byType: {},
        capturedVersion,
        skipped: true,
      };
    }

    const totalRow = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM document_links")
      .get();
    const resolvedRow = db
      .prepare<
        [],
        { count: number }
      >("SELECT COUNT(*) as count FROM document_links WHERE target_doc_id IS NOT NULL")
      .get();
    const byTypeRows = db
      .prepare<[], { link_type: string; total: number; resolved: number }>(
        `SELECT link_type,
                COUNT(*) as total,
                SUM(CASE WHEN target_doc_id IS NOT NULL THEN 1 ELSE 0 END) as resolved
         FROM document_links
         GROUP BY link_type`,
      )
      .all();
    db.exec("COMMIT");

    const byType: Record<string, { total: number; resolved: number }> = {};
    for (const row of byTypeRows) {
      byType[row.link_type] = { total: row.total, resolved: row.resolved };
    }

    return {
      totalLinks: totalRow?.count ?? 0,
      resolvedLinks: resolvedRow?.count ?? 0,
      byType,
      capturedVersion,
    };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already finalized */
    }
    throw err;
  }
}

export function upsertLinkStats(db: Db, agg: LinkStatsAggregation): { updated: number } {
  const now = Date.now();
  // Two-step atomic apply: first try to flip the OCC row (skip if
  // `dirty_version` moved while we were computing), then write the
  // data row. Wrapped in a transaction so the data write can't outlive
  // a refresh_meta skip. Pre-collapse the data + OCC lived in the same
  // row and a single `UPDATE … WHERE dirty_version = ?` was atomic by
  // construction; after the schema split the explicit transaction provides
  // the same guarantee.
  const tx = db.transaction((a: LinkStatsAggregation): { updated: number } => {
    const meta = db
      .prepare(
        `UPDATE refresh_meta
           SET last_computed_at = ?,
               last_computed_version = ?,
               needs_refresh = 0
         WHERE job = 'link_graph' AND dirty_version = ?`,
      )
      .run(now, a.capturedVersion, a.capturedVersion);
    if (meta.changes === 0) {
      return { updated: 0 };
    }
    db.prepare(
      `UPDATE link_stats
         SET total_links = ?,
             resolved_links = ?,
             by_type_json = ?,
             last_computed_at = ?
       WHERE id = 1`,
    ).run(a.totalLinks, a.resolvedLinks, linkStatsByTypeCodec.serialize(a.byType), now);
    return { updated: 1 };
  });
  return tx(agg);
}

/**
 * Read link stats from the trigger-maintained `link_stats_counters`
 * table. O(link_types) ≈ 5 rows, sub-millisecond. Falls back to the
 * materialized `link_stats` row if counters haven't been seeded yet
 * (pre-migration-12 DB that hasn't restarted).
 */
export function readLinkStatsFromCounters(db: Db): LinkStats {
  const rows = db
    .prepare<
      [],
      { link_type: string; total: number; resolved: number }
    >("SELECT link_type, total, resolved FROM link_stats_counters")
    .all();
  if (rows.length === 0) {
    return readMaterializedLinkStatsLegacy(db);
  }
  let totalLinks = 0;
  let resolvedLinks = 0;
  const byType: Record<string, { total: number; resolved: number }> = {};
  for (const r of rows) {
    totalLinks += r.total;
    resolvedLinks += r.resolved;
    byType[r.link_type] = { total: r.total, resolved: r.resolved };
  }
  return {
    totalLinks,
    resolvedLinks,
    unresolvedLinks: totalLinks - resolvedLinks,
    byType,
  };
}

/**
 * Reconcile trigger-maintained counters against a full table scan.
 * Corrects any drift and updates the materialized `link_stats` row.
 * Returns the number of counter rows that were corrected.
 */
export function reconcileLinkStatsCounters(db: Db): { corrected: number } {
  const actual = db
    .prepare<[], { link_type: string; total: number; resolved: number }>(
      `SELECT link_type, COUNT(*) AS total,
              SUM(CASE WHEN target_doc_id IS NOT NULL THEN 1 ELSE 0 END) AS resolved
       FROM document_links GROUP BY link_type`,
    )
    .all();
  let corrected = 0;
  for (const row of actual) {
    const { changes } = db
      .prepare(
        `INSERT INTO link_stats_counters (link_type, total, resolved) VALUES (?, ?, ?)
         ON CONFLICT(link_type) DO UPDATE SET total = excluded.total, resolved = excluded.resolved
         WHERE total != excluded.total OR resolved != excluded.resolved`,
      )
      .run(row.link_type, row.total, row.resolved);
    if (changes > 0) corrected++;
  }
  // Also update the materialized link_stats row for HTTP reads.
  const stats = readLinkStatsFromCounters(db);
  const now = Date.now();
  db.prepare(
    `UPDATE link_stats SET total_links = ?, resolved_links = ?, by_type_json = ?, last_computed_at = ? WHERE id = 1`,
  ).run(stats.totalLinks, stats.resolvedLinks, linkStatsByTypeCodec.serialize(stats.byType), now);
  // Clear needs_refresh so the reconciliation doesn't re-trigger immediately.
  db.prepare(
    "UPDATE refresh_meta SET needs_refresh = 0, last_computed_at = ? WHERE job = 'link_graph'",
  ).run(now);
  return { corrected };
}

function readMaterializedLinkStatsLegacy(db: Db): LinkStats {
  const row = db
    .prepare<
      [],
      {
        total_links: number;
        resolved_links: number;
        by_type_json: string;
        last_computed_at: number | null;
      }
    >(
      "SELECT total_links, resolved_links, by_type_json, last_computed_at FROM link_stats WHERE id = 1",
    )
    .get();
  if (!row || row.last_computed_at === null) {
    return { totalLinks: 0, resolvedLinks: 0, unresolvedLinks: 0, byType: {} };
  }
  const byType = linkStatsByTypeCodec.parseWithFallback(row.by_type_json);
  return {
    totalLinks: row.total_links,
    resolvedLinks: row.resolved_links,
    unresolvedLinks: row.total_links - row.resolved_links,
    byType,
  };
}

export function getLinkStats(db: Db): LinkStats {
  return readLinkStatsFromCounters(db);
}
