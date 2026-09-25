// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-shape DTOs for document responses.
 *
 * Centralizes the row → JSON transformations that used to be inlined
 * in `routes/documents.ts`. Pulling them out here means a renamed
 * column or a new metadata field is one edit, not several; future
 * routes that surface the same shape can reuse the helpers instead
 * of copy-pasting.
 *
 * Per #386, the `/documents/list` wire shape is now
 * the canonical `ListedDocument` from `@omnesis/core` — the same
 * shape the in-process indexer pipeline operates on. The previous
 * `ListedDocumentDto` was a near-identical local declaration whose
 * presence let the wire shape and the type drift independently
 * (e.g. `relevanceScore` lived on `IndexableDocument` only). The
 * shared row → projection mapper lives in
 * `data/document-mappers.ts:toListedDocument`.
 */

import { parseDocumentMetadata } from "../../data/json-columns.js";
import { toListedDocument } from "../../data/document-mappers.js";
import type { ListedDocumentRow, RecentDocument } from "../../data/types.js";
import type { ListedDocument } from "@omnesis/source-sdk";

/** Wire shape returned by `/documents/recent/:sourceId` and `/sources/:sourceId/recent`. */
export interface RecentDocumentDto {
  id: string;
  sourceId: string;
  externalId: string;
  deviceId: string | null;
  deviceName: string | null;
  title: string;
  contentPreview: string;
  documentType: string | null;
  relevanceScore: number | null;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
}

/** Map a `RecentDocument` row from the repository into the HTTP response shape. */
export function toRecentDocumentDto(doc: RecentDocument): RecentDocumentDto {
  const meta = parseDocumentMetadata(doc.metadata, doc.id);
  return {
    id: doc.id,
    sourceId: doc.source_id,
    externalId: doc.external_id,
    deviceId: doc.device_id || null,
    deviceName: doc.device_name,
    title: doc.title,
    contentPreview: doc.content_preview,
    documentType: meta.documentType ?? null,
    relevanceScore: meta.relevanceScore ?? null,
    sourceCreatedAt: doc.source_created_at,
    sourceUpdatedAt: doc.source_updated_at,
  };
}

/**
 * Map a raw `documents`-table row into the canonical `ListedDocument`
 * wire shape served by `/documents/list`. Just a re-export of the
 * shared row → projection mapper — kept here for the HTTP layer's
 * import-from-`http/dto` convention.
 */
export function toListedDocumentDto(doc: ListedDocumentRow): ListedDocument {
  return toListedDocument(doc);
}
