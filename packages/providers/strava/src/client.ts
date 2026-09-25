// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { STREAM_KEYS } from "./types.js";
import { loadClientCredentials, saveTokens } from "./provider.js";
import { StravaRateLimitTracker } from "./quota.js";
import type {
  StravaTokens,
  StravaSummaryActivity,
  StravaCredentials,
  StravaDetailedActivity,
  StravaComment,
  StravaSummaryAthlete,
  StravaActivityZone,
  StravaStreamSet,
  StreamKey,
  StravaDetailedAthlete,
  StravaAthleteZones,
  StravaActivityStats,
  StravaDetailedGear,
} from "./types.js";

const log = createLogger("provider:strava:client");

// Strava is migrating the API host: the legacy `www.strava.com/api/v3` host is
// retired on 2027-06-01, replaced by `www.api-v3.strava.com`. We resolve the
// base per request (see `resolveApiBase`) rather than at module load because the
// gateway/collector are long-running processes that may cross the cutover date
// without restarting. Only the API base moves — the OAuth endpoints below and
// website deep-links stay on `www.strava.com`. See #561 (remove the date-gate
// once the new host is verified live).
const LEGACY_API_BASE = "https://www.strava.com/api/v3";
const NEW_API_BASE = "https://www.api-v3.strava.com";
const API_BASE_CUTOVER_MS = Date.UTC(2027, 5, 1); // 2027-06-01T00:00:00Z

/**
 * Resolve the Strava API base host for a request. `OMNESIS_STRAVA_API_BASE`
 * overrides everything (flip early the moment Strava's new host is live, or pin
 * the legacy host if their cutover slips); otherwise the new host takes over on
 * or after {@link API_BASE_CUTOVER_MS}.
 */
export function resolveApiBase(now = Date.now()): string {
  const override = process.env.OMNESIS_STRAVA_API_BASE?.trim();
  if (override) return override;
  return now >= API_BASE_CUTOVER_MS ? NEW_API_BASE : LEGACY_API_BASE;
}

const TOKEN_URL = "https://www.strava.com/oauth/token";
const MAX_RETRIES = 3;

/**
 * Maximum in-tick sleep on a 429. `computeRateLimitBackoff` can return
 * up to 16 min (short-term cap) or 1h (daily cap); 5 min is a comfortable
 * compromise — short enough that the sync tick stays responsive, long
 * enough to absorb most short-window throttling without surfacing as a
 * source-state flip. Anything longer goes through `StravaRateLimitError`
 * (which the collector classifies as `rate-limit`) so the next scheduled
 * tick re-attempts and the source UI shows a clear "rate-limited" badge
 * rather than a stuck "syncing" pill.
 */
const IN_TICK_RATE_LIMIT_THRESHOLD_MS = 5 * 60 * 1000;
/** Refresh the access token this many seconds before its stated expiry. */
const REFRESH_SKEW_SECONDS = 60;

/**
 * The stored OAuth grant no longer works and only the athlete can fix it by
 * re-authorizing. Typed `auth` so the collector classifies it directly instead
 * of guessing from the message, and parks the source in `needs-auth`.
 *
 * Scoped `connection`: the grant lives on the athlete's Strava connection —
 * `strava-activities` is the only source built from it today, but the token
 * itself, not anything specific to that source's own state, is what died.
 */
export class StravaAuthError extends SyncError {
  constructor(message: string) {
    super("auth", message, { scope: "connection" });
    this.name = "StravaAuthError";
  }
}

/**
 * Strava is throttling. `retryAfterMs`, when known, is what lets the collector
 * defer the next tick by that long instead of failing the source outright —
 * see `extractRateLimitDeferral`.
 *
 * Quota `app`: `computeRateLimitBackoff` reads `X-RateLimit-Limit` /
 * `X-RateLimit-Usage`, which Strava counts against the registered API
 * application (`client_id`), not the individual athlete. Every install
 * registers its own app for exactly this reason — see `credentials-spec.ts`
 * — so in practice this installation's app and its one connected athlete
 * share the same budget, but the meter Strava enforces is the app's.
 */
export class StravaRateLimitError extends SyncError {
  constructor(message: string, retryAfterMs?: number) {
    super("rate-limit", message, { retryAfterMs, quota: { kind: "app" } });
    this.name = "StravaRateLimitError";
  }
}

/**
 * Thrown when an endpoint returns 403 (Summit-only features like zones or
 * advanced metrics on a non-Summit account) or 402 (a premium-gated
 * sub-resource the athlete's plan doesn't include). Both mean "your account
 * tier can't access this endpoint" — callers catch and downgrade gracefully
 * (e.g. mark `zones_unavailable=true`) instead of failing the whole sync.
 */
