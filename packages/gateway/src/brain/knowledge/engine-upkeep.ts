// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ANNOTATION_CONTEXT_VERIFIER } from "../annotation-verification.js";
import { outcomeRecordPolicyKey } from "../record-check/rubric.js";
import { cognitionBudgetVerdict } from "../cognition/budget.js";
import {
  captureDecisionPayloadSubjects,
  decisionPayloadErasureGeneration,
} from "../decision-payload.js";
import { CONTEXTUAL_VERIFIER } from "./claim-context.js";
import { listOrganizationAdmissions } from "./organization.js";
import { getKnowledgeNode } from "./storage.js";
import { knowledgeReviewSignals, decideKnowledgeReview } from "./review-policy.js";
import { WIKI_EDITORIAL_GROWTH_SQL } from "./wiki-review-signals.js";
import { isHistoricalKnowledgeOwner } from "./owner-maintenance.js";
import { knowledgeWorkParkedSql } from "./work-retry.js";
import { judgeKnowledge } from "./decision.js";
import { KnowledgeStorageError } from "./types.js";
import { LEGACY_OWNER_TABLES, legacyOwnerConversionFingerprint } from "./owner-conversion.js";
import type { KnowledgeEngineDeps } from "./engine.js";

export class KnowledgeUpkeep {
  constructor(
    private readonly deps: KnowledgeEngineDeps,
    private readonly id: (prefix: string) => string,
    private readonly initialRoot: () => string | null = () => null,
  ) {}

  async root(): Promise<void> {
    const initialRoot = this.initialRoot();
    if (initialRoot) await this.deps.writeGate["knowledge.classifyInitialRootBatches"](initialRoot);
    if (this.deps.db.prepare("SELECT 1 FROM knowledge_nodes WHERE kind='root'").get()) return;
    try {
      await this.deps.service.save({
        id: this.id("root"),
        kind: "root",
        title: "Current context",
        markdown: "",
        expectedRevision: 0,
        inputVersions: {},
        metadata: { activity: "active" },
      });
    } catch (error) {
      if (!(error instanceof KnowledgeStorageError && error.code === "root_conflict")) throw error;
    }
  }

  async recover(): Promise<void> {
    const cfg = this.deps.getSettings().knowledge;
    const rows = this.deps.db
      .prepare<[number], { id: string; failed: number }>(
        `SELECT b.id,COALESCE(r.status='failed',0) AS failed FROM knowledge_batches b
      LEFT JOIN cognition_runs r ON r.id=b.run_id WHERE b.status IN ('pending','running','deferred')
      AND (r.id IS NULL OR r.status IN ('completed','failed')) ORDER BY b.created_at LIMIT ?`,
      )
      .all(cfg.maxSeeds);
    for (const row of rows)
      await this.deps.writeGate["knowledge.abandonBatch"](
        {
          batchId: row.id,
          notBefore: this.deps.clock() + cfg.soonDelayMs,
          // A run that exhausted its attempts adjudicated the work it was offered.
          ...(row.failed
            ? {
                failure: {
                  backoffMs: cfg.retryBackoffMs,
                  backoffCapMs: cfg.retryBackoffCapMs,
                  maxFailedAttempts: cfg.maxFailedAttempts,
                },
              }
            : {}),
        },
        this.deps.clock(),
      );
  }

