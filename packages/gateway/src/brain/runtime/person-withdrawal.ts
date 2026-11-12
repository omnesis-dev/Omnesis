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
import {
  getPersonAnnotation,
  listPersonAnnotationEvidence,
  type PersonProfileBudget,
} from "../storage/person-annotations.js";
import type { PersonProfileReads } from "./person-profile-reads.js";
import type { CheckRecord } from "../record-check/check.js";
import type { ToolResult } from "@omnesis/core";
import type Database from "better-sqlite3";

/** Each destructive proposal assesses the current snapshot, including across continuations. */
export async function assessPersonWithdrawal(
  db: Database.Database,
  reads: PersonProfileReads,
  check: CheckRecord | undefined,
  id: string,
  budget: PersonProfileBudget,
  signal?: AbortSignal,
): Promise<{ budget?: PersonProfileBudget; refusal?: ToolResult }> {
  if (!check) return {};
  const snapshot = db.transaction(() => {
    const owner = getPersonAnnotation(db, id);
    if (!owner) return null;
    const receipt = reads.require(owner.personId, budget);
    const profile = readPersonReconciliationContext(db, owner.personId, [id], "withdraw");
    const atoms = listPersonAnnotationEvidence(db, id).map((a) => ({
      docId: a.evidenceDocId,
      quote: a.evidenceQuote,
    }));
    if (!atoms.length) atoms.push({ docId: owner.evidenceDocId, quote: owner.evidenceQuote });
    const payloadCapture = captureDecisionPayloadSubjects(
      db,
      {
        sourceIds: profile.sourceIds,
        nodeIds: profile.nodeIds,
      },
      decisionPayloadErasureGeneration(db),
    );
    const context = personRecordContext(owner.personId, atoms, profile.reconciliation);
    // No cropped prose is presented as complete destructive context.
    if (payloadCapture && profile.sourceIds.length <= 32) {
      const sources = profile.sourceIds.map(
        (sourceId) =>
          db.prepare("SELECT id,title,content FROM documents WHERE id=?").get(sourceId) as
            { id: string; title: string; content: string } | undefined,
      );
      if (
        sources.every((s) => s && typeof s.content === "string") &&
        sources.reduce((n, s) => n + (s!.content.length + (s!.title?.length ?? 0)), 0) <= 64_000
      )
        context.withdrawal_sources = sources.map((s) => ({
          id: s!.id,
          title: s!.title ?? "",
          content: s!.content,
        }));
    }
    return { owner, receipt, context, payloadCapture };
  })();
  if (!snapshot) return {};
  const result = await check(
    {
      recordId: id,
      documentId: snapshot.owner.evidenceDocId,
      personWithdrawal: true,
      record: { type: "person-fact", kind: "withdrawal", text: snapshot.owner.claimText },
      ...(snapshot.payloadCapture
        ? { payloadCapture: snapshot.payloadCapture, personContext: snapshot.context }
        : {}),
    },
    signal,
  );
  if (!result.save)
    return {
      refusal: {
        kind: "error",
        code: "person_withdrawal_refused",
        message: result.unavailable
          ? "Withdrawal assessment unavailable or incomplete. The existing fact remains pending; reread the complete profile and evidence before retrying."
          : "Withdrawal would lose useful supported person context or its preservation is uncertain. Keep the existing fact until person_annotation_revise or annotate_person with supersedes commits a supported replacement atomically. Do not delete first and recreate later. A duplicate may be removed only when its useful scope is already retained elsewhere.",
      },
    };
  return { budget: snapshot.receipt };
}
