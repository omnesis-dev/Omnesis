// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  isInventoryRevision,
  hasSourceInventoryTables,
} from "../../data/repositories/SourceInventoryRepository.js";
import { listTemporalAnnotationsAwaitingRefile } from "../../enrichment/temporal-annotations/storage.js";
import { cognitionBudgetVerdict } from "../cognition/budget.js";
import { bootstrapWindowOpen } from "../bootstrap-window.js";
import { brainSourceInclusionSql } from "../source-exclusion.js";
import { knowledgeDecisionErasureGeneration } from "./decision-debug.js";
import { getKnowledgeDependencies, getKnowledgeNode, listKnowledgeChanges } from "./storage.js";
import { knowledgeSourceReadiness } from "./engine-readiness.js";
import {
  hasHistoricalKnowledgeWorkBeyond,
  hasKnowledgeWorkFromExcludedSources,
  historicalKnowledgeAdmissions,
} from "./work.js";
import { historyHorizonFloor } from "./history-horizon.js";
import { KNOWLEDGE_DISCOVERY_POLICY, listKnowledgeDiscoveryBacklog } from "./discovery.js";
import { judgeKnowledge, knowledgeUrgencyState } from "./decision.js";
import { scheduleKnowledgeChange, type MaintenanceArc } from "./planner.js";
import type { KnowledgeEngineDeps } from "./engine.js";
/** Bounded writer ops one tick spends withdrawing excluded work; the rest waits a tick. */
const MAX_RETIRE_PASSES = 8;
/**
 * How long a source whose admission scan found nothing is left unscanned.
 * When every document of a source within the horizon is covered or queued,
 * its backlog query reads every one of them before returning empty, on the
 * main thread. An idle engine ticks every few seconds, so rescanning on each
 * tick would block the event loop over and over to learn nothing new. Arrivals
 * and edits are admitted by intake, not by these scans; a later page of the
 * source's initial inventory and a changed horizon, recent window or exclusion
 * list end the rest at once. What remains — coverage that expires, work
 * withdrawn without coverage — is not owed within minutes by routine lanes.
 */
