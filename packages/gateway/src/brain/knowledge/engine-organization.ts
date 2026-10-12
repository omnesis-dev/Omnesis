// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  selectOrganizationCohort,
  getOrganizationCohortForBatch,
  isOrganizationCohortCurrent,
} from "./organization-cohorts.js";
import {
  planMaintenanceGroups,
  MaintenancePlanLimitError,
  type MaintenanceArc,
} from "./planner.js";
import { KnowledgeStorageError } from "./types.js";
import type { KnowledgeFrontierInput } from "./work.js";
import type { KnowledgeEngineDeps } from "./engine.js";

interface OrganizationContext {
  deps: KnowledgeEngineDeps;
  id: (prefix: string) => string;
  frontier: (id: string, depth: number) => KnowledgeFrontierInput | null;
  arcs: (id: string) => MaintenanceArc[];
  roots: () => Set<string>;
}
/** Explicit joint discovery grouping; cohort membership never adds graph edges. */
export class KnowledgeOrganization {
  private nextSelectionAt = 0;
  constructor(private readonly context: OrganizationContext) {}
  async plan(): Promise<number> {
    const { deps } = this.context;
    const cfg = deps.getSettings().knowledge;
    if (cfg.maxSeeds < 2) return 0;
    const now = deps.clock();
    // Empty selections must not rescan settled history on every scheduler tick.
    // Restarting costs one read, while persisted cohorts retain model admission backoff.
    if (now < this.nextSelectionAt) return 0;
    this.nextSelectionAt = now + Math.max(1000, Math.min(60000, cfg.routineDelayMs));
    const selection = selectOrganizationCohort(deps.db, {
      now,
      limit: Math.min(8, cfg.maxSeeds),
      intervalMs: Math.max(60000, cfg.routineDelayMs),
      retryMs: Math.max(60000, cfg.maxReviewIntervalMs),
    });
    if (!selection) return 0;
    const ids = Object.keys(selection.sourceVersions);
    const frontier = ids.flatMap((id) => {
      const item = this.context.frontier(`source:${id}`, 0);
      return item ? [item] : [];
    });
    if (frontier.length !== ids.length) return 0;
    try {
      const groups = planMaintenanceGroups(
        ids.map((id) => ({
          id,
          revision: selection.sourceVersions[id]!,
          changedAt: now,
          dueAt: now,
          tier: "routine" as const,
          targets: [`source:${id}`],
        })),
        (id) => this.context.arcs(id).map((arc) => arc.dependent),
        this.context.roots(),
        cfg,
      );
      const regionNodeIds = [...new Set(groups.flatMap((group) => group.nodes))];
      // The union is bounded too, even when each individual source region fits.
      if (regionNodeIds.length > cfg.maxVisitedPerSeed) return 0;
      await deps.writeGate["knowledge.startOrganization"](
        {
          ...selection,
          id: this.context.id("ko"),
          batchId: this.context.id("kb"),
          runId: this.context.id("cog"),
          workPrefix: this.context.id("kw"),
          intervalMs: Math.max(60000, cfg.routineDelayMs),
          retryMs: Math.max(60000, cfg.maxReviewIntervalMs),
          regionNodeIds,
          frontier,
        },
        now,
      );
      return 1;
    } catch (error) {
      if (
        error instanceof MaintenancePlanLimitError ||
        (error instanceof KnowledgeStorageError && error.code === "revision_conflict")
      )
        return 0;
      throw error;
    }
  }
  async current(batchId: string): Promise<boolean> {
    const { deps } = this.context;
    const cohort = getOrganizationCohortForBatch(deps.db, batchId);
    // Privacy cleanup erases cohort reasons and membership before this run resumes.
    // Its durable run marker prevents that erasure becoming an ordinary completed pass.
    const missing =
      !cohort &&
      !!deps.db
        .prepare(
          `SELECT 1 FROM knowledge_batches b JOIN cognition_runs r ON r.id=b.run_id
      WHERE b.id=? AND json_extract(r.payload_json,'$.organizationCohortId') IS NOT NULL`,
        )
        .get(batchId);
    if (
      !missing &&
      (!cohort || cohort.status !== "pending" || isOrganizationCohortCurrent(deps.db, cohort))
    )
      return true;
    await deps.writeGate["knowledge.abandonBatch"](
      { batchId, notBefore: deps.clock() + deps.getSettings().knowledge.routineDelayMs },
      deps.clock(),
    );
    return false;
  }
  view(batchId: string) {
    const { deps } = this.context;
    const cohort = getOrganizationCohortForBatch(deps.db, batchId);
    if (!cohort || cohort.status !== "pending") return undefined;
    return {
      id: cohort.id,
      inputFingerprint: cohort.inputFingerprint,
      sourceIds: Object.keys(cohort.sourceVersions),
      readyToComplete: !deps.db
        .prepare(
          "SELECT 1 FROM knowledge_frontier WHERE batch_id=? AND status IN ('pending','offered','deferred') LIMIT 1",
        )
        .get(batchId),
    };
  }
}