export class StravaForbiddenError extends Error {
  constructor(
    public path: string,
    public status: 402 | 403 = 403,
  ) {
    super(`Strava access denied (${status}) for ${path}`);
    this.name = "StravaForbiddenError";
  }
}

/**
 * Thrown when an endpoint returns 401 *after* a successful token refresh.
 * This happens when the access token is valid but doesn't carry the OAuth
 * scope the endpoint requires (e.g. `/athlete/zones` needs `profile:read_all`,
 * which we don't request). Distinct from `StravaAuthError` — callers can
 * skip optional best-effort endpoints (athlete-refresh tier) without
 * tearing down the whole sync.
 */
export class StravaScopeError extends Error {
  constructor(public path: string) {
    super(`Strava endpoint ${path} requires a scope this token doesn't have`);
    this.name = "StravaScopeError";
  }
}

/**
 * Thrown when an activity has been deleted on Strava's side. Per-activity
 * 404s can be observed during enrichment between snapshot rewalks.
 */
export class StravaNotFoundError extends Error {
  constructor(public path: string) {
    super(`Strava not found (404) for ${path}`);
    this.name = "StravaNotFoundError";
  }
}

export interface ListActivitiesParams {
  /** Unix seconds — return activities that started before this. */
  before?: number;
  /** Unix seconds — return activities that started after this. */
  after?: number;
  /** 1-indexed page number. */
  page?: number;
  /** Activities per page (1–200). Default 30. */
  per_page?: number;
}

/** Injectable fetch dependency — lets tests swap in a mock without touching globals. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface StravaClientOptions {
  tokens: StravaTokens;
  credentials?: StravaCredentials;
  /** Called whenever tokens are refreshed so the caller can persist them. */
  onTokensRefreshed?: (tokens: StravaTokens) => Promise<void> | void;
  /** Optional custom config dir for credential lookup (used in tests). */
  configDir?: string;
  /** Injectable fetch, defaults to global fetch. */
  fetchFn?: FetchFn;
  /** Injectable sleep, defaults to setTimeout. */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Minimal Strava HTTP client — fetch + token refresh + 429 retry + quota tracker. */
export class StravaClient {
  private tokens: StravaTokens;
  private credentials: StravaCredentials;
  private onTokensRefreshed?: (tokens: StravaTokens) => Promise<void> | void;
  private fetchFn: FetchFn;
  private sleepFn: (ms: number) => Promise<void>;
  /** In-flight refresh, so concurrent requests share a single refresh call. */
  private refreshInFlight?: Promise<void>;
  /** Live read-quota tracker fed by every response's headers. */
  public readonly quota = new StravaRateLimitTracker();

