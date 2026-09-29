// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, type RateLimitTracker } from "@omnesis/core";

const log = createLogger("provider:strava:quota");

const HDR_LIMIT = "X-RateLimit-Limit";
const HDR_USAGE = "X-RateLimit-Usage";
const HDR_READ_LIMIT = "X-ReadRateLimit-Limit";
const HDR_READ_USAGE = "X-ReadRateLimit-Usage";

/** Conservative default — leave 10% headroom for liveness pings + sibling tokens. */
export const DEFAULT_SAFETY_PCT = 0.9;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a count reported just after a reset is still taken for the window
 * before it: a response crossing the boundary, or a host clock running a little
 * ahead of Strava's, reports the old window's usage once the new one has begun.
 * Taken for the new window's, a day spent at 23:59 would read as spent until the
 * next midnight.
 */
const RESET_GRACE_MS = 30_000;

/** A single (short, daily) limit pair from one of Strava's headers. */
export interface QuotaPair {
  short: number;
  daily: number;
}

/**
 * In-memory rate-limit tracker fed by every Strava API response. Strava splits
 * its quota into two parallel pairs (overall + read sub-quota), each carrying
 * a 15-min and a daily window packed into one comma-separated header. We track
 * all four budgets and gate calls on the tightest.
 *
 * Usage is only what the last response said, so it outlives the window it was
 * counted in unless the tracker lets it go: Strava resets the 15-minute windows
 * on the quarter hour and the daily one at midnight, both UTC, and a count
 * observed before the current window began no longer applies. Without that, a
 * spent budget would stay spent for good — the check that refuses a call is
 * also what keeps any new response from arriving to correct it.
 *
 * Implements the core `RateLimitTracker` interface for type-level uniformity,
 * but Strava's header shape is unique so the implementation is local. Callers
 * use `observe()`, `canMakeNCalls(n, safetyPct?, now?)`, and
 * `msUntilCanMakeNCalls` to learn how long a refused page waits;
 * `consumeHeaders` is an alias the core interface mandates. `recordCall` is a
 * no-op since usage is always derived from response headers, never inferred
 * client-side.
 */
export class StravaRateLimitTracker implements RateLimitTracker {
  private overall?: { used: QuotaPair; limit: QuotaPair };
  private read?: { used: QuotaPair; limit: QuotaPair };
  private lastObservedAt?: number;

  observe(headers: Headers | Record<string, string | undefined>): void {
    const get = headerGetter(headers);
    const overall = parsePair(get(HDR_LIMIT), get(HDR_USAGE));
    const read = parsePair(get(HDR_READ_LIMIT), get(HDR_READ_USAGE));
    if (overall) this.overall = overall;
    if (read) this.read = read;
    if (overall || read) this.lastObservedAt = Date.now();
  }

  consumeHeaders(headers: Headers | Record<string, string | undefined>): void {
    this.observe(headers);
  }

  recordCall(): void {}

  canMakeNCalls(
    n: number,
    safetyPct: number = DEFAULT_SAFETY_PCT,
    now: Date = new Date(),
  ): boolean {
    if (n <= 0) return true;
    return this.remainingShort(safetyPct, now) >= n && this.remainingDaily(safetyPct, now) >= n;
  }

  /**
   * How long until `n` calls fit: zero when they fit now, else until the
   * window that cannot cover them resets — UTC midnight when the day's budget
   * is spent, the next quarter hour when only the short window's is — plus
   * `RESET_GRACE_MS`, so the calls made then land after Strava's reset.
   */
  msUntilCanMakeNCalls(
    n: number,
    safetyPct: number = DEFAULT_SAFETY_PCT,
    now: Date = new Date(),
  ): number {
    if (this.remainingDaily(safetyPct, now) < n) {
      return startOfUtcDay(now) + DAY_MS + RESET_GRACE_MS - now.getTime();
    }
    if (this.remainingShort(safetyPct, now) < n)
      return this.msUntilWindowReset(now) + RESET_GRACE_MS;
    return 0;
  }

  remainingShort(safetyPct: number = DEFAULT_SAFETY_PCT, now: Date = new Date()): number {
    const inWindow = this.observedSince(startOfUtcQuarterHour(now));
    const overallShort = this.overall
      ? budget(inWindow ? this.overall.used.short : 0, this.overall.limit.short, safetyPct)
      : Infinity;
    const readShort = this.read
      ? budget(inWindow ? this.read.used.short : 0, this.read.limit.short, safetyPct)
      : Infinity;
    return Math.min(overallShort, readShort);
  }

