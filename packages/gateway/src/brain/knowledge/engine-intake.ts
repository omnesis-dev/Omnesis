// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { listTemporalAnnotationsAwaitingRefile } from "../../enrichment/temporal-annotations/storage.js";
import { cognitionBudgetVerdict } from "../cognition/budget.js";
import { bootstrapWindowOpen } from "../bootstrap-window.js";
import { getKnowledgeDependencies, getKnowledgeNode, listKnowledgeChanges } from "./storage.js";
import { knowledgeSourceReadiness } from "./engine-readiness.js";
import { historicalKnowledgeAdmissions } from "./work.js";
import { KNOWLEDGE_DISCOVERY_POLICY, listKnowledgeDiscoveryBacklog } from "./discovery.js";
import { judgeKnowledge } from "./decision.js";
import { scheduleKnowledgeChange, type MaintenanceArc } from "./planner.js";
import type { KnowledgeEngineDeps } from "./engine.js";
interface IntakeContext {
  deps: KnowledgeEngineDeps;
  id: (prefix: string) => string;
  source: (
    id: string,
  ) => { id: string; title: string; content: string; contentHash: string } | null;
  pageArcs: (input: string, after: string, limit: number) => MaintenanceArc[];
  roots: () => Set<string>;
}
/** Incremental interpretation and operator-authorized historical admission share durable work. */
export class KnowledgeIntake {
  constructor(private readonly context: IntakeContext) {}
  async intake(): Promise<void> {
    const cfg = this.context.deps.getSettings().knowledge;
    const changes = listKnowledgeChanges(this.context.deps.db, { limit: cfg.discoveryBatchSize });
    for (const change of changes) {
      if (
        cognitionBudgetVerdict(
          this.context.deps.db,
          this.context.deps.getSettings().budget,
          this.context.deps.clock(),
        ).exhausted
      )
        return;
      if (change.kind === "source_changed") {
        const source = this.context.source(change.entityId);
        if (source) {
          const covered = this.context.deps.db
            .prepare(
              "SELECT 1 FROM knowledge_discovery_coverage WHERE subject_id=? AND input_revision=? AND phase='organization' AND policy_version=? AND status IN ('considered','gated') AND (reconsider_at IS NULL OR reconsider_at>?)",
            )
            .get(
              source.id,
              source.contentHash,
              KNOWLEDGE_DISCOVERY_POLICY,
              this.context.deps.clock(),
            );
          // Coverage describes an evidence version, not the current state of
          // its dependents. A→B→A may restore covered evidence while pages still
          // describe B, and temporal casualties may need to be re-filed.
          if (
            covered &&
            this.context.pageArcs(`source:${source.id}`, "", 1).length === 0 &&
            listTemporalAnnotationsAwaitingRefile(this.context.deps.db, source.id, 1).length === 0
          ) {
            await this.context.deps.writeGate["knowledge.ackChanges"](change.seq);
            continue;
          }
          // Journal entries describe arrivals or edits, regardless of occurrence age.
          // Historical corpus admission is handled separately by bootstrap().
          const readiness = knowledgeSourceReadiness(
            this.context.deps,
            source.id,
            this.context.deps.clock(),
          );
          const score = readiness.ready
            ? await judgeKnowledge(this.context.deps.decisions, "urgency", {
                documentId: source.id,
                title: source.title,
                content: source.content.slice(0, 24000),
              })
            : null;
          const now = this.context.deps.clock();
          await this.context.deps.writeGate["knowledge.enqueue"](
            {
              id: this.context.id("kw"),
              subjectId: source.id,
              subjectKind: "source",
              reason: "change",
              inputRevision: source.contentHash,
              ...(readiness.ready
                ? scheduleKnowledgeChange(score, now, cfg)
                : { tier: "routine" as const, dueAt: now + cfg.routineDelayMs }),
              ...(readiness.reason ? { readinessReason: readiness.reason } : {}),
            },
            now,
          );
        }
      } else if (
        change.kind === "node_changed" ||
        change.kind === "node_deleted" ||
        change.kind === "source_evidence_changed"
      ) {
        const sourceEvidence = change.kind === "source_evidence_changed";
        const alreadyPropagated =
          change.kind === "node_changed" &&
          this.context.deps.db
            .prepare(
              "SELECT 1 FROM knowledge_frontier WHERE node_id=? AND result_revision=? AND status IN ('changed','unchanged') LIMIT 1",
            )
            .get(change.entityId, Number(change.revision));
        // A maintenance run itself expands its changed frontier. Independent
        // interactive edits still need a durable successor for their dependents.
        const checkpoint = this.context.deps.db
          .prepare<
            [],
            { revision: number; value_json: string }
          >("SELECT revision,value_json FROM knowledge_checkpoints WHERE id='knowledge:intake:dependent-page'")
          .get();
        const cursor = checkpoint
          ? (JSON.parse(checkpoint.value_json) as { seq: number; after: string })
          : null;
        const page = alreadyPropagated
          ? []
          : this.context.pageArcs(
              sourceEvidence ? `source:${change.entityId}` : change.entityId,
              cursor?.seq === change.seq ? cursor.after : "",
              cfg.discoveryBatchSize + 1,
            );
        const more = page.length > cfg.discoveryBatchSize;
        const affected = page.slice(0, cfg.discoveryBatchSize).map((arc) => arc.dependent);
        if (!sourceEvidence && !more && !this.context.roots().has(change.entityId))
          for (const id of this.context.roots()) if (!affected.includes(id)) affected.push(id);
        for (const id of affected) {
          const node = getKnowledgeNode(this.context.deps.db, id);
          if (!node) continue;
          const affectedRefs = getKnowledgeDependencies(this.context.deps.db, id).filter(
            (dep) =>
              dep.targetKind === (sourceEvidence ? "source" : "node") &&
              dep.targetId === change.entityId &&
              dep.relation !== "context",
          );
          const operational =
            node.kind === "loop" &&
            Array.isArray(node.canonicalFields.blockedBy) &&
            node.canonicalFields.blockedBy.includes(change.entityId);
          if (
            node.kind !== "root" &&
            !operational &&
            node.validity === "current" &&
            affectedRefs.length &&
            affectedRefs.every((dep) => {
              try {
                return dep.inputVersion === this.context.deps.service.reference(dep.ref).revision;
              } catch {
                return false;
              }
            })
          )
            continue;
          const now = this.context.deps.clock();
          await this.context.deps.writeGate["knowledge.enqueue"](
            {
              id: this.context.id("kw"),
              subjectId: id,
              subjectKind: "node",
              reason: node.kind === "root" ? "root" : "change",
              inputRevision: String(node.revision),
              tier: node.kind === "root" && !node.plainText ? "immediate" : "routine",
              dueAt: node.kind === "root" && !node.plainText ? now : now + cfg.routineDelayMs,
            },
            now,
          );
        }
        if (more) {
          await this.context.deps.writeGate["knowledge.checkpoint"](
            {
              id: "knowledge:intake:dependent-page",
              value: { seq: change.seq, after: affected.at(-1)! },
              expectedRevision: checkpoint?.revision ?? 0,
            },
            this.context.deps.clock(),
          );
          return; // Journal remains pending until all direct targets are admitted.
        }
      }
      await this.context.deps.writeGate["knowledge.ackChanges"](change.seq);
    }
  }

