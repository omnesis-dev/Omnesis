// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { knowledgeOwnerReadPredicate } from "../knowledge/storage-fence.js";
import { excludedDocumentIds } from "../source-exclusion.js";
import { latestSentMorningBrief, listMorningBriefItems } from "../storage/morning-brief-items.js";
import { getObservation } from "../storage/observations.js";
import { readDueSoonDeltaPrime } from "./delta-prime.js";
import { renderDigestHorizonLines, type DigestHorizon } from "./digest-horizon.js";
import type { ResolvedBrainSettings } from "../config.js";
import type { TaskEvent } from "../storage/types.js";
import type Database from "better-sqlite3";

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * One line per ranked observation the morning recheck chose for `day`. A
 * citation of a source excluded from the Brain is left out of the line.
 */
export function renderMorningBriefItemLines(
  db: Database.Database,
  day: string,
  excludedSources: readonly string[] = [],
): string[] {
  const titles = db.prepare<[string], { title: string }>(
    "SELECT title FROM documents WHERE id = ?",
  );
  return listMorningBriefItems(db, day).flatMap((item) => {
    const observation = getObservation(db, item.observationId);
    if (!observation) return [];
    const excluded = excludedDocumentIds(db, excludedSources, observation.citations);
    const sources = observation.citations
      .filter((id) => !excluded.has(id))
      .map((id) => `${titles.get(id)?.title ?? "untitled"} (${id})`)
      .join("; ");
    const window = [
      observation.windowStart !== null ? `from ${iso(observation.windowStart)}` : null,
      observation.relevantUntil !== null ? `until ${iso(observation.relevantUntil)}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return [
      `${item.rank}. [${observation.id}] ${observation.summary}` +
        (observation.why ? ` — why: ${observation.why}` : "") +
        (window ? ` — ${window}` : "") +
        (sources ? ` — sources: ${sources}` : ""),
    ];
  });
}

/** Most task changes the brief is told about; the rest are counted. */
const AUTO_APPLIED_LINES_MAX = 10;

/** How many of the newest task events are read for them. */
const RECENT_TASK_EVENTS_MAX = 2000;

/**
 * One line per change Omnesis applied on its own to the user's tasks since
 * the last brief was sent (or the last day, before the first brief), newest
 * first, leaving out any the user has since undone.
 */
export function renderAutoAppliedTaskLines(db: Database.Database, now: number): string[] {
  const since = latestSentMorningBrief(db)?.sentAt ?? now - 86_400_000;
  const undone = new Set<number>();
  const applied: Array<{ seq: number; loopId: string; event: TaskEvent }> = [];
  // The newest task events, along the primary key: far more than a day's
  // worth of changes, without reading the whole ledger.
  const rows = db
    .prepare<[number], { seq: number; loop_id: string; at: number; event_json: string }>(
      `SELECT seq, loop_id, at, event_json FROM open_loop_ledger
        WHERE event_json IS NOT NULL ORDER BY seq DESC LIMIT ?`,
    )
    .all(RECENT_TASK_EVENTS_MAX);
  for (const row of rows) {
    if (row.at <= since) continue;
    const event = JSON.parse(row.event_json) as TaskEvent;
    if (event.kind === "undone" && event.undoOf !== undefined) undone.add(event.undoOf);
    else if (event.kind === "auto_applied")
      applied.push({ seq: row.seq, loopId: row.loop_id, event });
  }
  const title = db.prepare<[string], { title: string }>(
    `SELECT title FROM open_loops WHERE id = ? AND ${knowledgeOwnerReadPredicate(db, "open_loops.id")}`,
  );
  const lines = applied.flatMap(({ seq, loopId, event }) => {
    if (undone.has(seq)) return [];
    const task = title.get(loopId)?.title;
    if (task === undefined) return [];
    const verb = event.change?.kind === "complete" ? "Marked done" : "Updated";
    return [`- ${verb}: ${task}${event.note ? ` — ${event.note}` : ""}`];
  });
  return lines.length > AUTO_APPLIED_LINES_MAX
    ? [
        ...lines.slice(0, AUTO_APPLIED_LINES_MAX),
        `- … and ${lines.length - AUTO_APPLIED_LINES_MAX} more`,
      ]
    : lines;
}

/**
 * The morning brief's input packet: today's horizon, the ranked observations
 * the recheck chose, and the loops coming due. The brief is sent only when
 * one of those three has something in it; loops merely touched recently,
 * and the task changes Omnesis applied on its own, are context for the
 * composition, never a reason to send.
 */
export function readDigestInputs(
  db: Database.Database,
  now: number,
  cfg: ResolvedBrainSettings,
  horizon: DigestHorizon,
  day: string,
) {
  const horizonLines = renderDigestHorizonLines(horizon);
  const itemLines = renderMorningBriefItemLines(db, day, cfg.excludedSources);
  const prime = readDueSoonDeltaPrime(db, { now, cfg });
  return {
    horizonLines,
    itemLines,
    deltaPrime: prime.text,
    autoAppliedLines: renderAutoAppliedTaskLines(db, now),
    hasInputs: horizonLines.length > 0 || itemLines.length > 0 || prime.dueLoopCount > 0,
  };
}
