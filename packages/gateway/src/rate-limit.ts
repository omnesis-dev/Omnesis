// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-IP rate limiter shared by the unauthenticated trust-boundary
 * endpoints — `/devices/pair` and the WebSocket upgrade token check.
 * Both surfaces accept untrusted credentials
 * (a 40-bit pairing code, an opaque bearer token) from any LAN client;
 * without rate limiting they're a brute-force oracle.
 *
 * The implementation is a small token-bucket per source-IP:
 *
 *   - Each IP gets two limits: a short window ("burst") and a long
 *     window ("hourly"). Either limit hitting zero refuses the call.
 *   - Buckets refill linearly at `capacity / windowMs` per ms.
 *   - State is in-memory; on gateway restart the limits reset. That's
 *     fine for a single-host install — the threat model is
 *     "someone on the LAN brute-forcing for ~10 min", not "an
 *     adversary spreading attacks across multiple gateway lifetimes".
 *
 * The limiter logs every refusal at WARN so an operator can spot
 * brute-force traffic in `journalctl`. It does NOT log the candidate
 * token / pairing code — only the source IP and the rule that fired.
 */
import { createLogger } from "@omnesis/core";

const log = createLogger("gateway:rate-limit");

interface Bucket {
  /** Tokens currently available. Float so refill can be partial. */
  tokens: number;
  /** Wall-clock ms of the last refill. */
  lastRefillMs: number;
}

export interface RateLimiterRule {
  /** Capacity = max tokens in the bucket, restored over `windowMs`. */
  capacity: number;
  /** How fast tokens regenerate. e.g. capacity=10 + windowMs=60_000 → 10 attempts/min. */
  windowMs: number;
}

export interface RateLimiterOpts {
  /** Short-window limit. Caught by the burst-protection branch. */
  burst: RateLimiterRule;
  /** Long-window limit. Caught when an attacker paces just under burst. */
  hourly: RateLimiterRule;
  /** Logical name of the surface, included in the warn log on refusal. */
  surface: string;
}

export class IpRateLimiter {
  private burstBuckets = new Map<string, Bucket>();
  private hourlyBuckets = new Map<string, Bucket>();
  private readonly burst: RateLimiterRule;
  private readonly hourly: RateLimiterRule;
  private readonly surface: string;
  /**
   * Cap on the number of distinct IPs we track. Any new IP after this
   * cap evicts the bucket least recently touched. Keeps a hostile
   * peer from inflating us into OOM territory by spraying random
   * spoofed IPs at the unauthenticated endpoints.
   */
  private static readonly MAX_TRACKED_IPS = 10_000;

  constructor(opts: RateLimiterOpts) {
    this.burst = opts.burst;
    this.hourly = opts.hourly;
    this.surface = opts.surface;
  }

  /**
   * Returns `null` to allow the request, or a string explaining why
   * the request was refused (suitable for an operator log; the HTTP /
   * WS handler should NOT echo it to the caller — the bookkeeping is
   * an internal signal).
   */
  consume(ip: string, now: number = Date.now()): null | string {
    if (this.refuse(this.burstBuckets, ip, this.burst, now)) {
      const reason = `${this.surface}: burst limit exceeded`;
      log.warn(`Rate-limit refusal from ${ip} — ${reason}`);
      return reason;
    }
    if (this.refuse(this.hourlyBuckets, ip, this.hourly, now)) {
      // Restore the burst token we just consumed since we're refusing
      // anyway — keeps the burst bucket honest for the next request
      // that might pass the hourly check (e.g. after a clean window).
      this.refund(this.burstBuckets, ip, this.burst, now);
      const reason = `${this.surface}: hourly limit exceeded`;
      log.warn(`Rate-limit refusal from ${ip} — ${reason}`);
      return reason;
    }
    return null;
  }

  private refuse(
    buckets: Map<string, Bucket>,
    ip: string,
    rule: RateLimiterRule,
    now: number,
  ): boolean {
    let bucket = buckets.get(ip);
    if (!bucket) {
      if (buckets.size >= IpRateLimiter.MAX_TRACKED_IPS) {
        // Evict an arbitrary entry — no LRU bookkeeping; the cap
        // protects against memory exhaustion, not against a
        // concerted slow-roll attacker.
        const firstKey = buckets.keys().next().value;
        if (firstKey !== undefined) buckets.delete(firstKey);
      }
      bucket = { tokens: rule.capacity, lastRefillMs: now };
      buckets.set(ip, bucket);
    } else {
      this.refill(bucket, rule, now);
    }
    if (bucket.tokens < 1) return true;
    bucket.tokens -= 1;
    return false;
  }

  private refund(
    buckets: Map<string, Bucket>,
    ip: string,
    rule: RateLimiterRule,
    _now: number,
  ): void {
    const bucket = buckets.get(ip);
    if (!bucket) return;
    bucket.tokens = Math.min(rule.capacity, bucket.tokens + 1);
  }

  private refill(bucket: Bucket, rule: RateLimiterRule, now: number): void {
    const elapsed = Math.max(0, now - bucket.lastRefillMs);
    if (elapsed === 0) return;
    const refill = (elapsed / rule.windowMs) * rule.capacity;
    bucket.tokens = Math.min(rule.capacity, bucket.tokens + refill);
    bucket.lastRefillMs = now;
  }
}

/** Default config for the pairing-code endpoint. */
export function pairingRateLimiter(): IpRateLimiter {
  return new IpRateLimiter({
    surface: "/devices/pair",
    burst: { capacity: 10, windowMs: 60_000 },
    hourly: { capacity: 100, windowMs: 3_600_000 },
  });
}

