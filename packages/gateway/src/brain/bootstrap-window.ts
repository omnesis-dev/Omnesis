// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * An optional daily window during which the retrospective lane may buy work.
 *
 * The lane spends steadily for as long as there is history left, and on a
 * metered backend that spending is not equally convenient at all hours. Some
 * providers price off-peak capacity lower; a shared machine has quiet hours;
 * an operator may simply prefer the backfill not to compete with their day.
 *
 * The window gates ENQUEUE, not execution. A run already bought is worked to
 * completion whenever the drainer reaches it: stopping mid-run would waste the
 * tokens already spent on it, and the queue's own pacing keeps the tail short.
 * So the window shapes when the lane commits money, which is the thing an
 * operator is actually choosing.
 *
 * Times are local wall-clock `HH:MM`, matching the local-day boundary the
 * lane's other counters already use. A window whose end is not after its start
 * wraps midnight, which is the common case for "overnight".
 */

/** A daily window, local wall-clock. Absent means the lane may always buy. */
export interface BootstrapWindow {
  from: string;
  to: string;
}

/** Minutes past local midnight for an `HH:MM`, or null if unparseable. */
function minutesOfDay(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes past local midnight for an instant, in the host's zone. */
function localMinutes(now: number): number {
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Whether the lane may buy work at `now`.
 *
 * An unparseable window is treated as no window at all — open rather than
 * shut. A typo in a config field must not silently stop the lane forever with
 * nothing but a validation error nobody re-reads; the schema rejects malformed
 * values at the boundary, and this is the belt to that braces.
 */
export function bootstrapWindowOpen(window: BootstrapWindow | undefined, now: number): boolean {
  if (!window) return true;
  const from = minutesOfDay(window.from);
  const to = minutesOfDay(window.to);
  if (from === null || to === null) return true;
  const at = localMinutes(now);
  // A window that does not end after it starts wraps midnight, so the open
  // side is the union of the two halves rather than the span between them.
  return to > from ? at >= from && at < to : at >= from || at < to;
}

/**
 * When the window next opens, as epoch ms — or null when there is no window.
 *
 * Answers the only question a paused-for-the-window lane raises: how long is
 * this. Computed by walking to the window's start on today's date and adding a
 * day when that has already passed, so it stays correct across the wrap case
 * without arithmetic on the wrap itself.
 */
export function bootstrapWindowOpensAt(
  window: BootstrapWindow | undefined,
  now: number,
): number | null {
  if (!window) return null;
  const from = minutesOfDay(window.from);
  if (from === null) return null;
  const d = new Date(now);
  d.setHours(Math.floor(from / 60), from % 60, 0, 0);
  const at = d.getTime();
  return at > now ? at : at + 86_400_000;
}
