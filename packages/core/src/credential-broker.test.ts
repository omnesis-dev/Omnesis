// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SyncError } from "@omnesis/types";
import {
  BrokerCredentialError,
  BrokeredCredentials,
  brokerBindingPath,
  brokerConnectionFor,
  fetchBrokerCredential,
  hasBrokerBinding,
  listBrokeredAccountIds,
  readBrokerBinding,
  readCredentialBrokerConfig,
  writeBrokerBinding,
  writeCredentialBrokerConfig,
  type BrokerBinding,
  type CredentialBrokerConfig,
} from "./credential-broker.js";
import { clearProviderAccountCredentials } from "./credentials.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.length = 0;
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-broker-"));
  created.push(dir);
  return dir;
}

const CONFIG: CredentialBrokerConfig = {
  kind: "nango",
  url: "http://127.0.0.1:3003",
  secretKey: "test-broker-key",
};

const BINDING: BrokerBinding = {
  broker: "nango",
  connections: {
    gmail: { providerConfigKey: "gmail-example", connectionId: "conn-gmail" },
    calendar: { providerConfigKey: "gcal-example", connectionId: "conn-gcal" },
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(respond: (url: URL) => Response) {
  const calls: Array<{ url: URL; headers: Headers }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers) });
    return respond(url);
  }) as typeof fetch;
  return { fn, calls };
}

describe("broker configuration and bindings", () => {
  test("round-trip through secret files", async () => {
    const cfg = tempConfigDir();
    await writeCredentialBrokerConfig({ ...CONFIG, url: "http://127.0.0.1:3003/" }, cfg);
    expect(await readCredentialBrokerConfig(cfg)).toEqual(CONFIG);

    await writeBrokerBinding("google", "maya.reeves@example.com", BINDING, cfg);
    expect(await readBrokerBinding("google", "maya.reeves@example.com", cfg)).toEqual(BINDING);
    expect(hasBrokerBinding("google", "maya.reeves@example.com", cfg)).toBe(true);
    expect(listBrokeredAccountIds("google", cfg)).toEqual(["maya.reeves@example.com"]);
  });

  test("no configuration reads as null, and a broken one is refused", async () => {
    const cfg = tempConfigDir();
    expect(await readCredentialBrokerConfig(cfg)).toBeNull();
    expect(await readBrokerBinding("notion", "ws-1", cfg)).toBeNull();
    expect(listBrokeredAccountIds("notion", cfg)).toEqual([]);
  });

  test("plain http is allowed only to this machine", async () => {
    const cfg = tempConfigDir();
    await expect(
      writeCredentialBrokerConfig({ ...CONFIG, url: "http://nango.example.com:3003" }, cfg),
    ).rejects.toThrow(/https/);
    await writeCredentialBrokerConfig({ ...CONFIG, url: "https://nango.example.com" }, cfg);
    await writeCredentialBrokerConfig({ ...CONFIG, url: "http://localhost:3003" }, cfg);
  });

  test("a binding naming an unusable connection is refused on write", async () => {
    await expect(
      writeBrokerBinding(
        "notion",
        "ws-1",
        {
          broker: "nango",
          connections: { default: { providerConfigKey: "notion", connectionId: ".." } },
        },
        tempConfigDir(),
      ),
    ).rejects.toThrow(/no usable connection/);
  });

  test("a non-http broker URL is refused", async () => {
    await expect(
      writeCredentialBrokerConfig({ ...CONFIG, url: "file:///etc/passwd" }, tempConfigDir()),
    ).rejects.toThrow(/http/);
  });

  test("removing the account removes its binding", async () => {
    const cfg = tempConfigDir();
    await writeBrokerBinding(
      "notion",
      "ws-1",
      { broker: "nango", connections: { default: BINDING.connections.gmail! } },
      cfg,
    );
    await clearProviderAccountCredentials("notion", "ws-1", cfg);
    expect(hasBrokerBinding("notion", "ws-1", cfg)).toBe(false);
    expect(listBrokeredAccountIds("notion", cfg)).toEqual([]);
  });

  test("the binding is written owner-only", async () => {
    const cfg = tempConfigDir();
    await writeBrokerBinding(
      "notion",
      "ws-1",
      { broker: "nango", connections: { default: BINDING.connections.gmail! } },
      cfg,
    );
    expect(statSync(brokerBindingPath("notion", "ws-1", cfg)).mode & 0o777).toBe(0o600);
  });

  test("the default purpose resolves to a lone connection, and an unbound purpose throws", () => {
    const single: BrokerBinding = {
      broker: "nango",
      connections: { only: BINDING.connections.gmail! },
    };
    expect(brokerConnectionFor(single)).toEqual(BINDING.connections.gmail);
    expect(() => brokerConnectionFor(BINDING, "drive")).toThrow(BrokerCredentialError);
  });
});

