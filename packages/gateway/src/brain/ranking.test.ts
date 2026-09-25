// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The feed ranking engine (pure half): the deadline due-day probe, the
 * tier derivation, and the full hand-set ordering. Time is always an
 * explicit `now` built from local-time Date constructors, so the local-
 * day assertions hold in any timezone the suite runs in.
 */

import { describe, expect, test } from "vitest";
import {
  FEED_TIER,
  briefFeedTier,
  briefFeedSortKey,
  compareBriefFeedSortKeys,
  deadlineDueDay,
  deadlineProximity,
  rankFeedBriefs,
} from "./ranking.js";
import type { BriefRow } from "./storage/types.js";

/** Local noon — comfortably inside one local day in every timezone. */
const NOW = new Date(2026, 5, 15, 12, 0, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

let seq = 0;
function brief(over: Partial<BriefRow> = {}): BriefRow {
  seq += 1;
  return {
    id: over.id ?? `brf_${String(seq).padStart(3, "0")}`,
    createdByRun: "run_test",
    kind: "info",
    title: "A brief",
    description: "",
    body: null,
    citations: [],
    confidence: 0.5,
    urgency: 0.5,
    relevantUntil: null,
    relatedLoopIds: [],
    nextShow: null,
    eventAt: null,
    userFeedback: null,
    state: "unread",
    createdAt: NOW - 24 * HOUR,
    updatedAt: NOW - 24 * HOUR,
    ...over,
  };
}

describe("deadlineDueDay", () => {
  test("reads the recommended shape's date — bare day or full ISO date-time", () => {
    expect(deadlineDueDay({ type: "by", date: "2026-06-20" })).toBe("2026-06-20");
    expect(deadlineDueDay({ type: "on_day", date: "2026-06-20" })).toBe("2026-06-20");
    // A full ISO date-time converts to the LOCAL day of that instant.
    const instant = new Date(2026, 5, 20, 15, 30, 0, 0);
    expect(deadlineDueDay({ type: "by", date: instant.toISOString() })).toBe("2026-06-20");
  });

  test("tolerates a bare-string deadline that parses as a date", () => {
    expect(deadlineDueDay("2026-06-20")).toBe("2026-06-20");
  });

  test("never invents a day: undated types, prose, and junk yield null", () => {
    expect(deadlineDueDay(null)).toBeNull();
    expect(deadlineDueDay(undefined)).toBeNull();
    expect(deadlineDueDay({ type: "any_time" })).toBeNull();
    expect(deadlineDueDay({ type: "approximate", note: "sometime in spring" })).toBeNull();
    expect(deadlineDueDay({ date: 20260620 })).toBeNull();
    expect(deadlineDueDay("whenever works")).toBeNull();
    expect(deadlineDueDay(42)).toBeNull();
    expect(deadlineDueDay([{ date: "2026-06-20" }])).toBeNull();
  });
});

describe("deadlineProximity", () => {
  test("1 at/past the deadline, ramps to 0 at the 7-day window edge; nearest wins", () => {
    expect(deadlineProximity([{ date: "2026-06-14" }], NOW)).toBe(1); // yesterday (overdue)
    expect(deadlineProximity([{ date: "2026-06-15" }], NOW)).toBe(1); // today
    expect(deadlineProximity([{ date: "2026-06-18" }], NOW)).toBeCloseTo(1 - 3 / 7); // +3 days
    expect(deadlineProximity([{ date: "2026-06-22" }], NOW)).toBe(0); // exactly 7 days → edge
    expect(deadlineProximity([{ date: "2026-08-01" }], NOW)).toBe(0); // beyond the window
    expect(deadlineProximity([], NOW)).toBe(0);
    expect(deadlineProximity([{ type: "any_time" }], NOW)).toBe(0); // undated
    // Nearest deadline of the set wins.
    expect(deadlineProximity([{ date: "2026-06-20" }, { date: "2026-06-17" }], NOW)).toBeCloseTo(
      1 - 2 / 7,
    );
  });
});

describe("briefFeedTier", () => {
  test("event_at within [now, now+1h] → next-hour, regardless of kind or deadlines", () => {
    expect(briefFeedTier(brief({ eventAt: NOW + 30 * 60 * 1000 }), [], NOW)).toBe(
      FEED_TIER.nextHour,
    );
    expect(briefFeedTier(brief({ eventAt: NOW }), [], NOW)).toBe(FEED_TIER.nextHour);
    expect(briefFeedTier(brief({ eventAt: NOW + HOUR }), [], NOW)).toBe(FEED_TIER.nextHour);
    // A loop brief with a due deadline still ranks by its imminent event.
    expect(
      briefFeedTier(brief({ kind: "loop", eventAt: NOW + HOUR }), [{ date: "2026-06-14" }], NOW),
    ).toBe(FEED_TIER.nextHour);
  });

  test("event_at elsewhere on today's local day → today (a past event this morning counts)", () => {
    expect(briefFeedTier(brief({ eventAt: NOW - 3 * HOUR }), [], NOW)).toBe(FEED_TIER.today);
    expect(briefFeedTier(brief({ eventAt: NOW + 5 * HOUR }), [], NOW)).toBe(FEED_TIER.today);
  });

  test("a non-today event_at falls through to the kind-derived tiers", () => {
    const tomorrow = new Date(2026, 5, 16, 9, 0, 0, 0).getTime();
    expect(briefFeedTier(brief({ eventAt: tomorrow }), [], NOW)).toBe(FEED_TIER.ambientInfo);
    expect(briefFeedTier(brief({ kind: "loop", eventAt: tomorrow }), [], NOW)).toBe(
      FEED_TIER.otherLoop,
    );
  });

  test("loop briefs: deadline day ≤ today (due or overdue) → due tier, else other-loop", () => {
    const loop = brief({ kind: "loop" });
    expect(briefFeedTier(loop, [{ type: "by", date: "2026-06-15" }], NOW)).toBe(FEED_TIER.dueLoop);
    expect(briefFeedTier(loop, [{ type: "by", date: "2026-06-01" }], NOW)).toBe(FEED_TIER.dueLoop);
    expect(briefFeedTier(loop, [{ type: "by", date: "2026-06-16" }], NOW)).toBe(
      FEED_TIER.otherLoop,
    );
    expect(briefFeedTier(loop, [{ type: "any_time" }], NOW)).toBe(FEED_TIER.otherLoop);
    expect(briefFeedTier(loop, [], NOW)).toBe(FEED_TIER.otherLoop);
    // One due loop among several undated ones is enough.
    expect(briefFeedTier(loop, [{ type: "any_time" }, { date: "2026-06-10" }], NOW)).toBe(
      FEED_TIER.dueLoop,
    );
  });

  test("info briefs without a time hook are ambient", () => {
    expect(briefFeedTier(brief(), [], NOW)).toBe(FEED_TIER.ambientInfo);
  });
});

describe("rankFeedBriefs", () => {
  const item = (b: BriefRow, deadlines: unknown[] = []) => ({
    brief: b,
    relatedLoopDeadlines: deadlines,
  });

  test("orders by tier: next-hour, today, due loop, other loop, ambient info", () => {
    const ambient = item(brief({ id: "brf_ambient" }));
    const nextHour = item(brief({ id: "brf_next", eventAt: NOW + 20 * 60 * 1000 }));
    const today = item(brief({ id: "brf_today", eventAt: NOW + 6 * HOUR }));
    const due = item(brief({ id: "brf_due", kind: "loop" }), [{ date: "2026-06-15" }]);
    const otherLoop = item(brief({ id: "brf_loop", kind: "loop" }));
    const ranked = rankFeedBriefs([ambient, otherLoop, due, today, nextHour], NOW);
    expect(ranked.map((r) => r.brief.id)).toEqual([
      "brf_next",
      "brf_today",
      "brf_due",
      "brf_loop",
      "brf_ambient",
    ]);
  });

  test("read briefs sort last — the outermost key, ahead of any tier", () => {
    const readNextHour = item(
      brief({ id: "brf_read", state: "read", eventAt: NOW + 20 * 60 * 1000 }),
    );
    const unreadAmbient = item(brief({ id: "brf_unread" }));
    const ranked = rankFeedBriefs([readNextHour, unreadAmbient], NOW);
    expect(ranked.map((r) => r.brief.id)).toEqual(["brf_unread", "brf_read"]);
  });

  test("within the time tiers the soonest event comes first", () => {
    const later = item(brief({ id: "brf_later", eventAt: NOW + 50 * 60 * 1000, urgency: 0.9 }));
    const sooner = item(brief({ id: "brf_sooner", eventAt: NOW + 10 * 60 * 1000, urgency: 0.1 }));
    const ranked = rankFeedBriefs([later, sooner], NOW);
    expect(ranked.map((r) => r.brief.id)).toEqual(["brf_sooner", "brf_later"]);
  });

  test("scalar sort within a tier: urgency, then confidence, then sooner relevant_until, then newer created_at", () => {
    const base = { kind: "info" as const };
    const ranked = rankFeedBriefs(
      [
        item(brief({ ...base, id: "brf_old", urgency: 0.5, confidence: 0.5, createdAt: NOW - 5 })),
        item(brief({ ...base, id: "brf_new", urgency: 0.5, confidence: 0.5, createdAt: NOW - 1 })),
        item(
          brief({
            ...base,
            id: "brf_expiring",
            urgency: 0.5,
            confidence: 0.5,
            createdAt: NOW - 9,
            relevantUntil: NOW + HOUR,
          }),
        ),
        item(brief({ ...base, id: "brf_confident", urgency: 0.5, confidence: 0.9 })),
        item(brief({ ...base, id: "brf_urgent", urgency: 0.9, confidence: 0.1 })),
      ],
      NOW,
    );
    expect(ranked.map((r) => r.brief.id)).toEqual([
      "brf_urgent",
      "brf_confident",
      "brf_expiring",
      "brf_new",
      "brf_old",
    ]);
  });

  test("deadline-proximity gradient: a nearer loop deadline outranks a farther one within a tier", () => {
    // Both future dated loops → the otherLoop tier; proximity sits ABOVE
    // urgency, so the nearer deadline wins despite lower urgency.
    const near = item(brief({ id: "brf_near", kind: "loop", urgency: 0.1 }), [
      { date: "2026-06-17" }, // +2 days
    ]);
    const far = item(brief({ id: "brf_far", kind: "loop", urgency: 0.9 }), [
      { date: "2026-06-20" }, // +5 days
    ]);
    const ranked = rankFeedBriefs([far, near], NOW);
    expect(ranked.map((r) => r.brief.id)).toEqual(["brf_near", "brf_far"]);
  });

  test("undated / beyond-window loops get no proximity boost — they tie through to urgency", () => {
    const undated = item(brief({ id: "brf_undated", kind: "loop", urgency: 0.9 }));
    const farOut = item(brief({ id: "brf_farout", kind: "loop", urgency: 0.1 }), [
      { date: "2026-08-01" }, // well beyond the 7-day window
    ]);
    const ranked = rankFeedBriefs([farOut, undated], NOW);
    // Both proximity 0 → urgency decides.
    expect(ranked.map((r) => r.brief.id)).toEqual(["brf_undated", "brf_farout"]);
  });

  test("full order is deterministic: id breaks exact ties", () => {
    const a = item(brief({ id: "brf_a", createdAt: NOW - 10 }));
    const b = item(brief({ id: "brf_b", createdAt: NOW - 10 }));
    expect(rankFeedBriefs([b, a], NOW).map((r) => r.brief.id)).toEqual(["brf_a", "brf_b"]);
  });

  test("the cursor sort key preserves the complete semantic order", () => {
    const rows = [
      item(brief({ id: "brf_read", state: "read", urgency: 1 })),
      item(brief({ id: "brf_ambient", urgency: 0.2 })),
      item(brief({ id: "brf_loop", kind: "loop", urgency: 0.8 })),
      item(brief({ id: "brf_next", eventAt: NOW + 10 * 60 * 1000 })),
    ];
    const ranked = rankFeedBriefs(rows, NOW);
    const keyed = [...rows].sort((a, b) =>
      compareBriefFeedSortKeys(briefFeedSortKey(a, NOW), briefFeedSortKey(b, NOW)),
    );
    expect(keyed.map((row) => row.brief.id)).toEqual(ranked.map((row) => row.brief.id));
  });
});
