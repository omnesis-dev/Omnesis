// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  selectOrganizationCohort,
  getOrganizationCohortForBatch,
  isOrganizationCohortCurrent,
  narrowOrganizationSelection,
  newSubjectCohortTally,
  type OrganizationCohortSelection,
  type SubjectCohortTally,
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
/** Why a selected cohort did not start. */
export type OrganizationDropReason =
  | "unreadable_source"
  | "region_limit"
  | "seed_limit"
  | "revision_conflict";
interface FittedCohort {
  selection: OrganizationCohortSelection;
  frontier: KnowledgeFrontierInput[];
  regionNodeIds: string[];
  shed: number;
}
type Settings = ReturnType<KnowledgeEngineDeps["getSettings"]>["knowledge"];

/** Explicit joint discovery grouping; cohort membership never adds graph edges. */
export class KnowledgeOrganization {
  private nextSelectionAt = 0;
  /** Subjects that could not start, by anchor outcome, until they may be tried again. */
  private readonly passedOver = new Map<string, number>();
  /** The last line logged per report kind, so a repeated state is not logged every tick. */
  private readonly lastReports = new Map<"drop" | "subjects", { key: string; at: number }>();
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
    for (const [loopId, until] of this.passedOver) if (until <= now) this.passedOver.delete(loopId);
    // Subjects are paced like soon work: an important matter without a page
    // should not wait behind the routine cadence of chronological cohorts.
    const subjectIntervalMs = Math.max(60000, cfg.soonDelayMs);
    const tally = newSubjectCohortTally();
    const selection = selectOrganizationCohort(deps.db, {
      now,
      limit: Math.min(8, cfg.maxSeeds),
      intervalMs: Math.max(60000, cfg.routineDelayMs),
      retryMs: Math.max(60000, cfg.maxReviewIntervalMs),
      excludedSources: deps.getSettings().excludedSources,
      subjectIntervalMs,
      skipSubjects: new Set(this.passedOver.keys()),
      subjectTally: tally,
    });
    if (tally.evaluated && !selection?.subjectLoopId) this.reportSubjects(tally, now, cfg);
    if (!selection) return 0;
    const fitted = this.fit(selection, now, cfg);
    if (typeof fitted === "string") return this.drop(selection, fitted, now, cfg);
    const chosen = fitted.selection;
    try {
      await deps.writeGate["knowledge.startOrganization"](
        {
          ...chosen,
          id: this.context.id("ko"),
          batchId: this.context.id("kb"),
          runId: this.context.id("cog"),
          workPrefix: this.context.id("kw"),
          intervalMs: Math.max(60000, cfg.routineDelayMs),
          retryMs: Math.max(60000, cfg.maxReviewIntervalMs),
          subjectIntervalMs,
          regionNodeIds: fitted.regionNodeIds,
          frontier: fitted.frontier,
        },
        now,
      );
    } catch (error) {
      if (error instanceof KnowledgeStorageError && error.code === "revision_conflict")
        return this.drop(selection, "revision_conflict", now, cfg);
      throw error;
    }
    const count = Object.keys(chosen.sourceVersions).length;
    deps.log.info(
      `Organization cohort started: ${describe(chosen)}, ${count} source(s)${fitted.shed ? `, ${fitted.shed} shed` : ""}`,
    );
    return 1;
  }

  /**
   * Plans the cohort's maintenance region. A subject sheds its least recently
   * attached sources until the region fits, so one source behind a large
   * region cannot keep the whole matter from being organized; other cohorts
   * keep their exact membership.
   */
  private fit(
    selection: OrganizationCohortSelection,
    now: number,
    cfg: Settings,
  ): FittedCohort | OrganizationDropReason {
    const subject = selection.subjectLoopId !== undefined;
    const frontier = new Map<string, KnowledgeFrontierInput>();
    for (const id of Object.keys(selection.sourceVersions)) {
      const item = this.context.frontier(`source:${id}`, 0);
      if (item) frontier.set(id, item);
      else if (!subject) return "unreadable_source";
    }
    let ids = [...frontier.keys()];
    let reason: OrganizationDropReason = "unreadable_source";
    while (ids.length >= 2) {
      let groups: ReturnType<typeof planMaintenanceGroups>;
      try {
        groups = planMaintenanceGroups(
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
      } catch (error) {
        if (!(error instanceof MaintenancePlanLimitError)) throw error;
        reason = error.limit === "region" ? "region_limit" : "seed_limit";
        const seedId = error.seedId;
        if (!subject || error.limit !== "region" || !seedId) return reason;
        ids = ids.filter((id) => id !== seedId);
        continue;
      }
      const regionNodeIds = [...new Set(groups.flatMap((group) => group.nodes))];
      // The union is bounded too, even when each individual source region fits.
      if (regionNodeIds.length > cfg.maxVisitedPerSeed) {
        reason = "region_limit";
        if (!subject) return reason;
        ids = ids.slice(0, -1);
        continue;
      }
      const shed = Object.keys(selection.sourceVersions).length - ids.length;
      return {
        selection: shed ? narrowOrganizationSelection(selection, ids) : selection,
        frontier: ids.map((id) => frontier.get(id)!),
        regionNodeIds,
        shed,
      };
    }
    return reason;
  }

  /**
   * A subject that cannot start is passed over so the next subject, or a
   * chronological cohort, gets the slot; without that the same subject would
   * be selected again on every tick. A conflict with work already admitted
   * (an overlapping region, evidence picked up meanwhile) clears by itself,
   * so it waits one subject interval; a region that does not fit waits a
   * routine delay.
   */
  private drop(
    selection: OrganizationCohortSelection,
    reason: OrganizationDropReason,
    now: number,
    cfg: Settings,
  ): 0 {
    const retryMs = Math.max(
      60000,
      reason === "revision_conflict" ? cfg.soonDelayMs : cfg.routineDelayMs,
    );
    if (selection.subjectLoopId) this.passedOver.set(selection.subjectLoopId, now + retryMs);
    const message = `Organization cohort not started: ${describe(selection)}, ${Object.keys(selection.sourceVersions).length} source(s), reason ${reason}`;
    if (selection.subjectLoopId)
      this.context.deps.log.info(`${message}; passing over the subject for ${retryMs}ms`);
    else if (this.due("drop", `${selection.inputFingerprint}:${reason}`, now, retryMs))
      this.context.deps.log.info(message);
    return 0;
  }

  /** Says why the subject pass offered nothing, when that changes or once per routine delay. */
  private reportSubjects(tally: SubjectCohortTally, now: number, cfg: Settings): void {
    const { evaluated: _evaluated, ...counts } = tally;
    if (!this.due("subjects", JSON.stringify(counts), now, Math.max(60000, cfg.routineDelayMs)))
      return;
    this.context.deps.log.info(
      `Subject organization cohorts: none started; ${tally.important} important outcome(s), ${tally.uncovered} without a page, in ${tally.subjects} subject(s); ${tally.waiting} waiting their retry, ${tally.skipped} passed over after a failed start, ${tally.lackingEvidence} with fewer than two considered documents (${tally.lackingConsidered} of their ${tally.lackingDocuments} considered)`,
    );
  }

  private due(kind: "drop" | "subjects", key: string, now: number, intervalMs: number): boolean {
    const last = this.lastReports.get(kind);
    if (last?.key === key && now < last.at + intervalMs) return false;
    this.lastReports.set(kind, { key, at: now });
    return true;
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
      ...(cohort.subjectLoopId ? { subject: { loopRef: `loop:${cohort.subjectLoopId}` } } : {}),
      readyToComplete: !deps.db
        .prepare(
          "SELECT 1 FROM knowledge_frontier WHERE batch_id=? AND status IN ('pending','offered','deferred') LIMIT 1",
        )
        .get(batchId),
    };
  }
}

function describe(selection: OrganizationCohortSelection): string {
  return selection.subjectLoopId
    ? `subject anchored on loop ${selection.subjectLoopId}`
    : "chronological";
}
