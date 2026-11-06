// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { documentsMetadataCodec } from "../data/json-columns.js";
import { getSourceScopes } from "./scope-descriptors.js";
import { projectStoredDocumentScopes } from "./scope-projection.js";
import type { DocumentMetadata } from "@omnesis/types";
import type { Db } from "../data/types.js";

/** Legacy document writes are replayed once, not discovered by restarting corpus scans. */
export function drainNativeScopeReprojections(
  db: Db,
  budget: number,
  token?: { requested(): boolean },
): number {
  const cursor = db
    .prepare<[], { document_id: string }>(
      "SELECT document_id FROM scope_native_reprojection_cursor WHERE id=1",
    )
    .get()!.document_id;
  const rows = db
    .prepare<[string, number], { document_id: string }>(
      "SELECT document_id FROM scope_native_reprojection WHERE document_id>? ORDER BY document_id LIMIT ?",
    )
    .all(cursor, budget);
  if (rows.length < budget && cursor)
    rows.push(
      ...db
        .prepare<[string, number], { document_id: string }>(
          "SELECT document_id FROM scope_native_reprojection WHERE document_id<=? ORDER BY document_id LIMIT ?",
        )
        .all(cursor, budget - rows.length),
    );
  let processed = 0;
  let preempted = false;
  for (const row of rows) {
    db.transaction(() => {
      db.prepare("UPDATE scope_native_reprojection_cursor SET document_id=? WHERE id=1").run(
        row.document_id,
      );
      const document = db
        .prepare<
          [string],
          {
            id: string;
            source_id: string;
            provider_id: string;
            stream_id: string;
            external_id: string;
            metadata: string;
            type: string;
            rowid: number;
          }
        >(
          `SELECT d.rowid,d.id,d.source_id,d.provider_id,d.stream_id,d.external_id,d.metadata,s.type FROM documents d JOIN sources s ON s.id=d.source_id WHERE d.id=?`,
        )
        .get(row.document_id);
      if (!document) {
        db.prepare("DELETE FROM scope_native_reprojection WHERE document_id=?").run(
          row.document_id,
        );
        return;
      }
      const baseline = db
        .prepare<[string], { ready: number; cursor_rowid: number }>(
          "SELECT ready,cursor_rowid FROM scope_fact_backfill WHERE source_id=?",
        )
        .get(document.source_id);
      if (baseline?.ready === 0 && document.rowid > baseline.cursor_rowid) {
        db.prepare("DELETE FROM scope_native_reprojection WHERE document_id=?").run(document.id);
        return;
      }
      if (token?.requested()) {
        preempted = true;
        return;
      }
      const scopes = getSourceScopes(db, document.type);
      if (!scopes) return;
      let metadata: DocumentMetadata;
      try {
        metadata = documentsMetadataCodec.parse(document.metadata, { rowId: document.id });
      } catch {
        metadata = {};
      }
      projectStoredDocumentScopes(
        db,
        {
          id: document.id,
          sourceId: document.source_id,
          providerId: document.provider_id,
          streamId: document.stream_id,
          externalId: document.external_id,
          metadata,
          historical: true,
          reprojection: true,
        },
        scopes,
      );
      processed++;
    })();
    if (preempted) break;
  }
  return processed;
}
