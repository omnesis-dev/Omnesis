// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrokeredCredentials,
  brokerBindingPath,
  writeBrokerBinding,
  writeCredentialBrokerConfig,
} from "@omnesis/core";
import { ProviderId, SourceId, SyncError } from "@omnesis/types";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeProviderHost, fakeSourceHost } from "@omnesis/source-sdk/testing";

/**
 * A brokered account must never set MSAL up: an empty cache would only ever
 * answer that the account needs signing in, and a populated one would be a
 * second copy of the broker's grant.
 */
const msal = vi.hoisted(() => ({ constructed: vi.fn() }));

vi.mock("@azure/msal-node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@azure/msal-node")>()),
  PublicClientApplication: vi.fn().mockImplementation(function PublicClientApplication() {
    msal.constructed();
    throw new Error("MSAL is not for a brokered account");
  }),
}));

import definition from "./index.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  msal.constructed.mockClear();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const BROKER = { kind: "nango" as const, url: "http://127.0.0.1:3999", secretKey: "broker-key" };
const REF = { providerConfigKey: "one-drive-personal", connectionId: "conn-outlook" };
const MAILBOX = "Maya.Reeves@example.com";

async function brokeredConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-outlook-broker-"));
  tmpDirs.push(dir);
  await writeCredentialBrokerConfig(BROKER, dir);
  await writeBrokerBinding(
    "outlook",
    MAILBOX,
    { broker: "nango", connections: { default: REF } },
    dir,
  );
  return dir;
}

