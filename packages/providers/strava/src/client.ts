// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { SyncError, type SyncRemediation } from "@omnesis/types";
import { STREAM_KEYS } from "./types.js";
import { loadClientCredentials, saveTokens } from "./provider.js";
import { DEFAULT_SAFETY_PCT, ENRICHMENT_SAFETY_PCT, StravaRateLimitTracker } from "./quota.js";
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
// website deep-links stay on `www.strava.com`. See #27 (remove the date-gate
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
 * Maximum in-tick sleep on a 429. The wait runs 30 seconds past the reset of
 * the window Strava reports spent: up to 15½ minutes for the 15-minute window,
 * until UTC midnight for the day. 5 min is a comfortable compromise — short
 * enough that the sync tick stays responsive, long enough to absorb most
 * short-window throttling without surfacing as a source-state flip. Anything
 * longer goes through `StravaRateLimitError` (which the collector classifies
 * as `rate-limit`) so the next scheduled tick re-attempts and the source UI
 * shows a clear "rate-limited" badge rather than a stuck "syncing" pill.
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
 * Quota `app`: the wait comes from the `X-RateLimit-*` and `X-ReadRateLimit-*`
 * usage, which Strava counts against the registered API application
 * (`client_id`), not the individual athlete, so every athlete connected
 * through this install's app (see `credentials-spec.ts`) draws on one budget.
 */
export class StravaRateLimitError extends SyncError {
  constructor(message: string, retryAfterMs?: number) {
    super("rate-limit", message, { retryAfterMs, quota: { kind: "app" } });
    this.name = "StravaRateLimitError";
  }
}

/**
 * A page its rate-limit gate refused before it made a single call.
 *
 * Still a `StravaRateLimitError`, so the collector parks the source on it like
 * any other. It has a type of its own because nothing was spent: the
 * activities source can drop an enrichment page refused this way and list new
 * activities in its place.
 *
 * That rests on one invariant: this is only ever thrown before a page's first
 * call to Strava. A gate placed after a call would have the fallback silently
 * drop what the page had fetched. A 429 is never one of these, even though it
 * too is a rate limit: it can arrive partway through a page, after calls were
 * spent, and Strava would refuse the listing as well.
 */
export class StravaQuotaDeferral extends StravaRateLimitError {
  constructor(message: string, retryAfterMs: number) {
    super(message, retryAfterMs);
    this.name = "StravaQuotaDeferral";
  }
}

/**
 * The error a page throws when the rate-limit budget cannot cover it.
 *
 * A page that returned `hasMore` with its cursor unchanged would be fetched
 * again at once and refused again, each time a round trip to the gateway, for
 * as long as the window stays spent. A `rate-limit` error that says how long to
 * wait parks the source instead, and the next tick resumes from the same cursor.
 */
export function quotaDeferral(
  label: string,
  calls: number,
  quota: StravaRateLimitTracker,
  safetyPct = DEFAULT_SAFETY_PCT,
): StravaQuotaDeferral {
  return new StravaQuotaDeferral(
    `${label}: quota too low for ${calls} calls`,
    // At least 1ms: a rate-limit error without a positive delay takes the
    // collector's generic error path, and the budget can come back between the
    // caller's check and this one.
    Math.max(1, quota.msUntilCanMakeNCalls(calls, safetyPct)),
  );
}

/**
 * Refuses enrichment that enrichment's share of the budget cannot cover, with
 * a deferral that waits until it can; see `ENRICHMENT_SAFETY_PCT`.
 */
export function requireEnrichmentBudget(
  label: string,
  calls: number,
  quota: StravaRateLimitTracker,
): void {
  if (!quota.canMakeNCalls(calls, ENRICHMENT_SAFETY_PCT)) {
    throw quotaDeferral(label, calls, quota, ENRICHMENT_SAFETY_PCT);
  }
}

/** Where the owner of a Strava API application manages it. */
const STRAVA_API_SETTINGS_URL = "https://www.strava.com/settings/api";

