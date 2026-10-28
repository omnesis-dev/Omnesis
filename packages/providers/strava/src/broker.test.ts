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
import { ProviderId } from "@omnesis/types";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { StravaAuthError } from "./client.js";
import definition from "./index.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const BROKER = { kind: "nango" as const, url: "http://127.0.0.1:3999", secretKey: "broker-key" };
const REF = { providerConfigKey: "strava-web", connectionId: "conn-strava" };
const ATHLETE_ID = "9876543";

async function brokeredConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-strava-broker-"));
  tmpDirs.push(dir);
  await writeCredentialBrokerConfig(BROKER, dir);
  await writeBrokerBinding(
    "strava",
    ATHLETE_ID,
    { broker: "nango", connections: { default: REF }, params: { athleteName: "Maya Reeves" } },
    dir,
  );
  return dir;
}

interface Call {
  url: URL;
  authorization: string | null;
}

/**
 * The broker hands out `token`, or `renewed` when asked to refresh; Strava
 * answers `strava` for every request.
 */
function stubNetwork(
  opts: {
    token?: string;
    renewed?: string;
    raw?: Record<string, unknown>;
    brokerStatus?: number;
    brokerErrorCode?: string;
    strava?: (call: Call) => Response;
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
        if (opts.brokerStatus) {
          return Promise.resolve(
            Response.json(
              { error: { code: opts.brokerErrorCode ?? "connection_refresh_exhausted" } },
              { status: opts.brokerStatus },
            ),
          );
        }
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
      return Promise.resolve(opts.strava ? opts.strava(call) : Response.json([]));
    }),
  );
  return calls;
}

const stravaCalls = (calls: Call[]) => calls.filter((c) => c.url.hostname.endsWith("strava.com"));
const brokerCalls = (calls: Call[]) => calls.filter((c) => c.url.origin === BROKER.url);
const tokenEndpointCalls = (calls: Call[]) =>
  stravaCalls(calls).filter((c) => c.url.pathname.endsWith("/oauth/token"));

async function brokeredContext(configDir: string) {
  return definition.createContext!({
    accountId: ATHLETE_ID,
    providerId: ProviderId(`strava:${ATHLETE_ID}`),
    host: fakeProviderHost({ configDir }),
  });
}

describe("Strava with a brokered grant", () => {
  test("discovers the brokered athlete with no token or API application file on disk", async () => {
    const configDir = await brokeredConfigDir();
    expect(existsSync(join(configDir, "strava", ATHLETE_ID, "tokens.json"))).toBe(false);
    expect(existsSync(join(configDir, "strava-credentials.json"))).toBe(false);
    await expect(definition.discover!({ configDir })).resolves.toEqual([ATHLETE_ID]);
  });

  test("calls Strava with the broker's token, never its token endpoint, and writes nothing", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({ token: "brokered-strava-token" });
    const context = await brokeredContext(configDir);
    expect(context.athleteId).toBe(9876543);
    expect(context.athleteName).toBe("Maya Reeves");

    await context.client.listActivities({ per_page: 1 });

    expect(brokerCalls(calls)[0]!.authorization).toBe("Bearer broker-key");
    expect(stravaCalls(calls).length).toBeGreaterThan(0);
    for (const call of stravaCalls(calls)) {
      expect(call.authorization).toBe("Bearer brokered-strava-token");
    }
    expect(tokenEndpointCalls(calls)).toEqual([]);
    expect(readdirSync(join(configDir, "strava", ATHLETE_ID))).toEqual(["broker.json"]);
  });

  test("asks the broker to refresh once when Strava refuses its token, and retries with the new one", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({
      token: "rotated-away",
      renewed: "renewed-token",
      strava: (call) =>
        call.authorization === "Bearer renewed-token"
          ? Response.json([])
          : new Response(null, { status: 401 }),
    });
    const context = await brokeredContext(configDir);
    await expect(context.client.listActivities()).resolves.toEqual([]);

    const forced = brokerCalls(calls).filter(
      (c) => c.url.searchParams.get("force_refresh") === "true",
    );
    expect(forced).toHaveLength(1);
    expect(stravaCalls(calls).map((c) => c.authorization)).toEqual([
      "Bearer rotated-away",
      "Bearer renewed-token",
    ]);
    expect(tokenEndpointCalls(calls)).toEqual([]);
    expect(readdirSync(join(configDir, "strava", ATHLETE_ID))).toEqual(["broker.json"]);
  });

  test("a grant the broker can no longer refresh is a dead grant, as a stored one is", async () => {
    const configDir = await brokeredConfigDir();
    stubNetwork({ brokerStatus: 424 });
    const context = await brokeredContext(configDir);
    const error = await context.client.listActivities().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StravaAuthError);
    expect((error as StravaAuthError).kind).toBe("auth");
    expect((error as StravaAuthError).scope).toBe("connection");
  });

  test("is connected while the binding reads, and never-connected once it is removed", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork();
    const context = await brokeredContext(configDir);
    await expect(definition.credentialState!(context)).resolves.toEqual({ status: "connected" });

    await definition.disposeContext!(context);
    await definition.cleanupCredentials!(ATHLETE_ID, { configDir });
    expect(existsSync(brokerBindingPath("strava", ATHLETE_ID, configDir))).toBe(false);
    await expect(definition.credentialState!(context)).resolves.toEqual({
      status: "never-connected",
    });
    // Neither Strava nor the broker was told anything: the grant is shared.
    expect(calls).toEqual([]);
  });

  test("names the account by the athlete the broker's token response carries", async () => {
    const calls = stubNetwork({
      raw: {
        token_type: "Bearer",
        athlete: { id: 9876543, firstname: "Maya", lastname: "Reeves" },
      },
    });
    const credentials = new BrokeredCredentials(
      { broker: "nango", connections: { default: REF } },
      BROKER,
    );
    await expect(definition.broker!.resolveAccount(credentials, {})).resolves.toEqual({
      accountId: ATHLETE_ID,
      params: { athleteName: "Maya Reeves" },
    });
    expect(stravaCalls(calls)).toEqual([]);
  });

  test("asks Strava for the athlete once a refresh has replaced the token response", async () => {
    const calls = stubNetwork({
      raw: { token_type: "Bearer", expires_in: 21600 },
      strava: () => Response.json({ id: 9876543, firstname: "Maya", lastname: "Reeves" }),
    });
    const credentials = new BrokeredCredentials(
      { broker: "nango", connections: { default: REF } },
      BROKER,
    );
    await expect(definition.broker!.resolveAccount(credentials, {})).resolves.toEqual({
      accountId: ATHLETE_ID,
      params: { athleteName: "Maya Reeves" },
    });
    const athlete = stravaCalls(calls);
    expect(athlete).toHaveLength(1);
    expect(athlete[0]!.url.pathname).toMatch(/\/athlete$/);
    expect(athlete[0]!.authorization).toBe("Bearer brokered-token");
  });
});
