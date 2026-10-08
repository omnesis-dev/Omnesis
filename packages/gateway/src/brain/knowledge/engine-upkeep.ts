// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { cognitionBudgetVerdict } from "../cognition/budget.js";
import { listOrganizationAdmissions } from "./organization.js";
import { getKnowledgeNode } from "./storage.js";
import { knowledgeReviewSignals, decideKnowledgeReview } from "./review-policy.js";
import { isHistoricalKnowledgeBrief } from "./owner-maintenance.js";
import { judgeKnowledge } from "./decision.js";
import { KnowledgeStorageError } from "./types.js";
import type { KnowledgeEngineDeps } from "./engine.js";
import type { KnowledgeOwnerKind } from "./owner-adapters.js";

export class KnowledgeUpkeep {
  constructor(
    private readonly deps: KnowledgeEngineDeps,
    private readonly id: (prefix: string) => string,
  ) {}

  async root(): Promise<void> {
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
    const rows = this.deps.db
      .prepare<[number], { id: string }>(
        `SELECT b.id FROM knowledge_batches b
      LEFT JOIN cognition_runs r ON r.id=b.run_id WHERE b.status IN ('pending','running','deferred')
      AND (r.id IS NULL OR r.status IN ('completed','failed')) ORDER BY b.created_at LIMIT ?`,
      )
      .all(this.deps.getSettings().knowledge.maxSeeds);
    for (const row of rows)
      await this.deps.writeGate["knowledge.abandonBatch"](
        {
          batchId: row.id,
          notBefore: this.deps.clock() + this.deps.getSettings().knowledge.soonDelayMs,
        },
        this.deps.clock(),
      );
  }

