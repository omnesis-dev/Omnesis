// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentScopeFacts, ScopeRef } from "@omnesis/types";
import type { Db } from "../data/types.js";

/**
 * Replace a complete projection atomically, including its unknown kinds.
 * Never merge a partial update into old completeness: doing so could authorize
 * a document using facts from a previous revision. Caller owns batching and
 * writer admission; nested SQLite transactions are savepoints.
 *
 * A projection equal to the stored one writes nothing, so a document
 * re-ingested with the same scope keeps its rows and fires no fact trigger.
 */
export function replaceDocumentScopeFacts(
  db: Db,
  documentId: string,
  projection: DocumentScopeFacts,
): void {
  const facts = new Map<string, [kind: string, entityId: string]>();
  const add = (kind: string, entityId: string) =>
    facts.set(JSON.stringify([kind, entityId]), [kind, entityId]);
  for (const fact of projection.facts) {
    if (fact.kind === "participant") {
      const { type, value } = fact.identifier;
      add(fact.kind, `${type}:${value}`);
      // A domain is an exact email-domain match, never a suffix or a name.
      if (type === "email") {
        const at = value.lastIndexOf("@");
        if (at > 0 && at < value.length - 1) add(fact.kind, `domain:${value.slice(at + 1)}`);
      }
    } else {
      add(fact.kind, fact.id);
    }
  }
  const complete = new Set<string>(projection.complete);
  db.transaction(() => {
    const storedFacts = db
      .prepare<[string], { kind: string; entity_id: string }>(
        "SELECT kind, entity_id FROM document_scope_facts WHERE document_id = ?",
      )
      .all(documentId);
    const storedComplete = db
      .prepare<[string], { kind: string; complete: number }>(
        "SELECT kind, complete FROM document_scope_completeness WHERE document_id = ?",
      )
      .all(documentId);
    if (
      storedFacts.length === facts.size &&
      storedComplete.length === complete.size &&
      storedFacts.every((row) => facts.has(JSON.stringify([row.kind, row.entity_id]))) &&
      storedComplete.every((row) => row.complete === 1 && complete.has(row.kind))
    )
      return;
    deleteDocumentScopeFacts(db, documentId);
    const insertFact = db.prepare(
      "INSERT INTO document_scope_facts (document_id, kind, entity_id) VALUES (?, ?, ?)",
    );
    for (const [kind, entityId] of facts.values()) insertFact.run(documentId, kind, entityId);
    const insertComplete = db.prepare(
      "INSERT INTO document_scope_completeness (document_id, kind, complete) VALUES (?, ?, 1)",
    );
    for (const kind of complete) insertComplete.run(documentId, kind);
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
