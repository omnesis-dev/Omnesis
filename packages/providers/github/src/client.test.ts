// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { SyncError } from "@omnesis/types";
import { GithubClient } from "./client.js";

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function clientWith(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return new GithubClient("github_pat_test", {
    fetchImpl: (async (input: unknown, init?: unknown) =>
      handler(String(input), init as RequestInit)) as typeof fetch,
    sleep: async () => {},
    now: () => 1_000_000_000_000,
  });
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (err) {
    if (err instanceof SyncError) return err.kind;
    throw err;
  }
}

describe("GithubClient error classification", () => {
  it("maps 401 to auth, scoped connection", async () => {
    const client = clientWith(() => respond(401, { message: "Bad credentials" }));
    try {
      await client.getUser();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).kind).toBe("auth");
      expect((err as SyncError).scope).toBe("connection");
    }
  });

  it("maps a rate-limit 403 to rate-limit with the reset delay and an account quota", async () => {
    const client = clientWith(() =>
      respond(
        403,
        { message: "API rate limit exceeded" },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(1_000_000_000 + 120),
        },
      ),
    );
    try {
      await client.getUser();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).kind).toBe("rate-limit");
      expect((err as SyncError).retryAfterMs).toBe(120_000);
      expect((err as SyncError).quota).toEqual({ kind: "account" });
    }
  });

  it("sleeps through a short Retry-After once, then succeeds", async () => {
    let calls = 0;
    const client = clientWith(() => {
      calls++;
      if (calls === 1) {
        return respond(403, { message: "secondary limit" }, { "retry-after": "1" });
      }
      return respond(200, { login: "tester" });
    });
    const user = await client.getUser();
    expect(user.login).toBe("tester");
    expect(calls).toBe(2);
  });

  it("maps a scope 403 (no rate-limit headers) to permission", async () => {
    const client = clientWith(() =>
      respond(
        403,
        { message: "Resource not accessible by personal access token" },
        {
          "x-ratelimit-remaining": "4999",
        },
      ),
    );
    expect(await kindOf(client.getUser())).toBe("permission");
  });

  it("retries a transient 5xx and succeeds", async () => {
    let calls = 0;
    const client = clientWith(() => {
      calls++;
      return calls === 1 ? respond(504, "gateway timeout") : respond(200, { login: "tester" });
    });
    const user = await client.getUser();
    expect(user.login).toBe("tester");
    expect(calls).toBe(2);
  });

  it("maps 5xx to transient and fetch failures to network", async () => {
    expect(await kindOf(clientWith(() => respond(502, "bad gateway")).getUser())).toBe("transient");
    const failing = clientWith(() => {
      throw new TypeError("fetch failed");
    });
    expect(await kindOf(failing.getUser())).toBe("network");
  });
});

describe("GithubClient conditional requests", () => {
  it("replays the cached body on 304", async () => {
    let calls = 0;
    const client = clientWith((url, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      if (headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304 });
      return respond(200, [{ id: 1, updated_at: "2026-01-01T00:00:00Z" }], { etag: '"v1"' });
    });
    const first = await client.listIssueCommentsSince("acme/widgets", "2026-01-01T00:00:00Z", 1);
    const second = await client.listIssueCommentsSince("acme/widgets", "2026-01-01T00:00:00Z", 1);
    expect(calls).toBe(2);
    expect(second.rows).toEqual(first.rows);
  });
});

describe("GithubClient graphql", () => {
  it("maps RATE_LIMITED errors to rate-limit with an account quota", async () => {
    const client = clientWith(() =>
      respond(
        200,
        { errors: [{ type: "RATE_LIMITED", message: "slow down" }] },
        {
          "x-ratelimit-reset": String(1_000_000_000 + 60),
        },
      ),
    );
    try {
      await client.graphql("query { viewer { login } }");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).kind).toBe("rate-limit");
      expect((err as SyncError).quota).toEqual({ kind: "account" });
    }
  });

  it("tolerates NOT_FOUND when asked, keeping partial data", async () => {
    const client = clientWith(() =>
      respond(200, {
        data: { repository: { t0: null } },
        errors: [{ type: "NOT_FOUND", message: "gone" }],
      }),
    );
    const data = await client.graphql<{ repository: { t0: null } }>(
      "query Q { x }",
      {},
      {
        tolerateNotFound: true,
      },
    );
    expect(data.repository.t0).toBeNull();
  });

  it("maps FORBIDDEN errors to permission", async () => {
    const client = clientWith(() =>
      respond(200, { errors: [{ type: "FORBIDDEN", message: "nope" }] }),
    );
    expect(await kindOf(client.graphql("query { viewer { login } }"))).toBe("permission");
  });
});
