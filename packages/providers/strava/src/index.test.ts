// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderId } from "@omnesis/types";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { saveTokens } from "./provider.js";
import definition from "./index.js";
import type { StravaClient } from "./client.js";

const tmpDirs: string[] = [];

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-strava-context-"));
  tmpDirs.push(dir);
  await writeFile(
    join(dir, "strava-credentials.json"),
    JSON.stringify({ client_id: "strava-client", client_secret: "strava-secret" }),
  );
  return dir;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Strava provider context", () => {
  test("persists refreshed tokens in the collector config directory", async () => {
    const configDir = await makeConfigDir();
    await saveTokens(
      {
        access_token: "expired-access",
        refresh_token: "old-refresh",
        expires_at: 1,
        athlete_id: 4242,
      },
      configDir,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "https://www.strava.com/oauth/token") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                access_token: "fresh-access",
                refresh_token: "fresh-refresh",
                expires_at: Math.floor(Date.now() / 1000) + 7200,
                expires_in: 7200,
                token_type: "Bearer",
              }),
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ id: 4242 })));
      }),
    );

    const context = await definition.createContext!({
      accountId: "4242",
      providerId: ProviderId("strava:4242"),
      host: fakeProviderHost({ configDir }),
    });
    await context.client.getAthleteDetail();

    const saved = JSON.parse(
      await readFile(join(configDir, "strava", "4242", "tokens.json"), "utf-8"),
    ) as { access_token: string; refresh_token: string };
    expect(saved).toMatchObject({ access_token: "fresh-access", refresh_token: "fresh-refresh" });
  });
});

describe("Strava isAuthenticated", () => {
  async function contextFor(configDir: string) {
    await saveTokens(
      {
        access_token: "access",
        refresh_token: "refresh",
        expires_at: Math.floor(Date.now() / 1000) + 7200,
        athlete_id: 4242,
      },
      configDir,
    );
    return definition.createContext!({
      accountId: "4242",
      providerId: ProviderId("strava:4242"),
      host: fakeProviderHost({ configDir }),
    });
  }

  /**
   * A client that turns any reach for the Strava API into a failure. Answering
   * this gate from the network cannot tell "Strava is unreachable" from "the
   * athlete disconnected us", so it would park every Strava source in
   * needs-auth and push a re-auth reminder the credentials never warranted.
   */
  function unreachableClient(): StravaClient {
    return new Proxy({} as StravaClient, {
      get(_target, property) {
        throw new Error(`isAuthenticated reached for client.${String(property)}`);
      },
    });
  }

  test("answers from the stored grant without calling Strava", async () => {
    const configDir = await makeConfigDir();
    const context = await contextFor(configDir);
    context.client = unreachableClient();

    await expect(definition.credentialState!(context)).resolves.toEqual({ status: "connected" });
  });

  test("reports unauthenticated once the grant is gone from disk", async () => {
    const configDir = await makeConfigDir();
    const context = await contextFor(configDir);
    context.client = unreachableClient();

    await rm(join(configDir, "strava", "4242"), { recursive: true, force: true });

    await expect(definition.credentialState!(context)).resolves.toEqual({
      status: "never-connected",
    });
  });
});
