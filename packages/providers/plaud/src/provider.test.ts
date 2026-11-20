// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readProviderAccountCredentials, writeProviderAccountCredentials } from "@omnesis/core";
import { AuthFailure, type AuthChallenge, type AuthSession } from "@omnesis/source-sdk";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { EU_BASE, FAKE_EMAIL, FakePlaud } from "./fake-plaud.js";
import {
  authenticate,
  cleanupCredentials,
  discoverAccounts,
  hasCredentials,
  loadConnection,
} from "./provider.js";
import plaudProvider from "./index.js";

const created: string[] = [];
afterEach(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
  created.length = 0;
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-plaud-"));
  created.push(dir);
  return dir;
}

/** A session that answers each question in turn from `answers`. */
function session(
  answers: Array<Record<string, string>>,
  overrides: Partial<AuthSession> & { configDir?: string } = {},
) {
  const { configDir = tempConfigDir(), ...rest } = overrides;
  const asked: AuthChallenge[] = [];
  const shown: string[] = [];
  const s: AuthSession = {
    reason: rest.accountId ? "reauthenticate" : "connect",
    flowId: "flow-1",
    supplied: {},
    host: { ...fakeProviderHost(), configDir },
    canShow: () => true,
    show: (c) => void shown.push(c.title),
    ask: (c) => {
      asked.push(c);
      const answer = answers.shift();
      if (!answer) throw new Error(`unexpected question: ${c.title}`);
      return Promise.resolve(answer as never);
    },
    ...rest,
  };
  return { session: s, asked, shown, configDir };
}

