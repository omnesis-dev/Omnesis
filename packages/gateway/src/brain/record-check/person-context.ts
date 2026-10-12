// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  getPersonAnnotation,
  listLivePersonAnnotationsForPerson,
  listPersonAnnotationEvidence,
} from "../storage/person-annotations.js";
import type Database from "better-sqlite3";

interface ProfileFact {
  id: string;
  kind: string;
  text: string;
}
export interface PersonReconciliationContext {
  operation: "create" | "replace" | "revise" | "withdraw";
  /** Model-authored rationale is untrusted, not proof that omitted scope is dispensable. */
  reason: string | null;
  predecessors: ProfileFact[];
  /** The proposed final profile is these retained facts plus the separately supplied record. */
  retained_profile: ProfileFact[];
  truncated: boolean;
}

/** Source-vetted context for judging whether a fact belongs in a person's profile. */
export interface PersonRecordContext {
  subject_id: string;
  evidence: { source: number; quote: string }[];
  evidence_truncated: boolean;
  reconciliation?: PersonReconciliationContext;
  /** Original source context for destructive editorial assessment; never proposed instructions. */
  withdrawal_sources?: { id: string; title: string; content: string }[];
}

/** Inputs must already have passed the annotation source/evidence firewall. */
export function personRecordContext(
  personId: string,
  atoms: readonly { docId: string; quote: string }[],
  reconciliation?: PersonReconciliationContext,
): PersonRecordContext {
  const sourceNumbers = new Map<string, number>();
  return {
    subject_id: personId,
    ...(reconciliation ? { reconciliation } : {}),
    evidence: atoms.slice(0, 9).map((atom) => {
      if (!sourceNumbers.has(atom.docId)) sourceNumbers.set(atom.docId, sourceNumbers.size);
      let end = Math.min(atom.quote.length, 500);
      const last = atom.quote.charCodeAt(end - 1);
      if (end < atom.quote.length && last >= 0xd800 && last <= 0xdbff) end--;
      return { source: sourceNumbers.get(atom.docId)!, quote: atom.quote.slice(0, end) };
    }),
    evidence_truncated: atoms.length > 9 || atoms.some((atom) => atom.quote.length > 500),
  };
}

/**
 * Call inside the same read transaction as the complete-profile receipt check and
 * payload capture. Every included fact contributes all its evidence subjects to
 * capture ancestry, even though the judge only needs its bounded text.
 */
export function readPersonReconciliationContext(
  db: Database.Database,
  personId: string,
  predecessorIds: readonly string[],
  operation: PersonReconciliationContext["operation"],
  reason?: string,
): { reconciliation: PersonReconciliationContext; sourceIds: string[]; nodeIds: string[] } {
  const replaced = new Set(predecessorIds);
  const reconciliation: PersonReconciliationContext = {
    operation,
    reason: reason ?? null,
    predecessors: [],
    retained_profile: [],
    truncated: false,
  };
  const sourceIds = new Set<string>();
  const nodeIds = new Set<string>();
  const ownerNode = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_nodes'")
    .get()
    ? db.prepare<[string], { id: string }>(
        "SELECT id FROM knowledge_nodes WHERE kind='person_annotation' AND COALESCE(owner_id,id)=?",
      )
    : null;
  let remainingCharacters = 12_000;
  let remainingFacts = 64;
  const include = (
    row: NonNullable<ReturnType<typeof getPersonAnnotation>>,
    predecessor: boolean,
  ) => {
    if (remainingFacts === 0 || row.claimText.length > remainingCharacters) {
      reconciliation.truncated = true;
      return;
    }
    remainingFacts--;
    remainingCharacters -= row.claimText.length;
    (predecessor ? reconciliation.predecessors : reconciliation.retained_profile).push({
      id: row.id,
      kind: row.claimType,
      text: row.claimText,
    });
    const node = ownerNode?.get(row.id);
    if (node) nodeIds.add(node.id);
    sourceIds.add(row.evidenceDocId);
    for (const atom of listPersonAnnotationEvidence(db, row.id)) sourceIds.add(atom.evidenceDocId);
  };
  for (const id of predecessorIds) {
    const row = getPersonAnnotation(db, id);
    if (row && row.invalidatedAt === null) include(row, true);
    else reconciliation.truncated = true;
  }
  const rows = listLivePersonAnnotationsForPerson(db, personId, 65);
  if (rows.length > 64) reconciliation.truncated = true;
  for (const row of rows.slice(0, 64)) if (!replaced.has(row.id)) include(row, false);
  return { reconciliation, sourceIds: [...sourceIds], nodeIds: [...nodeIds] };
}
