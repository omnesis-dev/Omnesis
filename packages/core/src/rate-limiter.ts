// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export interface RateLimitTracker {
  canMakeNCalls(n: number): boolean;
  recordCall(): void;
  consumeHeaders(headers: Headers | Record<string, string | undefined>): void;
  quotaUsed(): { current: number; limit: number };
  resetTime(): Date;
}

export interface StandardRateLimitTrackerOptions {
  limitHeader?: string;
  remainingHeader?: string;
  resetHeader?: string;
  retryAfterHeader?: string;
  defaultLimit?: number;
  safetyPct?: number;
}

const DEFAULT_LIMIT_HEADER = "X-RateLimit-Limit";
const DEFAULT_REMAINING_HEADER = "X-RateLimit-Remaining";
const DEFAULT_RESET_HEADER = "X-RateLimit-Reset";
const DEFAULT_RETRY_AFTER_HEADER = "Retry-After";

export class StandardRateLimitTracker implements RateLimitTracker {
  private current = 0;
  private limit: number;
  private reset: Date;
  private readonly limitHeader: string;
  private readonly remainingHeader: string;
  private readonly resetHeader: string;
  private readonly retryAfterHeader: string;
  private readonly safetyPct: number;

  constructor(options: StandardRateLimitTrackerOptions = {}) {
    this.limitHeader = options.limitHeader ?? DEFAULT_LIMIT_HEADER;
    this.remainingHeader = options.remainingHeader ?? DEFAULT_REMAINING_HEADER;
    this.resetHeader = options.resetHeader ?? DEFAULT_RESET_HEADER;
    this.retryAfterHeader = options.retryAfterHeader ?? DEFAULT_RETRY_AFTER_HEADER;
    this.limit = options.defaultLimit ?? Infinity;
    this.safetyPct = options.safetyPct ?? 1;
    this.reset = new Date(0);
  }

  canMakeNCalls(n: number): boolean {
    if (n <= 0) return true;
    if (this.limit === Infinity) return true;
    const cap = Math.floor(this.limit * this.safetyPct);
    return this.current + n <= cap;
  }

  recordCall(): void {
    this.current += 1;
  }

  consumeHeaders(headers: Headers | Record<string, string | undefined>): void {
    const get = headerGetter(headers);

    const retryAfter = get(this.retryAfterHeader);
    if (retryAfter !== undefined) {
      const parsed = parseRetryAfter(retryAfter);
      if (parsed) this.reset = parsed;
    }

    const limit = get(this.limitHeader);
    if (limit !== undefined) {
      const n = parseFiniteInt(limit);
      if (n !== undefined) this.limit = n;
    }

    const remaining = get(this.remainingHeader);
    if (remaining !== undefined) {
      const n = parseFiniteInt(remaining);
      if (n !== undefined && this.limit !== Infinity) {
        this.current = Math.max(0, this.limit - n);
      }
    }

    const resetRaw = get(this.resetHeader);
    if (resetRaw !== undefined) {
      const parsed = parseResetTime(resetRaw);
      if (parsed) this.reset = parsed;
    }
  }

  quotaUsed(): { current: number; limit: number } {
    return { current: this.current, limit: this.limit };
  }

  resetTime(): Date {
    return this.reset;
  }
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

function parseFiniteInt(value: string): number | undefined {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseResetTime(value: string): Date | undefined {
  const trimmed = value.trim();
  const asInt = parseInt(trimmed, 10);
  if (Number.isFinite(asInt) && /^\d+$/.test(trimmed)) {
    const ms = asInt < 1e12 ? asInt * 1000 : asInt;
    return new Date(ms);
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}

function parseRetryAfter(value: string): Date | undefined {
  const trimmed = value.trim();
  const seconds = parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && /^\d+$/.test(trimmed)) {
    return new Date(Date.now() + seconds * 1000);
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}
