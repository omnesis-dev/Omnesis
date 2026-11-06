// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentScopeFacts, ScopeRef } from "@omnesis/types";
import type { Db } from "../data/types.js";

/**
 * Replace a complete projection atomically, including its unknown kinds.
 * Never merge a partial update into old completeness: doing so could authorize
 * a document using facts from a previous revision. Caller owns batching and
 * writer admission; nested SQLite transactions are savepoints.
 */
export function replaceDocumentScopeFacts(
  db: Db,
  documentId: string,
  projection: DocumentScopeFacts,
): void {
  db.transaction(() => {
    deleteDocumentScopeFacts(db, documentId);
    const insertFact = db.prepare(
      "INSERT OR IGNORE INTO document_scope_facts (document_id, kind, entity_id) VALUES (?, ?, ?)",
    );
    for (const fact of projection.facts) {
      if (fact.kind === "participant") {
        const { type, value } = fact.identifier;
        insertFact.run(documentId, fact.kind, `${type}:${value}`);
        // A domain is an exact email-domain match, never a suffix or a name.
        if (type === "email") {
          const at = value.lastIndexOf("@");
          if (at > 0 && at < value.length - 1) {
            insertFact.run(documentId, fact.kind, `domain:${value.slice(at + 1)}`);
          }
        }
      } else {
        insertFact.run(documentId, fact.kind, fact.id);
      }
    }
    const insertComplete = db.prepare(
      "INSERT OR IGNORE INTO document_scope_completeness (document_id, kind, complete) VALUES (?, ?, 1)",
    );
    for (const kind of projection.complete) insertComplete.run(documentId, kind);
  })();
}

export function deleteDocumentScopeFacts(db: Db, documentId: string): void {
  // Revoke completeness first, so a standalone cleanup cannot briefly turn
  // an exclusion filter into an allow while its facts are being removed.
  db.prepare("DELETE FROM document_scope_completeness WHERE document_id = ?").run(documentId);
  db.prepare("DELETE FROM document_scope_facts WHERE document_id = ?").run(documentId);
}

/** Invalidate before publishing changed membership or hierarchy in batches. */
export function invalidateDocumentScopeKind(
  db: Db,
  documentId: string,
  kind: ScopeRef["kind"],
): void {
  db.prepare("DELETE FROM document_scope_completeness WHERE document_id = ? AND kind = ?").run(
    documentId,
    kind,
  );
}
