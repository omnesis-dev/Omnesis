// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import { syncRemediationSchema } from "@omnesis/core";
import { formatSyncRemediation, type SyncError } from "@omnesis/types";
import {
  StravaApiError,
  StravaApplicationInactiveError,
  StravaAuthError,
  StravaClient,
  StravaForbiddenError,
  StravaQuotaDeferral,
  StravaRateLimitError,
  StravaScopeError,
  classifyRefreshFailure,
  quotaDeferral,
  resolveApiBase,
} from "./client.js";
import { ENRICHMENT_SAFETY_PCT, StravaRateLimitTracker } from "./quota.js";
import type { FetchFn } from "./client.js";
import type { StravaTokens, StravaCredentials } from "./types.js";

const CREDS: StravaCredentials = { client_id: "cid", client_secret: "csec" };

function makeTokens(overrides: Partial<StravaTokens> = {}): StravaTokens {
  return {
    access_token: "old_access",
    refresh_token: "old_refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    athlete_id: 123,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Build a mock fetch from a queue of responses keyed loosely by URL. */
function makeMockFetch(
  handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>,
) {
  let i = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: FetchFn = async (input, init) => {
    const url = input;
    calls.push({ url, init });
    const handler = handlers[i++];
    if (!handler) throw new Error(`Unexpected fetch call #${i}: ${url}`);
    return handler(url, init);
  };
  return { fetchFn, calls };
}

describe("StravaClient token refresh", () => {
  test("refreshes and persists when expires_at is stale", async () => {
    const tokens = makeTokens({ expires_at: Math.floor(Date.now() / 1000) - 10 });
    const persisted: StravaTokens[] = [];

    const { fetchFn, calls } = makeMockFetch([
      // 1. Refresh
      () =>
        jsonResponse({
          access_token: "new_access",
          refresh_token: "new_refresh",
          expires_at: Math.floor(Date.now() / 1000) + 7200,
          expires_in: 7200,
          token_type: "Bearer",
        }),
      // 2. /athlete
      (url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(url).toBe(`${resolveApiBase()}/athlete`);
        expect(headers.Authorization).toBe("Bearer new_access");
        return jsonResponse({ id: 123, firstname: "A", lastname: "B" });
      },
    ]);

    const client = new StravaClient({
      tokens,
      credentials: CREDS,
      fetchFn,
      onTokensRefreshed: async (t) => {
        persisted.push(t);
      },
    });

    const athlete = await client.getAthleteDetail();
    expect(athlete.id).toBe(123);
    expect(calls[0]!.url).toContain("/oauth/token");
    expect(client.getTokens().access_token).toBe("new_access");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.access_token).toBe("new_access");
  });

  test("does NOT refresh when token is still fresh", async () => {
    const { fetchFn, calls } = makeMockFetch([() => jsonResponse({ id: 123 })]);
    const client = new StravaClient({
      tokens: makeTokens(),
      credentials: CREDS,
      fetchFn,
    });
    await client.getAthleteDetail();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${resolveApiBase()}/athlete`);
  });

  test("refreshes once on 401, then retries the original request", async () => {
    let refreshCount = 0;
    const { fetchFn } = makeMockFetch([
      // 1. First /athlete call → 401
      () => new Response("unauthorized", { status: 401 }),
      // 2. Refresh
      () => {
        refreshCount++;
        return jsonResponse({
          access_token: "new_access",
          refresh_token: "new_refresh",
          expires_at: Math.floor(Date.now() / 1000) + 7200,
          expires_in: 7200,
          token_type: "Bearer",
        });
      },
      // 3. Retry /athlete → 200
      (_, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer new_access");
        return jsonResponse({ id: 123 });
      },
    ]);

    const client = new StravaClient({
      tokens: makeTokens(),
      credentials: CREDS,
      fetchFn,
    });

    const athlete = await client.getAthleteDetail();
    expect(athlete.id).toBe(123);
    expect(refreshCount).toBe(1);
  });
});

/** Strava's answer to a token that lacks the scope an endpoint needs. */
function scopeRefusal(): Response {
  return jsonResponse(
    {
      message: "authorization error",
      errors: [{ resource: "AccessToken", field: "activity:read_permission", code: "missing" }],
    },
    401,
  );
}

function refreshedGrant(): Response {
  return jsonResponse({
    access_token: "new_access",
    refresh_token: "new_refresh",
    expires_at: Math.floor(Date.now() / 1000) + 7200,
    expires_in: 7200,
    token_type: "Bearer",
  });
}

// A 401 that survives a refresh means the grant is good but too narrow. Most
// endpoints are optional and their callers skip it; the activity listing is
// what every phase of the sync starts from.
describe("a grant too narrow for an endpoint", () => {
  test("refused on the activity listing, it is an auth failure only a new authorization fixes", async () => {
    const { fetchFn, calls } = makeMockFetch([scopeRefusal, refreshedGrant, scopeRefusal]);
    const client = new StravaClient({ tokens: makeTokens(), credentials: CREDS, fetchFn });

    const err = await client.listActivities({ page: 1 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StravaAuthError);
    expect(err).toMatchObject({ kind: "auth", scope: "connection" });
    // One refresh to rule out a stale token, then no more.
    expect(calls.filter((c) => c.url.includes("/oauth/token"))).toHaveLength(1);
  });

  test("refused on an optional endpoint, it stays a scope error its caller skips", async () => {
    const { fetchFn } = makeMockFetch([scopeRefusal, refreshedGrant, scopeRefusal]);
    const client = new StravaClient({ tokens: makeTokens(), credentials: CREDS, fetchFn });

    await expect(client.getAthleteZones()).rejects.toBeInstanceOf(StravaScopeError);
  });
});

// Strava refuses every data request of an application it has deactivated, its
// owner having no subscription, with a 403 whose body names the application.
// Read as one endpoint refused, each tier would mark its activities done with
// nothing fetched.
describe("a refusal of the API application itself", () => {
  const inactive = {
    message: "Forbidden",
    errors: [{ resource: "Application", field: "Status", code: "Inactive" }],
  };

  async function refusedWith(body: unknown, status = 403): Promise<unknown> {
    const { fetchFn } = makeMockFetch([
      () =>
        typeof body === "string" ? new Response(body, { status }) : jsonResponse(body, status),
    ]);
    const client = new StravaClient({ tokens: makeTokens(), credentials: CREDS, fetchFn });
    return client.getActivityZones(7).catch((e: unknown) => e);
  }

  test("is the application refused, with a remedy, not the endpoint refused", async () => {
    const err = await refusedWith(inactive);

    expect(err).toBeInstanceOf(StravaApplicationInactiveError);
    expect(err).not.toBeInstanceOf(StravaForbiddenError);
    expect(err).not.toBeInstanceOf(StravaApiError);
    expect(err).toMatchObject({
      // Authorizing again would change nothing, so not `auth`.
      kind: "permission",
      scope: "connection",
      path: "/activities/7/zones",
      status: 403,
      code: "Inactive",
      remediation: {
        summary: "Strava has deactivated this install's API application",
        restartRequired: false,
      },
    });
    const remedy = formatSyncRemediation((err as SyncError).remediation!);
    expect(remedy).toMatch(/account that registered this install's API application/);
    expect(remedy).toMatch(/active Strava subscription/);
    expect(remedy).toMatch(
      /Reactivate the application on https:\/\/www\.strava\.com\/settings\/api/,
    );
    // A client without the remedy's affordance shows the message alone.
    expect((err as Error).message).toMatch(
      /^Strava has deactivated this install's API application \(Strava answered 403 for \/activities\/7\/zones\): .*subscription.*https:\/\/www\.strava\.com\/settings\/api$/,
    );
  });

  test("on the activity listing it stays the application refused, not a sign-in", async () => {
    const { fetchFn } = makeMockFetch([() => jsonResponse(inactive, 403)]);
    const client = new StravaClient({ tokens: makeTokens(), credentials: CREDS, fetchFn });

    const err = await client.listActivities({ page: 1 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StravaApplicationInactiveError);
    expect(err).toMatchObject({ kind: "permission", path: "/athlete/activities" });
  });

  test.each<[string, unknown]>([
    ["spelled in another case", { errors: [{ resource: "application", code: "inactive" }] }],
    [
      "after an error about something else",
      {
        message: "Forbidden",
        errors: [
          { resource: "Athlete", field: "id", code: "invalid" },
          { resource: " Application ", field: "Status", code: "Inactive" },
        ],
      },
    ],
  ])("is read from a body %s", async (_, body) => {
    await expect(refusedWith(body)).resolves.toMatchObject({
      code: expect.stringMatching(/^inactive$/i),
      remediation: { summary: "Strava has deactivated this install's API application" },
    });
  });

  test("with a code Strava does not document, it is still the application refused", async () => {
    const err = await refusedWith({
      message: "Forbidden",
      errors: [{ resource: "Application", field: "Status", code: "Suspended" }],
    });

    expect(err).toBeInstanceOf(StravaApplicationInactiveError);
    // Without claiming a deactivation Strava did not report.
    expect(err).toMatchObject({
      remediation: { summary: "Strava refuses this install's API application (Suspended)" },
    });
  });

  test("however long its code, the remedy still fits what reaches the operator", async () => {
    const err = await refusedWith({
      message: "Forbidden",
      errors: [{ resource: "Application", field: "Status", code: "Withheld".repeat(40) }],
    });

    expect(err).toBeInstanceOf(StravaApplicationInactiveError);
    // A remedy past the wire schema's bounds is dropped whole on its way.
    const remediation = (err as SyncError).remediation;
    expect(syncRemediationSchema.safeParse(remediation).success).toBe(true);
    expect(remediation?.summary).toMatch(
      /^Strava refuses this install's API application \(Withheld/,
    );
  });

  test.each<[string, unknown, 402 | 403]>([
    ["an empty body", "", 403],
    ["a body that is not JSON", "forbidden", 403],
    ["a body without errors", { message: "Forbidden" }, 403],
    [
      "errors that are not a list",
      { message: "Forbidden", errors: { resource: "Application" } },
      403,
    ],
    ["an empty list of errors", { message: "Forbidden", errors: [] }, 403],
    [
      "errors about the activity",
      { message: "Forbidden", errors: [{ resource: "Activity", field: "id", code: "forbidden" }] },
      403,
    ],
    ["a payment refusal of the athlete's", { message: "Payment required", errors: [] }, 402],
  ])("%s is the endpoint refused, which its caller steps over", async (_, body, status) => {
    const err = await refusedWith(body, status);

    expect(err).toBeInstanceOf(StravaForbiddenError);
    expect(err).toMatchObject({ status, path: "/activities/7/zones" });
  });
});

// A refresh failure is the only place the client can learn that the stored
// grant is dead — and the only place it can mistake Strava being unwell for
// the athlete having disconnected. The `kind` is what the collector reads to
// decide between "park in needs-auth and nag the operator" and "retry later".
describe("token-refresh failure classification", () => {
  test("400 and 401 are the only statuses that mean re-authorize", () => {
    for (const status of [400, 401]) {
      const err = classifyRefreshFailure(status, '{"code":"invalid"}');
      expect(err).toBeInstanceOf(StravaAuthError);
      expect((err as SyncError).kind).toBe("auth");
      // The grant lives on the athlete's Strava connection, not on
      // strava-activities specifically.
      expect((err as SyncError).scope).toBe("connection");
    }
  });

  test("a throttled token endpoint is rate-limit, not auth, and counts against the app's quota", () => {
    const err = classifyRefreshFailure(429, "slow down");
    expect((err as SyncError).kind).toBe("rate-limit");
    expect(err).not.toBeInstanceOf(StravaAuthError);
    // Strava counts the short and daily caps against the registered
    // client_id, not the individual athlete.
    expect((err as SyncError).quota).toEqual({ kind: "app" });
  });

  test("a Strava outage is transient, not auth", () => {
    for (const status of [500, 502, 503]) {
      const err = classifyRefreshFailure(status, "upstream unavailable");
      expect((err as SyncError).kind).toBe("transient");
      expect(err).not.toBeInstanceOf(StravaAuthError);
    }
  });

  test("an unclassifiable status is not auth either", () => {
    const err = classifyRefreshFailure(418, "");
    expect((err as SyncError).kind).toBe("unknown");
    expect(err).not.toBeInstanceOf(StravaAuthError);
  });

  test("a 5xx while refreshing does not reach the collector as auth", async () => {
    const { fetchFn } = makeMockFetch([() => new Response("upstream down", { status: 503 })]);
    const client = new StravaClient({
      tokens: makeTokens({ expires_at: Math.floor(Date.now() / 1000) - 10 }),
      credentials: CREDS,
      fetchFn,
    });
    await expect(client.getAthleteDetail()).rejects.toMatchObject({ kind: "transient" });
  });

  test("a revoked grant reaches the collector as auth", async () => {
    const { fetchFn } = makeMockFetch([
      () =>
        new Response(
          // The body a revoked or superseded grant comes back with.
          JSON.stringify({
            errors: [{ resource: "RefreshToken", field: "refresh_token", code: "invalid" }],
          }),
          { status: 400 },
        ),
    ]);
    const client = new StravaClient({
      tokens: makeTokens({ expires_at: Math.floor(Date.now() / 1000) - 10 }),
      credentials: CREDS,
      fetchFn,
    });
    await expect(client.getAthleteDetail()).rejects.toMatchObject({ kind: "auth" });
  });

  // Strava does not document whether it refuses a deactivated application's
  // refreshes. Once the six-hour access token lapses the refresh is the first
  // request of every tick, so if it does, the refresh is all the source meets.
  describe("a refresh refused because Strava refused the application", () => {
    const inactive = JSON.stringify({
      message: "Forbidden",
      errors: [{ resource: "Application", field: "Status", code: "Inactive" }],
    });

    test("is the application refused, with its remedy", () => {
      const err = classifyRefreshFailure(403, inactive);

      expect(err).toBeInstanceOf(StravaApplicationInactiveError);
      expect(err).toMatchObject({
        kind: "permission",
        scope: "connection",
        path: "/oauth/token",
        status: 403,
        code: "Inactive",
        remediation: { summary: "Strava has deactivated this install's API application" },
      });
    });

    test("is never a sign-in, whatever status carries it", () => {
      // Authorizing again would leave the application as deactivated as it was.
      for (const status of [400, 401, 429, 503]) {
        const err = classifyRefreshFailure(status, inactive);
        expect(err, String(status)).toBeInstanceOf(StravaApplicationInactiveError);
        expect(err, String(status)).not.toBeInstanceOf(StravaAuthError);
        expect(err.kind, String(status)).toBe("permission");
      }
    });

    test("a 403 naming the application is it, whatever the code", () => {
      const err = classifyRefreshFailure(
        403,
        JSON.stringify({
          errors: [{ resource: "Application", field: "Status", code: "Suspended" }],
        }),
      );

      expect(err).toBeInstanceOf(StravaApplicationInactiveError);
      expect(err).toMatchObject({ code: "Suspended" });
    });

    test("a client id Strava does not know is still the credentials, not the application", () => {
      // The answer to a wrong client id names the application too.
      const err = classifyRefreshFailure(
        400,
        JSON.stringify({
          errors: [{ resource: "Application", field: "client_id", code: "invalid" }],
        }),
      );

      expect(err).toBeInstanceOf(StravaAuthError);
      expect(err).not.toBeInstanceOf(StravaApplicationInactiveError);
    });

    test("a lapsed token's refresh ends the listing with it, before any data request", async () => {
      const { fetchFn, calls } = makeMockFetch([() => new Response(inactive, { status: 403 })]);
      const client = new StravaClient({
        tokens: makeTokens({ expires_at: Math.floor(Date.now() / 1000) - 10 }),
        credentials: CREDS,
        fetchFn,
      });

      const err = await client.listActivities({ page: 1 }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(StravaApplicationInactiveError);
      expect(err).not.toBeInstanceOf(StravaApiError);
      expect(err).toMatchObject({ kind: "permission", path: "/oauth/token" });
      expect(formatSyncRemediation((err as SyncError).remediation!)).toMatch(
        /active Strava subscription.*https:\/\/www\.strava\.com\/settings\/api/s,
      );
      expect(calls.map(({ url }) => url)).toEqual(["https://www.strava.com/oauth/token"]);
    });

    test("a 401 whose forced refresh is refused ends the request with it too", async () => {
      // An access token Strava stops honouring before its stated expiry.
      const { fetchFn, calls } = makeMockFetch([
        () =>
          jsonResponse(
            { errors: [{ resource: "Athlete", field: "access_token", code: "invalid" }] },
            401,
          ),
        () => new Response(inactive, { status: 403 }),
      ]);
      const client = new StravaClient({ tokens: makeTokens(), credentials: CREDS, fetchFn });

      await expect(client.getActivity(7)).rejects.toBeInstanceOf(StravaApplicationInactiveError);
      expect(calls).toHaveLength(2);
    });
  });
});

/**
 * A 429 as Strava sends it: the usage headers every response carries, for the
 * overall limit and for the read limit a new app reaches first.
 */
function refusal(
  usage: { overall: string; read: string },
  extra: Record<string, string> = {},
): Response {
  return jsonResponse({ message: "rate limit exceeded" }, 429, {
    "X-RateLimit-Limit": "200,2000",
    "X-RateLimit-Usage": usage.overall,
    "X-ReadRateLimit-Limit": "100,1000",
    "X-ReadRateLimit-Usage": usage.read,
    ...extra,
  });
}

describe("StravaClient rate limit handling", () => {
  test("sleeps and retries on 429, then succeeds", async () => {
    const sleeps: number[] = [];
    const { fetchFn } = makeMockFetch([
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "2" },
        }),
      () => jsonResponse([{ id: 1 }]),
    ]);
    const client = new StravaClient({
      tokens: makeTokens(),
      credentials: CREDS,
      fetchFn,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    const activities = await client.listActivities({ page: 1 });
    expect(activities).toHaveLength(1);
    expect(sleeps).toEqual([2000]);
  });

  // The wait a 429 carries comes from the tracker, which by then has observed
  // the refusal's own headers: it knows which window Strava counts as spent
  // and when that window resets.
  describe("the wait after a 429", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function clientFor(
      handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>,
      tokens: Partial<StravaTokens> = {},
    ) {
      const sleeps: number[] = [];
      const { fetchFn, calls } = makeMockFetch(handlers);
      const client = new StravaClient({
        tokens: makeTokens(tokens),
        credentials: CREDS,
        fetchFn,
        sleepFn: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });
      return { client, sleeps, calls };
    }

    test("a spent day of reads waits until UTC midnight", async () => {
      // The overall day is far from its limit; the read day is spent.
      vi.setSystemTime(new Date("2026-03-04T22:37:30Z"));
      const { client, sleeps, calls } = clientFor([
        () => refusal({ overall: "14,1006", read: "14,1006" }),
      ]);

      const request = client.getActivity(1);

      // Midnight, plus the 30 seconds that let Strava's reset land first.
      await expect(request).rejects.toMatchObject({ kind: "rate-limit", retryAfterMs: 4_980_000 });
      expect(sleeps).toEqual([]);
      expect(calls).toHaveLength(1);
    });

    test("a spent overall day waits until midnight, not an hour", async () => {
      vi.setSystemTime(new Date("2026-03-04T10:07:30Z"));
      const { client } = clientFor([() => refusal({ overall: "20,2001", read: "20,990" })]);

      await expect(client.getActivity(1)).rejects.toMatchObject({
        kind: "rate-limit",
        retryAfterMs: 49_980_000,
      });
    });

    test("a spent 15-minute read window waits for the quarter hour, not the day", async () => {
      vi.setSystemTime(new Date("2026-03-04T10:07:30Z"));
      const { client } = clientFor([() => refusal({ overall: "101,640", read: "101,640" })]);

      await expect(client.getActivity(1)).rejects.toMatchObject({
        kind: "rate-limit",
        retryAfterMs: 480_000,
      });
    });

    test("it waits for Strava's own limit, not the gates' headroom, and sleeps when the reset is near", async () => {
      // The short window is spent and the day stands at 95%: inside the 10%
      // the gates hold back, but under Strava's limit. The gates apply their
      // headroom to the next page themselves, without a call.
      vi.setSystemTime(new Date("2026-03-04T10:12:00Z"));
      const { client, sleeps } = clientFor([
        () => refusal({ overall: "100,950", read: "100,950" }),
        () => jsonResponse({ id: 1 }),
      ]);

      await expect(client.getActivity(1)).resolves.toMatchObject({ id: 1 });
      expect(sleeps).toEqual([210_000]);
    });

    test("a refusal reported in a window's first 30 seconds waits only for that grace to end", async () => {
      // Counted for the window before, so the tracker cannot explain it; the
      // window that refused it has reset by the end of the grace.
      vi.setSystemTime(new Date("2026-03-04T10:15:10Z"));
      const { client, sleeps } = clientFor([
        () => refusal({ overall: "100,300", read: "100,300" }),
        () => jsonResponse({ id: 1 }),
      ]);

      await expect(client.getActivity(1)).resolves.toMatchObject({ id: 1 });
      expect(sleeps).toEqual([20_000]);
    });

    test("a refusal nothing explains waits for the next quarter hour, never zero", async () => {
      vi.setSystemTime(new Date("2026-03-04T10:07:30Z"));
      const { client } = clientFor([() => jsonResponse({ message: "slow down" }, 429)]);

      const err = (await client.getActivity(1).catch((e: unknown) => e)) as SyncError;

      expect(err).toMatchObject({ kind: "rate-limit", retryAfterMs: 480_000 });
      expect(err.retryAfterMs).toBeGreaterThan(0);
    });

    test("a Retry-After never shortens a spent day's wait", async () => {
      vi.setSystemTime(new Date("2026-03-04T22:37:30Z"));
      const { client, sleeps } = clientFor([
        () => refusal({ overall: "14,1006", read: "14,1006" }, { "Retry-After": "2" }),
        () => jsonResponse({ id: 1 }),
      ]);

      await expect(client.getActivity(1)).rejects.toMatchObject({ retryAfterMs: 4_980_000 });
      expect(sleeps).toEqual([]);
    });

    test("a 429 is a plain rate limit, never the refusal a gate makes before calling", async () => {
      // The activities source lists in place of a page its gate refused. A 429
      // can come after calls were spent, and Strava would refuse the listing too.
      vi.setSystemTime(new Date("2026-03-04T22:37:30Z"));
      const { client } = clientFor([() => refusal({ overall: "14,1006", read: "14,1006" })]);

      const err = await client.getActivity(1).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(StravaRateLimitError);
      expect(err).not.toBeInstanceOf(StravaQuotaDeferral);
    });

    // A 429's wait takes an attempt too, so the attempt index cannot say
    // whether this request has refreshed the token yet.
    test("a 401 after a 429's wait refreshes, and a revoked grant is an auth failure", async () => {
      vi.setSystemTime(new Date("2026-03-04T10:13:00Z"));
      const { client, sleeps, calls } = clientFor([
        () => refusal({ overall: "101,500", read: "101,500" }),
        () => new Response("unauthorized", { status: 401 }),
        () => jsonResponse({ message: "bad request" }, 400),
      ]);

      await expect(client.getActivity(1)).rejects.toBeInstanceOf(StravaAuthError);
      expect(sleeps).toEqual([150_000]);
      expect(calls.filter((c) => c.url.includes("/oauth/token"))).toHaveLength(1);
    });

    test("a 401 after a 429's wait and a refresh is a missing scope", async () => {
      vi.setSystemTime(new Date("2026-03-04T10:13:00Z"));
      const { client, calls } = clientFor([
        () => refusal({ overall: "101,500", read: "101,500" }),
        () => new Response("unauthorized", { status: 401 }),
        refreshedGrant,
        () => new Response("unauthorized", { status: 401 }),
      ]);

      await expect(client.getActivity(1)).rejects.toBeInstanceOf(StravaScopeError);
      expect(calls.filter((c) => c.url.includes("/oauth/token"))).toHaveLength(1);
    });

    test("a 401 after every 429 wait still retries once the token is refreshed", async () => {
      // The refresh's retry is not a 429 retry: spending the last attempt on
      // it would end the request on an untyped error instead of the page.
      vi.setSystemTime(new Date("2026-03-04T10:13:00Z"));
      const spent = () => refusal({ overall: "101,500", read: "101,500" });
      const { client, sleeps } = clientFor([
        spent,
        spent,
        spent,
        () => new Response("unauthorized", { status: 401 }),
        refreshedGrant,
        () => jsonResponse({ id: 1 }),
      ]);

      await expect(client.getActivity(1)).resolves.toMatchObject({ id: 1 });
      expect(sleeps).toHaveLength(3);
    });

    test("a throttled token refresh defers as long as the tracker says", async () => {
      vi.setSystemTime(new Date("2026-03-04T22:37:30Z"));
      const { client } = clientFor([() => new Response("slow down", { status: 429 })], {
        expires_at: Math.floor(Date.now() / 1000) - 10,
      });
      client.quota.setState(undefined, {
        used: { short: 3, daily: 1000 },
        limit: { short: 100, daily: 1000 },
      });

      await expect(client.getAthleteDetail()).rejects.toMatchObject({
        kind: "rate-limit",
        retryAfterMs: 4_980_000,
      });
    });
  });
});

describe("a page its budget gate refuses", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("is a StravaQuotaDeferral the collector still reads as a rate limit", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-04T10:07:30Z"));
    const quota = new StravaRateLimitTracker();
    // 850 of the day's 1,000 reads: past enrichment's share, inside the default cap.
    quota.setState(undefined, {
      used: { short: 5, daily: 850 },
      limit: { short: 100, daily: 1000 },
    });

    const enrichment = quotaDeferral("Detail-backfill", 10, quota, ENRICHMENT_SAFETY_PCT);

    expect(enrichment).toBeInstanceOf(StravaQuotaDeferral);
    expect(enrichment).toBeInstanceOf(StravaRateLimitError);
    expect(enrichment).toMatchObject({
      kind: "rate-limit",
      quota: { kind: "app" },
      retryAfterMs: 49_980_000,
    });
    // At the default cap the same ten calls fit, and the wait never reaches zero.
    expect(quotaDeferral("Incremental", 10, quota).retryAfterMs).toBe(1);
  });
});

describe("StravaClient listActivities params", () => {
  test("forwards query params", async () => {
    const { fetchFn, calls } = makeMockFetch([() => jsonResponse([])]);
    const client = new StravaClient({
      tokens: makeTokens(),
      credentials: CREDS,
      fetchFn,
    });
    await client.listActivities({ before: 100, after: 50, page: 2, per_page: 100 });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("before")).toBe("100");
    expect(url.searchParams.get("after")).toBe("50");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("per_page")).toBe("100");
  });
});

describe("resolveApiBase", () => {
  const CUTOVER_MS = Date.UTC(2027, 5, 1);
  const LEGACY = "https://www.strava.com/api/v3";
  const NEW = "https://www.api-v3.strava.com";

  afterEach(() => {
    delete process.env.OMNESIS_STRAVA_API_BASE;
  });

  test("uses the legacy host before the cutover", () => {
    expect(resolveApiBase(CUTOVER_MS - 1)).toBe(LEGACY);
  });

  test("switches to the new host on/after the cutover", () => {
    expect(resolveApiBase(CUTOVER_MS)).toBe(NEW);
    expect(resolveApiBase(CUTOVER_MS + 86_400_000)).toBe(NEW);
  });

  test("OMNESIS_STRAVA_API_BASE overrides the date-gate either way", () => {
    process.env.OMNESIS_STRAVA_API_BASE = "https://proxy.example.com/strava";
    expect(resolveApiBase(CUTOVER_MS - 1)).toBe("https://proxy.example.com/strava");
    expect(resolveApiBase(CUTOVER_MS)).toBe("https://proxy.example.com/strava");
  });

  test("ignores a blank/whitespace override", () => {
    process.env.OMNESIS_STRAVA_API_BASE = "   ";
    expect(resolveApiBase(CUTOVER_MS - 1)).toBe(LEGACY);
  });
});