  /**
   * One page per owner kind of the legacy conversion sweep. An owner the sweep
   * set aside is skipped on the reader until its retry comes due or its input
   * fingerprint changes, so an unconvertible owner costs no writer work per pass.
   */
  async convert(): Promise<void> {
    const limit = Math.max(
      1,
      Math.floor(this.deps.getSettings().knowledge.bootstrapBatchSize / LEGACY_OWNER_TABLES.length),
    );
    const now = this.deps.clock();
    let converted = 0;
    const deferred = new Map<string, number>();
    for (const [kind, table] of LEGACY_OWNER_TABLES) {
      if (
        !this.deps.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table)
      )
        continue;
      const key = `knowledge:conversion:${kind}`;
      const checkpoint = this.deps.db
        .prepare<
          [string],
          { value_json: string; revision: number }
        >("SELECT value_json,revision FROM knowledge_checkpoints WHERE id=?")
        .get(key);
      const after = checkpoint ? (JSON.parse(checkpoint.value_json) as string) : "";
      const rows = this.deps.db
        .prepare<
          [string, string, number],
          { id: string; retryAt: number | null; fingerprint: string | null }
        >(
          `SELECT o.id,d.retry_at AS retryAt,d.input_fingerprint AS fingerprint FROM ${table} o
          LEFT JOIN knowledge_conversion_deferrals d ON d.kind=? AND d.owner_id=o.id
          WHERE o.id>? AND NOT EXISTS(SELECT 1 FROM knowledge_nodes n WHERE n.id=o.id) AND NOT EXISTS(SELECT 1 FROM knowledge_node_tombstones t WHERE t.id=o.id) ORDER BY o.id LIMIT ?`,
        )
        .all(kind, after, limit);
      for (const row of rows) {
        if (
          row.retryAt !== null &&
          row.retryAt > now &&
          legacyOwnerConversionFingerprint(this.deps.db, kind, row.id) === row.fingerprint
        )
          continue;
        const attempt = await this.deps.writeGate["knowledge.convertOwner"](
          kind,
          row.id,
          this.deps.clock(),
        );
        if (attempt.outcome === "converted") converted++;
        else deferred.set(attempt.reason, (deferred.get(attempt.reason) ?? 0) + 1);
      }
      // A completed scan wraps for newly created legacy owners whose IDs sort earlier.
      await this.deps.writeGate["knowledge.checkpoint"](
        {
          id: key,
          value: rows.length === limit ? rows.at(-1)!.id : "",
          expectedRevision: checkpoint?.revision ?? 0,
        },
        this.deps.clock(),
      );
    }
    if (deferred.size) {
      const reasons = [...deferred].map(([reason, count]) => `${reason} ${count}`).join(", ");
      this.deps.log.warn(
        `Legacy owner conversion: ${converted} converted, ${[...deferred.values()].reduce((a, b) => a + b, 0)} set aside (${reasons})`,
      );
    } else if (converted) this.deps.log.info(`Legacy owner conversion: ${converted} converted`);
  }

  async organization(): Promise<void> {
    const cfg = this.deps.getSettings().knowledge;
    const now = this.deps.clock();
    const admissions = listOrganizationAdmissions(this.deps.db, {
      now,
      limit: cfg.maxReviewsPerTick,
      retryMs: cfg.maxReviewIntervalMs,
      initialDelayMs: cfg.soonDelayMs,
      excludedSources: this.deps.getSettings().excludedSources,
    });
    for (const admission of admissions) {
      if (cognitionBudgetVerdict(this.deps.db, this.deps.getSettings().budget, now).exhausted)
        return;
      await this.deps.writeGate["knowledge.admitOrganization"](
        {
          admission,
          workPrefix: this.id("kw"),
          retryAt: now + cfg.maxReviewIntervalMs,
          excludedSources: this.deps.getSettings().excludedSources,
        },
        now,
      );
    }
  }

  async reviews(): Promise<void> {
    const cfg = this.deps.getSettings().knowledge,
      now = this.deps.clock();
    // Incremental claim verification must not postpone a wiki's whole-page editorial review.
    const last =
      "CASE WHEN n.kind='wiki' THEN COALESCE(json_extract(n.metadata_json,'$.lastReviewedAt'),n.created_at) ELSE MAX(COALESCE(json_extract(n.metadata_json,'$.lastVerifiedAt'),n.created_at),COALESCE(json_extract(n.metadata_json,'$.lastReviewedAt'),n.created_at)) END";
    const maximum = `${last}+${cfg.maxReviewIntervalMs}`;
    // A completed but unverified review is still an attempt. Bound retries without
    // moving lastVerifiedAt or pretending its claims became current. A claim the
    // verifier cannot confirm stays unverified however often it is reviewed, so
    // each further attempt since the last meaningful review doubles the wait, up
    // to the maximum review interval; a verified review moves that baseline and
    // starts the sequence again.
    const retryAfter = Math.max(60_000, cfg.soonDelayMs);
    const retryCap = Math.max(retryAfter, cfg.maxReviewIntervalMs);
    const reviewRetryAt = `(SELECT MAX(w.updated_at)+MIN(${retryCap},${retryAfter}*(1<<MIN(30,COUNT(*)-1)))
      FROM knowledge_work w WHERE w.subject_kind='node' AND w.subject_id=n.id AND w.reason='review'
      AND w.status='completed' AND w.updated_at>=${last})`;
    const hasLoops = !!this.deps.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='open_loops'")
      .get();
    const importance = hasLoops
      ? "COALESCE(l.importance,json_extract(n.metadata_json,'$.importance'),0)"
      : "COALESCE(json_extract(n.fields_json,'$.importance'),json_extract(n.metadata_json,'$.importance'),0)";
    const defaultDelay = `CASE WHEN COALESCE(json_extract(n.metadata_json,'$.volatility'),0)>=0.7 OR ${importance}>=0.7 THEN ${cfg.soonDelayMs} WHEN json_extract(n.metadata_json,'$.activity')='active' THEN ${cfg.routineDelayMs} ELSE ${cfg.maxReviewIntervalMs} END`;
    const loopDeadline = hasLoops
      ? "CASE WHEN l.state='open' THEN CAST(strftime('%s',COALESCE(json_extract(l.deadline_json,'$.date'),CASE WHEN json_type(l.deadline_json)='text' THEN json_extract(l.deadline_json,'$') END)) AS REAL)*1000 END"
      : "NULL";
    const ownerCheckpoint = `CASE WHEN (${loopDeadline})-${cfg.checkpointLeadMs}>COALESCE(json_extract(n.metadata_json,'$.lastReviewedAt'),0) THEN (${loopDeadline})-${cfg.checkpointLeadMs} ELSE ${maximum} END`;
    const hasRetiredLoops = !!this.deps.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retired_loops'")
      .get();
    const historicalLoop =
      hasLoops && hasRetiredLoops
        ? "(n.kind='loop' AND l.id IS NULL AND EXISTS(SELECT 1 FROM retired_loops r WHERE r.id=COALESCE(n.owner_id,n.id)))"
        : "0";
    const retiredAnnotations = ["doc_annotation", "person_annotation"]
      .map((kind) => {
        const table = kind === "doc_annotation" ? "doc_annotations" : "person_annotations";
        const exists = this.deps.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table);
        return exists
          ? `(n.kind='${kind}' AND EXISTS(SELECT 1 FROM ${table} a WHERE a.id=COALESCE(n.owner_id,n.id) AND (a.invalidated_at IS NOT NULL OR a.superseded_by IS NOT NULL)))`
          : "0";
      })
      .join(" OR ");
    const checkpointDue = `CASE WHEN json_extract(n.metadata_json,'$.checkpointAt')-${cfg.checkpointLeadMs}>COALESCE(json_extract(n.metadata_json,'$.lastReviewedAt'),0) THEN json_extract(n.metadata_json,'$.checkpointAt')-${cfg.checkpointLeadMs} ELSE ${maximum} END`;
    // A persisted gate decision covers the snapshot it judged. Ordinary ticks
    // must not repeatedly judge unchanged growth after a bounded deferral.
    const editorialDue = `CASE WHEN ${WIKI_EDITORIAL_GROWTH_SQL} AND COALESCE(json_extract(n.metadata_json,'$.reviewDecidedAt'),0)<n.updated_at THEN ${last}+${cfg.routineDelayMs} ELSE ${maximum} END`;
    const outcomePolicy = outcomeRecordPolicyKey(
      "enforce",
      this.deps.decisions.getDecision?.()?.modelId ?? null,
    );
    const policyChecksEnabled =
      this.deps.getSettings().annotations.recordCheck === "enforce" &&
      !!this.deps.decisions.getDecision?.();
    const policyDue =
      hasLoops && policyChecksEnabled
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
    // A node a source discovery has just created or changed is that batch's
    // to inspect once the source settles. Reviewing it in a batch of its own
    // would reserve the region the discovery still has to append, and the
    // discovery would be abandoned and its source interpreted again.
    const rows = this.deps.db
      .prepare<
        {
          now: number;
          limit: number;
          outcomePolicy?: string;
          contextualVerifier: string;
          annotationVerifier: string;
        },
        { id: string; policy_review: number; proof_policy_review: number }
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
        limit: cfg.maxReviewsPerTick,
        contextualVerifier: CONTEXTUAL_VERIFIER,
        annotationVerifier: ANNOTATION_CONTEXT_VERIFIER,
        ...(hasLoops && policyChecksEnabled ? { outcomePolicy } : {}),
      });
    for (const row of rows) {
      if (cognitionBudgetVerdict(this.deps.db, this.deps.getSettings().budget, now).exhausted)
        return;
      const payloadGeneration = decisionPayloadErasureGeneration(this.deps.db);
      const node = getKnowledgeNode(this.deps.db, row.id);
      if (!node) continue;
      if (isHistoricalKnowledgeOwner(this.deps.db, node, now)) continue;
      const signals = knowledgeReviewSignals(this.deps.db, node, now);
      const policyReview = row.policy_review === 1 || row.proof_policy_review === 1;
      const score = policyReview
        ? null
        : await judgeKnowledge(this.deps.decisions, "review", signals, {
            nodeId: node.id,
            payloadCapture:
              captureDecisionPayloadSubjects(
                this.deps.db,
                { nodeIds: [node.id], nodeRevisions: { [node.id]: node.revision } },
                payloadGeneration,
              ) ?? undefined,
          });
      const schedule = policyReview
        ? {
            decision: "now" as const,
            nextReviewAt: now,
            reason:
              row.proof_policy_review === 1
                ? "verifier_policy_revalidation"
                : "outcome_policy_revalidation",
          }
        : decideKnowledgeReview(signals, score, cfg);
      await this.deps.writeGate["knowledge.scheduleReview"](
        {
          id: node.id,
          expectedRevision: node.revision,
          nextReviewAt: schedule.nextReviewAt,
          decision: schedule.decision,
          reason: schedule.reason,
          ...(schedule.decision === "now" ? { workId: this.id("kw") } : {}),
        },
        now,
      );
    }
  }
}
