// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  captureDecisionPayloadSubjects,
  decisionPayloadErasureGeneration,
} from "../decision-payload.js";
import {
  personRecordContext,
  readPersonReconciliationContext,
} from "../record-check/person-context.js";
import { RECORD_CHECK_RUBRIC_VERSION } from "../record-check/rubric.js";
import {
  DEFAULT_PERSON_PROFILE_BUDGET,
  getPersonAnnotation,
  getPersonProfileFingerprint,
  listPersonAnnotationEvidence,
} from "../storage/person-annotations.js";
import { knowledgeSourceRevisionSql } from "./source-revision.js";
import { assertKnowledgeRunFence, type KnowledgeRunFence } from "./run-fence.js";
import { KnowledgeStorageError, type SaveKnowledgeNodeInput } from "./types.js";
import type { PersonProfileReads } from "../steward/person-profile-reads.js";
import type { CheckRecord } from "../record-check/check.js";
import type Database from "better-sqlite3";

export interface PersonReviewFence {
  personId: string;
  ownerId: string;
  profileFingerprint: string;
}

export function isPersonEditorialReview(
  db: Database.Database,
  batchId: string,
  nodeId: string,
): boolean {
  return !!db
    .prepare("SELECT 1 FROM knowledge_work WHERE batch_id=? AND subject_id=? AND reason='review'")
    .get(batchId, nodeId);
}

export function assertPersonReviewFence(
  db: Database.Database,
  input: SaveKnowledgeNodeInput,
): void {
  if (
    input.kind !== "person_annotation" ||
    !input.maintenance ||
    !isPersonEditorialReview(db, input.maintenance.batchId, input.id)
  )
    return;
  const fence = input.personReviewFence;
  const owner = getPersonAnnotation(db, input.ownerId ?? input.id);
  if (
    !fence ||
    !owner ||
    fence.ownerId !== owner.id ||
    fence.personId !== owner.personId ||
    fence.profileFingerprint !== getPersonProfileFingerprint(db, fence.personId)
  )
    throw new KnowledgeStorageError(
      "revision_conflict",
      "Person review needs a current complete-profile assessment. Read annotation_search({personId}) through every nextCursor, then retry knowledge_save; a profile fact or its evidence changed.",
    );
}

/** One assessment per canonical profile/evidence snapshot; proof-only projection writes do not rejudge. */
export class PersonEditorialReview {
  private readonly memo = new Map<string, ReturnType<CheckRecord>>();
  constructor(
    private readonly db: Database.Database,
    private readonly reads: PersonProfileReads,
  ) {}