  constructor(opts: StravaClientOptions) {
    this.tokens = opts.tokens;
    this.credentials = opts.credentials ?? loadClientCredentials(opts.configDir);
    this.onTokensRefreshed = opts.onTokensRefreshed;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Current tokens (may have been refreshed since construction). */
  getTokens(): StravaTokens {
    return this.tokens;
  }

  // ── Activity-listing endpoints ────────────────────────────────────

  /** GET /athlete/activities — paginated list of the authed athlete's activities. */
  async listActivities(params: ListActivitiesParams = {}): Promise<StravaSummaryActivity[]> {
    const qs: Record<string, string> = {};
    if (params.before !== undefined) qs.before = String(params.before);
    if (params.after !== undefined) qs.after = String(params.after);
    if (params.page !== undefined) qs.page = String(params.page);
    if (params.per_page !== undefined) qs.per_page = String(params.per_page);
    return this.get<StravaSummaryActivity[]>("/athlete/activities", qs);
  }

  // ── Per-activity detail / comments / kudos / zones / streams ──────

  /** GET /activities/{id} — DetailedActivity with description, splits, etc. */
  async getActivity(id: number | string): Promise<StravaDetailedActivity> {
    // include_all_efforts ensures every segment_effort is returned
    // (default truncates to a sample).
    return this.get<StravaDetailedActivity>(`/activities/${id}`, {
      include_all_efforts: "true",
    });
  }

  /** GET /activities/{id}/comments — paginated list of comments on the activity. */
  async listActivityComments(
    id: number | string,
    params: { page?: number; per_page?: number } = {},
  ): Promise<StravaComment[]> {
    const qs: Record<string, string> = {};
    if (params.page !== undefined) qs.page = String(params.page);
    qs.per_page = String(params.per_page ?? 200);
    return this.get<StravaComment[]>(`/activities/${id}/comments`, qs);
  }

  /** GET /activities/{id}/kudos — paginated list of kudoers. */
  async listActivityKudos(
    id: number | string,
    params: { page?: number; per_page?: number } = {},
  ): Promise<StravaSummaryAthlete[]> {
    const qs: Record<string, string> = {};
    if (params.page !== undefined) qs.page = String(params.page);
    qs.per_page = String(params.per_page ?? 200);
    return this.get<StravaSummaryAthlete[]>(`/activities/${id}/kudos`, qs);
  }

  /**
   * GET /activities/{id}/zones — HR/power time-in-zone. Summit-only.
   * Throws `StravaForbiddenError` on 403.
   */
  async getActivityZones(id: number | string): Promise<StravaActivityZone[]> {
    return this.get<StravaActivityZone[]>(`/activities/${id}/zones`);
  }

  /**
   * GET /activities/{id}/streams — per-second time series. One call returns
   * all requested keys; we always ask for the full set (Strava returns only
   * the keys that exist for the activity).
   */
  async getActivityStreams(
    id: number | string,
    keys: readonly StreamKey[] = STREAM_KEYS,
  ): Promise<StravaStreamSet> {
    return this.get<StravaStreamSet>(`/activities/${id}/streams`, {
      keys: keys.join(","),
      key_by_type: "true",
    });
  }

  // ── Athlete-level endpoints (one-shot) ────────────────────────────

  /** GET /athlete — DetailedAthlete (bio, ftp, weight, bikes, shoes, ...). */
  async getAthleteDetail(): Promise<StravaDetailedAthlete> {
    return this.get<StravaDetailedAthlete>("/athlete");
  }

  /** GET /athlete/zones — HR + power zone definitions. */
  async getAthleteZones(): Promise<StravaAthleteZones> {
    return this.get<StravaAthleteZones>("/athlete/zones");
  }

  /** GET /athletes/{id}/stats — lifetime totals per sport. */
  async getAthleteStats(id: number | string): Promise<StravaActivityStats> {
    return this.get<StravaActivityStats>(`/athletes/${id}/stats`);
  }

  /** GET /gear/{id} — DetailedGear (brand, model, frame_type, distance). */
  async getGear(id: string): Promise<StravaDetailedGear> {
    return this.get<StravaDetailedGear>(`/gear/${id}`);
  }

  // ── Internals ──────────────────────────────────────────────────────

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${resolveApiBase()}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.ensureFreshToken();

      const res = await this.fetchFn(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.tokens.access_token}`,
          Accept: "application/json",
        },
      });

      // Always observe headers — even on errors — so the tracker stays
      // honest about how close we are to the cap.
      this.quota.observe(res.headers);

      if (res.ok) {
        return (await res.json()) as T;
      }

      if (res.status === 401) {
        if (attempt === 0) {
          log.warn("Got 401, forcing token refresh");
          await this.refreshTokens();
          continue;
        }
        // 401 *after* a successful refresh ≠ auth failure. The refresh
        // would have thrown if the refresh_token were actually bad. So
        // this access_token is valid; the endpoint requires a scope we
        // don't carry. Surface as StravaScopeError so callers can skip
        // optional endpoints (athlete-refresh) without breaking the
        // whole sync.
        throw new StravaScopeError(path);
      }

      // 402 (premium-gated sub-resource, e.g. an activity's HR/power zones)
      // and 403 (Summit-only) both mean the athlete's plan can't access this
      // endpoint. Surface the same typed error so optional enrichments skip
      // gracefully rather than aborting the whole sync.
      if (res.status === 402 || res.status === 403) {
        throw new StravaForbiddenError(path, res.status);
      }

      if (res.status === 404) {
        throw new StravaNotFoundError(path);
      }

      if (res.status === 429) {
        const waitMs = computeRateLimitBackoff(res.headers);
        if (attempt >= MAX_RETRIES) {
          throw new StravaRateLimitError(
            `Rate limit exceeded after ${MAX_RETRIES} retries`,
            waitMs,
          );
        }
        // `computeRateLimitBackoff` returns up to 16 min on short-term-cap
        // exhaustion and a full 1h on daily-cap exhaustion. Sleeping that long
        // in-tick blocks the whole sync (the engine's wall-clock timeout from
        // #324 eventually fires, but only after the wait is wasted). Cap the
        // in-tick wait at the threshold below; for longer waits, carry the
        // backoff out on the error so the engine flips the source to
        // `rate-limit` and defers the next tick by exactly that long.
        if (waitMs > IN_TICK_RATE_LIMIT_THRESHOLD_MS) {
          throw new StravaRateLimitError(
            `Rate limit exceeded — backoff ${Math.round(waitMs / 60_000)}m exceeds the in-tick threshold; surfacing to the engine to defer`,
            waitMs,
          );
        }
        log.warn(
          `Rate limited (429), sleeping ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await this.sleepFn(waitMs);
        continue;
      }