/**
 * Strava refused this install's API application, not anything the athlete or
 * one activity holds.
 *
 * Strava deactivates a Standard Tier application whose owner, the account that
 * registered it, has no active subscription, and then answers every data
 * request with a 403 whose body names the `Application` resource (code
 * `Inactive`) rather than the athlete or activity a refusal of one resource
 * concerns. The athletes connected to the application need no subscription
 * for it; only its owner subscribing and reactivating it on the API settings
 * page clears it. Strava does not document whether it also refuses a
 * deactivated application's token refreshes, and a lapsed access token makes
 * the refresh the first request of every tick, so a refused refresh that
 * names the application is read as this too (see `classifyRefreshFailure`).
 *
 * Never a `StravaForbiddenError`. The tiers read that as one activity refused,
 * mark the activity done and move on, so a deactivated application read as one
 * would mark the whole backlog done with nothing fetched, and reactivating it
 * would bring none of it back. Thrown, it ends the tick before the page writes
 * anything, and the next tick resumes from the same cursor.
 *
 * Kind `permission`, not `auth`: authorizing again changes nothing, so
 * `needs-auth` would send the athlete through a sign-in that leaves the source
 * as it was. Scoped `connection`: the application is the credential every
 * athlete on this install connects through.
 */
export class StravaApplicationInactiveError extends SyncError {
  constructor(
    public readonly path: string,
    public readonly status: number,
    /** The code Strava gave for the refusal; `Inactive` for a deactivated application. */
    public readonly code: string,
  ) {
    const remediation = applicationRemediation(code);
    super(
      "permission",
      `${remediation.summary} (Strava answered ${status} for ${path}): sign in to Strava as the account that registered it, make sure that account has an active subscription, and reactivate the application at ${STRAVA_API_SETTINGS_URL}`,
      { scope: "connection", remediation },
    );
    this.name = "StravaApplicationInactiveError";
  }
}

/** Strava's code for a deactivated application, in whichever case it is sent. */
const isInactive = (code: string): boolean => /^inactive$/i.test(code);

function applicationRemediation(code: string): SyncRemediation {
  // Strava's code is unbounded and a remedy's summary is not: one longer than
  // the wire schema allows is dropped whole on its way to the operator.
  const shown = code.slice(0, 40);
  return {
    // Only `Inactive` is documented. Any other code still names the
    // application, so the steps are the same, but the summary does not claim
    // a deactivation Strava did not report.
    summary: isInactive(code)
      ? "Strava has deactivated this install's API application"
      : `Strava refuses this install's API application${shown ? ` (${shown})` : ""}`,
    steps: [
      "Sign in to Strava as the account that registered this install's API application.",
      "Make sure that account has an active Strava subscription: Strava deactivates a Standard Tier application whose owner has none, whether or not the athletes connected to it subscribe.",
      `Reactivate the application on ${STRAVA_API_SETTINGS_URL}; the source then carries on from where it stopped.`,
    ],
    restartRequired: false,
  };
}

/**
 * Strava's refusal of the application, read off a failed response, or
 * `undefined` when the response is not one.
 *
 * A 402 or 403 whose body names the `Application` resource is one whatever
 * its code: a data request asks nothing of the application but that it be
 * allowed. Any other status is one only with the code `Inactive`. Strava also
 * names the application when the token endpoint is sent a client id it does
 * not know (a 400, code `invalid`), and that is the install's credentials
 * being wrong, which re-entering them fixes, not the application refused.
 */
function applicationRefused(
  path: string,
  status: number,
  body: string,
): StravaApplicationInactiveError | undefined {
  const code = applicationRefusalCode(body);
  if (code === undefined) return undefined;
  if (status === 402 || status === 403 || isInactive(code)) {
    return new StravaApplicationInactiveError(path, status, code);
  }
  return undefined;
}

/**
 * The code of the refusal a body gives the `Application` resource, or
 * `undefined` when the body names no such refusal — not JSON, no `errors`, or
 * errors about anything else, which is a refusal of the resource asked for.
 * The code is empty when the refusal gives none.
 */
