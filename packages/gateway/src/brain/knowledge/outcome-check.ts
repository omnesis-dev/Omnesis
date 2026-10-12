// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { RECORD_CHECK_RUBRIC_VERSION } from "../record-check/rubric.js";
import {
  captureOutcomeWriteFence,
  type OutcomeWriteFence,
} from "../storage/outcome-write-fence.js";
import { getOpenLoop } from "../storage/open-loops.js";
import { outcomeProposal, prepareOutcomeRecordContext } from "../record-check/outcome-context.js";
import { makeOutcomeAssessment, readOutcomeAssessment } from "./outcome-assessment.js";
import { KnowledgeStorageError } from "./types.js";
import { parseClaimMarkup } from "./claims.js";
import { getKnowledgeNode } from "./storage-read.js";
import type { CheckRecord } from "../record-check/check.js";
import type { KnowledgeRunFence } from "./run-fence.js";
import type { KnowledgeService } from "./service.js";

export class KnowledgeOutcomeRejected extends Error {
  constructor(
    readonly score: number,
    readonly threshold: number,
    readonly questionId?: string,
  ) {
    super("The outcome revision was refused by the record check");
  }
}

/** Canonical operations and proof-only saves share one policy without judging the same prose twice. */
export async function checkKnowledgeOutcome(
  service: KnowledgeService,
  check: CheckRecord | undefined,
  node: { id: string; kind: string; ownerId?: string | null; title: string; markdown: string },
  signal?: AbortSignal,
  run?: KnowledgeRunFence,
): Promise<OutcomeWriteFence | undefined> {
  if (node.kind !== "loop" || !check) return;
  const enforcePolicy = check.enforcesOutcomePolicy?.() ?? true;
  if (!enforcePolicy && !(check.needsDocumentContext?.() ?? true)) return;
  const snapshot = service.deps.db.transaction(() => {
    const loop = getOpenLoop(service.deps.db, node.ownerId ?? node.id);
    if (!loop) return;
    const parsed = parseClaimMarkup(node.markdown);
    const description = parsed.text;
    const unchanged =
      loop.title === node.title &&
      (loop.description.trim() ? loop.description : loop.title) === description;
    if (unchanged && !enforcePolicy) return;
    const reviewBatchId =
      run &&
      service.deps.db
        .prepare(
          "SELECT 1 FROM knowledge_work WHERE batch_id=? AND subject_id=? AND reason='review'",
        )
        .get(run.batchId, node.id)
        ? run.batchId
        : null;
    const proposedDocumentIds = parsed.claims.flatMap((claim) =>
      claim.refs.filter((ref) => ref.kind === "source").map((ref) => ref.id),
    );
    const currentNode = getKnowledgeNode(service.deps.db, node.id);
    const priorDocumentIds = currentNode
      ? parseClaimMarkup(currentNode.markdown).claims.flatMap((claim) =>
          claim.refs.filter((ref) => ref.kind === "source").map((ref) => ref.id),
        )
      : [];
    const changedDocumentIds = run
      ? service.deps.db
          .prepare<[string, string], { subject_id: string }>(
            "SELECT w.subject_id FROM knowledge_work w JOIN knowledge_batches b ON b.id=w.batch_id WHERE w.batch_id=? AND b.run_id=? AND w.subject_kind='source' ORDER BY w.created_at DESC,w.id",
          )
          .all(run.batchId, run.runId)
          .map((row) => row.subject_id)
      : [];
    const priorIds = new Set(priorDocumentIds);
    const priorityDocumentIds = [
      ...new Set([
        ...changedDocumentIds,
        ...proposedDocumentIds.filter((id) => !priorIds.has(id)),
        ...proposedDocumentIds,
      ]),
    ];
    const documentIds = [...new Set([...loop.docs, ...priorityDocumentIds])];
    const supportingNodeIds = [
      ...new Set(
        parsed.claims.flatMap((claim) =>
          claim.refs.filter((ref) => ref.kind !== "source").map((ref) => ref.id),
        ),
      ),
    ];
    if (!documentIds.length && !supportingNodeIds.length)
      throw new KnowledgeStorageError(
        "claim_invalid",
        "A substantive outcome revision requires supporting source evidence.",
      );
    const previous = outcomeProposal(loop);
    const proposed = { ...previous, title: node.title, description };
    const prepared = prepareOutcomeRecordContext(service.deps.db, {
      documentIds,
      priorityDocumentIds,
      priorDocumentIds,
      previous,
      proposed,
      ownerId: node.id,
      outcomeId: loop.id,
      supportingNodeIds,
      now: service.deps.clock(),
    });
    const documentId = prepared?.documentId ?? documentIds[0];
    if (!documentId)
      throw new KnowledgeStorageError(
        "reference_invalid",
        "Outcome support is unavailable; read current supporting evidence before revising it.",
      );
    const outcomeFence =
      prepared?.outcomeFence ?? captureOutcomeWriteFence(service.deps.db, loop.id, documentIds);
    const receipt = makeOutcomeAssessment(
      check.outcomePolicyKey?.() ?? check.policyKey?.() ?? RECORD_CHECK_RUBRIC_VERSION,
      proposed,
      outcomeFence.sources,
      "",
      reviewBatchId,
      outcomeFence.actorRoles,
      prepared?.context.sources.map((source) => source.id),
    );
    const prior = readOutcomeAssessment(service.deps.db, loop.id, receipt.fingerprint);
    const matches = prior?.policy === receipt.policy && prior.fingerprint === receipt.fingerprint;
    if (
      unchanged &&
      matches &&
      prior.status === "pass" &&
      (reviewBatchId === null || prior.review_batch_id === reviewBatchId)
    )
      return {
        loop,
        proposed,
        prepared,
        documentId,
        outcomeFence,
        receipt,
        unchanged,
        reviewBatchId,
        reuse: true,
      };
    if (matches && prior.status !== "pass" && prior.retry_at > service.deps.clock())
      throw new KnowledgeStorageError(
        "claim_invalid",
        prior.status === "skip"
          ? "This exact outcome was refused under the current policy. Correct the outcome or supply changed evidence; do not retry unchanged content before its scheduled retry."
          : "Outcome assessment is temporarily unavailable. This review remains pending until its scheduled retry.",
      );
    return {
      loop,
      proposed,
      prepared,
      documentId,
      outcomeFence,
      receipt,
      unchanged,
      reviewBatchId,
    };
  })();
  if (!snapshot) return;
  if ("reuse" in snapshot) return snapshot.outcomeFence;
  const { loop, proposed, prepared, documentId, outcomeFence, receipt, unchanged, reviewBatchId } =
    snapshot;
  const result = await check(
    {
      recordId: loop.id,
      documentId,
      record: { type: "outcome", kind: "revision", text: JSON.stringify(proposed) },
      ...(prepared
        ? { outcomeContext: prepared.context, payloadCapture: prepared.payloadCapture }
        : {}),
    },
    signal,
  );
  if (
    !result.save ||
    (enforcePolicy && !result.assessment && (unchanged || reviewBatchId !== null))
  ) {
    await service.deps.writeGate["knowledge.outcomeAssessmentAttempt"](
      {
        fence: outcomeFence,
        receipt: { ...receipt, decisionId: result.save ? "" : result.decisionId },
        status: result.save ? "unavailable" : "skip",
        retryAt:
          service.deps.clock() + Math.max(60_000, service.deps.getSettings().knowledge.soonDelayMs),
      },
      service.deps.clock(),
    );
    if (!result.save)
      throw new KnowledgeOutcomeRejected(result.score, result.threshold, result.questionId);
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Outcome assessment is unavailable; the review remains pending and will retry after backoff.",
    );
  }
  if (result.assessment && result.assessment.policy !== receipt.policy)
    throw new KnowledgeStorageError(
      "revision_conflict",
      "Outcome decision policy changed; retry against the current policy.",
    );
  if (result.assessment) outcomeFence.assessment = { ...receipt, ...result.assessment };
  return outcomeFence;
}
