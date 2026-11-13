// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { projectDocumentScopeFacts } from "@omnesis/source-sdk";
import {
  replaceNativeScopeWitnesses,
  withNativeScopePublication,
  publishNativeScopeWitnesses,
} from "./scope-native-witnesses.js";
import { observeDocumentConversation } from "./scope-conversations.js";
import { stageOrReplaceScopeFacts } from "./scope-fact-rebuilds.js";
import { projectDocumentHierarchyScopes } from "./scope-hierarchy-projection.js";
import { documentHierarchySchema } from "./scope-hierarchy-validation.js";
import { documentScopeFactsSchema } from "./scope-update-schema.js";
import { recordNativeScopeKind } from "./scope-refresh-requirements.js";
import type { DocumentMetadata, SourceScopes } from "@omnesis/types";
import type { Db } from "../data/types.js";

export interface ScopeProjectionDocument {
  id: string;
  providerId: string;
  sourceId: string;
  streamId: string;
  externalId: string;
  metadata: DocumentMetadata;
  writeEpoch?: number;
  historical?: boolean;
  snapshotAuthority?: boolean;
  authorityId?: string;
  reprojection?: boolean;
}

function metadataString(
  metadata: DocumentMetadata,
  path: readonly string[] | undefined,
): string | null {
  if (!path?.length) return null;
  let value: unknown = metadata;
  for (const key of path) {
    value =
      value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key)
        ? (value as Record<string, unknown>)[key]
        : undefined;
  }
  return typeof value === "string" && value.trim() ? value : null;
}

function hasNativeAssertion(metadata: DocumentMetadata, kind: "label" | "folder"): boolean {
  if (kind === "folder") {
    const hierarchy = documentHierarchySchema.safeParse(metadata.scopeHierarchy);
    return hierarchy.success && hierarchy.data.some((item) => item.kind === kind);
  }
  const facts = documentScopeFactsSchema.safeParse(metadata.scopeFacts);
  return (
    facts.success &&
    (
      facts.data.kinds ?? [...facts.data.facts.map((fact) => fact.kind), ...facts.data.complete]
    ).includes(kind)
  );
}

