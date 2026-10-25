// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import {
  findConversationDocId,
  upsertConversationCitations,
  type ConversationCitationInput,
} from "./citation-writer.js";
import {
  preparedConversationEvidence,
  type ConversationEvidenceProjection,
} from "./evidence-projection.js";
import { OMNESIS_CHAT_PROVIDER_ID, OMNESIS_CHAT_SOURCE_ID } from "./ids.js";
import type { DocumentInput } from "@omnesis/types";
import type Database from "better-sqlite3";

/** Source-owned atomic publication. Collector metadata cannot invoke this path.
 * Preserve an unchanged sealed digest before the ordinary document UPSERT so
 * repeated publication does not clear and restore authority in two revisions. */
export function upsertConversationDocument(
  db: Database.Database,
  doc: DocumentInput,
  projection: ConversationEvidenceProjection,
  citations: readonly ConversationCitationInput[],
): void {
  if (doc.providerId !== OMNESIS_CHAT_PROVIDER_ID || doc.sourceId !== OMNESIS_CHAT_SOURCE_ID)
    throw new Error("Unexpected conversation document identity");
  db.transaction(() => {
    const existing = findConversationDocId(db, doc.providerId, doc.sourceId, doc.externalId);
    const prepared = preparedConversationEvidence(db, existing, projection);
    const input = { ...doc, metadata: { ...doc.metadata, evidenceAuthority: prepared.digest } };
    const result = upsertDocuments(db, [input]);
    if (!result.acceptedDocumentCount) return;
    const id = findConversationDocId(db, doc.providerId, doc.sourceId, doc.externalId);
    if (!id) throw new Error("Conversation document publication was not visible");
    const exists = db.prepare("SELECT 1 FROM documents WHERE id=?");
    const currentCitations = citations.filter((citation) => {
      const target = citation.kind === "record" ? citation.boundDocumentId : citation.targetDocId;
      return target === null || !!exists.get(target);
    });
    upsertConversationCitations(db, id, currentCitations, projection);
  })();
}
