// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { capabilityToRule, getLevelCapabilities } from "./store-rules.js";
import type { Db } from "../data/types.js";
import type { AccessLevelSummary } from "./types.js";

export interface AccessLevelRow {
  id: string;
  name: string;
  revision: number;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

/** A live connection: a live grant under a live interactive principal. */
const LIVE_MEMBER = `g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > ?)
  AND p.kind = 'interactive' AND p.revoked_at IS NULL`;

export function getLiveLevelRow(db: Db, levelId: string): AccessLevelRow | null {
  return (
    db
      .prepare<
        [string],
        AccessLevelRow
      >("SELECT * FROM access_levels WHERE id = ? AND revoked_at IS NULL")
      .get(levelId) ?? null
  );
}

/** The live grants that carry a level's rules, through the level index. */
export function liveLevelMemberGrantIds(db: Db, levelId: string, now: number): string[] {
  return db
    .prepare<[string, number], { id: string }>(
      `SELECT g.id FROM access_grants g
         JOIN access_principals p ON p.id = g.principal_id
        WHERE g.level_id = ? AND ${LIVE_MEMBER}
        ORDER BY g.created_at, g.id`,
    )
    .all(levelId, now)
    .map((row) => row.id);
}

type LevelDevice = AccessLevelSummary["devices"][number];

/**
 * The unrevoked devices on each level, keyed by level; `levelId` narrows it to
 * one. A database without device bindings — an access store built on its own —
 * has none.
 */
export function liveLevelDevices(db: Db, levelId?: string): Map<string, LevelDevice[]> {
  const byLevel = new Map<string, LevelDevice[]>();
  const bound = db
    .prepare<
      [],
      { present: number }
    >("SELECT 1 AS present FROM pragma_table_info('devices') WHERE name = 'access_level_id'")
    .get();
  if (!bound) return byLevel;
  const rows = db
    .prepare<[string | null, string | null], LevelDevice & { level_id: string }>(
      `SELECT access_level_id AS level_id, id, name, kind FROM devices
        WHERE access_level_id IS NOT NULL AND revoked_at IS NULL
          AND (? IS NULL OR access_level_id = ?)
        ORDER BY name COLLATE NOCASE, id`,
    )
    .all(levelId ?? null, levelId ?? null);
  for (const row of rows) {
    const devices = byLevel.get(row.level_id) ?? [];
    devices.push({ id: row.id, name: row.name, kind: row.kind });
    byLevel.set(row.level_id, devices);
  }
  return byLevel;
}

export function loadAccessLevelSummary(
  db: Db,
  levelId: string,
  now: number,
): AccessLevelSummary | null {
  const row = getLiveLevelRow(db, levelId);
  return row
    ? summaryFromRow(
        db,
        row,
        liveLevelMemberGrantIds(db, levelId, now).length,
        liveLevelDevices(db, levelId).get(levelId) ?? [],
      )
    : null;
}

/** Every live level, sorted by name without regard to case. */
export function listAccessLevels(db: Db, now: number): AccessLevelSummary[] {
  const counts = new Map(
    db
      .prepare<[number], { level_id: string; connections: number }>(
        `SELECT g.level_id, COUNT(*) AS connections FROM access_grants g
           JOIN access_principals p ON p.id = g.principal_id
          WHERE g.level_id IS NOT NULL AND ${LIVE_MEMBER}
          GROUP BY g.level_id`,
      )
      .all(now)
      .map((row) => [row.level_id, row.connections]),
  );
  const devices = liveLevelDevices(db);
  return db
    .prepare<[], AccessLevelRow>("SELECT * FROM access_levels WHERE revoked_at IS NULL")
    .all()
    .map((row) => summaryFromRow(db, row, counts.get(row.id) ?? 0, devices.get(row.id) ?? []))
    .sort((left, right) => {
      const byName = left.name.toLowerCase().localeCompare(right.name.toLowerCase());
      return byName !== 0 ? byName : left.id.localeCompare(right.id);
    });
}

function summaryFromRow(
  db: Db,
  row: AccessLevelRow,
  connectionCount: number,
  devices: LevelDevice[],
): AccessLevelSummary {
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    rules: getLevelCapabilities(db, row.id).map(capabilityToRule),
    connectionCount,
    devices,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
