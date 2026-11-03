// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { outcomeRecordPolicyKey } from "../record-check/rubric.js";
import { cognitionBudgetVerdict } from "../cognition/budget.js";
import {
  COGNITION_RUN_STALE_MS,
  DEFAULT_COGNITION_RUN_MAX_ATTEMPTS,
} from "../storage/run-queue.js";
import { decisionPayloadErasureGeneration } from "../decision-payload.js";
import { getKnowledgeNode } from "./storage.js";
import { knowledgeSelectionReads } from "./selection-reads.js";
import { knowledgeReviewSignals, decideKnowledgeReview } from "./review-policy.js";
import { isHistoricalKnowledgeOwner } from "./owner-maintenance.js";
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

  /**
   * Release the batches whose run is over: settled, missing, or dead — still
   * pending at its attempts cap, which the drainer never claims again, last
   * claimed long ago and not executing now (a process that died on every
   * attempt leaves exactly that row, holding its region forever).
   */
  async recover(): Promise<void> {
    const cfg = this.deps.getSettings().knowledge;
    const claimedBefore = this.deps.clock() - COGNITION_RUN_STALE_MS;
    const rows = await knowledgeSelectionReads(this.deps).knowledgeRecoverableBatches({
      maxAttempts: DEFAULT_COGNITION_RUN_MAX_ATTEMPTS,
      claimedBefore,
      limit: cfg.maxSeeds,
    });
    for (const row of rows) {
      if (row.dead && this.deps.isRunActive?.(row.runId)) continue;
      await this.deps.writeGate["knowledge.abandonBatch"](
        {
          batchId: row.id,
          notBefore: this.deps.clock() + cfg.soonDelayMs,
          ...(row.dead
            ? {
                deadRun: {
                  runId: row.runId,
                  maxAttempts: DEFAULT_COGNITION_RUN_MAX_ATTEMPTS,
                  claimedBefore,
                },
              }
            : {}),
          // A run that exhausted its attempts adjudicated the work it was offered.
          ...(row.failed || row.dead
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
        .prepare<[string], { value_json: string; revision: number }>(
          "SELECT value_json,revision FROM knowledge_checkpoints WHERE id=?",
        )
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
    const admissions = await knowledgeSelectionReads(this.deps).knowledgeOrganizationAdmissions({
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
    const policyChecksEnabled =
      this.deps.getSettings().annotations.recordCheck === "enforce" &&
      !!this.deps.decisions.getDecision?.();
    const rows = await knowledgeSelectionReads(this.deps).knowledgeDueReviews({
      now,
      limit: cfg.maxReviewsPerTick,
      soonDelayMs: cfg.soonDelayMs,
      routineDelayMs: cfg.routineDelayMs,
      maxReviewIntervalMs: cfg.maxReviewIntervalMs,
      checkpointLeadMs: cfg.checkpointLeadMs,
      ...(policyChecksEnabled
        ? {
            outcomePolicy: outcomeRecordPolicyKey(
              "enforce",
              this.deps.decisions.getDecision?.()?.modelId ?? null,
            ),
          }
        : {}),
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
              (await knowledgeSelectionReads(this.deps).knowledgeDecisionPayloadSubjects(
                { nodeIds: [node.id], nodeRevisions: { [node.id]: node.revision } },
                payloadGeneration,
              )) ?? undefined,
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
