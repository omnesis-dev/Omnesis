// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { listMorningBriefItems } from "../storage/morning-brief-items.js";
import { getObservation } from "../storage/observations.js";
import { readDueSoonDeltaPrime } from "./delta-prime.js";
import { renderDigestHorizonLines, type DigestHorizon } from "./digest-horizon.js";
import type { ResolvedBrainSettings } from "../config.js";
import type Database from "better-sqlite3";

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** One line per ranked observation the morning recheck chose for `day`. */
export function renderMorningBriefItemLines(db: Database.Database, day: string): string[] {
  const titles = db.prepare<[string], { title: string }>(
    "SELECT title FROM documents WHERE id = ?",
  );
  return listMorningBriefItems(db, day).flatMap((item) => {
    const observation = getObservation(db, item.observationId);
    if (!observation) return [];
    const sources = observation.citations
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

/**
 * The morning brief's input packet: today's horizon, the ranked observations
 * the recheck chose, and the loops coming due. The brief is sent only when
 * one of those three has something in it; loops merely touched recently are
 * context for the composition, never a reason to send.
 */
export function readDigestInputs(
  db: Database.Database,
  now: number,
  cfg: ResolvedBrainSettings,
  horizon: DigestHorizon,
  day: string,
) {
  const horizonLines = renderDigestHorizonLines(horizon);
  const itemLines = renderMorningBriefItemLines(db, day);
  const prime = readDueSoonDeltaPrime(db, { now, cfg });
  return {
    horizonLines,
    itemLines,
    deltaPrime: prime.text,
    hasInputs: horizonLines.length > 0 || itemLines.length > 0 || prime.dueLoopCount > 0,
  };
}