/** An unsigned ID token carrying `claims`, as a token response holds one. */
function idToken(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.signature`;
}

interface Call {
  url: URL;
  authorization: string | null;
}

/**
 * The broker hands out `token`, or `renewed` when asked to refresh; Graph
 * answers `graph` for every request.
 */
function stubNetwork(
  opts: {
    token?: string;
    renewed?: string;
    raw?: Record<string, unknown>;
    brokerStatus?: number;
    graph?: (call: Call) => Response;
  } = {},
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: new URL(String(input)),
        authorization: new Headers(init?.headers).get("authorization"),
      };
      calls.push(call);
      if (call.url.origin === BROKER.url) {
        if (opts.brokerStatus)
          return Promise.resolve(new Response(null, { status: opts.brokerStatus }));
        const forced = call.url.searchParams.get("force_refresh") === "true";
        return Promise.resolve(
          Response.json({
            credentials: {
              type: "OAUTH2",
              access_token: forced
                ? (opts.renewed ?? "renewed-token")
                : (opts.token ?? "brokered-token"),
              raw: opts.raw ?? {},
            },
          }),
        );
      }
      return Promise.resolve(opts.graph ? opts.graph(call) : Response.json({ value: [] }));
    }),
  );
  return calls;
}

const graphCalls = (calls: Call[]) => calls.filter((c) => c.url.hostname === "graph.microsoft.com");
const brokerCalls = (calls: Call[]) => calls.filter((c) => c.url.origin === BROKER.url);

async function brokeredContext(configDir: string) {
  return definition.createContext!({
    accountId: MAILBOX,
    providerId: ProviderId(`microsoft:${MAILBOX}`),
    host: fakeProviderHost({ configDir }),
  });
}

async function emailSource(configDir: string) {
  const context = await brokeredContext(configDir);
  const spec = definition.sources.find((s) => s.id === "outlook-email")!;
  const source = await spec.create(
    {
      accountId: MAILBOX,
      sourceId: SourceId(`outlook-email:${MAILBOX}`),
      providerId: ProviderId(`microsoft:${MAILBOX}`),
      sourceConfig: { enabled: true },
      host: fakeSourceHost({ configDir }),
    },
    context,
  );
  return { context, source };
}

describe("Outlook with a brokered grant", () => {
  test("discovers the brokered mailbox with no token cache or client file on disk", async () => {
    const configDir = await brokeredConfigDir();
    expect(existsSync(join(configDir, "outlook", MAILBOX, "tokens.json"))).toBe(false);
    expect(existsSync(join(configDir, "outlook-credentials.json"))).toBe(false);
    await expect(definition.discover!({ configDir })).resolves.toEqual([
      { id: MAILBOX, subject: { kind: "email", value: MAILBOX } },
    ]);
  });

  test("syncs through Graph with the broker's token, never setting MSAL up or writing a cache", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({ token: "brokered-outlook-token" });
    const { source } = await emailSource(configDir);
    await source.sync!(null);

    expect(msal.constructed).not.toHaveBeenCalled();
    expect(brokerCalls(calls)[0]!.authorization).toBe("Bearer broker-key");
    expect(graphCalls(calls).length).toBeGreaterThan(0);
    for (const call of graphCalls(calls)) {
      expect(call.authorization).toBe("Bearer brokered-outlook-token");
    }
    expect(calls.some((c) => c.url.hostname === "login.microsoftonline.com")).toBe(false);
    expect(readdirSync(join(configDir, "outlook", MAILBOX))).toEqual(["broker.json"]);
  });

  test("asks the broker to refresh once when Graph refuses its token, and retries with the new one", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({
      token: "rotated-away",
      renewed: "renewed-token",
      graph: (call) =>
        call.authorization === "Bearer renewed-token"
          ? Response.json({ value: [] })
          : new Response(null, { status: 401 }),
    });
    const { source } = await emailSource(configDir);
    await source.sync!(null);

    const forced = brokerCalls(calls).filter(
      (c) => c.url.searchParams.get("force_refresh") === "true",
    );
    expect(forced).toHaveLength(1);
    // The refused request itself is sent again, rather than left to whatever
    // its caller makes of a 401.
    const [refused, resent] = graphCalls(calls);
    expect(refused!.authorization).toBe("Bearer rotated-away");
    expect(resent!.authorization).toBe("Bearer renewed-token");
    expect(resent!.url.href).toBe(refused!.url.href);
    for (const call of graphCalls(calls).slice(1)) {
      expect(call.authorization).toBe("Bearer renewed-token");
    }
    expect(readdirSync(join(configDir, "outlook", MAILBOX))).toEqual(["broker.json"]);
  });

  test("a connection the broker no longer holds parks every source on the account", async () => {
    const configDir = await brokeredConfigDir();
    stubNetwork({ brokerStatus: 404 });
    const { source } = await emailSource(configDir);
    const error = await source.sync!(null).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).kind).toBe("auth");
    expect((error as SyncError).scope).toBe("connection");
  });

  test("is connected while the binding reads, and never-connected once it is removed", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork();
    const context = await brokeredContext(configDir);
    await expect(definition.credentialState!(context)).resolves.toEqual({ status: "connected" });

    await definition.disposeContext!(context);
    await definition.cleanupCredentials!(MAILBOX, { configDir });
    expect(existsSync(brokerBindingPath("outlook", MAILBOX, configDir))).toBe(false);
    await expect(definition.credentialState!(context)).resolves.toEqual({
      status: "never-connected",
    });
    // Neither Microsoft nor the broker was told anything: the grant is shared.
    expect(calls).toEqual([]);
  });

  test("names the account by the ID token's username, as MSAL does, unchanged in case", async () => {
    const calls = stubNetwork({
      raw: {
        id_token: idToken({
          preferred_username: MAILBOX,
          upn: "someone-else@example.com",
          tid: "9188040d-6c67-4c5b-b112-36a304b66dad",
        }),
      },
    });
    const credentials = new BrokeredCredentials(
      { broker: "nango", connections: { default: REF } },
      BROKER,
    );
    await expect(definition.broker!.resolveAccount(credentials, {})).resolves.toEqual({
      accountId: MAILBOX,
    });
    expect(graphCalls(calls)).toEqual([]);
  });

  test("asks Graph whose token it is when the broker kept no ID token", async () => {
    const calls = stubNetwork({
      graph: () => Response.json({ userPrincipalName: MAILBOX, mail: null }),
    });
    const credentials = new BrokeredCredentials(
      { broker: "nango", connections: { default: REF } },
      BROKER,
    );
    await expect(definition.broker!.resolveAccount(credentials, {})).resolves.toEqual({
      accountId: MAILBOX,
    });
    const me = graphCalls(calls);
    expect(me.map((c) => c.url.pathname)).toEqual(["/v1.0/me"]);
    expect(me[0]!.authorization).toBe("Bearer brokered-token");
  });
});
