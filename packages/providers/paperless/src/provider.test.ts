// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readProviderAccountCredentials, writeProviderAccountCredentials } from "@omnesis/core";
import { AccountId, ProviderId, SourceId } from "@omnesis/types";
import { AuthFailure, tableWrites, type AuthSession } from "@omnesis/source-sdk";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { FAKE_BASE_URL, FAKE_TOKEN, FakePaperless } from "./fake-paperless.js";
import {
  authenticate,
  cleanupCredentials,
  deriveAccountId,
  discoverAccounts,
  loadConnection,
} from "./provider.js";
import paperlessProvider from "./index.js";

const created: string[] = [];
afterEach(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
  created.length = 0;
  vi.unstubAllGlobals();
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-paperless-"));
  created.push(dir);
  return dir;
}

describe("deriveAccountId", () => {
  test.each([
    ["maya", "http://nas.example.org:8000", "maya@nas.example.org+8000"],
    ["maya", "https://paperless.example.com", "maya@paperless.example.com"],
    ["maya", "https://NAS.example.com/paperless", "maya@nas.example.com~paperless"],
    ["maya", "http://[fd00::12]:8000", "maya@fd00__12+8000"],
    ["CORP\\maya", "https://paperless.example.com", "CORP_maya@paperless.example.com"],
  ])("%s on %s → %s", (user, url, expected) => {
    expect(String(deriveAccountId(user, url))).toBe(expected);
  });

  test("the same user on two instances is two accounts", () => {
    expect(deriveAccountId("admin", "http://home.example.com")).not.toBe(
      deriveAccountId("admin", "http://office.example.com"),
    );
  });

  test("a port and a hostname that spells the same digits stay apart", () => {
    expect(deriveAccountId("maya", "http://paperless.local:8000")).not.toBe(
      deriveAccountId("maya", "http://paperless.local-8000"),
    );
    expect(deriveAccountId("maya", "http://nas/paperless")).not.toBe(
      deriveAccountId("maya", "http://nas-paperless"),
    );
  });

  test("a username no account id can hold yields none", () => {
    expect(deriveAccountId("m".repeat(300), "https://paperless.example.com")).toBeNull();
  });
});

