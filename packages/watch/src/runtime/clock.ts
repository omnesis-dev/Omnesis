// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The runtime's clock, which is a value rather than a reading.
 *
 * Nothing in this package calls `Date.now()`. Time arrives from the journal —
 * each event carries the instant it happened — and the runtime advances the
 * clock to meet it. A live run and a backtest therefore differ only in how fast
 * the events arrive, not in what the engine does with them, which is the whole
 * reason a backtest is worth trusting.
 *
 * The clock only ever moves forward. An event that arrives with an earlier
 * semantic time is a source backfilling, and it must not drag the deadline
 * horizon backwards: a wait that already expired cannot un-expire because a
 * month-old email showed up late.
 */

export class VirtualClock {
  private currentMs: number;

  /**
   * The evaluation timezone, as an offset from UTC in minutes.
   *
   * A watch's `$today` is a civil date, not a UTC one: "spent more than £500
   * this month" means the operator's month. Making the zone an explicit input
   * rather than assuming UTC is what keeps that honest — and what lets a golden
   * pin the answer instead of inheriting the machine's.
   */
  constructor(
    startedAt: string | number,
    readonly timeZoneOffsetMinutes = 0,
  ) {
    this.currentMs = typeof startedAt === "number" ? startedAt : parseInstant(startedAt);
  }

  /** Epoch milliseconds. */
  get nowMs(): number {
    return this.currentMs;
  }

  /** The current instant as an ISO-8601 string in UTC. */
  get now(): string {
    return new Date(this.currentMs).toISOString();
  }

  /** Today's civil date in the evaluation timezone, as `$today` binds it. */
  get today(): string {
    return new Date(this.currentMs + this.timeZoneOffsetMinutes * 60_000)
      .toISOString()
      .slice(0, 10);
  }

  /**
   * Move the clock to `instant` if that is later than where it is. Returns the
   * instant the clock ended up at, so a caller can tell whether it moved.
   */
  advanceTo(instant: string | number): number {
    const ms = typeof instant === "number" ? instant : parseInstant(instant);
    if (ms > this.currentMs) this.currentMs = ms;
    return this.currentMs;
  }

  /**
   * Where the clock stands, so an abandoned attempt at an event can put it back.
   *
   * Evaluating an event is retried when it needs an answer fetched from off the
   * host. The clock moves during the abandoned attempt, and since it only ever
   * moves forward it would still be ahead on the retry — so a deadline anchored
   * to "now" would land at a different instant depending on how many times the
   * event happened to be retried. Restoring it keeps an event's outcome a
   * function of the journal rather than of the fetching.
   */
  get position(): number {
    return this.currentMs;
  }

  set position(ms: number) {
    this.currentMs = ms;
  }
}

function parseInstant(instant: string): number {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) {
    throw new Error(`'${instant}' is not an instant the clock can be set to.`);
  }
  return ms;
}