  async prepare(
    node: { id: string; kind: string; ownerId?: string | null; expectedRevision: number },
    run: KnowledgeRunFence | undefined,
    inputFingerprint: string | undefined,
    check?: CheckRecord,
    signal?: AbortSignal,
  ): Promise<PersonReviewFence | undefined> {
    if (
      node.kind !== "person_annotation" ||
      !run ||
      !isPersonEditorialReview(this.db, run.batchId, node.id)
    )
      return;
    const snapshot = this.db.transaction(() => {
      assertKnowledgeRunFence(this.db, run);
      const offered = this.db
        .prepare(
          "SELECT f.input_versions_json FROM knowledge_frontier f JOIN knowledge_nodes n ON n.id=f.node_id WHERE f.batch_id=? AND f.node_id=? AND f.input_fingerprint=? AND f.status='offered' AND n.revision=? AND n.kind='person_annotation' AND COALESCE(n.owner_id,n.id)=?",
        )
        .get(
          run.batchId,
          node.id,
          inputFingerprint ?? "",
          node.expectedRevision,
          node.ownerId ?? node.id,
        ) as { input_versions_json: string } | undefined;
      if (!offered)
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Person review input changed; call knowledge_next_frontier and read the current node before retrying.",
        );
      for (const [ref, expected] of Object.entries(JSON.parse(offered.input_versions_json))) {
        if (!ref.startsWith("source:") || ref.includes("#")) continue;
        const source = this.db
          .prepare(
            `SELECT ${knowledgeSourceRevisionSql()} AS content_hash FROM documents d WHERE id=?`,
          )
          .get(ref.slice(7)) as { content_hash: string } | undefined;
        if (source?.content_hash !== expected)
          throw new KnowledgeStorageError(
            "revision_conflict",
            "Review source changed; request knowledge_next_frontier before retrying.",
          );
      }
      if (
        this.db
          .prepare(
            "SELECT 1 FROM knowledge_owner_changes WHERE kind='person_annotation' AND owner_id=?",
          )
          .get(node.ownerId ?? node.id)
      )
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Canonical person fact changed before synthesis conversion; call knowledge_next_frontier and reread the current person profile before retrying.",
        );
      const owner = getPersonAnnotation(this.db, node.ownerId ?? node.id);
      if (!owner || owner.invalidatedAt !== null)
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Person fact is no longer live; read the current profile and frontier.",
        );
      const receipt = this.reads.require(owner.personId, DEFAULT_PERSON_PROFILE_BUDGET);
      const profile = readPersonReconciliationContext(
        this.db,
        owner.personId,
        [owner.id],
        "revise",
        "Explicit scheduled review: assess whether retaining this exact fact belongs in the current compact person profile, not merely whether evidence supports it.",
      );
      const atoms = listPersonAnnotationEvidence(this.db, owner.id).map((atom) => ({
        docId: atom.evidenceDocId,
        quote: atom.evidenceQuote,
      }));
      if (!atoms.length) atoms.push({ docId: owner.evidenceDocId, quote: owner.evidenceQuote });
      const erasureGeneration = decisionPayloadErasureGeneration(this.db);
      const payloadCapture = captureDecisionPayloadSubjects(
        this.db,
        {
          sourceIds: [
            owner.evidenceDocId,
            ...atoms.map((atom) => atom.docId),
            ...profile.sourceIds,
          ],
          nodeIds: profile.nodeIds,
        },
        erasureGeneration,
      );
      return {
        owner,
        fence: {
          ownerId: owner.id,
          personId: owner.personId,
          profileFingerprint: receipt.expectedProfileFingerprint!,
        },
        payloadCapture,
        erasureGeneration,
        personContext: personRecordContext(owner.personId, atoms, profile.reconciliation),
      };
    })();
    const key = JSON.stringify([
      run.batchId,
      node.id,
      snapshot.fence,
      snapshot.erasureGeneration,
      RECORD_CHECK_RUBRIC_VERSION,
      check?.policyKey?.() ?? "bound-check",
    ]);
    let pending = this.memo.get(key);
    if (!pending) {
      pending = check
        ? check(
            {
              recordId: snapshot.owner.id,
              documentId: snapshot.owner.evidenceDocId,
              record: {
                type: "person-fact",
                kind: snapshot.owner.claimType,
                text: snapshot.owner.claimText,
              },
              ...(snapshot.payloadCapture
                ? { payloadCapture: snapshot.payloadCapture, personContext: snapshot.personContext }
                : {}),
            },
            signal,
          )
        : Promise.resolve({ save: true as const });
      this.memo.set(key, pending);
    }
    let result: Awaited<ReturnType<CheckRecord>>;
    try {
      result = await pending;
    } catch (error) {
      this.memo.delete(key);
      throw error;
    }
    if (!result.save)
      throw new KnowledgeStorageError(
        "claim_invalid",
        `Person review refused retention (${result.questionId ?? "belongs"} score ${result.score.toFixed(2)} below ${result.threshold}). This review remains pending. Use canonical person_annotation_revise, person_annotation_supersede or person_annotation_retract to correct, consolidate or remove the fact. Distill distinct person-level meaning; keep corroborating details in evidence and preserve temporal uncertainty. Do not retry the same retained text or weaken it to a document observation.`,
      );
    return snapshot.fence;
  }
}