describe("connecting through the typed session", () => {
  function session(
    answer: Record<string, string>,
    overrides: Partial<AuthSession> & { configDir?: string } = {},
  ) {
    const { configDir = tempConfigDir(), ...rest } = overrides;
    const shown: string[] = [];
    const asked: string[] = [];
    const s: AuthSession = {
      reason: rest.accountId ? "reauthenticate" : "connect",
      flowId: "flow-1",
      supplied: {},
      host: { ...fakeProviderHost(), configDir },
      canShow: () => true,
      show: (c) => void shown.push(c.title),
      ask: (c) => {
        asked.push(c.title);
        return Promise.resolve(answer as never);
      },
      ...rest,
    };
    return { session: s, shown, asked, configDir };
  }

  const fake = new FakePaperless();
  const opts = { fetchImpl: fake.fetch };

  test("the descriptor connects through the session", () => {
    expect(typeof paperlessProvider.authenticate).toBe("function");
  });

  test("asks for the address and token, checks them, and stores them under the user", async () => {
    fake.username = "maya";
    const {
      session: s,
      asked,
      shown,
      configDir,
    } = session({
      base_url: `${FAKE_BASE_URL}/`,
      api_token: FAKE_TOKEN,
    });

    const result = await authenticate(s, opts);

    expect(asked).toEqual(["Connect Paperless-ngx"]);
    expect(shown).toEqual(["Checking the token"]);
    expect(result.accounts).toEqual([
      { accountId: "maya@paperless.example.com+8000", state: { status: "connected" } },
    ]);
    await expect(
      readProviderAccountCredentials("paperless", "maya@paperless.example.com+8000", configDir),
    ).resolves.toEqual({ base_url: FAKE_BASE_URL, api_token: FAKE_TOKEN });
    await expect(loadConnection("maya@paperless.example.com+8000", configDir)).resolves.toEqual({
      baseUrl: FAKE_BASE_URL,
      token: FAKE_TOKEN,
    });
  });

  test("takes values a client already collected rather than asking twice", async () => {
    fake.username = "maya";
    const { session: s, asked } = session(
      {},
      { supplied: { base_url: FAKE_BASE_URL, api_token: FAKE_TOKEN } },
    );
    await authenticate(s, opts);
    expect(asked).toEqual([]);
  });

  test("a rejected token stores nothing", async () => {
    const { session: s, configDir } = session({ base_url: FAKE_BASE_URL, api_token: "wrong" });
    const err = await authenticate(s, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFailure);
    expect((err as AuthFailure).code).toBe("credential-rejected");
    expect(discoverAccounts(configDir)).toEqual([]);
  });

  test("an unreachable instance may clear on its own", async () => {
    const { session: s } = session({ base_url: FAKE_BASE_URL, api_token: FAKE_TOKEN });
    const err = await authenticate(s, {
      fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
    }).catch((e: unknown) => e);
    expect((err as AuthFailure).code).toBe("unavailable");
  });

  test("an address that is not http or https is refused before any request", async () => {
    const { session: s } = session({ base_url: "paperless.local", api_token: FAKE_TOKEN });
    const err = await authenticate(s, opts).catch((e: unknown) => e);
    expect((err as AuthFailure).code).toBe("credential-rejected");
  });

  test("a re-auth with a fresh token for the same user and address keeps the account", async () => {
    fake.username = "maya";
    const configDir = tempConfigDir();
    await writeProviderAccountCredentials(
      "paperless",
      "maya@paperless.example.com+8000",
      { base_url: FAKE_BASE_URL, api_token: "regenerated-since" },
      configDir,
    );
    const { session: s, asked } = session(
      { base_url: FAKE_BASE_URL, api_token: FAKE_TOKEN },
      { accountId: "maya@paperless.example.com+8000", configDir },
    );

    const result = await authenticate(s, opts);

    expect(asked).toEqual(["Reconnect maya@paperless.example.com+8000"]);
    expect(result.accounts[0]?.accountId).toBe("maya@paperless.example.com+8000");
    await expect(loadConnection("maya@paperless.example.com+8000", configDir)).resolves.toEqual({
      baseUrl: FAKE_BASE_URL,
      token: FAKE_TOKEN,
    });
  });

  test("a re-auth refuses the same username on another address", async () => {
    // Paperless has no instance identity: `admin` at home and `admin` at the
    // office look alike, and accepting the other would replace this archive.
    fake.username = "maya";
    const configDir = tempConfigDir();
    await writeProviderAccountCredentials(
      "paperless",
      "maya@old-nas.example.com",
      { base_url: "http://old-nas.example.com", api_token: "old" },
      configDir,
    );
    const { session: s } = session(
      { base_url: FAKE_BASE_URL, api_token: FAKE_TOKEN },
      { accountId: "maya@old-nas.example.com", configDir },
    );

    const err = await authenticate(s, opts).catch((e: unknown) => e);

    expect((err as AuthFailure).code).toBe("identity-mismatch");
    await expect(loadConnection("maya@old-nas.example.com", configDir)).resolves.toEqual({
      baseUrl: "http://old-nas.example.com",
      token: "old",
    });
  });

  test("a new connection never takes over an account id stored for another address", async () => {
    fake.username = "maya";
    const configDir = tempConfigDir();
    await writeProviderAccountCredentials(
      "paperless",
      "maya@paperless.example.com+8000",
      { base_url: "http://paperless.example.com:8000/elsewhere", api_token: "theirs" },
      configDir,
    );
    const { session: s } = session(
      { base_url: FAKE_BASE_URL, api_token: FAKE_TOKEN },
      { configDir },
    );

    const err = await authenticate(s, opts).catch((e: unknown) => e);

    expect((err as AuthFailure).code).toBe("duplicate");
  });

  test("a certificate this host cannot verify is not reported as an outage", async () => {
    const tlsError = Object.assign(new Error("self-signed certificate"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    });
    const { session: s } = session({ base_url: FAKE_BASE_URL, api_token: FAKE_TOKEN });
    const err = await authenticate(s, {
      fetchImpl: () => Promise.reject(new TypeError("fetch failed", { cause: tlsError })),
    }).catch((e: unknown) => e);
    expect((err as AuthFailure).code).toBe("insecure-connection");
  });

  test("blank answers are a rejected credential, not a missing app credential", async () => {
    const { session: s } = session({ base_url: " ", api_token: "" });
    const err = await authenticate(s, opts).catch((e: unknown) => e);
    expect((err as AuthFailure).code).toBe("credential-rejected");
  });

  test("a re-auth refuses a token belonging to another user", async () => {
    fake.username = "david";
    const { session: s } = session(
      { base_url: FAKE_BASE_URL, api_token: FAKE_TOKEN },
      { accountId: "maya@paperless.example.com+8000" },
    );
    const err = await authenticate(s, opts).catch((e: unknown) => e);
    expect((err as AuthFailure).code).toBe("identity-mismatch");
    // Names the accounts, not the typed address the collector masks.
    expect((err as AuthFailure).message).toBe(
      "This token belongs to the account david@paperless.example.com+8000, not maya@paperless.example.com+8000.",
    );
    expect((err as AuthFailure).remedy).toMatch(/separate source/);
  });
});

