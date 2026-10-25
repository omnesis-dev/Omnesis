// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { MaintenancePlanLimitError } from "./planner.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

export const MAX_AFFINITY_MEMBERS = 4096;
interface Binding {
  id: string;
  batch_id: string | null;
  status: string;
  batch_status: string | null;
  created_at: number | null;
}

/** Coordination metadata only: these keys never become knowledge nodes or evidence. */
export function candidateAffinity(db: Database.Database, workIds: readonly string[]) {
  const work = new Set(workIds);
  const keys = new Set<string>();
  const batches = new Map<string, number>();
  const candidates = db.prepare<[string], { id: string; generation: number; evidence: string }>(
    `SELECT DISTINCT c.id,c.decision_generation AS generation,c.evidence_ids_json AS evidence
     FROM knowledge_work seed JOIN knowledge_work alias
       ON alias.subject_kind=seed.subject_kind AND alias.subject_id=seed.subject_id
     JOIN knowledge_candidate_decision_work cw ON cw.work_id=alias.id
     JOIN knowledge_candidates c ON c.id=cw.candidate_id
     WHERE seed.id=? AND cw.generation=c.decision_generation AND c.decision_pending=1
       AND c.status IN ('proposed','deferred') LIMIT 4097`,
  );
  const members = db.prepare<[string, number, number], Binding>(
    `SELECT w.id,w.batch_id,w.status,b.status AS batch_status,b.created_at
     FROM knowledge_candidate_decision_work cw JOIN knowledge_work w ON w.id=cw.work_id
     LEFT JOIN knowledge_batches b ON b.id=w.batch_id
     WHERE cw.candidate_id=? AND cw.generation=? LIMIT ?`,
  );
  const pending = [...work];
  for (let at = 0; at < pending.length; at++) {
    const attached = candidates.all(pending[at]!);
    if (attached.length > MAX_AFFINITY_MEMBERS) refuse();
    for (const candidate of attached) {
      const key = JSON.stringify([candidate.id, candidate.generation]);
      if (keys.has(key)) continue;
      const evidence: string[] = JSON.parse(candidate.evidence);
      if (!evidence.every((id) => isKnowledgeEvidenceReadable(db, id))) continue;
      keys.add(key);
      if (keys.size > MAX_AFFINITY_MEMBERS) refuse();
      // The final parameter bounds this read even when a historical generation has many retries.
      const rows = members.all(candidate.id, candidate.generation, MAX_AFFINITY_MEMBERS + 1);
      if (rows.length > MAX_AFFINITY_MEMBERS) refuse();
      for (const row of rows) {
        if (!work.has(row.id)) {
          work.add(row.id);
          pending.push(row.id);
          if (work.size > MAX_AFFINITY_MEMBERS) refuse();
        }
        if (
          row.status === "batched" &&
          row.batch_id &&
          row.batch_status &&
          !["completed", "abandoned"].includes(row.batch_status)
        )
          batches.set(row.batch_id, row.created_at ?? 0);
      }
    }
  }
  const owner = [...batches].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return { keys: [...keys].sort(), owner, batches: [...batches.keys()], workIds: [...work] };
}
function refuse(): never {
  throw new KnowledgeStorageError(
    "revision_conflict",
    "Candidate coordination exceeds its bounded scope",
  );
}
export function candidateBatchWork(db: Database.Database, batchId: string): string[] {
  return db
    .prepare<[string], { id: string }>("SELECT id FROM knowledge_work WHERE batch_id=?")
    .all(batchId)
    .map((row) => row.id);
}
/** Must run inside the writer transaction before reserving/adopting new work. */
export function assertCandidateReservation(
  db: Database.Database,
  workIds: readonly string[],
  batchId: string,
): void {
  const affinity = candidateAffinity(db, [...candidateBatchWork(db, batchId), ...workIds]);
  if (affinity.batches.some((id) => id !== batchId))
    throw new KnowledgeStorageError(
      "revision_conflict",
      "Candidate curation is reserved by another batch",
    );
}
/** Old separately admitted batches elect one owner; other preflights remain unpaid. */
export function ownsCandidateTurn(db: Database.Database, batchId: string): boolean {
  const batch = db
    .prepare<[string], { status: string }>("SELECT status FROM knowledge_batches WHERE id=?")
    .get(batchId);
  if (batch?.status === "completed" || batch?.status === "abandoned") return true;
  const { owner } = candidateAffinity(db, candidateBatchWork(db, batchId));
  return !owner || owner === batchId;
}

/** Per synchronous planning pass; shared components are traversed only once. */
export function candidateCoordinationKeys(db: Database.Database): (workId: string) => string[] {
  const cached = new Map<string, string[]>();
  return (workId) => {
    const existing = cached.get(workId);
    if (existing) return existing;
    try {
      const component = candidateAffinity(db, [workId]);
      for (const id of component.workIds) cached.set(id, component.keys);
      return component.keys;
    } catch (error) {
      if (error instanceof KnowledgeStorageError && error.code === "revision_conflict")
        throw new MaintenancePlanLimitError("region", workId);
      throw error;
    }
  };
}