      const body = await res.text().catch(() => "");
      throw new Error(`Strava API ${res.status} ${res.statusText} for ${path}: ${body}`);
    }

    throw new Error("Strava client: max retries exhausted");
  }

  private async ensureFreshToken(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.tokens.expires_at > nowSec + REFRESH_SKEW_SECONDS) return;
    await this.refreshTokens();
  }

  private async refreshTokens(): Promise<void> {
    if (this.refreshInFlight) {
      await this.refreshInFlight;
      return;
    }
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = undefined;
    });
    await this.refreshInFlight;
  }

  private async doRefresh(): Promise<void> {
    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.credentials.client_id,
        client_secret: this.credentials.client_secret,
        grant_type: "refresh_token",
        refresh_token: this.tokens.refresh_token,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw classifyRefreshFailure(res.status, body, res.headers);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_at: number;
      expires_in: number;
      token_type: string;
    };

    this.tokens = {
      ...this.tokens,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    };

    log.info(
      `Refreshed Strava token for athlete ${this.tokens.athlete_id} (expires at ${new Date(this.tokens.expires_at * 1000).toISOString()})`,
    );

    if (this.onTokensRefreshed) {
      await this.onTokensRefreshed(this.tokens);
    }
  }
}

/**
 * Map a failed `POST /oauth/token` response to a typed error.
 *
 * Only `400` and `401` mean the grant itself is gone: Strava answers a revoked,
 * superseded, or otherwise invalid refresh token with `400 Bad Request`. Those
 * are the two statuses where re-authorizing is the remedy, so they alone become
 * a `StravaAuthError` and park the source in `needs-auth`.
 *
 * Every other status is the token endpoint being unhappy, not the athlete
 * having disconnected — a `429` is throttling, a `5xx` is Strava's own outage,
 * and both clear on their own. Calling those `auth` would push a re-auth
 * reminder for credentials that were never broken and that no amount of
 * re-authorizing would change.
 */
export function classifyRefreshFailure(status: number, body: string, headers?: Headers): SyncError {
  const detail = `Strava token refresh failed (${status})${body ? `: ${body}` : ""}`;
  if (status === 400 || status === 401) return new StravaAuthError(detail);
  if (status === 429) {
    return new StravaRateLimitError(detail, headers ? computeRateLimitBackoff(headers) : undefined);
  }
  return new SyncError(status >= 500 ? "transient" : "unknown", detail);
}

/**
 * Factory that loads tokens from disk and wires the persist-on-refresh callback.
 * Used by the provider's `createContext`.
 */
export async function buildStravaClient(opts: {
  tokens: StravaTokens;
  configDir?: string;
}): Promise<StravaClient> {
  return new StravaClient({
    tokens: opts.tokens,
    configDir: opts.configDir,
    onTokensRefreshed: async (refreshed) => {
      await saveTokens(refreshed, opts.configDir);
    },
  });
}

/**
 * Compute backoff for a 429.
 *
 * Strava's rate-limit headers look like:
 *   X-RateLimit-Limit: 100,1000
 *   X-RateLimit-Usage: 101,1234
 * (short-term 15-min limit, daily limit).
 */
export function computeRateLimitBackoff(headers: Headers): number {
  const retryAfter = headers.get("Retry-After");
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  }

  const usage = parseRateLimitPair(headers.get("X-RateLimit-Usage"));
  const limit = parseRateLimitPair(headers.get("X-RateLimit-Limit"));

  if (usage && limit && usage.daily >= limit.daily) {
    return 60 * 60 * 1000;
  }

  const now = new Date();
  const minutes = now.getUTCMinutes();
  const nextQuarter = Math.ceil((minutes + 1) / 15) * 15;
  const next = new Date(now);
  next.setUTCMinutes(nextQuarter, 0, 0);
  const waitMs = next.getTime() - now.getTime();
  return Math.max(30_000, Math.min(waitMs, 16 * 60 * 1000));
}

function parseRateLimitPair(value: string | null): { short: number; daily: number } | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((s) => parseInt(s.trim(), 10));
  if (parts.length !== 2 || parts.some(Number.isNaN)) return undefined;
  return { short: parts[0]!, daily: parts[1]! };
}