describe("fetchBrokerCredential", () => {
  test("asks Nango for the connection with the key as bearer token", async () => {
    const { fn, calls } = recordingFetch(() =>
      jsonResponse(200, {
        credentials: {
          type: "OAUTH2",
          access_token: "ya29.token",
          expires_at: "2026-10-28T12:00:00.000Z",
          raw: { scope: "openid" },
        },
        connection_config: { workspace: "w" },
        metadata: null,
      }),
    );
    const result = await fetchBrokerCredential(CONFIG, BINDING.connections.gmail!, { fetch: fn });
    expect(calls[0]!.url.pathname).toBe("/connections/conn-gmail");
    expect(calls[0]!.url.searchParams.get("provider_config_key")).toBe("gmail-example");
    expect(calls[0]!.url.searchParams.has("force_refresh")).toBe(false);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer test-broker-key");
    expect(result).toEqual({
      credential: {
        type: "oauth2",
        accessToken: "ya29.token",
        expiresAt: Date.parse("2026-10-28T12:00:00.000Z"),
        raw: { scope: "openid" },
      },
      connectionConfig: { workspace: "w" },
      metadata: {},
    });
  });

  test("normalises API-key and basic credentials", async () => {
    const apiKey = recordingFetch(() =>
      jsonResponse(200, { credentials: { type: "API_KEY", apiKey: "k" } }),
    );
    expect(
      (await fetchBrokerCredential(CONFIG, BINDING.connections.gmail!, { fetch: apiKey.fn }))
        .credential,
    ).toEqual({
      type: "api-key",
      apiKey: "k",
    });
    const basic = recordingFetch(() =>
      jsonResponse(200, { credentials: { type: "BASIC", username: "u", password: "p" } }),
    );
    expect(
      (await fetchBrokerCredential(CONFIG, BINDING.connections.gmail!, { fetch: basic.fn }))
        .credential,
    ).toEqual({
      type: "basic",
      username: "u",
      password: "p",
    });
  });

  test.each([
    [401, {}, "rejected", "auth"],
    [404, { error: { code: "unknown_connection" } }, "not-found", "auth"],
    [400, { error: { code: "unknown_provider_config" } }, "unbound", "auth"],
    [424, { error: { code: "connection_refresh_exhausted" } }, "refresh-exhausted", "auth"],
    [424, { error: { code: "connection_refresh_backoff" } }, "unavailable", "network"],
    [424, { error: { code: "script_http_error" } }, "unavailable", "network"],
    [
      400,
      { error: { code: "refresh_token_external_error", payload: { error: "invalid_grant" } } },
      "refresh-exhausted",
      "auth",
    ],
    [
      400,
      {
        error: {
          code: "refresh_token_external_error",
          payload: { error: "temporarily_unavailable" },
        },
      },
      "unavailable",
      "network",
    ],
    [502, { error: "bad gateway" }, "unavailable", "network"],
  ] as const)("HTTP %i %j is %s and classified %s", async (status, body, reason, kind) => {
    const { fn } = recordingFetch(() => jsonResponse(status, body));
    const err = await fetchBrokerCredential(CONFIG, BINDING.connections.gmail!, {
      fetch: fn,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerCredentialError);
    expect(err).toBeInstanceOf(SyncError);
    expect(err.reason).toBe(reason);
    expect(err.kind).toBe(kind);
    expect(String(err.message)).not.toContain("test-broker-key");
  });

  test("Nango's refresh back-off is retried after its cooldown, not parked", async () => {
    const { fn } = recordingFetch(() =>
      jsonResponse(424, { error: { code: "connection_refresh_backoff" } }),
    );
    const err = await fetchBrokerCredential(CONFIG, BINDING.connections.gmail!, {
      fetch: fn,
    }).catch((e) => e);
    expect(err.retryAfterMs).toBe(30_000);
  });

  test("an answer that is not JSON is a network failure that does not repeat the body", async () => {
    const fn = (async () =>
      new Response("<html>proxy login for maya</html>", { status: 200 })) as typeof fetch;
    const err = await fetchBrokerCredential(CONFIG, BINDING.connections.gmail!, {
      fetch: fn,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerCredentialError);
    expect(err.kind).toBe("network");
    expect(String(err.message)).not.toContain("maya");
  });

  test.each([".", "..", "a/b", "a?b", "a#b", "a%2Fb", "a\u0000b", ""])(
    "refuses connection id %j before any request",
    async (connectionId) => {
      const { fn, calls } = recordingFetch(() => jsonResponse(200, {}));
      const err = await fetchBrokerCredential(
        CONFIG,
        { providerConfigKey: "gmail-example", connectionId },
        { fetch: fn },
      ).catch((e) => e);
      expect(err.reason).toBe("unbound");
      expect(calls).toHaveLength(0);
    },
  );

  test("an unreachable broker is a network failure", async () => {
    const fn = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const err = await fetchBrokerCredential(CONFIG, BINDING.connections.gmail!, {
      fetch: fn,
    }).catch((e) => e);
    expect(err.reason).toBe("unavailable");
    expect(err.kind).toBe("network");
  });

  test("an unknown auth mode is refused", async () => {
    const { fn } = recordingFetch(() =>
      jsonResponse(200, { credentials: { type: "APP", jwtToken: "x" } }),
    );
    const err = await fetchBrokerCredential(CONFIG, BINDING.connections.gmail!, {
      fetch: fn,
    }).catch((e) => e);
    expect(err.reason).toBe("unsupported");
  });
});

describe("BrokeredCredentials", () => {
  test("reuses a token until shortly before it expires", async () => {
    let now = Date.parse("2026-10-28T10:00:00.000Z");
    let issued = 0;
    const { fn, calls } = recordingFetch(() =>
      jsonResponse(200, {
        credentials: {
          type: "OAUTH2",
          access_token: `token-${++issued}`,
          expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
        },
      }),
    );
    const creds = new BrokeredCredentials(BINDING, CONFIG, { now: () => now, fetch: fn });
    expect(await creds.token("gmail")).toBe("token-1");
    now += 30 * 60 * 1000;
    expect(await creds.token("gmail")).toBe("token-1");
    now += 26 * 60 * 1000;
    expect(await creds.token("gmail")).toBe("token-2");
    expect(calls).toHaveLength(2);
  });

  test("each purpose fetches its own connection, and concurrent calls share one request", async () => {
    const { fn, calls } = recordingFetch((url) =>
      jsonResponse(200, { credentials: { type: "OAUTH2", access_token: url.pathname } }),
    );
    const creds = new BrokeredCredentials(BINDING, CONFIG, { fetch: fn });
    const [a, b, c] = await Promise.all([
      creds.token("gmail"),
      creds.token("gmail"),
      creds.token("calendar"),
    ]);
    expect([a, b, c]).toEqual([
      "/connections/conn-gmail",
      "/connections/conn-gmail",
      "/connections/conn-gcal",
    ]);
    expect(calls).toHaveLength(2);
  });

  test("a token without an expiry is fetched again after ten minutes, and invalidate forces it", async () => {
    let now = 0;
    const { fn, calls } = recordingFetch(() =>
      jsonResponse(200, { credentials: { type: "API_KEY", apiKey: "k" } }),
    );
    const creds = new BrokeredCredentials(BINDING, CONFIG, { now: () => now, fetch: fn });
    await creds.token("gmail");
    now += 9 * 60 * 1000;
    await creds.token("gmail");
    expect(calls).toHaveLength(1);
    now += 2 * 60 * 1000;
    await creds.token("gmail");
    expect(calls).toHaveLength(2);
    creds.invalidate("gmail");
    await creds.token("gmail");
    expect(calls).toHaveLength(3);
  });

  test("forceRefresh asks the broker to refresh", async () => {
    const { fn, calls } = recordingFetch(() =>
      jsonResponse(200, { credentials: { type: "OAUTH2", access_token: "t" } }),
    );
    const creds = new BrokeredCredentials(BINDING, CONFIG, { fetch: fn });
    await creds.token("gmail", { forceRefresh: true });
    expect(calls[0]!.url.searchParams.get("force_refresh")).toBe("true");
  });

  test("forceRefresh refetches a key or login without asking the broker to refresh it", async () => {
    const { fn, calls } = recordingFetch(() =>
      jsonResponse(200, { credentials: { type: "BASIC", username: "u", password: "p" } }),
    );
    const creds = new BrokeredCredentials(BINDING, CONFIG, { fetch: fn });
    await creds.get("gmail");
    await creds.get("gmail", { forceRefresh: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.has("force_refresh")).toBe(false);
  });

  test("a slower fetch that started first never replaces a newer forced refresh", async () => {
    const releases: Array<(r: Response) => void> = [];
    const fn = (() =>
      new Promise<Response>((resolve) => releases.push(resolve))) as unknown as typeof fetch;
    const creds = new BrokeredCredentials(BINDING, CONFIG, { fetch: fn });
    const older = creds.token("gmail");
    const newer = creds.token("gmail", { forceRefresh: true });
    releases[1]!(jsonResponse(200, { credentials: { type: "OAUTH2", access_token: "NEW" } }));
    expect(await newer).toBe("NEW");
    releases[0]!(jsonResponse(200, { credentials: { type: "OAUTH2", access_token: "OLD" } }));
    expect(await older).toBe("NEW");
    expect(await creds.token("gmail")).toBe("NEW");
  });

  test("forced refreshes of one connection are throttled", async () => {
    let now = 0;
    const { fn, calls } = recordingFetch(() =>
      jsonResponse(200, { credentials: { type: "OAUTH2", access_token: "t" } }),
    );
    const creds = new BrokeredCredentials(BINDING, CONFIG, { now: () => now, fetch: fn });
    await creds.token("gmail", { forceRefresh: true });
    now += 60_000;
    await creds.token("gmail", { forceRefresh: true });
    now += 5 * 60_000;
    await creds.token("gmail", { forceRefresh: true });
    expect(calls.map((c) => c.url.searchParams.get("force_refresh"))).toEqual([
      "true",
      null,
      "true",
    ]);
  });

  test("verify sees every fresh credential and a refusal is never cached", async () => {
    let owner = "workspace-1";
    const { fn } = recordingFetch(() =>
      jsonResponse(200, {
        credentials: { type: "OAUTH2", access_token: "t", raw: { workspace_id: owner } },
      }),
    );
    const creds = new BrokeredCredentials(BINDING, CONFIG, {
      fetch: fn,
      verify: (_purpose, result) => {
        const raw = result.credential.type === "oauth2" ? result.credential.raw : {};
        if (raw.workspace_id !== "workspace-1") {
          throw new BrokerCredentialError("identity-changed", "another workspace");
        }
      },
    });
    expect(await creds.token("gmail")).toBe("t");
    owner = "workspace-2";
    creds.invalidate("gmail");
    await expect(creds.token("gmail")).rejects.toMatchObject({
      reason: "identity-changed",
      kind: "auth",
    });
    await expect(creds.token("gmail")).rejects.toMatchObject({ reason: "identity-changed" });
  });

  test("load names what is missing", async () => {
    const cfg = tempConfigDir();
    await expect(
      BrokeredCredentials.load("google", "maya.reeves@example.com", cfg),
    ).rejects.toMatchObject({
      reason: "unbound",
    });
    await writeBrokerBinding("google", "maya.reeves@example.com", BINDING, cfg);
    await expect(
      BrokeredCredentials.load("google", "maya.reeves@example.com", cfg),
    ).rejects.toMatchObject({
      reason: "unconfigured",
    });
    await writeCredentialBrokerConfig(CONFIG, cfg);
    const creds = await BrokeredCredentials.load("google", "maya.reeves@example.com", cfg);
    expect(creds.purposes).toEqual(["gmail", "calendar"]);
  });
});
