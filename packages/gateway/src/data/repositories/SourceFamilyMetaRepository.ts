// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { sourceTypeOf } from "@omnesis/types";
import { retryOnBusy } from "../retry.js";
import { sourcePrefixPredicate } from "../source-addressing.js";
import type { SourceFamilyMeta, SourceMetaEntry } from "@omnesis/source-sdk";

/**
 * A source family's declared display identity.
 *
 * The family is what a client shows when it groups a corpus by type rather
 * than by account. It is declared by the source's definition and pushed
 * alongside each account's own identity, never assembled from an account:
 * two accounts of one type legitimately carry different labels and icons, so
 * a family copied from either is named after one of its members — and for a
 * source that labels each connection by institution, that publishes one
 * account's institution as the family's name.
 */
export function setSourceFamilyMeta(db: Db, sourceType: string, meta: SourceFamilyMeta): void {
  // Every column is COALESCEd, so a push that omits a field leaves the stored
  // one alone, matching how a source's own meta is written. A source declaring
  // a family with no fields at all writes nothing rather than an empty row.
  //
  // A family's identity is declared in code, so every sync page of every
  // account of that type pushes the same four values. The conflict arm's
  // WHERE makes the repeat a no-op page instead of a writer-thread write:
  // it fires only when the merged row would actually differ from the stored
  // one (`IS NOT` is SQLite's null-safe comparison).
  if (!meta.icon && !meta.label && !meta.bgColor && !meta.accentColor) return;
  retryOnBusy(
    () =>
      db
        .prepare(
          `INSERT INTO source_family_meta
             (source_type, icon, label, bg_color, accent_color, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_type) DO UPDATE SET
             icon = COALESCE(excluded.icon, source_family_meta.icon),
             label = COALESCE(excluded.label, source_family_meta.label),
             bg_color = COALESCE(excluded.bg_color, source_family_meta.bg_color),
             accent_color = COALESCE(excluded.accent_color, source_family_meta.accent_color),
             updated_at = excluded.updated_at
           WHERE COALESCE(excluded.icon, source_family_meta.icon) IS NOT source_family_meta.icon
              OR COALESCE(excluded.label, source_family_meta.label) IS NOT source_family_meta.label
              OR COALESCE(excluded.bg_color, source_family_meta.bg_color)
                   IS NOT source_family_meta.bg_color
              OR COALESCE(excluded.accent_color, source_family_meta.accent_color)
                   IS NOT source_family_meta.accent_color`,
        )
        .run(
          sourceType,
          meta.icon ?? null,
          meta.label ?? null,
          meta.bgColor ?? null,
          meta.accentColor ?? null,
          new Date().toISOString(),
        ),
    { op: "setSourceFamilyMeta" },
  );
}

/** Every declared family identity, keyed by source type. */
export function getSourceFamilyMeta(db: Db): Record<string, SourceMetaEntry> {
  const rows = db
    .prepare<
      [],
      {
        source_type: string;
        icon: string | null;
        label: string | null;
        bg_color: string | null;
        accent_color: string | null;
      }
    >(`SELECT source_type, icon, label, bg_color, accent_color FROM source_family_meta`)
    .all();
  const out: Record<string, SourceMetaEntry> = {};
  for (const row of rows) {
    const entry: SourceMetaEntry = {};
    if (row.icon) entry.icon = row.icon;
    if (row.label) entry.label = row.label;
    if (row.bg_color) entry.bgColor = row.bg_color;
    if (row.accent_color) entry.accentColor = row.accent_color;
    if (entry.icon || entry.label || entry.bgColor || entry.accentColor)
      out[row.source_type] = entry;
  }
  return out;
}

/**
 * Drop a family's declaration once nothing of that type is left.
 *
 * Called after a source is removed. A family whose last account is gone would
 * otherwise keep answering lookups for a type the install no longer hosts —
 * harmless to a client that only asks about live sources, but it is stale
 * state served on a public route, and nothing else would ever remove it.
 */
export function pruneSourceFamilyMeta(db: Db, sourceId: string): void {
  const sourceType = sourceTypeOf(sourceId);
  // `sources` is the register of accounts; `sync_state` is a cursor table and
  // holds a row only once an account has synced. An account added a minute ago
  // and not yet authorised has none — so asking the cursor table whether the
  // family still has members answers "no" for a family that plainly does, and
  // takes its icon and label away from the account that is still there.
  const addressed = sourcePrefixPredicate("id", [sourceType]);
  const survivor = db
    .prepare<unknown[], { id: string }>(`SELECT id FROM sources WHERE ${addressed.sql} LIMIT 1`)
    .get(...addressed.params);
  if (survivor) return;
  db.prepare("DELETE FROM source_family_meta WHERE source_type = ?").run(sourceType);
}
