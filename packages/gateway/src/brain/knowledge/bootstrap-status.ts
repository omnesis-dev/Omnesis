// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readProviderOutage, type BootstrapSettingsView } from "../bootstrap-status.js";
import { bootstrapWindowOpen, bootstrapWindowOpensAt } from "../bootstrap-window.js";
import { cognitionBudgetVerdict, type CognitionBudgetSettings } from "../cognition/budget.js";
import { readKnowledgeInventoryStatus } from "./inventory-status.js";
import { historicalKnowledgeAdmissions } from "./work.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery.js";
import type Database from "better-sqlite3";

/** Durable admission and coverage milestones; never legacy processed-document markers. */
export function readKnowledgeBootstrapStatus(
  db: Database.Database,
  settings: BootstrapSettingsView,
  now: number,
  budgetSettings?: CognitionBudgetSettings,
) {
  const marker = db
    .prepare<[string], { value: string }>("SELECT value FROM cognition_engine_state WHERE key=?")
    .get("bootstrap_started_at");
  const startedAt = marker && Number.isFinite(Number(marker.value)) ? Number(marker.value) : null;
  const seeds = {
    ...historicalKnowledgeAdmissions(db, now),
    ...db
      .prepare<[], { pending: number; batched: number; completed: number; deferred: number }>(
        `
      SELECT COALESCE(SUM(status='pending'),0) AS pending,COALESCE(SUM(status='batched'),0) AS batched,
      COALESCE(SUM(status='completed'),0) AS completed,COALESCE(SUM(status='deferred'),0) AS deferred
      FROM knowledge_work WHERE subject_kind='source' AND reason IN ('discovery','upgrade')`,
      )
      .get()!,
  };
  const windowOpen = bootstrapWindowOpen(settings.activeHours, now);
  const budget = budgetSettings ? cognitionBudgetVerdict(db, budgetSettings, now) : null;
  const state = !settings.enabled
    ? "off"
    : startedAt === null
      ? "unstarted"
      : budget?.exhausted
        ? "parked"
        : seeds.total >= settings.maxRuns
          ? "parked"
          : !windowOpen || seeds.today >= settings.maxRunsPerDay
            ? "waiting"
            : "running";
  const reason = !settings.enabled
    ? "Historical discovery is disabled; live evidence discovery remains active."
    : startedAt === null
      ? "Historical discovery awaits the operator's start; live evidence discovery remains active."
      : budget?.exhausted
        ? "Historical discovery is paused by the shared cognition spend ceiling."
        : seeds.total >= settings.maxRuns
          ? "Historical discovery reached its lifetime admission backstop."
          : !windowOpen
            ? "Historical admission resumes in its configured daily window."
            : seeds.today >= settings.maxRunsPerDay
              ? "Historical discovery reached today's admission backstop."
              : "Historical discovery is enabled. Coverage records interpretation and organization separately; an empty queue does not prove corpus completion.";
  return {
    mode: "knowledge" as const,
    state,
    reason,
    settings,
    startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
    computedAt: new Date(now).toISOString(),
    liveDiscoveryIndependent: true,
    admission: {
      unit: "source-revision-work-items" as const,
      ...seeds,
      remainingLifetime: Math.max(0, settings.maxRuns - seeds.total),
      remainingToday: Math.max(0, settings.maxRunsPerDay - seeds.today),
      backlogRoom: Math.max(0, settings.backlogTarget - seeds.pending - seeds.batched),
      windowOpen,
      windowOpensAt: windowOpen ? null : bootstrapWindowOpensAt(settings.activeHours, now),
    },
    budget,
    providerOutage: readProviderOutage(db, now),
    batches: db
      .prepare(
        `SELECT b.status,COUNT(*) AS count FROM knowledge_batches b
      WHERE EXISTS(SELECT 1 FROM knowledge_work w WHERE w.batch_id=b.id AND w.reason IN ('discovery','upgrade')) GROUP BY b.status`,
      )
      .all(),
    revisionCoverage: db
      .prepare(
        `SELECT phase,status,COUNT(*) AS count FROM knowledge_discovery_coverage WHERE policy_version=? GROUP BY phase,status`,
      )
      .all(KNOWLEDGE_DISCOVERY_POLICY),
    conversion: db
      .prepare(
        "SELECT id,revision,updated_at AS updatedAt FROM knowledge_checkpoints WHERE id LIKE 'knowledge:conversion:%' ORDER BY id",
      )
      .all(),
    recentWindowMs: settings.knowledgeRecentWindowMs ?? 30 * 86_400_000,
    inventory: readKnowledgeInventoryStatus(
      db,
      settings.knowledgeRecentWindowMs ?? 30 * 86_400_000,
    ),
    corpusCompletion: "not-measured" as const,
  };
}
