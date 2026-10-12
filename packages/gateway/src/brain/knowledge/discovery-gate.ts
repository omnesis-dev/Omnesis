// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { listTemporalAnnotationsAwaitingRefile } from "../../enrichment/temporal-annotations/storage.js";
import { KnowledgeGraph } from "./engine-graph.js";
import type Database from "better-sqlite3";

/** A cheap relevance judgement cannot discharge an existing reconciliation obligation. */
export function sourceHasDiscoveryObligation(db: Database.Database, id: string): boolean {
  if (new KnowledgeGraph(db, () => 1).page(`source:${id}`, "", 1).length) return true;
  if (
    db
      .prepare(
        "SELECT 1 FROM knowledge_dependencies WHERE target_kind='source' AND target_id=? LIMIT 1",
      )
      .get(id)
  )
    return true;
  // The reverse index bounds work to this source; a saturated page fails open.
  const candidates = db
    .prepare<[string], { status: string }>(
      `SELECT c.status FROM knowledge_candidate_sources s JOIN knowledge_candidates c ON c.id=s.candidate_id
     WHERE s.document_id=? LIMIT 129`,
    )
    .all(id);
  if (
    candidates.length > 128 ||
    candidates.some((candidate) => ["proposed", "deferred"].includes(candidate.status))
  )
    return true;
  return (
    !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='temporal_annotations'")
      .get() && listTemporalAnnotationsAwaitingRefile(db, id, 1).length > 0
  );
}
