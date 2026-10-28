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
    [401, "rejected", "auth"],
    [404, "not-found", "auth"],
    [424, "refresh-exhausted", "auth"],
    [502, "unavailable", "network"],
  ] as const)("HTTP %i is %s and classified %s", async (status, reason, kind) => {
    const { fn } = recordingFetch(() => jsonResponse(status, { error: "x" }));
    const err = await fetchBrokerCredential(CONFIG, BINDING.connections.gmail!, {
      fetch: fn,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerCredentialError);
    expect(err).toBeInstanceOf(SyncError);
    expect(err.reason).toBe(reason);
    expect(err.kind).toBe(kind);
    expect(String(err.message)).not.toContain("test-broker-key");
  });

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
