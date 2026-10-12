// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { readKnowledgeOwner, type KnowledgeOwnerKind } from "./owner-adapters.js";
import { reconcileKnowledgeOwner } from "./owner-sync.js";
import { isKnowledgeOwnerReadable } from "./storage-fence.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import { getKnowledgeNode } from "./storage-read.js";
import { recordKnowledgeDiscoveryTargets } from "./work-lifecycle.js";
import { enqueueKnowledgeWork } from "./work.js";
import { KnowledgeStorageError } from "./types.js";
import type { KnowledgeCanonicalFence } from "./canonical-fence.js";
import type Database from "better-sqlite3";

const operations: Record<string, [KnowledgeOwnerKind, "create" | "update"]> = {
  "cognition.openLoopCreate": ["loop", "create"],
  "cognition.openLoopUpdate": ["loop", "update"],
  "cognition.briefCreate": ["brief", "create"],
  "cognition.briefUpdate": ["brief", "update"],
  "cognition.annotationCreate": ["doc_annotation", "create"],
  "cognition.annotationCreateSuperseding": ["doc_annotation", "create"],
  "cognition.annotationUpdate": ["doc_annotation", "update"],
  "cognition.personAnnotationCreate": ["person_annotation", "create"],
  "cognition.personAnnotationCreateSuperseding": ["person_annotation", "create"],
  "cognition.personAnnotationRevise": ["person_annotation", "update"],
};
export interface CanonicalEnrollmentCandidate {
  kind: KnowledgeOwnerKind;
  id: string;
  version: string | null;
}
/** Writer arguments identify server-generated owners; model tool output is never consulted. */
export function captureCanonicalEnrollment(
  db: Database.Database,
  operation: string,
  args: unknown[],
): CanonicalEnrollmentCandidate | null {
  const descriptor = operations[operation];
  if (!descriptor) return null;
  const [kind, mode] = descriptor;
  const input = args[0];
  const id =
    mode === "update"
      ? input
      : input && typeof input === "object" && "id" in input
        ? input.id
        : undefined;
  if (typeof id !== "string") return null;
  let version: string | null = null;
  try {
    version = readKnowledgeOwner(db, kind, id).versionFingerprint;
  } catch (error) {
    if (!(error instanceof KnowledgeStorageError && error.code === "reference_invalid"))
      throw error;
  }
  return { kind, id, version };
}

/** Run inside the canonical mutation transaction: failed writes publish no repair hints. */
export function enrollCanonicalMutation(
  db: Database.Database,
  fence: KnowledgeCanonicalFence,
  candidate: CanonicalEnrollmentCandidate | null,
  now: number,
): void {
  if (!candidate || !isKnowledgeOwnerReadable(db, candidate.id)) return;
  let owner;
  try {
    owner = readKnowledgeOwner(db, candidate.kind, candidate.id);
  } catch (error) {
    if (error instanceof KnowledgeStorageError && error.code === "reference_invalid") return;
    throw error;
  }
  if (owner.versionFingerprint === candidate.version || owner.canonicalFields.invalidatedAt != null)
    return;
  // A node already offered in this turn is explicitly awaiting knowledge_save.
  // Reconciliation here would invalidate the very revision the agent was handed.
  if (fence.inputs.some((input) => input.nodeId === owner.id)) return;
  if (owner.markdown.length > 262144 || owner.evidenceDocumentIds.length > 1024)
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Canonical repair exceeds the bounded conversion budget",
    );
  // Closing or correcting an existing owner remains valid when old evidence is
  // unavailable. Keep conversion pending rather than restoring unsupported prose
  // or rolling back the canonical action. The ordinary owner sweep retries it.
  if (owner.evidenceDocumentIds.some((id) => !isKnowledgeEvidenceReadable(db, id))) {
    db.prepare(
      "INSERT INTO knowledge_owner_changes(kind,owner_id,operation,changed_at) VALUES(?,?,'update',?) ON CONFLICT(kind,owner_id) DO UPDATE SET operation='update',changed_at=excluded.changed_at",
    ).run(owner.kind, owner.id, now);
    return;
  }
  reconcileKnowledgeOwner(db, owner.kind, owner.id, now);
  const node = getKnowledgeNode(db, owner.id);
  if (!node || node.canonicalFields.withdrawn === true) return;
  const evidence = new Set(owner.evidenceDocumentIds);
  const sources = fence.inputs.filter(
    (input) => input.nodeId.startsWith("source:") && evidence.has(input.nodeId.slice(7)),
  );
  for (const source of sources)
    recordKnowledgeDiscoveryTargets(
      db,
      {
        runFence: { batchId: fence.batchId, runId: fence.runId },
        sourceId: source.nodeId.slice(7),
        sourceRevision: String(source.versions[source.nodeId]),
        nodeIds: [node.id],
      },
      now,
    );
  if (!sources.length)
    enqueueKnowledgeWork(
      db,
      {
        id: `kw_${randomUUID()}`,
        subjectId: node.id,
        subjectKind: "node",
        reason: "review",
        inputRevision: String(node.revision),
        tier: "immediate",
        dueAt: now,
      },
      now,
    );
}
