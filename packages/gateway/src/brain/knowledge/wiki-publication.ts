// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  readKnowledgeCollectionRevision,
  assertKnowledgeReconciliation,
  knowledgeReconciliationConflict,
} from "./reconciliation.js";
import { getKnowledgeNode } from "./storage.js";
import { resolveKnowledgeReference } from "./storage-validation.js";
import { parseClaimReference } from "./references.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

export interface WikiCreationAssessment {
  reason: string;
  relatedPageIds: string[];
}
/** Produced by actual tool reads, never accepted inside a node proposal. */
export interface WikiPublicationReceipt {
  candidateId: string;
  inventoryRevision: number;
  assessment: WikiCreationAssessment;
  relatedPageRevisions: Readonly<Record<string, number>>;
}

/** Bounded observed context is a judgment aid, not proof that no duplicate exists. */
export class WikiPublicationReads {
  private inventoryRevision?: number;
  constructor(private readonly db: Database.Database) {}
  snapshot<T>(read: () => T, accept: (result: T) => void): T {
    return this.db.transaction(() => {
      const revision = readKnowledgeCollectionRevision(this.db, "wiki_scope");
      const result = read();
      assertKnowledgeReconciliation(this.db, { collection: "wiki_scope", revision });
      accept(result);
      return result;
    })();
  }
  private observe(): void {
    const current = readKnowledgeCollectionRevision(this.db, "wiki_scope");
    if (this.inventoryRevision !== undefined && this.inventoryRevision !== current) {
      this.pages = false;
      this.candidates = false;
      this.candidateIds.clear();
      this.nodes.clear();
    }
    this.inventoryRevision = current;
  }
  acceptProposal(id: string, revision: number): void {
    this.inventoryRevision = revision;
    this.candidateIds.add(id);
  }
  private pages = false;
  private candidates = false;
  private readonly candidateIds = new Set<string>();
  private readonly nodes = new Map<string, number>();

  library(): void {
    this.observe();
    this.pages = true;
  }
  candidatesRead(ids: string[], initial: boolean): void {
    this.observe();
    if (initial) this.candidates = true;
    for (const id of ids) this.candidateIds.add(id);
  }
  nodeRead(node: { id: string; kind: string; revision: number } | null): void {
    if (node?.kind === "wiki") this.nodes.set(node.id, node.revision);
  }
  assertInspected(): number {
    assertKnowledgeReconciliation(this.db, {
      collection: "wiki_scope",
      revision: this.inventoryRevision ?? -1,
    });
    if (!this.pages || !this.candidates) throw knowledgeReconciliationConflict("wiki_scope");
    return this.inventoryRevision!;
  }
  receipt(candidateId: string, assessment?: WikiCreationAssessment): WikiPublicationReceipt {
    if (!this.pages || !this.candidates || !this.candidateIds.has(candidateId))
      throw knowledgeReconciliationConflict("wiki_scope");
    if (!assessment)
      throw new KnowledgeStorageError(
        "claim_invalid",
        "New wiki publication requires creationAssessment explaining why existing scopes should not be enriched instead.",
      );
    this.assertInspected();
    const relatedPageRevisions: Record<string, number> = {};
    for (const id of assessment.relatedPageIds) {
      const revision = this.nodes.get(id);
      if (revision === undefined)
        throw new KnowledgeStorageError(
          "claim_invalid",
          "Read every considered related wiki with knowledge_fetch before publishing a distinct scope.",
        );
      relatedPageRevisions[id] = revision;
    }
    return {
      candidateId,
      inventoryRevision: this.inventoryRevision!,
      assessment,
      relatedPageRevisions,
    };
  }
}

export function assertWikiPublicationReceipt(
  db: Database.Database,
  candidateId: string,
  receipt?: WikiPublicationReceipt,
): void {
  if (
    !receipt ||
    receipt.candidateId !== candidateId ||
    !receipt.assessment.reason.trim() ||
    receipt.assessment.reason.length > 1000 ||
    receipt.assessment.relatedPageIds.length > 16
  )
    throw new KnowledgeStorageError(
      "claim_invalid",
      "New wiki publication requires a trusted creation assessment after library and candidate reads.",
    );
  assertKnowledgeReconciliation(db, {
    collection: "wiki_scope",
    revision: receipt.inventoryRevision,
  });
  for (const id of receipt.assessment.relatedPageIds) {
    const node = getKnowledgeNode(db, id);
    if (!node || node.kind !== "wiki" || node.revision !== receipt.relatedPageRevisions[id])
      throw new KnowledgeStorageError(
        "revision_conflict",
        "A considered related page changed or became unavailable; reread and reconcile the proposed scope.",
      );
  }
}

/** Count only current exact support paths, never declared candidates or context edges.
 * Equal content hashes represent one source copy, not independent coverage. */
export function assertWikiSourceDiversity(db: Database.Database, nodeId: string): void {
  const pending: Array<{ id: string; claimId: string | null }> = [{ id: nodeId, claimId: null }];
  const visited = new Set<string>();
  const hashes = new Set<string>();
  let remaining = 8192;
  const dependencies = db.prepare<
    [string, string | null, string | null, number],
    { kind: string; id: string; ref: string; version: string }
  >(
    "SELECT target_kind AS kind,target_id AS id,ref,input_version_json AS version FROM knowledge_dependencies WHERE node_id=? AND (? IS NULL OR claim_id=?) AND relation='supports' LIMIT ?",
  );
  while (pending.length) {
    const item = pending.pop()!;
    const key = JSON.stringify(item);
    if (visited.has(key)) continue;
    visited.add(key);
    const node = getKnowledgeNode(db, item.id);
    if (!node) continue;
    const rows = dependencies.all(item.id, item.claimId, item.claimId, Math.max(1, remaining + 1));
    remaining -= rows.length + 1;
    if (remaining < 0)
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Wiki source support exceeds the bounded traversal budget",
      );
    for (const row of rows) {
      const ref = parseClaimReference(row.ref);
      let resolved: ReturnType<typeof resolveKnowledgeReference>;
      try {
        resolved = resolveKnowledgeReference(db, ref);
      } catch (error) {
        if (error instanceof KnowledgeStorageError) continue;
        throw error;
      }
      if (resolved.stale || JSON.parse(row.version) !== resolved.revision) continue;
      if (row.kind === "source") {
        hashes.add(String(resolved.revision));
        if (hashes.size >= 2) return;
      } else if (ref.selector?.kind === "claim")
        pending.push({ id: row.id, claimId: ref.selector.id });
    }
  }
  if (hashes.size < 2)
    throw new KnowledgeStorageError(
      "claim_invalid",
      "A new wiki must synthesize at least two distinct current source documents through claim supports. Context references, candidate declarations and identical copies do not count; enrich an existing topic, retain a useful document annotation, or defer the candidate instead.",
    );
}