/** Called in the document's transaction: changed facts never lag the corpus write. */
export function projectStoredDocumentScopes(
  db: Db,
  doc: ScopeProjectionDocument,
  scopes: SourceScopes,
): void {
  const projection = projectDocumentHierarchyScopes(
    db,
    doc,
    scopes,
    projectDocumentScopeFacts(doc.metadata, scopes),
  );
  if (doc.historical) {
    // Recovery may retain physical proof not revoked by a legacy mutation, but
    // must never create proof from an echo merely retained in stored metadata.
    withNativeScopePublication(db, doc.id, () => {
      stageOrReplaceScopeFacts(db, doc.sourceId, doc.id, projection);
      publishNativeScopeWitnesses(db, doc.id);
    });
  } else {
    stageOrReplaceScopeFacts(db, doc.sourceId, doc.id, projection);
    replaceNativeScopeWitnesses(db, doc.id, projection);
  }
  for (const item of scopes.items) {
    if (
      item.kind === "label" &&
      Array.isArray(doc.metadata.scopeFacts?.complete) &&
      doc.metadata.scopeFacts.complete.includes("label")
    )
      recordNativeScopeKind(db, doc.sourceId, "label");
    if (item.kind === "folder" && projection.complete.includes("folder"))
      recordNativeScopeKind(db, doc.sourceId, "folder");
  }
  observeDocumentConversation(db, doc, scopes);
  const conversation = projection.facts.find((fact) => fact.kind === "conversation");
  if (conversation && conversation.kind !== "participant") {
    const label =
      metadataString(doc.metadata, scopes.legacyProjection?.conversationLabelPath) ??
      conversation.id;
    db.prepare(
      `INSERT INTO scope_entities (source_id, kind, entity_id, label) VALUES (?, 'conversation', ?, ?)
      ON CONFLICT(source_id, kind, entity_id) DO UPDATE SET label = excluded.label`,
    ).run(doc.sourceId, conversation.id, label);
  }

  db.prepare("DELETE FROM document_scope_subjects WHERE document_id = ?").run(doc.id);
  const parentExternalId = metadataString(doc.metadata, ["extra", "parentExternalId"]) ?? "";
  const hasParentRelation =
    doc.metadata.extra &&
    typeof doc.metadata.extra === "object" &&
    Object.prototype.hasOwnProperty.call(doc.metadata.extra, "parentExternalId");
  if (doc.metadata.documentType !== "attachment" && !hasParentRelation) {
    // A current producer omitting native assertions revokes editor readiness.
    // Historical projections and explicitly unknown native assertions affect
    // only their documents, not a completed source catalogue.
    for (const item of scopes.items) {
      if (
        !doc.historical &&
        (item.kind === "label" || item.kind === "folder") &&
        !projection.complete.includes(item.kind) &&
        !hasNativeAssertion(doc.metadata, item.kind)
      ) {
        db.prepare(
          `INSERT INTO source_scope_kind_readiness(source_id,kind,ready) VALUES(?,?,0)
          ON CONFLICT(source_id,kind) DO UPDATE SET ready=0`,
        ).run(doc.sourceId, item.kind);
      }
    }
    db.prepare("DELETE FROM scope_native_reprojection WHERE document_id=?").run(doc.id);
    return;
  }
  // A parent that becomes derived is no longer a valid terminal subject for
  // its existing children. Their bounded retries cannot rebind to it.
  db.prepare(
    "UPDATE document_scope_subjects SET subject_document_id = '' WHERE subject_document_id = ?",
  ).run(doc.id);
  const parent = parentExternalId
    ? db
        .prepare<[string, string, string, string, string], { id: string }>(
          `SELECT id FROM documents WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND external_id = ?
      AND id <> ? AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.documentType') IS NOT 'attachment' AND json_type(metadata, '$.extra.parentExternalId') IS NULL ELSE 0 END`,
        )
        .get(doc.providerId, doc.sourceId, doc.streamId, parentExternalId, doc.id)
    : undefined;
  db.prepare(
    `INSERT INTO document_scope_subjects
    (document_id, subject_document_id, provider_id, source_id, stream_id, parent_external_id)
    VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(doc.id, parent?.id ?? "", doc.providerId, doc.sourceId, doc.streamId, parentExternalId);
  db.prepare("DELETE FROM scope_native_reprojection WHERE document_id=?").run(doc.id);
}

/** Out-of-order parents earn a later bounded retry; missing parents remain hidden. */
export function resolvePendingScopeSubjects(
  db: Db,
  limit: number,
): { examined: number; resolved: number } {
  const cursor = db
    .prepare<[], { cursor_rowid: number }>(
      "SELECT cursor_rowid FROM scope_subject_retries WHERE id = 1",
    )
    .get()!.cursor_rowid;
  const pending = db.prepare<
    [number, number],
    {
      rowid: number;
      document_id: string;
      provider_id: string;
      source_id: string;
      stream_id: string;
      parent_external_id: string;
    }
  >(
    `
    SELECT rowid, document_id, provider_id, source_id, stream_id, parent_external_id FROM document_scope_subjects
    WHERE rowid > ? AND subject_document_id = '' ORDER BY rowid LIMIT ?`,
  );
  let rows = pending.all(cursor, limit);
  if (rows.length === 0 && cursor > 0) rows = pending.all(0, limit);
  const parent = db.prepare<
    [string, string, string, string, string],
    { id: string }
  >(`SELECT id FROM documents
    WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND external_id = ? AND id <> ?
    AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.documentType') IS NOT 'attachment' AND json_type(metadata, '$.extra.parentExternalId') IS NULL ELSE 0 END`);
  const update = db.prepare(
    "UPDATE document_scope_subjects SET subject_document_id = ? WHERE document_id = ? AND subject_document_id = ''",
  );
  let resolved = 0;
  for (const row of rows) {
    if (!row.parent_external_id) continue;
    const found = parent.get(
      row.provider_id,
      row.source_id,
      row.stream_id,
      row.parent_external_id,
      row.document_id,
    );
    if (!found) continue;
    update.run(found.id, row.document_id);
    resolved += 1;
  }
  db.prepare("UPDATE scope_subject_retries SET cursor_rowid = ? WHERE id = 1").run(
    rows.at(-1)?.rowid ?? 0,
  );
  return { examined: rows.length, resolved };
}