  async bootstrap(): Promise<void> {
    const settings = this.context.deps.getSettings(),
      cfg = settings.knowledge,
      backfill = settings.bootstrap;
    if (
      !backfill.enabled ||
      !bootstrapWindowOpen(backfill.activeHours, this.context.deps.clock()) ||
      !this.context.deps.db
        .prepare("SELECT 1 FROM cognition_engine_state WHERE key='bootstrap_started_at'")
        .get()
    )
      return;
    const counts = {
      ...historicalKnowledgeAdmissions(this.context.deps.db, this.context.deps.clock()),
      ...this.context.deps.db
        .prepare<
          [],
          { backlog: number }
        >("SELECT COUNT(*) AS backlog FROM knowledge_work WHERE subject_kind='source' AND reason IN ('discovery','upgrade') AND status IN ('pending','batched')")
        .get()!,
    };
    const room = Math.min(
      backfill.maxRuns - counts.total,
      backfill.maxRunsPerDay - counts.today,
      backfill.backlogTarget - counts.backlog,
      backfill.batchSize,
    );
    if (room <= 0) return;
    // Historical admission has its own bounded backlog; live arrivals cannot
    // consume its entire allowance. Round-robin source IDs prevent a prolific
    // recent source from hiding all history from quieter sources.
    const checkpoint = this.context.deps.db
      .prepare<
        [],
        { revision: number; value_json: string }
      >("SELECT revision,value_json FROM knowledge_checkpoints WHERE id='knowledge:bootstrap:source'")
      .get();
    const after = checkpoint
      ? (JSON.parse(checkpoint.value_json) as { sourceId: string }).sourceId
      : "";
    const limit = Math.min(cfg.bootstrapBatchSize, room);
    const sources = this.context.deps.db
      .prepare<
        [string, number],
        { source_id: string }
      >("SELECT DISTINCT source_id FROM documents WHERE source_id>? ORDER BY source_id LIMIT ?")
      .all(after, limit);
    if (sources.length < limit) {
      sources.push(
        ...this.context.deps.db
          .prepare<
            [string, number],
            { source_id: string }
          >("SELECT DISTINCT source_id FROM documents WHERE source_id<=? ORDER BY source_id LIMIT ?")
          .all(after, limit - sources.length),
      );
    }
    const docs = sources.flatMap((source) =>
      listKnowledgeDiscoveryBacklog(this.context.deps.db, {
        phase: "organization",
        sourceId: source.source_id,
        direction: backfill.direction,
        limit: 1,
        now: this.context.deps.clock(),
      }),
    );
    const fresh = !this.context.deps.db
      .prepare("SELECT 1 FROM knowledge_discovery_coverage LIMIT 1")
      .get();
    for (const doc of docs) {
      const now = this.context.deps.clock();
      await this.context.deps.writeGate["knowledge.enqueue"](
        {
          id: this.context.id("kw"),
          subjectId: doc.id,
          subjectKind: "source",
          reason: "discovery",
          inputRevision: doc.contentHash,
          tier: fresh ? "immediate" : "routine",
          dueAt: fresh ? now : now + cfg.routineDelayMs,
        },
        now,
      );
    }
    if (sources.length)
      await this.context.deps.writeGate["knowledge.checkpoint"](
        {
          id: "knowledge:bootstrap:source",
          expectedRevision: checkpoint?.revision ?? 0,
          value: { sourceId: sources.at(-1)!.source_id },
        },
        this.context.deps.clock(),
      );
  }
}
