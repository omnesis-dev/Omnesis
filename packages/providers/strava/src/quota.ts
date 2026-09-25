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
 * Implements the core `RateLimitTracker` interface for type-level uniformity,
 * but Strava's header shape is unique so the implementation is local. Callers
 * use `observe()` / `canMakeNCalls(n, safetyPct?)`; `consumeHeaders` is an
 * alias the core interface mandates. `recordCall` is a no-op since usage is
 * always derived from response headers, never inferred client-side.
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

  canMakeNCalls(n: number, safetyPct: number = DEFAULT_SAFETY_PCT): boolean {
    if (n <= 0) return true;
    return this.remainingShort(safetyPct) >= n && this.remainingDaily(safetyPct) >= n;
  }

  remainingShort(safetyPct: number = DEFAULT_SAFETY_PCT): number {
    const overallShort = this.overall
      ? budget(this.overall.used.short, this.overall.limit.short, safetyPct)
      : Infinity;
    const readShort = this.read
      ? budget(this.read.used.short, this.read.limit.short, safetyPct)
      : Infinity;
    return Math.min(overallShort, readShort);
  }

  remainingDaily(safetyPct: number = DEFAULT_SAFETY_PCT): number {
    const overallDaily = this.overall
      ? budget(this.overall.used.daily, this.overall.limit.daily, safetyPct)
      : Infinity;
    const readDaily = this.read
      ? budget(this.read.used.daily, this.read.limit.daily, safetyPct)
      : Infinity;
    return Math.min(overallDaily, readDaily);
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
