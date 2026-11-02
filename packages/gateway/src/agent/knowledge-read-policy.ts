// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KNOWLEDGE_SOURCE_ID } from "../brain/knowledge/source-meta.js";
import { OPEN_LOOP_SOURCE_ID } from "../brain/open-loop-source/source-meta.js";
import type Database from "better-sqlite3";
import type { ToolHandle } from "@omnesis/agent";

/** The two gateway-owned projections of maintained pages and tracked outcomes. */
export function isKnowledgeReadSource(sourceId: string): boolean {
  return sourceId === KNOWLEDGE_SOURCE_ID || sourceId === OPEN_LOOP_SOURCE_ID;
}

export function isKnowledgeReadDocument(db: Database.Database, documentId: string): boolean {
  const row = db
    .prepare<[string], { source_id: string }>("SELECT source_id FROM documents WHERE id = ?")
    .get(documentId);
  return row ? isKnowledgeReadSource(row.source_id) : false;
}

/** Also applied to per-conversation tools, whose wiki reads arrive from the Brain. */
export function withoutKnowledgeReadTools(tools: readonly ToolHandle[]): ToolHandle[] {
  return tools.filter(
    (tool) =>
      !tool.name.startsWith("knowledge_") &&
      !tool.name.startsWith("open_loop_") &&
      // The Task journal shares the loop store, including accepted suggestions.
      !tool.name.startsWith("task_") &&
      !["list_loops", "search_loops", "fetch_loop", "entity_context"].includes(tool.name),
  );
}
