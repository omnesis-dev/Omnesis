// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ANNOTATION_CONTEXT_VERIFIER } from "../annotation-verification.js";
import { CONTEXTUAL_VERIFIER } from "./claim-context.js";
import { WIKI_EDITORIAL_GROWTH_SQL } from "./wiki-review-signals.js";
import { knowledgeWorkParkedSql } from "./work-retry.js";
import type Database from "better-sqlite3";

/**
 * Everything the due-review selection reads from the caller. Plain data, so the
 * selection can run on a read worker as readily as on the caller's handle.
 */
export interface DueKnowledgeReviewOptions {
  now: number;
  limit: number;
  soonDelayMs: number;
  routineDelayMs: number;
  maxReviewIntervalMs: number;
  checkpointLeadMs: number;
  /**
   * The outcome record-check policy loops must have passed under. Set only when
   * record checks are enforced and a decision model is available; absent, no
   * loop is nominated for outcome-policy revalidation.
   */
  outcomePolicy?: string;
}

/** A node whose review is due, and whether a policy change rather than time made it due. */
export interface DueKnowledgeReview {
  id: string;
  policy_review: number;
  proof_policy_review: number;
}

/**
 * The nodes whose next review is due, most overdue first. A node a source
 * discovery has just created or changed is left to that batch: reviewing it in
 * a batch of its own would reserve the region the discovery still has to
 * append, and the discovery would be abandoned and its source interpreted again.
 */