  remainingDaily(safetyPct: number = DEFAULT_SAFETY_PCT, now: Date = new Date()): number {
    const inWindow = this.observedSince(startOfUtcDay(now));
    const overallDaily = this.overall
      ? budget(inWindow ? this.overall.used.daily : 0, this.overall.limit.daily, safetyPct)
      : Infinity;
    const readDaily = this.read
      ? budget(inWindow ? this.read.used.daily : 0, this.read.limit.daily, safetyPct)
      : Infinity;
    return Math.min(overallDaily, readDaily);
  }

  /**
   * Whether the usage on record was counted in the window starting at
   * `windowStart`, rather than reported across its start (`RESET_GRACE_MS`).
   */
  private observedSince(windowStart: number): boolean {
    return this.lastObservedAt !== undefined && this.lastObservedAt >= windowStart + RESET_GRACE_MS;
  }

  /**
   * Tightest short-window pair, surfaced via the core interface. Returns the
   * overall short pair if observed, else read short pair, else `{0, Infinity}`.
   */
  quotaUsed(): { current: number; limit: number } {
    if (this.overall) return { current: this.overall.used.short, limit: this.overall.limit.short };
    if (this.read) return { current: this.read.used.short, limit: this.read.limit.short };
    return { current: 0, limit: Infinity };
  }

  /** Strava doesn't send a reset header; returns the next 15-min UTC boundary. */
  resetTime(): Date {
    return new Date(Date.now() + this.msUntilWindowReset());
  }

  msUntilWindowReset(now: Date = new Date()): number {
    const minutes = now.getUTCMinutes();
    const nextQuarter = Math.ceil((minutes + 1) / 15) * 15;
    const next = new Date(now);
    next.setUTCMinutes(nextQuarter, 0, 0);
    return next.getTime() - now.getTime();
  }

  snapshot(): {
    overall?: { used: QuotaPair; limit: QuotaPair };
    read?: { used: QuotaPair; limit: QuotaPair };
    lastObservedAt?: number;
  } {
    return { overall: this.overall, read: this.read, lastObservedAt: this.lastObservedAt };
  }

  setState(
    overall?: { used: QuotaPair; limit: QuotaPair },
    read?: { used: QuotaPair; limit: QuotaPair },
  ): void {
    this.overall = overall;
    this.read = read;
    this.lastObservedAt = Date.now();
    log.info(
      `Quota state set: overall=${overall ? `${overall.used.short}/${overall.limit.short},${overall.used.daily}/${overall.limit.daily}` : "none"} read=${read ? `${read.used.short}/${read.limit.short},${read.used.daily}/${read.limit.daily}` : "none"}`,
    );
  }
}

function budget(used: number, limit: number, safetyPct: number): number {
  const cap = Math.floor(limit * safetyPct);
  return Math.max(0, cap - used);
}

/** When the 15-minute window `now` falls in began: on the quarter hour, UTC. */
function startOfUtcQuarterHour(now: Date): number {
  const start = new Date(now);
  start.setUTCMinutes(Math.floor(now.getUTCMinutes() / 15) * 15, 0, 0);
  return start.getTime();
}

/** When the daily window `now` falls in began: midnight, UTC. */
function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function parsePair(
  limitValue: string | undefined,
  usageValue: string | undefined,
): { used: QuotaPair; limit: QuotaPair } | undefined {
  const limit = parseQuotaPair(limitValue);
  const used = parseQuotaPair(usageValue);
  if (!limit || !used) return undefined;
  return { used, limit };
}

function parseQuotaPair(value: string | undefined): QuotaPair | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((s) => parseInt(s.trim(), 10));
  if (parts.length !== 2 || parts.some(Number.isNaN)) return undefined;
  return { short: parts[0]!, daily: parts[1]! };
}

function headerGetter(
  headers: Headers | Record<string, string | undefined>,
): (name: string) => string | undefined {
  if (typeof (headers as Headers).get === "function") {
    const h = headers as Headers;
    return (name) => h.get(name) ?? undefined;
  }
  const record = headers as Record<string, string | undefined>;
  const lowered = new Map<string, string>();
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string") lowered.set(k.toLowerCase(), v);
  }
  return (name) => lowered.get(name.toLowerCase());
}
