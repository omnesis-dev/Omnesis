// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { cognitionBudgetVerdict } from "../cognition/budget.js";
import { judgeKnowledge } from "./decision.js";
import { knowledgeSourceReadiness } from "./engine-readiness.js";
import { listKnowledgePlanningWork, type KnowledgeFrontierInput } from "./work.js";
import {
  scheduleKnowledgeChange,
  planMaintenanceGroups,
  MaintenancePlanLimitError,
  type MaintenanceArc,
} from "./planner.js";
import { KnowledgeStorageError } from "./types.js";
import type { KnowledgeEngineDeps } from "./engine.js";

interface PlanningContext {
  initialRoot: () => string | null;
  deps: KnowledgeEngineDeps;
  id: (prefix: string) => string;
  frontier: (id: string, depth: number) => KnowledgeFrontierInput | null;
  arcs: (input: string) => MaintenanceArc[];
  roots: () => Set<string>;
}
const sourceKey = (id: string) => `source:${id}`;

/** Planning and late admission share the same durable component reservations. */
export class KnowledgeBatchPlanner {
  constructor(private readonly context: PlanningContext) {}
  async plan(): Promise<number> {
    const cfg = this.context.deps.getSettings().knowledge;
    let work = listKnowledgePlanningWork(
      this.context.deps.db,
      cfg.maxSeeds * cfg.maxVisitedPerSeed,
    );
    if (!work.length) return 0;
    // Refresh only stale/missing subjects. Healthy older work cannot monopolize
    // the reconciliation window when there is a large backlog.
    const stale = this.context.deps.db
      .prepare<[], { id: string }>(
        `
      SELECT w.id FROM knowledge_work w
      LEFT JOIN documents d ON w.subject_kind='source' AND d.id=w.subject_id
      LEFT JOIN knowledge_nodes n ON w.subject_kind='node' AND n.id=w.subject_id
      WHERE w.status='pending' AND (
        (w.subject_kind='source' AND (d.id IS NULL OR d.content_hash!=w.input_revision)) OR
        (w.subject_kind='node' AND (n.id IS NULL OR CAST(n.revision AS TEXT)!=w.input_revision OR json_extract(n.fields_json,'$.withdrawn')=1)))
      ORDER BY w.due_at,w.id LIMIT 512`,
      )
      .all();
    if (stale.length) {
      await this.context.deps.writeGate["knowledge.refreshWork"](
        stale.map((item) => item.id),
        this.context.deps.clock(),
      );
      work = listKnowledgePlanningWork(this.context.deps.db, cfg.maxSeeds * cfg.maxVisitedPerSeed);
    }
    // Classify only settled evidence, before deciding whether its tier is due.
    // Held work starts in the latest tier so an urgency verdict can promote it.
    for (const item of work
      .filter(
        (item) =>
          item.subjectKind === "source" &&
          ["pending_content", "derivation"].includes(item.lastError ?? ""),
      )
      .slice(0, cfg.discoveryBatchSize)) {
      if (!knowledgeSourceReadiness(this.context.deps, item.subjectId, item.inputChangedAt).ready)
        continue;
      const now = this.context.deps.clock();
      if (
        cognitionBudgetVerdict(this.context.deps.db, this.context.deps.getSettings().budget, now)
          .exhausted
      )
        break;
      const source = this.context.deps.db
        .prepare<
          [string],
          { title: string; content: string; contentHash: string }
        >("SELECT title,content,content_hash AS contentHash FROM documents WHERE id=?")
        .get(item.subjectId);
      if (!source || source.contentHash !== item.inputRevision) continue;
      const score = await judgeKnowledge(this.context.deps.decisions, "urgency", {
        documentId: item.subjectId,
        title: source.title,
        content: source.content.slice(0, 24000),
      });
      try {
        await this.context.deps.writeGate["knowledge.enqueue"](
          { ...item, ...scheduleKnowledgeChange(score, item.createdAt, cfg) },
          now,
        );
      } catch (error) {
        if (!(error instanceof KnowledgeStorageError && error.code === "revision_conflict"))
          throw error;
      }
    }
    work = listKnowledgePlanningWork(this.context.deps.db, cfg.maxSeeds * cfg.maxVisitedPerSeed);
    const byId = new Map(work.map((item) => [item.id, item]));
    const arcs = (id: string) => this.context.arcs(id).map((arc) => arc.dependent);
    const roots = this.context.roots();
    let eligible = work;
    let groups: ReturnType<typeof planMaintenanceGroups> = [];
    while (eligible.length) {
      try {
        groups = planMaintenanceGroups(
          eligible.map((item) => ({
            id: item.id,
            revision: item.inputRevision,
            changedAt: item.createdAt,
            dueAt: item.dueAt,
            tier: item.tier,
            targets: [item.subjectKind === "source" ? sourceKey(item.subjectId) : item.subjectId],
          })),
          arcs,
          roots,
          { ...cfg, maxSeeds: cfg.maxSeeds * cfg.maxVisitedPerSeed },
        );
        break;
      } catch (error) {
        if (!(error instanceof MaintenancePlanLimitError)) throw error;
        this.context.deps.log.warn(
          "Knowledge maintenance region exceeds its configured bound; affected seed remains pending",
        );
        if (error.limit !== "region" || !error.seedId) return 0;
        eligible = eligible.filter((item) => item.id !== error.seedId);
      }
    }
    const initialRoot = this.context.initialRoot();
    let enqueued = 0;
    for (const group of groups) {
      if (group.dueAt > this.context.deps.clock()) continue;
      if (
        group.seeds.some((seed) => {
          const item = byId.get(seed.id)!;
          return (
            item.subjectKind === "source" &&
            !knowledgeSourceReadiness(this.context.deps, item.subjectId, item.inputChangedAt).ready
          );
        })
      )
        continue;
      const seeds = group.seeds.slice(0, cfg.maxSeeds).map((seed) => byId.get(seed.id)!);
      for (const seed of seeds)
        if (seed.lastError)
          await this.context.deps.writeGate["knowledge.enqueue"](seed, this.context.deps.clock());
      const frontier: KnowledgeFrontierInput[] = [];
      for (const seed of seeds) {
        const item = this.context.frontier(
          seed.subjectKind === "source" ? sourceKey(seed.subjectId) : seed.subjectId,
          0,
        );
        if (item) frontier.push(item);
      }
      if (!frontier.length) continue;
      const batchId = this.context.id("kb");
      const runId = this.context.id("cog");
      try {
        await this.context.deps.writeGate["knowledge.startBatch"](
          {
            id: batchId,
            runId,
            tier: group.tier,
            work: seeds.map((seed) => ({
              id: seed.id,
              generation: seed.generation,
              inputRevision: seed.inputRevision,
            })),
            regionNodeIds: group.nodes,
            frontier,
          },
          {
            id: runId,
            kind: "synthesis",
            payload: {
              focus: "knowledge-maintenance",
              batchId,
              ...(initialRoot &&
              seeds.some((seed) => seed.subjectKind === "node" && seed.subjectId === initialRoot)
                ? { schedulingClass: "initial-root" }
                : {}),
            },
            notBefore: group.dueAt,
          },
          this.context.deps.clock(),
        );
        enqueued++;
      } catch (err) {
        if (err instanceof KnowledgeStorageError && err.code === "revision_conflict") continue;
        throw err;
      }
    }
    return enqueued;
  }

