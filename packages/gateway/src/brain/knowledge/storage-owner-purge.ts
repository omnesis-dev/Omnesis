// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { deleteOpenLoop } from "../storage/open-loops.js";
import { deleteObservationsAttachedToLoops } from "../storage/observations.js";
import { deleteDocAnnotation } from "../storage/annotations.js";
import { deletePersonAnnotation } from "../storage/person-annotations.js";
import type Database from "better-sqlite3";
import type { KnowledgeNodeKind } from "./types.js";

/** Remove canonical plaintext projections too, including legacy mirrors and retirement traces. */
export function purgeKnowledgeOwner(
  db: Database.Database,
  kind: KnowledgeNodeKind,
  ownerId: string | null,
): void {
  if (!ownerId) return;
  if (kind === "loop") {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='open_loops'").get())
      return;
    deleteObservationsAttachedToLoops(db, [ownerId], { includeClosed: true });
    deleteOpenLoop(db, ownerId, { retire: false });
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retired_loops'").get())
      db.prepare("DELETE FROM retired_loops WHERE id=?").run(ownerId);
    // Preserve corpus mirror IDs until mirror.remove can delete their index chunks.
    // Immediate owner read fences hide them while bounded cleanup is pending.
  } else if (kind === "observation") {
    db.prepare("DELETE FROM observations WHERE id=?").run(ownerId);
  } else if (kind === "doc_annotation") {
    deleteDocAnnotation(db, ownerId);
  } else if (kind === "person_annotation") {
    deletePersonAnnotation(db, ownerId);
  }
}