export function listDueKnowledgeReviews(
  db: Database.Database,
  options: DueKnowledgeReviewOptions,
): DueKnowledgeReview[] {
  const { now } = options;
  // Incremental claim verification must not postpone a wiki's whole-page editorial review.
  const last =
    "CASE WHEN n.kind='wiki' THEN COALESCE(json_extract(n.metadata_json,'$.lastReviewedAt'),n.created_at) ELSE MAX(COALESCE(json_extract(n.metadata_json,'$.lastVerifiedAt'),n.created_at),COALESCE(json_extract(n.metadata_json,'$.lastReviewedAt'),n.created_at)) END";
  const maximum = `${last}+${options.maxReviewIntervalMs}`;
  // A completed but unverified review is still an attempt. Bound retries without
  // moving lastVerifiedAt or pretending its claims became current. A claim the
  // verifier cannot confirm stays unverified however often it is reviewed, so
  // each further attempt since the last meaningful review doubles the wait, up
  // to the maximum review interval; a verified review moves that baseline and
  // starts the sequence again.
  const retryAfter = Math.max(60_000, options.soonDelayMs);
  const retryCap = Math.max(retryAfter, options.maxReviewIntervalMs);
  const reviewRetryAt = `(SELECT MAX(w.updated_at)+MIN(${retryCap},${retryAfter}*(1<<MIN(30,COUNT(*)-1)))
      FROM knowledge_work w WHERE w.subject_kind='node' AND w.subject_id=n.id AND w.reason='review'
      AND w.status='completed' AND w.updated_at>=${last})`;
  const hasLoops = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='open_loops'")
    .get();
  const importance = hasLoops
    ? "COALESCE(l.importance,json_extract(n.metadata_json,'$.importance'),0)"
    : "COALESCE(json_extract(n.fields_json,'$.importance'),json_extract(n.metadata_json,'$.importance'),0)";
  const defaultDelay = `CASE WHEN COALESCE(json_extract(n.metadata_json,'$.volatility'),0)>=0.7 OR ${importance}>=0.7 THEN ${options.soonDelayMs} WHEN json_extract(n.metadata_json,'$.activity')='active' THEN ${options.routineDelayMs} ELSE ${options.maxReviewIntervalMs} END`;
  const loopDeadline = hasLoops
    ? "CASE WHEN l.state='open' THEN CAST(strftime('%s',COALESCE(json_extract(l.deadline_json,'$.date'),CASE WHEN json_type(l.deadline_json)='text' THEN json_extract(l.deadline_json,'$') END)) AS REAL)*1000 END"
    : "NULL";
  const ownerCheckpoint = `CASE WHEN (${loopDeadline})-${options.checkpointLeadMs}>COALESCE(json_extract(n.metadata_json,'$.lastReviewedAt'),0) THEN (${loopDeadline})-${options.checkpointLeadMs} ELSE ${maximum} END`;
  const hasRetiredLoops = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retired_loops'")
    .get();
  const historicalLoop =
    hasLoops && hasRetiredLoops
      ? "(n.kind='loop' AND l.id IS NULL AND EXISTS(SELECT 1 FROM retired_loops r WHERE r.id=COALESCE(n.owner_id,n.id)))"
      : "0";
  const retiredAnnotations = ["doc_annotation", "person_annotation"]
    .map((kind) => {
      const table = kind === "doc_annotation" ? "doc_annotations" : "person_annotations";
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      return exists
        ? `(n.kind='${kind}' AND EXISTS(SELECT 1 FROM ${table} a WHERE a.id=COALESCE(n.owner_id,n.id) AND (a.invalidated_at IS NOT NULL OR a.superseded_by IS NOT NULL)))`
        : "0";
    })
    .join(" OR ");
  const checkpointDue = `CASE WHEN json_extract(n.metadata_json,'$.checkpointAt')-${options.checkpointLeadMs}>COALESCE(json_extract(n.metadata_json,'$.lastReviewedAt'),0) THEN json_extract(n.metadata_json,'$.checkpointAt')-${options.checkpointLeadMs} ELSE ${maximum} END`;
  // A persisted gate decision covers the snapshot it judged. Ordinary ticks
  // must not repeatedly judge unchanged growth after a bounded deferral.
  const editorialDue = `CASE WHEN ${WIKI_EDITORIAL_GROWTH_SQL} AND COALESCE(json_extract(n.metadata_json,'$.reviewDecidedAt'),0)<n.updated_at THEN ${last}+${options.routineDelayMs} ELSE ${maximum} END`;
  const outcomePolicy = options.outcomePolicy;
  const policyDue =
    hasLoops && outcomePolicy !== undefined
      ? `(n.kind='loop' AND l.id IS NOT NULL AND (oa.owner_id IS NULL OR oa.policy!=@outcomePolicy ) AND NOT EXISTS(SELECT 1 FROM knowledge_outcome_assessments attempt WHERE attempt.owner_id=l.id AND attempt.policy=@outcomePolicy AND attempt.status!='pass' AND attempt.retry_at>${now}))`
      : "0";
  // Positive proofs from an older verifier contract cannot be reused by readers.
  // Nominate repair incrementally, without resetting discovery or trusting Jev
  // to decide whether a deterministic proof-policy mismatch matters.
  const proofPolicyDue = `(n.kind IN ('wiki','root','loop','doc_annotation','person_annotation') AND (n.kind!='loop' OR ${hasLoops ? "l.id IS NOT NULL" : "0"}) AND EXISTS(
      SELECT 1 FROM knowledge_claims c WHERE c.node_id=n.id AND c.verification='verified'
      AND COALESCE(c.verifier,'')!=CASE WHEN n.kind IN ('wiki','root','loop') THEN @contextualVerifier ELSE @annotationVerifier END))`;
  const requiredPolicyDue = `(${policyDue} OR ${proofPolicyDue})`;
  const due = `MIN(COALESCE(json_extract(n.metadata_json,'$.nextReviewAt'),${last}+(${defaultDelay})),${maximum},${checkpointDue},${ownerCheckpoint},${editorialDue},CASE WHEN ${requiredPolicyDue} THEN 0 ELSE ${maximum} END)`;
  return db
    .prepare<
      {
        now: number;
        limit: number;
        outcomePolicy?: string;
        contextualVerifier: string;
        annotationVerifier: string;
      },
      DueKnowledgeReview
    >(
      `SELECT n.id,${policyDue} AS policy_review,${proofPolicyDue} AS proof_policy_review,${due} AS review_due FROM knowledge_nodes n
      ${hasLoops ? "LEFT JOIN open_loops l ON n.kind='loop' AND l.id=COALESCE(n.owner_id,n.id)" : ""}
      LEFT JOIN knowledge_outcome_assessments oa ON n.kind='loop' AND oa.owner_id=COALESCE(n.owner_id,n.id) AND oa.status='pass'
      WHERE (n.kind!='root' OR ${proofPolicyDue}) AND NOT (${historicalLoop}) AND NOT (${retiredAnnotations}) AND n.kind!='observation' AND COALESCE(json_extract(n.fields_json,'$.withdrawn'),0)!=1 AND review_due<=@now
      AND NOT EXISTS(SELECT 1 FROM knowledge_work w WHERE w.subject_kind='node' AND w.subject_id=n.id AND w.status IN ('pending','batched'))
      AND NOT ${knowledgeWorkParkedSql("'node'", "n.id", "CAST(n.revision AS TEXT)", "'review'")}
      AND COALESCE(${reviewRetryAt},0)<=@now
      AND NOT EXISTS(SELECT 1 FROM knowledge_discovery_targets t
        JOIN knowledge_batch_regions r ON r.node_id='source:'||t.source_id
        JOIN knowledge_batches b ON b.id=r.batch_id AND b.status NOT IN ('completed','abandoned')
        WHERE t.node_id=n.id)
      ORDER BY CASE WHEN ${maximum}<=${now} THEN 0 ELSE 1 END,review_due,n.id LIMIT @limit`,
    )
    .all({
      now,
      limit: options.limit,
      contextualVerifier: CONTEXTUAL_VERIFIER,
      annotationVerifier: ANNOTATION_CONTEXT_VERIFIER,
      ...(hasLoops && outcomePolicy !== undefined ? { outcomePolicy } : {}),
    })
    .map(({ id, policy_review, proof_policy_review }) => ({
      id,
      policy_review,
      proof_policy_review,
    }));
}
