// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KNOWLEDGE_SOURCE_ID } from "../brain/knowledge/source-meta.js";
import { OPEN_LOOP_SOURCE_ID } from "../brain/open-loop-source/source-meta.js";
import { labFeatureEnabled } from "./store.js";
import type Database from "better-sqlite3";

/** Task projections share the Knowledge source with ordinary maintained pages. */
export function taskDocumentHidden(db: Database.Database, documentId: string): boolean {
  if (labFeatureEnabled(db, "tasks")) return false;
  return (
    db
      .prepare<[string, string, string], { hidden: number }>(
        `
    SELECT 1 AS hidden FROM documents d
    WHERE d.id = ? AND (
      d.source_id = ? OR
      (d.source_id = ? AND EXISTS (
        SELECT 1 FROM knowledge_nodes n WHERE n.id = d.external_id AND n.kind = 'loop'
      ))
    )
  `,
      )
      .get(documentId, OPEN_LOOP_SOURCE_ID, KNOWLEDGE_SOURCE_ID)?.hidden === 1
  );
}
