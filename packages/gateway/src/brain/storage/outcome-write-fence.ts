// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { isKnowledgeEvidenceReadable } from "../knowledge/storage-source-fence.js";
import { readKnowledgeSourceRevision } from "../knowledge/source-revision.js";
import { KnowledgeStorageError } from "../knowledge/types.js";
import { getOpenLoop } from "./open-loops.js";
import type { OutcomeAssessmentReceipt } from "../knowledge/outcome-assessment.js";
import type Database from "better-sqlite3";

const MAX_SOURCES = 1_024;
export type OutcomeWriteConflict = "outcome_changed" | "evidence_changed";

/** Trusted snapshot taken before the outcome judge reads its proposed mutation. */
export interface OutcomeWriteFence {
  assessment?: OutcomeAssessmentReceipt;
  actorRoles?: Array<{ id: string; is_self: boolean | null }>;
  ownerId: string;
  ownerFingerprint: string;
  sources: Array<{
    id: string;
    hash: string | null;
    contextFingerprint?: string;
    semanticRevision?: string | null;
  }>;
}

function ownerFingerprint(db: Database.Database, id: string): string {
  return createHash("sha256")
    .update(JSON.stringify(getOpenLoop(db, id)))
    .digest("hex");
}

function evidenceHash(db: Database.Database, id: string): string | null {
  const hasKnowledge = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_source_revisions'")
    .get();
  if (hasKnowledge && !isKnowledgeEvidenceReadable(db, id)) return null;
  return (
    db
      .prepare<[string], { content_hash: string | null }>(
        "SELECT content_hash FROM documents WHERE id=?",
      )
      .get(id)?.content_hash ?? null
  );
}

function sourceContextFingerprints(db: Database.Database): (id: string) => string {
  const columns = new Set(
    db
      .prepare<[], { name: string }>("PRAGMA table_info(documents)")
      .all()
      .map((row) => row.name),
  );
  const fields = ["title", "source_created_at", "source_updated_at"].map((name) =>
    columns.has(name) ? name : `NULL AS ${name}`,
  );
  const statement = db.prepare(`SELECT ${fields.join(",")} FROM documents WHERE id=?`);
  return (id) =>
    createHash("sha256")
      .update(JSON.stringify(statement.get(id) ?? null))
      .digest("hex");
}

/** One read transaction captures all fields, including equal-timestamp owner changes. */
export function captureOutcomeWriteFence(
  db: Database.Database,
  id: string,
  sourceIds: readonly string[],
): OutcomeWriteFence {
  const ids = [...new Set(sourceIds)];
  if (ids.length > MAX_SOURCES)
    throw new KnowledgeStorageError(
      "revision_conflict",
      "Outcome evidence exceeds the bounded write fence",
    );
  return db.transaction(() => {
    const contextFingerprint = ids.length ? sourceContextFingerprints(db) : undefined;
    return {
      ownerId: id,
      ownerFingerprint: ownerFingerprint(db, id),
      sources: ids.map((sourceId) => ({
        id: sourceId,
        hash: evidenceHash(db, sourceId),
        contextFingerprint: contextFingerprint!(sourceId),
        semanticRevision: readKnowledgeSourceRevision(db, sourceId),
      })),
    };
  })();
}

/** Called inside the same writer transaction as the canonical loop mutation. */
export function outcomeWriteConflict(
  db: Database.Database,
  id: string,
  fence: OutcomeWriteFence,
): OutcomeWriteConflict | null {
  if (fence.ownerId !== id || ownerFingerprint(db, id) !== fence.ownerFingerprint)
    return "outcome_changed";
  if ((fence.actorRoles?.length ?? 0) > 100) return "outcome_changed";
  if (fence.actorRoles?.length) {
    const readRole = db.prepare<[string], { is_self: number | null }>(
      "SELECT is_self FROM people WHERE id=?",
    );
    if (
      fence.actorRoles.some((actor) => {
        const row = readRole.get(actor.id);
        return (row ? Boolean(row.is_self) : null) !== actor.is_self;
      })
    )
      return "outcome_changed";
  }
  const contextFingerprint = fence.sources.some((source) => source.contextFingerprint !== undefined)
    ? sourceContextFingerprints(db)
    : undefined;
  if (
    fence.sources.length > MAX_SOURCES ||
    fence.sources.some(
      (source) =>
        source.hash === null ||
        evidenceHash(db, source.id) !== source.hash ||
        (source.semanticRevision !== undefined &&
          readKnowledgeSourceRevision(db, source.id) !== source.semanticRevision) ||
        (source.contextFingerprint !== undefined &&
          contextFingerprint!(source.id) !== source.contextFingerprint),
    )
  )
    return "evidence_changed";
  return null;
}
