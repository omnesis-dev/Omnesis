// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/**
 * When the re-verification sweep last queued each annotation. NULL on existing
 * rows, which places them ahead of any row queued from now on.
 */
export function addAnnotationRecheckQueuedAt(db: Db): void {
  for (const table of ["doc_annotations", "person_annotations"]) {
    const columns = db.pragma(`table_info(${table})`) as { name: string }[];
    if (!columns.some((column) => column.name === "last_recheck_queued_at")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN last_recheck_queued_at INTEGER`);
    }
  }
}
