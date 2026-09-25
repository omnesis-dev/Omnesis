// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Briefs feed ranking engine — the simple hand-set V1 algorithm.
 * Pure functions over already-selected rows: storage picks the showable
 * briefs (`unread`/`read`, `next_show` null-or-past, `relevant_until`
 * unexpired); this module orders them. No learned ranking, no
 * confidence-threshold gate — every showable brief ranks.
 *
 * Ordering, outermost key first:
 *
 *   1. `unread` before `read` — on return visits, seen briefs sort last.
 *   2. Tier, derived from `event_at` / `kind` / the related loops'
 *      deadlines (first match wins):
 *        0 next-hour   `event_at` within [now, now+1h]
 *        1 today       `event_at` on today's local day
 *        2 due loop    kind=loop with an open related loop due on or
 *                      before today
 *        3 other loop  kind=loop otherwise (confirm-done briefs land here)
 *        4 ambient     kind=info otherwise
 *   3. Within the two time tiers: `event_at` ascending — soonest first.
 *   3b. Deadline-proximity gradient (all tiers): a nearer open related-loop
 *      deadline sorts first — a continuous ramp inside a ~7-day window so a
 *      loop due in 2 days outranks one due in 20 (the binary due tier can't).
 *   4. The scalar sort: urgency desc, confidence desc, `relevant_until`
 *      asc (nulls last — briefs about to expire surface before
 *      open-ended ones), created_at desc, id (a total order, so the
 *      feed is stable across refreshes).
 *
 * Local-day comparisons use the gateway machine's local time — the same
 * deliberately-simple V1 basis as the daily rhythm.
 */

import { cognitionSpendDay } from "./storage/spend.js";
import type { BriefRow } from "./storage/types.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Window (days) over which a loop's deadline proximity ramps 0→1 toward the day. */
const PROXIMITY_WINDOW_DAYS = 7;

/** Feed tiers, in display order (lower ranks first). */
export const FEED_TIER = {
  nextHour: 0,
  today: 1,
  dueLoop: 2,
  otherLoop: 3,
  ambientInfo: 4,
} as const;

export type FeedTier = (typeof FEED_TIER)[keyof typeof FEED_TIER];

/**
 * Extract the one signal the ranking engine reads out of a loop's
 * deadline: an optional sortable due day (local `YYYY-MM-DD`).
 *
 * Deadlines are an agent-owned JSON structure the engine never
 * validates. The RECOMMENDED shape (advertised in the open-loop tool
 * descriptions) is
 *
 *   { "type": "any_time" | "by" | "approximate" | "on_day",
 *     "date"?: "YYYY-MM-DD", "note"?: string }
 *
 * A top-level `date` string — a bare day, or a full ISO date-time
 * converted to the local day — yields the due day; a bare-string
 * deadline that parses as a date is tolerated too. Anything else
 * ("any time", prose approximations, shapes of the agent's own
 * invention) yields null and simply never ranks as due.
 */
export function deadlineDueDay(deadline: unknown): string | null {
  if (typeof deadline === "string") return dueDayOfString(deadline);
  if (typeof deadline === "object" && deadline !== null) {
    const date = (deadline as Record<string, unknown>)["date"];
    if (typeof date === "string") return dueDayOfString(date);
  }
  return null;
}

const BARE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function dueDayOfString(s: string): string | null {
  // A bare day is already a local day — never route it through
  // `Date.parse`, which reads it as UTC midnight and would shift it a
  // day in negative-offset timezones.
  if (BARE_DAY_RE.test(s)) return s;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : cognitionSpendDay(ms);
}

/**
 * Derive a brief's feed tier. `relatedLoopDeadlines` carries the
 * deadline structures of the brief's related loops still in state
 * `open` — a resolved or dismissed loop's deadline no longer summons a
 * due/overdue reminder.
 */
export function briefFeedTier(
  brief: Pick<BriefRow, "kind" | "eventAt">,
  relatedLoopDeadlines: readonly unknown[],
  now: number,
): FeedTier {
  if (brief.eventAt !== null) {
    if (brief.eventAt >= now && brief.eventAt <= now + HOUR_MS) return FEED_TIER.nextHour;
    if (cognitionSpendDay(brief.eventAt) === cognitionSpendDay(now)) return FEED_TIER.today;
  }
  if (brief.kind === "loop") {
    const today = cognitionSpendDay(now);
    const due = relatedLoopDeadlines.some((d) => {
      const day = deadlineDueDay(d);
      // Local YYYY-MM-DD days compare correctly as strings.
      return day !== null && day <= today;
    });
    return due ? FEED_TIER.dueLoop : FEED_TIER.otherLoop;
  }
  return FEED_TIER.ambientInfo;
}

/**
 * A continuous 0..1 deadline-proximity score for a loop brief: how close the
 * NEAREST open related-loop deadline sits inside the proximity window. 1 at or
 * past the deadline, ramping linearly down to 0 at the window edge; 0 for an
 * info brief, or a loop whose deadlines are all undated or beyond the window.
 *
 * A ranking SUB-key below the feed tier (see `rankFeedBriefs`), so a loop due
 * in 2 days smoothly outranks one due in 20 — the binary `dueLoop` tier can't
 * tell those apart. Loop deadlines are day-granular (`deadlineDueDay`), so the
 * ramp is computed in whole days. Existing behaviour is preserved wherever this
 * returns 0 (info briefs, undated/far loops tie straight through to urgency).
 */
export function deadlineProximity(deadlines: readonly unknown[], now: number): number {
  const todayMs = Date.parse(cognitionSpendDay(now));
  let best = 0;
  for (const d of deadlines) {
    const day = deadlineDueDay(d);
    if (day === null) continue;
    const daysUntil = (Date.parse(day) - todayMs) / DAY_MS;
    const score =
      daysUntil <= 0
        ? 1
        : daysUntil >= PROXIMITY_WINDOW_DAYS
          ? 0
          : 1 - daysUntil / PROXIMITY_WINDOW_DAYS;
    if (score > best) best = score;
  }
  return best;
}

/** A brief plus the ranking signals that don't live on its row. */
export interface RankableBrief {
  brief: Pick<
    BriefRow,
    "id" | "kind" | "state" | "eventAt" | "urgency" | "confidence" | "relevantUntil" | "createdAt"
  >;
  /** Deadline structures of the brief's related loops in state `open`. */
  relatedLoopDeadlines: readonly unknown[];
}

/**
 * Complete, JSON-safe sort tuple for one feed row. The product cursor stores
 * this tuple so later pages continue at the exact same semantic boundary
 * instead of degrading the ranking to an offset or id-only approximation.
 */
export interface BriefFeedSortKey {
  readGroup: 0 | 1;
  tier: FeedTier;
  eventAt: number | null;
  proximity: number;
  urgency: number;
  confidence: number;
  relevantUntil: number | null;
  createdAt: number;
  id: string;
}

/** Compute the full feed sort tuple for one rankable brief. */
export function briefFeedSortKey(item: RankableBrief, now: number): BriefFeedSortKey {
  return {
    readGroup: item.brief.state === "read" ? 1 : 0,
    tier: briefFeedTier(item.brief, item.relatedLoopDeadlines, now),
    eventAt: item.brief.eventAt,
    proximity: deadlineProximity(item.relatedLoopDeadlines, now),
    urgency: item.brief.urgency,
    confidence: item.brief.confidence,
    relevantUntil: item.brief.relevantUntil,
    createdAt: item.brief.createdAt,
    id: item.brief.id,
  };
}

/**
 * Compare two complete feed keys in display order. Negative means `a` appears
 * before `b`; positive means it belongs on a later cursor page.
 */
export function compareBriefFeedSortKeys(a: BriefFeedSortKey, b: BriefFeedSortKey): number {
  if (a.readGroup !== b.readGroup) return a.readGroup - b.readGroup;
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.tier <= FEED_TIER.today) {
    // Both event_at values are non-null by construction in the time tiers.
    const d = (a.eventAt ?? 0) - (b.eventAt ?? 0);
    if (d !== 0) return d;
  }
  if (a.proximity !== b.proximity) return b.proximity - a.proximity;
  if (a.urgency !== b.urgency) return b.urgency - a.urgency;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  if (a.relevantUntil !== b.relevantUntil) {
    if (a.relevantUntil === null) return 1;
    if (b.relevantUntil === null) return -1;
    return a.relevantUntil - b.relevantUntil;
  }
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Order feed items per the hand-set algorithm (see the module doc). */
export function rankFeedBriefs<T extends RankableBrief>(items: readonly T[], now: number): T[] {
  const keyed = items.map((item) => ({
    item,
    key: briefFeedSortKey(item, now),
  }));
  keyed.sort((a, b) => compareBriefFeedSortKeys(a.key, b.key));
  return keyed.map((k) => k.item);
}