/**
 * Per-IP limiter for `POST /portal/api/login`. The portal login accepts the
 * same 40-bit pairing codes as `/devices/pair`, so it needs the same
 * brute-force resistance; sized identically to the pairing limiter.
 */
export function portalLoginRateLimiter(): IpRateLimiter {
  return new IpRateLimiter({
    surface: "/portal/api/login",
    burst: { capacity: 10, windowMs: 60_000 },
    hourly: { capacity: 100, windowMs: 3_600_000 },
  });
}

/** Default config for the WS upgrade token check. */
export function wsHelloRateLimiter(): IpRateLimiter {
  return new IpRateLimiter({
    surface: "/device/ws upgrade",
    burst: { capacity: 10, windowMs: 60_000 },
    hourly: { capacity: 200, windowMs: 3_600_000 },
  });
}

/**
 * Per-IP limiter for the authenticated `POST /search` endpoint (#58).
 * Defence-in-depth for a gateway exposed beyond the LAN: a stolen token or
 * a runaway client can't pin the search pipeline. Sized well above any
 * human's interactive cadence (2/s burst, ~1/s sustained).
 */
export function searchRateLimiter(): IpRateLimiter {
  return new IpRateLimiter({
    surface: "POST /search",
    burst: { capacity: 120, windowMs: 60_000 },
    hourly: { capacity: 3_000, windowMs: 3_600_000 },
  });
}

/**
 * Backstop for externally driven Direct tool loops. Unlike ordinary search,
 * loopback is intentionally not exempt: a runaway local or remote MCP client
 * is one of the primary failure modes this protects against. The hosted MCP
 * resource and experimental JSON adapter intentionally share this budget.
 */
export function directMcpRateLimiter(): IpRateLimiter {
  return new IpRateLimiter({
    surface: "Direct tool execution",
    burst: { capacity: 120, windowMs: 60_000 },
    hourly: { capacity: 3_000, windowMs: 3_600_000 },
  });
}

/** Public OAuth client registration can otherwise grow the durable client table without bound. */
export function oauthRegistrationRateLimiter(): IpRateLimiter {
  return new IpRateLimiter({
    surface: "POST /oauth/register",
    burst: { capacity: 20, windowMs: 60_000 },
    hourly: { capacity: 200, windowMs: 3_600_000 },
  });
}

/** Bounds creation of short-lived authorization transactions by one network peer. */
export function oauthAuthorizationRateLimiter(): IpRateLimiter {
  return new IpRateLimiter({
    surface: "GET /oauth/authorize",
    burst: { capacity: 60, windowMs: 60_000 },
    hourly: { capacity: 1_000, windowMs: 3_600_000 },
  });
}

/**
 * Much tighter than authorization-transaction creation: each accepted call
 * may wake every paired phone. Callers use separate instances for peer,
 * OAuth-client, and gateway-wide keys so one public client cannot turn the
 * authorization surface into a notification channel.
 */
export function oauthAuthorizationNotificationRateLimiter(
  surface: string,
  limits: { burst: RateLimiterRule; hourly: RateLimiterRule } = {
    burst: { capacity: 3, windowMs: 60_000 },
    hourly: { capacity: 12, windowMs: 3_600_000 },
  },
): IpRateLimiter {
  return new IpRateLimiter({ surface, ...limits });
}

/** Brute-force and runaway-client guard for token exchange, refresh, and revocation. */
export function oauthTokenRateLimiter(): IpRateLimiter {
  return new IpRateLimiter({
    surface: "OAuth token operations",
    burst: { capacity: 120, windowMs: 60_000 },
    hourly: { capacity: 3_000, windowMs: 3_600_000 },
  });
}

/**
 * Per-IP limiter for the authenticated `POST /documents` ingest endpoint
 * (#58). The collector is a legitimate high-volume client (batched
 * bootstrap ingestion), so the ceiling is deliberately generous — 20 req/s
 * burst — far above realistic batched ingestion, yet still a backstop
 * against a pathological write loop.
 */
export function documentsRateLimiter(): IpRateLimiter {
  return new IpRateLimiter({
    surface: "POST /documents",
    burst: { capacity: 1_200, windowMs: 60_000 },
    hourly: { capacity: 60_000, windowMs: 3_600_000 },
  });
}

/**
 * Per-IP limiter for `POST /agent-messages` — harness plugins pushing pushed
 * conversation turns. Each request carries a batch (up to a few thousand turns),
 * so the *request* ceiling can be modest while still admitting a large
 * install-time backfill: the plugin chunks its backfill into a handful of
 * batched requests, and steady-state live pushes are a trickle. Loopback is
 * exempt via the route.
 */
export function agentMessagesRateLimiter(): IpRateLimiter {
  return new IpRateLimiter({
    surface: "POST /agent-messages",
    burst: { capacity: 300, windowMs: 60_000 },
    hourly: { capacity: 6_000, windowMs: 3_600_000 },
  });
}

/**
 * Per-IP limiter for the authenticated `POST /notes` capture endpoint.
 * Captures are human-driven (or a phone flushing an offline buffer of a
 * few dozen notes), so the ceiling is human-capture-scale: 120/min burst
 * clears any realistic buffer flush instantly while still stopping a
 * pathological capture loop. Same-host callers bypass it entirely via
 * the route's loopback exemption.
 */
export function notesRateLimiter(): IpRateLimiter {
  return new IpRateLimiter({
    surface: "POST /notes",
    burst: { capacity: 120, windowMs: 60_000 },
    hourly: { capacity: 2_000, windowMs: 3_600_000 },
  });
}
