// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/**
 * Two facts a source declares about itself, each stored beside the declaration
 * it belongs to.
 *
 * `source_document_profiles.output_revision` is the source version a published
 * profile describes. Existing rows take 0, the value a publication without a
 * version counts as, so the next publish from any collector replaces them.
 *
 * `source_family_meta.resync_cost` is the source's own sentence about what
 * reading it again from the start costs. NULL until a collector that declares
 * one pushes its family meta.
 */
export function addSourceVersionDeclarations(db: Db): void {
  const has = (table: string, column: string): boolean =>
    (db.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);
  if (!has("source_document_profiles", "output_revision")) {
    db.exec(
      "ALTER TABLE source_document_profiles ADD COLUMN output_revision INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!has("source_family_meta", "resync_cost")) {
    db.exec("ALTER TABLE source_family_meta ADD COLUMN resync_cost TEXT");
  }
}