  async convert(): Promise<void> {
    const kinds: Array<[KnowledgeOwnerKind, string]> = [
      ["loop", "open_loops"],
      ["brief", "briefs"],
      ["doc_annotation", "doc_annotations"],
      ["person_annotation", "person_annotations"],
    ];
    const limit = Math.max(
      1,
      Math.floor(this.deps.getSettings().knowledge.bootstrapBatchSize / kinds.length),
    );
    for (const [kind, table] of kinds) {
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
          [string, number],
          { id: string }
        >(`SELECT o.id FROM ${table} o WHERE o.id>? AND NOT EXISTS(SELECT 1 FROM knowledge_nodes n WHERE n.id=o.id) AND NOT EXISTS(SELECT 1 FROM knowledge_node_tombstones t WHERE t.id=o.id) ORDER BY o.id LIMIT ?`)
        .all(after, limit);
      for (const row of rows) {
        try {
          await this.deps.writeGate["knowledge.convertOwner"](kind, row.id, this.deps.clock());
        } catch (error) {
          if (
            !(
              error instanceof KnowledgeStorageError &&
              ["reference_invalid", "revision_conflict", "claim_invalid"].includes(error.code)
            )
          )
            throw error;
          this.deps.log.warn(
            "Knowledge owner conversion deferred because evidence or structure needs repair",
          );
        }
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
  }

  async organization(): Promise<void> {
    const cfg = this.deps.getSettings().knowledge;
    const now = this.deps.clock();
    const admissions = listOrganizationAdmissions(this.deps.db, {
      now,
      limit: cfg.maxReviewsPerTick,
      retryMs: cfg.maxReviewIntervalMs,
    });
    for (const admission of admissions) {
      if (cognitionBudgetVerdict(this.deps.db, this.deps.getSettings().budget, now).exhausted)
        return;
      await this.deps.writeGate["knowledge.admitOrganization"](
        {
          admission,
          workPrefix: this.id("kw"),
          retryAt: now + cfg.maxReviewIntervalMs,
        },
        now,
      );
    }
  }

  async reviews(): Promise<void> {
    const cfg = this.deps.getSettings().knowledge,
      now = this.deps.clock();
    const last =
      "MAX(COALESCE(json_extract(n.metadata_json,'$.lastVerifiedAt'),n.created_at),COALESCE(json_extract(n.metadata_json,'$.lastReviewedAt'),n.created_at))";
    const maximum = `${last}+${cfg.maxReviewIntervalMs}`;
    // A completed but unverified review is still an attempt. Bound retries without
    // moving lastVerifiedAt or pretending its claims became current.
    const retryAfter = Math.max(60_000, cfg.soonDelayMs);
    const hasLoops = !!this.deps.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='open_loops'")
      .get();
    const hasBriefs = !!this.deps.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='briefs'")
      .get();
    const importance = hasLoops
      ? "COALESCE(l.importance,json_extract(n.metadata_json,'$.importance'),0)"
      : "COALESCE(json_extract(n.fields_json,'$.importance'),json_extract(n.metadata_json,'$.importance'),0)";
    const defaultDelay = `CASE WHEN COALESCE(json_extract(n.metadata_json,'$.volatility'),0)>=0.7 OR ${importance}>=0.7 THEN ${cfg.soonDelayMs} WHEN json_extract(n.metadata_json,'$.activity')='active' THEN ${cfg.routineDelayMs} ELSE ${cfg.maxReviewIntervalMs} END`;
    const loopDeadline = hasLoops
      ? "CASE WHEN l.state='open' THEN CAST(strftime('%s',COALESCE(json_extract(l.deadline_json,'$.date'),CASE WHEN json_type(l.deadline_json)='text' THEN json_extract(l.deadline_json,'$') END)) AS REAL)*1000 END"
      : "NULL";
    const ownerCheckpoint = `CASE WHEN (${loopDeadline})-${cfg.checkpointLeadMs}>COALESCE(json_extract(n.metadata_json,'$.lastReviewedAt'),0) THEN (${loopDeadline})-${cfg.checkpointLeadMs} ELSE ${maximum} END`;
    const briefState = hasBriefs
      ? "COALESCE(b.state,json_extract(n.fields_json,'$.state'))"
      : "json_extract(n.fields_json,'$.state')";
    const briefUntil = hasBriefs
      ? "CASE WHEN b.id IS NOT NULL THEN b.relevant_until ELSE json_extract(n.fields_json,'$.relevantUntil') END"
      : "json_extract(n.fields_json,'$.relevantUntil')";
    const historicalBrief = `(n.kind='brief' AND (${briefState} LIKE 'dismissed_%' OR ${briefState} IN ('retired','archived','expired') OR ${briefUntil}<=${now}))`;
    const checkpointDue = `CASE WHEN json_extract(n.metadata_json,'$.checkpointAt')-${cfg.checkpointLeadMs}>COALESCE(json_extract(n.metadata_json,'$.lastReviewedAt'),0) THEN json_extract(n.metadata_json,'$.checkpointAt')-${cfg.checkpointLeadMs} ELSE ${maximum} END`;
    const due = `MIN(COALESCE(json_extract(n.metadata_json,'$.nextReviewAt'),${last}+(${defaultDelay})),${maximum},${checkpointDue},${ownerCheckpoint})`;
    const rows = this.deps.db
      .prepare<[number, number], { id: string }>(
        `SELECT n.id FROM knowledge_nodes n
      ${hasLoops ? "LEFT JOIN open_loops l ON n.kind='loop' AND l.id=COALESCE(n.owner_id,n.id)" : ""}
      ${hasBriefs ? "LEFT JOIN briefs b ON n.kind='brief' AND b.id=COALESCE(n.owner_id,n.id)" : ""}
      WHERE n.kind!='root' AND NOT COALESCE(${historicalBrief},0) AND COALESCE(json_extract(n.fields_json,'$.withdrawn'),0)!=1 AND ${due}<=?
      AND NOT EXISTS(SELECT 1 FROM knowledge_work w WHERE w.subject_kind='node' AND w.subject_id=n.id AND w.status IN ('pending','batched'))
      AND NOT EXISTS(SELECT 1 FROM knowledge_work w WHERE w.subject_kind='node' AND w.subject_id=n.id AND w.reason='review' AND w.status='completed' AND w.updated_at>${now - retryAfter})
      ORDER BY CASE WHEN ${maximum}<=${now} THEN 0 ELSE 1 END,${due},n.id LIMIT ?`,
      )
      .all(now, cfg.maxReviewsPerTick);
    for (const row of rows) {
      if (cognitionBudgetVerdict(this.deps.db, this.deps.getSettings().budget, now).exhausted)
        return;
      const node = getKnowledgeNode(this.deps.db, row.id);
      if (!node) continue;
      if (isHistoricalKnowledgeBrief(this.deps.db, node, now)) continue;
      const signals = knowledgeReviewSignals(this.deps.db, node, now);
      const score = await judgeKnowledge(this.deps.decisions, "review", signals);
      const schedule = decideKnowledgeReview(signals, score, cfg);
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