  async adoptOverlappingWork(batchId: string): Promise<void> {
    const cfg = this.context.deps.getSettings().knowledge;
    const existing = this.context.deps.db
      .prepare<
        [string],
        { count: number }
      >("SELECT COUNT(*) AS count FROM knowledge_work WHERE batch_id=?")
      .get(batchId)!.count;
    if (existing >= cfg.maxSeeds) return;
    const owned = this.context.deps.db
      .prepare<[string], { node_id: string }>(
        "SELECT node_id FROM knowledge_batch_regions WHERE batch_id=?",
      )
      .all(batchId)
      .map((row) => row.node_id);
    const work = listKnowledgePlanningWork(
      this.context.deps.db,
      cfg.maxSeeds * cfg.maxVisitedPerSeed,
    );
    if (!work.length) return;
    const arcs = (id: string) => this.context.arcs(id).map((arc) => arc.dependent),
      roots = this.context.roots();
    let groups;
    try {
      groups = planMaintenanceGroups(
        [
          {
            id: "active-region",
            revision: "current",
            changedAt: 0,
            dueAt: 0,
            tier: "immediate",
            targets: owned,
          },
          ...work.map((item) => ({
            id: item.id,
            revision: item.inputRevision,
            changedAt: item.createdAt,
            dueAt: item.dueAt,
            tier: item.tier,
            targets: [item.subjectKind === "source" ? sourceKey(item.subjectId) : item.subjectId],
          })),
        ],
        arcs,
        roots,
        {
          maxSeeds: cfg.maxSeeds * cfg.maxVisitedPerSeed + 1,
          maxVisitedPerSeed: cfg.maxSeeds * cfg.maxVisitedPerSeed,
        },
      );
    } catch (error) {
      if (error instanceof MaintenancePlanLimitError) return;
      throw error;
    }
    const group = groups.find((candidate) =>
      candidate.seeds.some((seed) => seed.id === "active-region"),
    )!;
    const ids = new Set(group.seeds.map((seed) => seed.id));
    const adopted = work.filter((item) => ids.has(item.id)).slice(0, cfg.maxSeeds - existing);
    if (!adopted.length) return;
    const frontier = adopted.flatMap((item) => {
      const next = this.context.frontier(
        item.subjectKind === "source" ? sourceKey(item.subjectId) : item.subjectId,
        0,
      );
      return next ? [next] : [];
    });
    try {
      await this.context.deps.writeGate["knowledge.adoptWork"](
        {
          batchId,
          regionNodeIds: group.nodes,
          work: adopted.map((item) => ({
            id: item.id,
            generation: item.generation,
            inputRevision: item.inputRevision,
          })),
          frontier,
        },
        this.context.deps.clock(),
      );
    } catch (error) {
      if (error instanceof KnowledgeStorageError && error.code === "revision_conflict") {
        if (error.message.includes("overlaps an active batch"))
          await this.context.deps.writeGate["knowledge.abandonBatch"](
            { batchId, notBefore: this.context.deps.clock() },
            this.context.deps.clock(),
          );
      } else throw error;
    }
  }
}
