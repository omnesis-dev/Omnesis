// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { OPEN_LOOP_SOURCE_ID, OPEN_LOOP_DOCUMENT_TYPE } from "../open-loop-source/source-meta.js";
import { KNOWLEDGE_SOURCE_ID, KNOWLEDGE_DOCUMENT_TYPE } from "./source-meta.js";
import type Database from "better-sqlite3";

/** Source evidence excludes generated corpus mirrors and pending source removals. */
export function isKnowledgeEvidenceReadable(db: Database.Database, documentId: string): boolean {
  const row = db
    .prepare<
      [string],
      { deleted: number }
    >("SELECT deleted FROM knowledge_source_revisions WHERE document_id=?")
    .get(documentId);
  if (row?.deleted) return false;
  const columns = db.prepare<[], { name: string }>("PRAGMA table_info(documents)").all();
  if (!columns.some((column) => column.name === "source_id")) return true;
  const typeColumn = columns.some((column) => column.name === "metadata")
    ? "json_extract(metadata,'$.documentType')"
    : "NULL";
  const document = db
    .prepare<
      [string],
      { source_id: string; document_type: string | null }
    >(`SELECT source_id,${typeColumn} AS document_type FROM documents WHERE id=?`)
    .get(documentId);
  if (
    !document ||
    [KNOWLEDGE_SOURCE_ID, OPEN_LOOP_SOURCE_ID].includes(document.source_id) ||
    [KNOWLEDGE_DOCUMENT_TYPE, OPEN_LOOP_DOCUMENT_TYPE].includes(document.document_type ?? "")
  )
    return false;
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='removed_sources'").get()
  )
    return true;
  return !db.prepare("SELECT 1 FROM removed_sources WHERE id=?").get(document.source_id);
}