describe("connecting a Plaud account", () => {
  test("asks for the address, then the emailed code, and stores the sign-in under the address", async () => {
    const fake = new FakePlaud();
    const {
      session: s,
      asked,
      shown,
      configDir,
    } = session([{ email: " Maya.Reeves@Example.com " }, { code: "246810" }]);

    const result = await authenticate(s, { fetchImpl: fake.fetch });

    expect(asked.map((c) => c.kind)).toEqual(["fields", "code"]);
    expect(shown).toHaveLength(2);
    expect(shown[0]).toMatch(/email a code/);
    expect(result.accounts).toEqual([{ accountId: FAKE_EMAIL, state: { status: "connected" } }]);
    await expect(readProviderAccountCredentials("plaud", FAKE_EMAIL, configDir)).resolves.toEqual({
      email: FAKE_EMAIL,
      api_base: EU_BASE,
      access_token: "ut-1",
      refresh_token: "rt-1",
      access_expires_at: "2000000000",
      session_expires_at: "2100000000",
    });
    await expect(loadConnection(FAKE_EMAIL, configDir)).resolves.toMatchObject({
      apiBase: EU_BASE,
      tokens: { accessToken: "ut-1", refreshToken: "rt-1" },
    });
    expect(discoverAccounts(configDir).map(String)).toEqual([FAKE_EMAIL]);
  });

  test("takes an address a client already collected", async () => {
    const fake = new FakePlaud();
    const { session: s, asked } = session([{ code: "246810" }], {
      supplied: { email: FAKE_EMAIL },
    });
    await authenticate(s, { fetchImpl: fake.fetch });
    expect(asked.map((c) => c.kind)).toEqual(["code"]);
  });

  test("a re-authentication signs the same address in again and asks only for the code", async () => {
    const fake = new FakePlaud();
    const { session: s, asked } = session([{ code: "246810" }], { accountId: FAKE_EMAIL });
    const result = await authenticate(s, { fetchImpl: fake.fetch });
    expect(asked.map((c) => c.kind)).toEqual(["code"]);
    expect(result.accounts[0]?.accountId).toBe(FAKE_EMAIL);
  });

  test("a wrong code is refused and stores nothing", async () => {
    const fake = new FakePlaud();
    const { session: s, configDir } = session([{ email: FAKE_EMAIL }, { code: "111111" }]);
    const err = await authenticate(s, { fetchImpl: fake.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFailure);
    expect((err as AuthFailure).code).toBe("credential-rejected");
    expect(hasCredentials(FAKE_EMAIL, configDir)).toBe(false);
  });

  test("an address Plaud will not send a code to names Google and Apple accounts", async () => {
    const fake = new FakePlaud();
    const { session: s } = session([{ email: "jamie.lopez@example.com" }]);
    const err = (await authenticate(s, { fetchImpl: fake.fetch }).catch(
      (e: unknown) => e,
    )) as AuthFailure;
    expect(err.code).toBe("credential-rejected");
    expect(err.remedy).toMatch(/Google or Apple/);
  });

  test("something that is not an address is refused before Plaud is asked", async () => {
    const fake = new FakePlaud();
    const { session: s } = session([{ email: "not-an-address" }]);
    await expect(authenticate(s, { fetchImpl: fake.fetch })).rejects.toBeInstanceOf(AuthFailure);
    expect(fake.requests).toEqual([]);
  });

  test("Plaud being unreachable is reported as unavailable", async () => {
    const { session: s } = session([{ email: FAKE_EMAIL }]);
    const err = (await authenticate(s, {
      fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
    }).catch((e: unknown) => e)) as AuthFailure;
    expect(err.code).toBe("unavailable");
  });
});

describe("stored sign-ins", () => {
  test("a stored sign-in pointing at a host that is not Plaud's is not loaded", async () => {
    const configDir = tempConfigDir();
    await writeProviderAccountCredentials(
      "plaud",
      FAKE_EMAIL,
      { email: FAKE_EMAIL, api_base: "https://plaud.example.com", access_token: "ut-1" },
      configDir,
    );
    await expect(loadConnection(FAKE_EMAIL, configDir)).rejects.toMatchObject({ kind: "auth" });
  });

  test("credential state is offline: connected with a sign-in, never-connected without", async () => {
    const configDir = tempConfigDir();
    const state = (id: string) =>
      plaudProvider.credentialState!({ accountId: id, configDir, now: () => new Date() } as never);
    await expect(state(FAKE_EMAIL)).resolves.toMatchObject({ status: "never-connected" });
    await writeProviderAccountCredentials(
      "plaud",
      FAKE_EMAIL,
      { email: FAKE_EMAIL, api_base: EU_BASE, access_token: "ut-1" },
      configDir,
    );
    await expect(state(FAKE_EMAIL)).resolves.toMatchObject({ status: "connected" });
  });

  test("credential state names the end of the sign-in Plaud gave it", async () => {
    const configDir = tempConfigDir();
    const state = (now: string) =>
      plaudProvider.credentialState!({
        accountId: FAKE_EMAIL,
        configDir,
        now: () => new Date(now),
      } as never);
    await writeProviderAccountCredentials(
      "plaud",
      FAKE_EMAIL,
      {
        email: FAKE_EMAIL,
        api_base: EU_BASE,
        access_token: "ut-1",
        refresh_token: "rt-1",
        session_expires_at: "2100000000",
      },
      configDir,
    );
    await expect(state("2030-01-01T00:00:00Z")).resolves.toEqual({
      status: "connected",
      expiresAt: "2036-07-18T13:20:00.000Z",
    });
    await expect(state("2037-01-01T00:00:00Z")).resolves.toEqual({
      status: "expired",
      at: "2036-07-18T13:20:00.000Z",
    });
  });

  test("cleanup removes the account's sign-in", async () => {
    const configDir = tempConfigDir();
    await writeProviderAccountCredentials(
      "plaud",
      FAKE_EMAIL,
      { email: FAKE_EMAIL, api_base: EU_BASE, access_token: "ut-1" },
      configDir,
    );
    await cleanupCredentials(FAKE_EMAIL, configDir);
    expect(hasCredentials(FAKE_EMAIL, configDir)).toBe(false);
    expect(existsSync(join(configDir, "plaud"))).toBe(true);
  });

  test("a renewed token is written back for the next run", async () => {
    const configDir = tempConfigDir();
    const fake = new FakePlaud();
    await writeProviderAccountCredentials(
      "plaud",
      FAKE_EMAIL,
      {
        email: FAKE_EMAIL,
        api_base: EU_BASE,
        access_token: "ut-1",
        refresh_token: "rt-1",
        // Already expired: the first request renews it.
        access_expires_at: "1000",
      },
      configDir,
    );
    const ctx = await plaudProvider.createContext!({
      accountId: FAKE_EMAIL,
      host: { ...fakeProviderHost(), configDir },
    } as never);
    // The provider's own client uses the global fetch; swap in the fake.
    (ctx.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = fake.fetch;
    await ctx.client.listFiles();
    await expect(
      readProviderAccountCredentials("plaud", FAKE_EMAIL, configDir),
    ).resolves.toMatchObject({
      access_token: "ut-2",
      refresh_token: "rt-1",
    });
  });
});
