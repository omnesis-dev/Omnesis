// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { resolvePersonId } from "../../domain/PeopleResolutionService.js";
import { isKnowledgeOwnerReadable } from "./storage-fence.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import type Database from "better-sqlite3";

export interface KnowledgePersonSubjectRef {
  kind: "person";
  id: string;
  name: string;
}
export interface KnowledgeDocumentSubjectRef {
  kind: "source";
  id: string;
  title: string;
  sourceId: string;
}

/**
 * Normal owners supply their own subject. Only canonical withdrawal deliberately
 * removes that owner while preserving an authoritative subject snapshot. Model
 * proposals cannot set canonical fields, and owner-withdrawal updates the node
 * whose ID equals its canonical owner; arbitrary orphan mirrors are not history.
 */
function annotationSubject(
  db: Database.Database,
  nodeId: string,
  kind: "doc_annotation" | "person_annotation",
): { ownerId: string; subjectId: string } | null {
  const table = kind === "doc_annotation" ? "doc_annotations" : "person_annotations";
  const subjectColumn = kind === "doc_annotation" ? "doc_id" : "person_id";
  const row = db
    .prepare<
      [string, string],
      {
        id: string;
        ownerId: string | null;
        subjectId: string | null;
        fields: string;
      }
    >(
      `SELECT n.id,n.owner_id AS ownerId,a.${subjectColumn} AS subjectId,n.fields_json AS fields
    FROM knowledge_nodes n LEFT JOIN ${table} a ON a.id=n.owner_id WHERE n.id=? AND n.kind=?`,
    )
    .get(nodeId, kind);
  if (!row?.ownerId || !isKnowledgeOwnerReadable(db, row.ownerId)) return null;
  if (row.subjectId) return { ownerId: row.ownerId, subjectId: row.subjectId };
  if (row.ownerId !== row.id) return null;
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(row.fields);
  } catch {
    return null;
  }
  if (
    !fields ||
    fields.withdrawn !== true ||
    typeof fields.withdrawnAt !== "number" ||
    !Number.isSafeInteger(fields.withdrawnAt) ||
    fields.withdrawnAt < 0 ||
    typeof fields.subjectId !== "string" ||
    !fields.subjectId
  )
    return null;
  return { ownerId: row.ownerId, subjectId: fields.subjectId };
}

function documentSubject(
  db: Database.Database,
  nodeId: string,
): KnowledgeDocumentSubjectRef | null {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='doc_annotations'").get()
  )
    return null;
  const owner = annotationSubject(db, nodeId, "doc_annotation");
  if (
    !owner ||
    !isKnowledgeEvidenceReadable(db, owner.subjectId) ||
    db
      .prepare(
        "SELECT 1 FROM knowledge_cascade_jobs WHERE kind='purge' AND target_kind='source' AND target_id=?",
      )
      .get(owner.subjectId)
  )
    return null;
  const document = db
    .prepare<
      [string],
      { id: string; title: string; sourceId: string }
    >("SELECT id,title,source_id AS sourceId FROM documents WHERE id=?")
    .get(owner.subjectId);
  return document ? { kind: "source", ...document } : null;
}

/** Call only after the enclosing node read passes its privacy fence, in the same snapshot. */
export function readKnowledgeSubjectRef(
  db: Database.Database,
  nodeId: string,
  kind: string,
): KnowledgePersonSubjectRef | KnowledgeDocumentSubjectRef | null {
  if (kind === "doc_annotation") return documentSubject(db, nodeId);
  if (kind !== "person_annotation") return null;
  // Small isolated stores may not install either canonical owner registry.
  const tables = db
    .prepare<
      [],
      { count: number }
    >("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('person_annotations','people')")
    .get();
  if (tables?.count !== 2) return null;
  // Retirement affects the claim, not the identity of its subject. Historical
  // notes retain their person link while the normal privacy fences still apply.
  const owner = annotationSubject(db, nodeId, "person_annotation");
  if (!owner) return null;
  const id = resolvePersonId(db, owner.subjectId);
  const person = db
    .prepare<
      [string],
      { name: string }
    >("SELECT canonical_name AS name FROM people WHERE id=? AND merged_into IS NULL")
    .get(id);
  return person ? { kind: "person", id, name: person.name } : null;
}
