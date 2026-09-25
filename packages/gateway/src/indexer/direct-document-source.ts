// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * DocumentSource implementation that reads directly from the gateway SQLite database.
 * Replaces the HTTP-based GatewayDocumentSource now that the indexer runs in-process.
 *
 * Per #386, the row → projection mapping is shared with
 * the HTTP `/documents/list` route via `data/document-mappers.ts` so
 * the indexer pipeline and the wire response always see the same
 * shape for a given metadata-field addition.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;
import {
  listDocuments,
  listDocumentsLightweight,
  listDocumentIds,
  listDocumentsByIds,
  documentExistsForSource,
  getDocumentSourceIds,
} from "../db.js";
import type { DocumentSource, IndexableDocument, LightweightDocumentHeader } from "./types.js";
import { toListedDocument } from "../data/document-mappers.js";

export class DirectDocumentSource implements DocumentSource {
  constructor(private db: Db) {}

  async listUpdated(
    since: string | null,
    limit: number,
    afterId?: string,
  ): Promise<{ documents: IndexableDocument[]; hasMore: boolean }> {
    const result = listDocuments(this.db, {
      updatedSince: since ?? undefined,
      limit,
      afterId,
    });
    return {
      // Indexer is a trusted internal consumer — skip Zod validation.
      documents: result.documents.map((d) => toListedDocument(d, { skipValidation: true })),
      hasMore: result.hasMore,
    };
  }

  async listUpdatedLightweight(
    since: string | null,
    limit: number,
    afterId?: string,
  ): Promise<{ documents: LightweightDocumentHeader[]; hasMore: boolean }> {
    const result = listDocumentsLightweight(this.db, {
      updatedSince: since ?? undefined,
      limit,
      afterId,
    });
    return {
      documents: result.documents.map((row) => ({
        id: row.id,
        sourceId: row.source_id,
        contentHash: row.content_hash,
        sourceUrl: row.source_url,
        sourceCreatedAt: row.source_created_at,
        updatedAt: row.updated_at,
        documentType: row.document_type,
      })),
      hasMore: result.hasMore,
    };
  }

  async listAllIds(): Promise<string[]> {
    return listDocumentIds(this.db);
  }

  async getByIds(ids: string[]): Promise<IndexableDocument[]> {
    if (ids.length === 0) return [];
    // Indexer is a trusted internal consumer — skip Zod validation.
    return listDocumentsByIds(this.db, ids).map((d) =>
      toListedDocument(d, { skipValidation: true }),
    );
  }

  async hasDocuments(sourceId: string): Promise<boolean> {
    return documentExistsForSource(this.db, sourceId);
  }

  async getSourceIdsByIds(ids: string[]): Promise<Map<string, string>> {
    return getDocumentSourceIds(this.db, ids);
  }
}