function applicationRefusalCode(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const errors = (parsed as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return undefined;
  for (const error of errors as unknown[]) {
    const { resource, code } = (error ?? {}) as { resource?: unknown; code?: unknown };
    if (typeof resource === "string" && resource.trim().toLowerCase() === "application") {
      return typeof code === "string" ? code.trim() : "";
    }
  }
  return undefined;
}

/**
 * Thrown when an endpoint returns 403 (Summit-only features like zones or
 * advanced metrics on a non-Summit account) or 402 (a premium-gated
 * sub-resource the athlete's plan doesn't include). Both mean "your account
 * tier can't access this endpoint" — callers catch and downgrade gracefully
 * (e.g. mark `zones_unavailable=true`) instead of failing the whole sync.
 * A refusal of the API application itself is not one of these; see
 * `StravaApplicationInactiveError`.
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
 * which the athlete can untick on Strava's authorization screen). Distinct
 * from `StravaAuthError` — callers can skip optional best-effort endpoints
 * (athlete-refresh tier) without tearing down the whole sync. The activity
 * listing is not optional, and never surfaces this; see `listActivities`.
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

/**
 * Any other HTTP error Strava answers with: a 5xx, or a 4xx none of the errors
 * above covers. The message is the one these always carried, so the collector
 * still reads a 5xx in it as transient; the status and path let a caller tell
 * Strava failing one activity's resource from Strava failing.
 */
export class StravaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "StravaApiError";
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
    try {
      return await this.get<StravaSummaryActivity[]>("/athlete/activities", qs);
    } catch (err) {
      // Every other endpoint is optional and its caller skips a scope the
      // grant lacks. This one is not: every phase of the sync starts from the
      // listing, so a grant without an activity scope syncs nothing, and only
      // the athlete authorizing again can widen it. Untyped, the refusal
      // would leave the source in a generic error that every tick repeats.
      if (err instanceof StravaScopeError) {
        throw new StravaAuthError(
          "Strava's authorization does not cover this athlete's activities; authorize again and leave the activity boxes ticked",
        );
      }
      throw err;
    }
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

    // Whether this request has already refreshed the token after a 401. Not
    // the attempt index: a 429's in-tick wait also takes an attempt, and a 401
    // after it has had no refresh to vouch for the token. The attempts count
    // 429 waits only; the flag alone bounds the refreshes to one.
    let refreshedAfter401 = false;
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
        if (!refreshedAfter401) {
          refreshedAfter401 = true;
          log.warn("Got 401, forcing token refresh");
          await this.refreshTokens();
          attempt--;
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
      // gracefully rather than aborting the whole sync — unless the body says
      // Strava refused the application, which every request would meet alike.
      if (res.status === 402 || res.status === 403) {
        const refused = applicationRefused(path, res.status, await res.text().catch(() => ""));
        throw refused ?? new StravaForbiddenError(path, res.status);
      }

      if (res.status === 404) {
        throw new StravaNotFoundError(path);
      }

      if (res.status === 429) {
        // The refusal's headers were observed above, so the tracker knows which
        // window Strava counts as spent and when it resets.
        const waitMs = this.quota.msUntilRetry(retryAfterHeaderMs(res.headers));
        if (attempt >= MAX_RETRIES) {
          throw new StravaRateLimitError(
            `Rate limit exceeded after ${MAX_RETRIES} retries`,
            waitMs,
          );
        }
        // A spent 15-minute window waits up to 15½ minutes and a spent day
        // until midnight UTC. Sleeping that long in-tick blocks the whole sync
        // (the engine's wall-clock timeout eventually fires, but only after the
        // wait is wasted). Cap the in-tick wait at the threshold below; for
        // longer waits, carry the wait out on the error so the engine flips the
        // source to `rate-limit` and defers the next tick by exactly that long.
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
      throw new StravaApiError(
        res.status,
        path,
        `Strava API ${res.status} ${res.statusText} for ${path}: ${body}`,
      );
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
      let retryAfterMs: number | undefined;
      if (res.status === 429) {
        // A throttled refresh waits as a throttled request does.
        this.quota.observe(res.headers);
        retryAfterMs = this.quota.msUntilRetry(retryAfterHeaderMs(res.headers));
      }
      throw classifyRefreshFailure(res.status, body, retryAfterMs);
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
 *
 * Strava refusing the application comes before all of them. A deactivated
 * application is no grant gone, so reading its refusal as a `400` or `401`
 * would park the source in `needs-auth` for a sign-in that changes nothing,
 * and any other status would leave the operator with Strava's raw body and no
 * remedy.
 *
 * `retryAfterMs` is how long a throttled refresh waits; only a 429 reads it.
 */
export function classifyRefreshFailure(
  status: number,
  body: string,
  retryAfterMs?: number,
): SyncError {
  const refused = applicationRefused(new URL(TOKEN_URL).pathname, status, body);
  if (refused) return refused;
  const detail = `Strava token refresh failed (${status})${body ? `: ${body}` : ""}`;
  if (status === 400 || status === 401) return new StravaAuthError(detail);
  if (status === 429) return new StravaRateLimitError(detail, retryAfterMs);
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
 * A `Retry-After` in seconds, if the response carried one. Strava documents
 * none (its 429 carries the usage headers every response does), but a proxy
 * set through `OMNESIS_STRAVA_API_BASE` may send one.
 */
function retryAfterHeaderMs(headers: Headers): number | undefined {
  const seconds = parseInt(headers.get("Retry-After") ?? "", 10);
  return seconds > 0 ? seconds * 1000 : undefined;
}
