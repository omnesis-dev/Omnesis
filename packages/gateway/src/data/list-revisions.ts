// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

export type MutableListRevisionScope =
  | "product-loops"
  | "cognition-coverage"
  | "cognition-runs"
  | "link-declarations";

const SCOPES: readonly MutableListRevisionScope[] = [
  "product-loops",
  "cognition-coverage",
  "cognition-runs",
];

/**
 * Install exact, surface-local mutation counters for lists whose sort keys can
 * change between keyset pages. A global database revision is intentionally not
 * used: an unrelated sync-state or document write must not invalidate a page
 * walk and trap a busy client in restart loops.
 */
export function installMutableListRevisions(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mutable_list_revisions (
      scope TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0
    )
  `);

  const seed = db.prepare(
    "INSERT OR IGNORE INTO mutable_list_revisions (scope, revision) VALUES (?, 0)",
  );
  for (const scope of SCOPES) seed.run(scope);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mutable_list_product_loops_insert
      AFTER INSERT ON open_loops BEGIN
        UPDATE mutable_list_revisions SET revision = revision + 1 WHERE scope = 'product-loops';
      END;
    CREATE TRIGGER IF NOT EXISTS mutable_list_product_loops_update
      AFTER UPDATE ON open_loops BEGIN
        UPDATE mutable_list_revisions SET revision = revision + 1 WHERE scope = 'product-loops';
      END;
    CREATE TRIGGER IF NOT EXISTS mutable_list_product_loops_delete
      AFTER DELETE ON open_loops BEGIN
        UPDATE mutable_list_revisions SET revision = revision + 1 WHERE scope = 'product-loops';
      END;

    CREATE TRIGGER IF NOT EXISTS mutable_list_cognition_coverage_insert
      AFTER INSERT ON cognition_coverage BEGIN
        UPDATE mutable_list_revisions SET revision = revision + 1
          WHERE scope = 'cognition-coverage';
      END;
    CREATE TRIGGER IF NOT EXISTS mutable_list_cognition_coverage_update
      AFTER UPDATE ON cognition_coverage BEGIN
        UPDATE mutable_list_revisions SET revision = revision + 1
          WHERE scope = 'cognition-coverage';
      END;
    CREATE TRIGGER IF NOT EXISTS mutable_list_cognition_coverage_delete
      AFTER DELETE ON cognition_coverage BEGIN
        UPDATE mutable_list_revisions SET revision = revision + 1
          WHERE scope = 'cognition-coverage';
      END;

    CREATE TRIGGER IF NOT EXISTS mutable_list_cognition_runs_insert
      AFTER INSERT ON cognition_runs BEGIN
        UPDATE mutable_list_revisions SET revision = revision + 1 WHERE scope = 'cognition-runs';
      END;
    CREATE TRIGGER IF NOT EXISTS mutable_list_cognition_runs_update
      AFTER UPDATE ON cognition_runs BEGIN
        UPDATE mutable_list_revisions SET revision = revision + 1 WHERE scope = 'cognition-runs';
      END;
    CREATE TRIGGER IF NOT EXISTS mutable_list_cognition_runs_delete
      AFTER DELETE ON cognition_runs BEGIN
        UPDATE mutable_list_revisions SET revision = revision + 1 WHERE scope = 'cognition-runs';
      END;

  `);
}

/** Install the collector-membership fence introduced by schema migration 139. */
export function installCollectorRosterRevision(db: Db): void {
  db.prepare(
    "INSERT OR IGNORE INTO mutable_list_revisions (scope, revision) VALUES ('link-declarations', 0)",
  ).run();
  // A crash can leave the seqlock odd after the process-local registry changed
  // but before publication. Registries restart empty, so completing that
  // abandoned epoch during startup is conservative and restores liveness.
  db.prepare(
    `UPDATE mutable_list_revisions SET revision = revision + 1
      WHERE scope = 'link-declarations' AND revision % 2 = 1`,
  ).run();
  const deviceColumns = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
    .all()
    .map((row) => row.name);
  // Startup schema setup also runs against databases that have not replayed
  // migration 131 yet. Migration 139 calls this installer again after
  // `revoked_at` exists, so deferring the index/triggers here is safe.
  if (!deviceColumns.includes("revoked_at")) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_devices_active_collectors
      ON devices(id) WHERE kind = 'collector' AND revoked_at IS NULL;
    CREATE TRIGGER IF NOT EXISTS mutable_list_collector_roster_insert
      AFTER INSERT ON devices
      WHEN NEW.kind = 'collector' AND NEW.revoked_at IS NULL BEGIN
        UPDATE mutable_list_revisions SET revision = revision + 2
          WHERE scope = 'link-declarations';
      END;
    CREATE TRIGGER IF NOT EXISTS mutable_list_collector_roster_delete
      AFTER DELETE ON devices
      WHEN OLD.kind = 'collector' AND OLD.revoked_at IS NULL BEGIN
        UPDATE mutable_list_revisions SET revision = revision + 2
          WHERE scope = 'link-declarations';
      END;
    CREATE TRIGGER IF NOT EXISTS mutable_list_collector_roster_update
      AFTER UPDATE OF kind, revoked_at ON devices
      WHEN (OLD.kind = 'collector' AND OLD.revoked_at IS NULL)
        IS NOT (NEW.kind = 'collector' AND NEW.revoked_at IS NULL) BEGIN
        UPDATE mutable_list_revisions SET revision = revision + 2
          WHERE scope = 'link-declarations';
      END;
  `);
}

/** Enter the odd revision used while process-local URL declarations change. */
export function beginLinkDeclarationUpdate(db: Db): number {
  const row = db
    .prepare<[], { revision: number }>(
      `UPDATE mutable_list_revisions SET revision = revision + 1
        WHERE scope = 'link-declarations' AND revision % 2 = 0
        RETURNING revision`,
    )
    .get();
  if (!row) throw new Error("link declaration update already in progress");
  return row.revision;
}

/** Publish the stable even revision after process-local declarations change. */
export function finishLinkDeclarationUpdate(db: Db): number {
  const row = db
    .prepare<[], { revision: number }>(
      `UPDATE mutable_list_revisions SET revision = revision + 1
        WHERE scope = 'link-declarations' AND revision % 2 = 1
        RETURNING revision`,
    )
    .get();
  if (!row) throw new Error("no link declaration update is in progress");
  return row.revision;
}

export function mutableListRevision(db: Db, scope: MutableListRevisionScope): number {
  return db
    .prepare<
      [MutableListRevisionScope],
      { revision: number }
    >("SELECT revision FROM mutable_list_revisions WHERE scope = ?")
    .get(scope)!.revision;
}