describe("accounts on disk", () => {
  test("discover lists every stored account, opaque, without the network", async () => {
    const dir = tempConfigDir();
    await writeProviderAccountCredentials(
      "paperless",
      "maya@home.example.com",
      { base_url: "http://home.example.com", api_token: "a" },
      dir,
    );
    await writeProviderAccountCredentials(
      "paperless",
      "maya@office.example.com",
      { base_url: "http://office.example.com", api_token: "b" },
      dir,
    );

    const accounts = await paperlessProvider.discover!({ configDir: dir });

    expect(accounts).toEqual(
      expect.arrayContaining([
        {
          id: "maya@home.example.com",
          subject: { kind: "opaque", value: "maya@home.example.com" },
        },
        {
          id: "maya@office.example.com",
          subject: { kind: "opaque", value: "maya@office.example.com" },
        },
      ]),
    );
  });

  test("cleanup removes one account and leaves its sibling", async () => {
    const dir = tempConfigDir();
    await writeProviderAccountCredentials(
      "paperless",
      "a@home.example.com",
      { base_url: "http://home.example.com", api_token: "a" },
      dir,
    );
    await writeProviderAccountCredentials(
      "paperless",
      "b@home.example.com",
      { base_url: "http://home.example.com", api_token: "b" },
      dir,
    );

    await cleanupCredentials("a@home.example.com", dir);

    expect(discoverAccounts(dir).map(String)).toEqual(["b@home.example.com"]);
    expect(existsSync(join(dir, "paperless", "a@home.example.com"))).toBe(false);
  });

  test("two accounts created through the descriptor keep their own rows and documents", async () => {
    const dir = tempConfigDir();
    const home = new FakePaperless();
    const office = new FakePaperless();
    home.addDocument({ id: 1, title: "From home" });
    office.addDocument({ id: 1, title: "From the office" });
    await writeProviderAccountCredentials(
      "paperless",
      "maya@home.example.com",
      { base_url: "http://home.example.com", api_token: FAKE_TOKEN },
      dir,
    );
    await writeProviderAccountCredentials(
      "paperless",
      "maya@office.example.com",
      { base_url: "http://office.example.com", api_token: FAKE_TOKEN },
      dir,
    );
    vi.stubGlobal("fetch", ((input, init) =>
      (String(input).startsWith("http://home.") ? home : office).fetch(
        input,
        init,
      )) as typeof fetch);

    const synced = [];
    for (const account of ["maya@home.example.com", "maya@office.example.com"]) {
      const host = { ...fakeProviderHost(), configDir: dir };
      const ctx = await paperlessProvider.createContext!({
        accountId: AccountId(account),
        host,
      } as never);
      const instance = await paperlessProvider.sources[0]!.create(
        {
          sourceId: SourceId(`paperless-documents:${account}`),
          providerId: ProviderId(`paperless:${account}`),
          accountId: AccountId(account),
          host,
        } as never,
        ctx,
      );
      synced.push(await instance.syncStructured!(null, {}));
    }

    expect(synced.map((p) => p.documents![0]!.title)).toEqual(["From home", "From the office"]);
    const rowAccounts = synced.map(
      (p) =>
        tableWrites(p.analytics).find((w) => w.tableName === "paperless_documents")!.records![0]!
          .source_account_id,
    );
    expect(rowAccounts).toEqual(["maya@home.example.com", "maya@office.example.com"]);
    expect(synced[0]!.documents![0]!.sourceId).not.toBe(synced[1]!.documents![0]!.sourceId);
  });

  test("a missing or incomplete credential names what is missing", async () => {
    const dir = tempConfigDir();
    await writeProviderAccountCredentials(
      "paperless",
      "a@home.example.com",
      { api_token: "a" },
      dir,
    );
    await expect(loadConnection("a@home.example.com", dir)).rejects.toThrow(
      /No Paperless-ngx address and API token are stored for a@home\.example\.com\. Re-authenticate/,
    );
  });

  test("credential state is read from disk, never from the network", async () => {
    const dir = tempConfigDir();
    await writeProviderAccountCredentials(
      "paperless",
      "a@home.example.com",
      { base_url: "http://home.example.com", api_token: "a" },
      dir,
    );
    const ctx = { accountId: "a@home.example.com", configDir: dir } as never;
    await expect(paperlessProvider.credentialState!(ctx)).resolves.toEqual({ status: "connected" });
    await expect(
      paperlessProvider.credentialState!({
        accountId: "b@home.example.com",
        configDir: dir,
      } as never),
    ).resolves.toEqual({ status: "never-connected" });
  });
});
