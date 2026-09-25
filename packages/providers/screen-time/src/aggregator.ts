// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { coreDataToDate, appNameFromBundleId } from "./types.js";
import type { UsageSession } from "./types.js";

interface DailyAppAggregate extends Record<string, unknown> {
  id: string;
  bundle_id: string;
  app_name: string;
  date: string;
  total_seconds: number;
  session_count: number;
  longest_session_seconds: number;
}

/**
 * Aggregate usage sessions into daily per-app summaries.
 * If `dates` is provided, only aggregates sessions for those dates.
 */
export function aggregateDaily(sessions: UsageSession[], dates?: Set<string>): DailyAppAggregate[] {
  const map = new Map<string, DailyAppAggregate>();

  for (const s of sessions) {
    const date = coreDataToDate(s.startDate);
    if (dates && !dates.has(date)) continue;

    const key = `${s.bundleId}:${date}`;
    const existing = map.get(key);

    if (existing) {
      existing.total_seconds += s.durationSeconds;
      existing.session_count += 1;
      existing.longest_session_seconds = Math.max(
        existing.longest_session_seconds,
        s.durationSeconds,
      );
    } else {
      map.set(key, {
        id: key,
        bundle_id: s.bundleId,
        app_name: appNameFromBundleId(s.bundleId),
        date,
        total_seconds: s.durationSeconds,
        session_count: 1,
        longest_session_seconds: s.durationSeconds,
      });
    }
  }

  return Array.from(map.values());
}
