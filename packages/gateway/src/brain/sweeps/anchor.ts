// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * When a sweep fires.
 *
 * A cadence alone cannot answer that. An elapsed-time rule (`now - lastFire >=
 * cadence`) has no fixed point: the first fire sets the phase forever, every
 * subsequent fire adds the tick interval, and the whole set drifts. Worse, a
 * set of themes sharing a cadence stays welded together for the life of the
 * install — they were first enqueued in one pass, so they re-fire in one pass,
 * and the run drainer executes them strictly serialized.
 *
 * So a sweep fires on a BOUNDARY, like the daily rhythm does: the local
 * time-of-day `anchorMinutes`, on the first such moment at or after the
 * cadence has elapsed since the last boundary it fired for. Three properties
 * follow, and all three are the point:
 *
 *   - No drift. The marker stores the BOUNDARY the sweep fired for, not the
 *     wall-clock moment it happened to be enqueued, so phase is preserved
 *     exactly however late the tick was.
 *   - Downtime fires once. A gateway down for three cadence periods comes back
 *     to a single boundary at or before `now`, so it enqueues one run — never
 *     one per missed period.
 *   - Themes spread. An author who names no time gets a slot derived from the
 *     id, placed outside the window the morning digest needs quiet.
 *
 * Cadences are counted in whole local days, so one that is not a multiple of a
 * day rounds to the nearest — `36h` runs every other day, not every day and
 * not every two. Nothing denser than a day exists: a sweep has one boundary
 * per day by construction, and a check that wants to fire more often than that
 * is a watch, not a sweep.
 */

const MINUTES_PER_DAY = 1440;

/**
 * The most recent boundary at or before `nowMs` for a sweep anchored at
 * `anchorMinutes`. Computed through the local calendar rather than by modular
 * arithmetic on epoch ms, so it lands on the wall-clock time the operator
 * chose on both sides of a DST change.
 */
export function mostRecentSweepBoundary(nowMs: number, anchorMinutes: number): number {
  const today = localMidnight(nowMs, 0);
  if (today <= nowMs) return today;
  // Yesterday's anchor: step back a day through the calendar, not by 86.4e6 ms.
  return localMidnight(nowMs, -1);

  /** Local `anchorMinutes` on the day `offset` days from `nowMs`. */
  function localMidnight(at: number, offset: number): number {
    const d = new Date(at);
    d.setDate(d.getDate() + offset);
    // Through the Date API, not by adding milliseconds: on a DST day the
    // wall-clock time the operator chose is not a fixed offset from midnight.
    d.setHours(0, anchorMinutes, 0, 0);
    return d.getTime();
  }
}

export interface SweepDueInput {
  nowMs: number;
  cadenceHours: number;
  anchorMinutes: number;
  /**
   * The boundary this sweep last fired for (0 = never). Boundary, not fire
   * time — storing the latter is what makes an elapsed-time schedule drift.
   */
  lastBoundaryMs: number;
}

export type SweepDueResult =
  | { due: false }
  /** Fire, and record `boundaryMs` as the sweep's new marker. */
  | { due: true; boundaryMs: number }
  /**
   * Never fired before: record `seedBoundaryMs` and fire at the NEXT anchor.
   *
   * A fresh install would otherwise fire every sweep in one pass — the
   * serialized thundering herd the anchors exist to prevent, landing in
   * whatever part of the day the gateway happened to start, the digest's quiet
   * window included. Seeding just short of a full cadence makes each sweep due
   * at its own next anchor instead: at most a day away, and already spread.
   */
  | { due: false; seedBoundaryMs: number };

/** Whether a sweep is due now, and which boundary the fire belongs to. */
export function sweepDue(input: SweepDueInput): SweepDueResult {
  const cadenceDays = Math.max(1, Math.round(input.cadenceHours / 24));
  const boundaryMs = mostRecentSweepBoundary(input.nowMs, input.anchorMinutes);
  if (input.lastBoundaryMs === 0) {
    // One day short of a full cadence, so the first fire lands on the NEXT
    // anchor rather than on the very next tick.
    return { due: false, seedBoundaryMs: boundaryMs - (cadenceDays - 1) * 86_400_000 };
  }
  // A clock that jumped backwards past a boundary already fired stays quiet.
  if (boundaryMs <= input.lastBoundaryMs) return { due: false };
  // Whole local days, not milliseconds: a local day is 23 or 25 hours twice a
  // year, and a millisecond comparison would either skip a period or — with
  // slack loose enough to absorb the shift — fire a non-whole-day cadence far
  // too often (36h would come round every 24h).
  const elapsedDays = Math.round((boundaryMs - input.lastBoundaryMs) / 86_400_000);
  if (elapsedDays < cadenceDays) return { due: false };
  return { due: true, boundaryMs };
}

/** FNV-1a over the id — a stable, dependency-free spread across the day. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** A half-open local-time window, in minutes since midnight. May wrap midnight. */
export interface QuietWindow {
  startMinutes: number;
  endMinutes: number;
}

/**
 * The slot a sweep that names no time gets: derived from its id so it is
 * stable across restarts and spread across the day, and placed OUTSIDE
 * `quiet`.
 *
 * The quiet window matters more than the spread. The morning digest composes
 * behind a readiness barrier that waits for the whole run queue to fall
 * silent, so a sweep firing in that window holds the digest hostage until its
 * grace deadline and the user gets a thinner morning brief. Sweeps therefore
 * anchor around it by construction rather than by the operator noticing.
 */
export function deriveAnchorMinutes(id: string, quiet?: QuietWindow): number {
  const raw = hashId(id) % MINUTES_PER_DAY;
  if (!quiet) return raw;
  // `quietSpanMinutes` is bounded to 0..1439, so at least one minute is always
  // free and the modulo below always has something to divide by.
  const free = MINUTES_PER_DAY - quietSpanMinutes(quiet);
  const offset = hashId(id) % free;
  return (quiet.endMinutes + offset) % MINUTES_PER_DAY;
}

function quietSpanMinutes(quiet: QuietWindow): number {
  const raw = quiet.endMinutes - quiet.startMinutes;
  return raw >= 0 ? raw : raw + MINUTES_PER_DAY;
}

/** Whether a local-minute lands inside a (possibly midnight-wrapping) window. */
export function isInQuietWindow(minutes: number, quiet: QuietWindow): boolean {
  if (quiet.startMinutes === quiet.endMinutes) return false;
  if (quiet.startMinutes < quiet.endMinutes) {
    return minutes >= quiet.startMinutes && minutes < quiet.endMinutes;
  }
  return minutes >= quiet.startMinutes || minutes < quiet.endMinutes;
}

/** Parse "HH:MM" (24h, local) to minutes since midnight; null when malformed. */
export function parseClockTime(text: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Render minutes since midnight back to "HH:MM". */
export function formatClockTime(minutes: number): string {
  const norm = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(norm / 60);
  const m = norm % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
