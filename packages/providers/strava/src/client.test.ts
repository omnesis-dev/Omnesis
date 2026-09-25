// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, afterEach } from "vitest";
import {
  StravaAuthError,
  StravaClient,
  classifyRefreshFailure,
  computeRateLimitBackoff,
  resolveApiBase,
} from "./client.js";
import type { SyncError } from "@omnesis/types";
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
});

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

describe("computeRateLimitBackoff", () => {
  test("honors Retry-After when present", () => {
    const h = new Headers({ "Retry-After": "42" });
    expect(computeRateLimitBackoff(h)).toBe(42_000);
  });

  test("waits an hour when daily limit is blown", () => {
    const h = new Headers({
      "X-RateLimit-Limit": "100,1000",
      "X-RateLimit-Usage": "42,1234",
    });
    expect(computeRateLimitBackoff(h)).toBe(3_600_000);
  });

  test("returns a 30s..16min wait for short-term breach", () => {
    const h = new Headers({
      "X-RateLimit-Limit": "100,1000",
      "X-RateLimit-Usage": "101,50",
    });
    const ms = computeRateLimitBackoff(h);
    expect(ms).toBeGreaterThanOrEqual(30_000);
    expect(ms).toBeLessThanOrEqual(16 * 60 * 1000);
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
