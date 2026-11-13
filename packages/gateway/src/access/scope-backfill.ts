// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { documentsMetadataCodec } from "../data/json-columns.js";
import { drainNativeScopeReprojections } from "./scope-native-reprojection.js";
import { drainScopeFactRebuilds, hasScopeFactRebuilds } from "./scope-fact-rebuilds.js";
import { drainHierarchyWork } from "./scope-hierarchy-work.js";
import {
  drainLegacyConversationScopeRebuilds,
  hasLegacyConversationScopeRebuilds,
} from "./scope-conversations.js";
import { getSourceScopes } from "./scope-descriptors.js";
import { sourceFiltersActive } from "./scope-activation.js";
import { projectStoredDocumentScopes, resolvePendingScopeSubjects } from "./scope-projection.js";
import type { DocumentMetadata, SourceScopes } from "@omnesis/types";
import type { Db } from "../data/types.js";

export interface ScopeBackfillResult {
  processed: number;
  sourcesCompleted: number;
  subjectsResolved: number;
  factsRebuilt?: number;
  membershipProcessed?: number;
  hierarchyProcessed?: number;
  nativeReprojected?: number;
}

/** How many stored documents one commit of the pass may hold. */
const DOCUMENTS_PER_COMMIT = 16;

export function ensureScopeBackfillState(
  db: Db,
  sourceId: string,
  sourceType: string,
  scopes: SourceScopes,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO scope_fact_backfill (source_id, source_type, descriptor_json)
    VALUES (?, ?, ?)`,
  ).run(sourceId, sourceType, JSON.stringify(scopes));
}

/**
 * Does nothing while source filters are not active: no source is registered
 * and nothing is projected.
 *
 * One source and at most batchSize documents per call, committed a few
 * documents at a time: a commit waits for the disk, which costs more than
 * projecting a document does. An urgent write still preempts between two
 * documents, because a preempt request ends the transaction after the document
 * in hand. The cursor and readiness live in the corpus DB and advance with
 * each document, so an interrupted pass resumes after boot.
 * A document's content is untouched: the fact tables' generation triggers
 * queue it for the index's scope mirror, so nothing is re-indexed.
 */
export function backfillDocumentScopes(
  db: Db,
  batchSize: number,
  options: { token?: { requested(): boolean } } = {},
): ScopeBackfillResult {
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new Error("Invalid scope backfill batch size.");
  if (!sourceFiltersActive(db)) return { processed: 0, sourcesCompleted: 0, subjectsResolved: 0 };
  db.prepare(
    `INSERT OR IGNORE INTO scope_fact_backfill (source_id, source_type, descriptor_json)
    SELECT s.id, s.type, d.scopes_json FROM sources s JOIN source_scope_descriptors d ON d.source_type = s.type`,
  ).run();
  const result: ScopeBackfillResult = { processed: 0, sourcesCompleted: 0, subjectsResolved: 0 };
  const reprojected = drainNativeScopeReprojections(
    db,
    Math.min(Math.max(1, Math.floor(batchSize / 2)), 128),
    options.token,
  );
  if (reprojected) result.nativeReprojected = reprojected;
  const cursor = db
    .prepare<[], { last_source_id: string }>(
      "SELECT last_source_id FROM scope_backfill_cursor WHERE id = 1",
    )
    .get()!.last_source_id;
  const next = db.prepare<
    [string],
    { source_id: string; source_type: string; cursor_rowid: number }
  >(
    "SELECT source_id,source_type,cursor_rowid FROM scope_fact_backfill WHERE ready = 0 AND source_id > ? ORDER BY source_id LIMIT 1",
  );
  const state = next.get(cursor) ?? next.get("");
  const scopes = state ? getSourceScopes(db, state.source_type) : null;
  if (state)
    db.prepare("UPDATE scope_backfill_cursor SET last_source_id = ? WHERE id = 1").run(
      state.source_id,
    );
  // An unreadable/newer declaration remains fail-closed without starving other
  // sources or the independent pending attachment retry pass.
  if (state && scopes) {
    const remaining = Math.max(0, batchSize - reprojected);
    const rows = db
      .prepare<
        [string, number, number],
        {
          rowid: number;
          id: string;
          provider_id: string;
          external_id: string;
          stream_id: string;
          metadata: string;
        }
      >(
        `
      SELECT rowid,id,provider_id,external_id,stream_id,metadata FROM documents
      WHERE source_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
      )
      .all(state.source_id, state.cursor_rowid, remaining);
    let index = 0;
    let preempted = false;
    while (index < rows.length && !preempted) {
      db.transaction(() => {
        for (let count = 0; count < DOCUMENTS_PER_COMMIT && index < rows.length; count++) {
          if (options.token?.requested()) {
            preempted = true;
            return;
          }
          const row = rows[index]!;
          let metadata: DocumentMetadata;
          try {
            metadata = documentsMetadataCodec.parse(row.metadata, { rowId: row.id });
          } catch {
            metadata = {};
          }
          projectStoredDocumentScopes(
            db,
            {
              id: row.id,
              providerId: row.provider_id,
              sourceId: state.source_id,
              streamId: row.stream_id,
              externalId: row.external_id,
              metadata,
              historical: true,
            },
            scopes,
          );
          db.prepare(
            "UPDATE scope_fact_backfill SET cursor_rowid = ?, processed = processed + 1 WHERE source_id = ?",
          ).run(row.rowid, state.source_id);
          index++;
        }
      })();
    }
    result.processed = index;
    if (
      rows.length < remaining &&
      result.processed === rows.length &&
      !hasScopeFactRebuilds(db, state.source_id) &&
      !hasLegacyConversationScopeRebuilds(db, state.source_id)
    ) {
      db.prepare("UPDATE scope_fact_backfill SET ready = 1 WHERE source_id = ?").run(
        state.source_id,
      );
      result.sourcesCompleted = 1;
    }
  }
  if (!options.token?.requested()) {
    result.subjectsResolved = db.transaction(() =>
      resolvePendingScopeSubjects(db, batchSize),
    )().resolved;
  }
  if (!options.token?.requested()) {
    const facts = drainScopeFactRebuilds(db);
    if (facts.processed) result.factsRebuilt = facts.processed;
  }
  if (!options.token?.requested()) {
    const membership = drainLegacyConversationScopeRebuilds(db);
    if (membership.processed) result.membershipProcessed = membership.processed;
  }
  if (!options.token?.requested()) {
    const processed = drainHierarchyWork(db, 128, options.token);
    if (processed) result.hierarchyProcessed = processed;
  }
  return result;
}