export const EXHAUSTED_SOURCE_REST_MS = 30 * 60_000;
/** In-memory rest per (lane, source); a restart rescans every source once. */
class ExhaustedSources {
  private readonly rests = new Map<string, { until: number; mark: number }>();
  private scope = "";
  /** Forget every rest when the settings that bound eligibility change. */
  syncScope(scope: string): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.rests.clear();
  }
  /** `mark` is the source's inventory watermark; a newer one ends the rest. */
  isResting(lane: string, sourceId: string, mark: number, now: number): boolean {
    const key = `${lane}\0${sourceId}`;
    const rest = this.rests.get(key);
    if (!rest) return false;
    if (rest.until > now && rest.mark === mark) return true;
    this.rests.delete(key);
    return false;
  }
  rest(lane: string, sourceId: string, mark: number, now: number): void {
    this.rests.set(`${lane}\0${sourceId}`, { until: now + EXHAUSTED_SOURCE_REST_MS, mark });
  }
}
interface IntakeContext {
  deps: KnowledgeEngineDeps;
  id: (prefix: string) => string;
  source: (id: string) => {
    id: string;
    title: string;
    content: string;
    contentHash: string;
    sourceRevision: string;
  } | null;
  pageArcs: (input: string, after: string, limit: number) => MaintenanceArc[];
  roots: () => Set<string>;
}
/** Incremental interpretation and operator-authorized historical admission share durable work. */
export class KnowledgeIntake {
  private readonly exhausted = new ExhaustedSources();
  constructor(private readonly context: IntakeContext) {}
  /** Latest page any initial inventory of the source recorded; 0 without one. */
  private inventoryMark(sourceId: string, hasInventory: boolean): number {
    if (!hasInventory) return 0;
    return (
      this.context.deps.db
        .prepare<
          [string],
          { mark: number | null }
        >("SELECT MAX(observed_at) AS mark FROM source_inventories WHERE source_id=?")
        .get(sourceId)?.mark ?? 0
    );
  }
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
        const erasureGeneration = this.context.deps.decisions.record
          ? knowledgeDecisionErasureGeneration(this.context.deps.db)
          : 0;
        const source = this.context.source(change.entityId);
        if (source) {
          // Explicit initial inventory has its own recent-first admission. The
          // journal may be acknowledged because revision-keyed inventory persists.
          if (
            source.sourceRevision === source.contentHash &&
            isInventoryRevision(this.context.deps.db, source.id, source.contentHash)
          ) {
            await this.context.deps.writeGate["knowledge.ackChanges"](change.seq);
            continue;
          }
          const covered = this.context.deps.db
            .prepare(
              "SELECT 1 FROM knowledge_discovery_coverage WHERE subject_id=? AND input_revision=? AND phase='organization' AND policy_version=? AND status IN ('considered','gated') AND (reconsider_at IS NULL OR reconsider_at>?)",
            )
            .get(
              source.id,
              source.sourceRevision,
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
          const decisionId =
            readiness.ready && this.context.deps.decisions.record
              ? this.context.id("kd")
              : undefined;
          const score = readiness.ready
            ? await judgeKnowledge(
                this.context.deps.decisions,
                "urgency",
                await knowledgeUrgencyState(
                  { documentId: source.id, title: source.title, content: source.content },
                  this.context.deps.interest,
                ),
                {
                  nodeId: `source:${source.id}`,
                  ...(decisionId
                    ? {
                        id: decisionId,
                        urgencyCapture: {
                          sourceId: source.id,
                          inputRevision: source.sourceRevision,
                          erasureGeneration,
                          policy: {
                            immediateThreshold: cfg.immediateThreshold,
                            soonThreshold: cfg.soonThreshold,
                            soonDelayMs: cfg.soonDelayMs,
                            routineDelayMs: cfg.routineDelayMs,
                          },
                        },
                      }
                    : {}),
                },
              )
            : null;
          const now = this.context.deps.clock();
          await this.context.deps.writeGate["knowledge.enqueue"](
            {
              id: this.context.id("kw"),
              subjectId: source.id,
              subjectKind: "source",
              reason: "change",
              inputRevision: source.sourceRevision,
              ...(decisionId ? { urgencyDecision: { id: decisionId, anchorAt: now } } : {}),
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
        change.kind === "source_evidence_changed" ||
        change.kind === "source_deleted"
      ) {
        // A deleted source has no interpretation left to run; like changed
        // explicit evidence, its direct dependents are queued for review.
        const sourceEvidence =
          change.kind === "source_evidence_changed" || change.kind === "source_deleted";
        // The change ledger retains the committed creation revision even if
        // the page has already been edited again before intake catches up.
        const newWiki =
          change.kind === "node_changed" &&
          change.revision === "1" &&
          getKnowledgeNode(this.context.deps.db, change.entityId)?.kind === "wiki";
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
          const initialRoot = node.kind === "root" && !node.plainText;
          const newWikiOrientation = node.kind === "root" && newWiki;
          await this.context.deps.writeGate["knowledge.enqueue"](
            {
              id: this.context.id("kw"),
              subjectId: id,
              subjectKind: "node",
              reason: node.kind === "root" ? "root" : "change",
              inputRevision: String(node.revision),
              tier: initialRoot ? "immediate" : newWikiOrientation ? "soon" : "routine",
              dueAt: initialRoot
                ? now
                : now + (newWikiOrientation ? cfg.soonDelayMs : cfg.routineDelayMs),
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

  private async recentInventory(notBefore: string): Promise<void> {
    const { deps } = this.context;
    if (!hasSourceInventoryTables(deps.db)) return;
    const cfg = deps.getSettings().knowledge;
    const pending = deps.db
      .prepare<
        [],
        { count: number }
      >(`SELECT COUNT(*) AS count FROM knowledge_work w JOIN source_inventory_documents si ON si.document_id=w.subject_id AND si.input_revision=w.input_revision WHERE w.subject_kind='source' AND w.reason='change' AND w.status IN ('pending','batched')`)
      .get()!.count;
    const room = Math.max(0, cfg.discoveryBatchSize - pending);
    if (!room) return;
    const checkpoint = deps.db
      .prepare<
        [],
        { revision: number; value_json: string }
      >("SELECT revision,value_json FROM knowledge_checkpoints WHERE id='knowledge:inventory:source'")
      .get();
    const after = checkpoint
      ? (JSON.parse(checkpoint.value_json) as { sourceId: string }).sourceId
      : "";
    const included = brainSourceInclusionSql(deps.getSettings().excludedSources, "source_id");
    const sources = deps.db
      .prepare<
        unknown[],
        { sourceId: string }
      >(`SELECT DISTINCT source_id AS sourceId FROM source_inventories WHERE ${included.sql} ORDER BY source_id<=?,source_id LIMIT ?`)
      .all(...included.params, after, Math.min(cfg.bootstrapBatchSize, room));
    for (const { sourceId } of sources) {
      const mark = this.inventoryMark(sourceId, true);
      if (this.exhausted.isResting("inventory", sourceId, mark, deps.clock())) continue;
      const docs = listKnowledgeDiscoveryBacklog(deps.db, {
        phase: "organization",
        sourceId,
        direction: "recent-first",
        recentInventoryWindowMs: cfg.recentWindowMs,
        notBefore,
        limit: 1,
        now: deps.clock(),
      });
      if (!docs.length) this.exhausted.rest("inventory", sourceId, mark, deps.clock());
      for (const doc of docs) {
        const now = deps.clock();
        await deps.writeGate["knowledge.enqueue"](
          {
            id: this.context.id("kw"),
            subjectId: doc.id,
            subjectKind: "source",
            reason: "change",
            inputRevision: doc.sourceRevision,
            // Ready now is not urgent: initial catch-up must share ordinary
            // capacity with overdue reviews instead of outranking them forever.
            tier: "routine",
            dueAt: now,
          },
          now,
        );
      }
    }
    if (sources.length)
      await deps.writeGate["knowledge.checkpoint"](
        {
          id: "knowledge:inventory:source",
          expectedRevision: checkpoint?.revision ?? 0,
          value: { sourceId: sources.at(-1)!.sourceId },
        },
        deps.clock(),
      );
  }

  /**
   * Withdraw pending source work of sources excluded from the Brain, whatever
   * admitted it. Each tick runs it after every admission step and before
   * planning, so no excluded work is batched; the list is re-read every tick,
   * so an exclusion added while the gateway runs applies without a restart.
   * Each writer op is bounded; a large backlog drains over a few of them.
   */
  async retireExcluded(): Promise<void> {
    const excluded = this.context.deps.getSettings().excludedSources;
    let retired = 0;
    for (
      let pass = 0;
      pass < MAX_RETIRE_PASSES &&
      hasKnowledgeWorkFromExcludedSources(this.context.deps.db, excluded);
      pass++
    )
      retired += await this.context.deps.writeGate["knowledge.retireExcludedSources"](excluded);
    if (retired)
      this.context.deps.log.info(
        `Retired ${retired} pending work item(s) from sources excluded from the Brain`,
      );
  }

  async bootstrap(): Promise<void> {
    const settings = this.context.deps.getSettings(),
      cfg = settings.knowledge,
      backfill = settings.bootstrap;
    // One floor for the whole pass, recomputed every tick: documents age past
    // it while they wait, and the operator can move it without a restart.
    const notBefore = historyHorizonFloor(this.context.deps.clock(), backfill.horizonMs);
    this.exhausted.syncScope(
      JSON.stringify([
        backfill.horizonMs,
        cfg.recentWindowMs,
        [...settings.excludedSources].sort(),
      ]),
    );
    // Retired whether or not admission is open: pausing must not leave work
    // the horizon already excludes queued for the moment it resumes.
    if (hasHistoricalKnowledgeWorkBeyond(this.context.deps.db, notBefore)) {
      const retired = await this.context.deps.writeGate["knowledge.retireBeyondHorizon"](notBefore);
      this.context.deps.log.info(
        `Retired ${retired} pending historical work item(s) dated before the history horizon (${notBefore})`,
      );
    }
    const excluded = settings.excludedSources;
    await this.recentInventory(notBefore);
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
    const included = brainSourceInclusionSql(excluded, "source_id");
    const sources = this.context.deps.db
      .prepare<
        unknown[],
        { source_id: string }
      >(`SELECT DISTINCT source_id FROM documents WHERE source_id>? AND ${included.sql} ORDER BY source_id LIMIT ?`)
      .all(after, ...included.params, limit);
    if (sources.length < limit) {
      sources.push(
        ...this.context.deps.db
          .prepare<
            unknown[],
            { source_id: string }
          >(`SELECT DISTINCT source_id FROM documents WHERE source_id<=? AND ${included.sql} ORDER BY source_id LIMIT ?`)
          .all(after, ...included.params, limit - sources.length),
      );
    }
    let remaining = sources;
    let admitted = 0;
    let lastSourceId: string | undefined;
    const hasInventory = hasSourceInventoryTables(this.context.deps.db);
    // One document per source per round gives every selected source a turn,
    // then reuses spare capacity from exhausted sources. Pending writes exclude
    // the previous round's inputs, so reads stay bounded by admissions + sources.
    while (remaining.length && admitted < limit) {
      const nextRound: typeof sources = [];
      for (const source of remaining) {
        if (admitted >= limit) break;
        lastSourceId = source.source_id;
        const mark = this.inventoryMark(source.source_id, hasInventory);
        if (this.exhausted.isResting("history", source.source_id, mark, this.context.deps.clock()))
          continue;
        const [doc] = listKnowledgeDiscoveryBacklog(this.context.deps.db, {
          phase: "organization",
          sourceId: source.source_id,
          direction: backfill.direction,
          notBefore,
          ...(hasInventory ? { excludeRecentInventoryWindowMs: cfg.recentWindowMs } : {}),
          limit: 1,
          now: this.context.deps.clock(),
        });
        if (!doc) {
          this.exhausted.rest("history", source.source_id, mark, this.context.deps.clock());
          continue;
        }
        const now = this.context.deps.clock();
        await this.context.deps.writeGate["knowledge.enqueue"](
          {
            id: this.context.id("kw"),
            subjectId: doc.id,
            subjectKind: "source",
            reason: "discovery",
            inputRevision: doc.sourceRevision,
            // Historical reading is explicitly admitted work, not a live edit
            // awaiting coalescing. Keep its lower priority without delaying it.
            tier: "routine",
            dueAt: now,
          },
          now,
        );
        admitted++;
        nextRound.push(source);
      }
      remaining = nextRound;
    }
    if (lastSourceId !== undefined)
      await this.context.deps.writeGate["knowledge.checkpoint"](
        {
          id: "knowledge:bootstrap:source",
          expectedRevision: checkpoint?.revision ?? 0,
          value: { sourceId: lastSourceId },
        },
        this.context.deps.clock(),
      );
  }
}
