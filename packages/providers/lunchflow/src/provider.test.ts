// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  hasProviderAccountCredentials,
  isCredentialPersistError,
  isMissingCredentialsError,
  listProviderAccountIds,
} from "@omnesis/core";
import { AuthFailure, isRetryable, type AuthSession } from "@omnesis/source-sdk";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import {
  LUNCHFLOW_ACCOUNT_ID,
  authenticateWith,
  authFlow,
  cleanupCredentials,
  deriveAccountId,
  discoverAccounts,
  hasCredentials,
  loadApiKey,
} from "./provider.js";
import lunchflowProvider from "./index.js";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "omnesis-lunchflow-test-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/** A pre-per-account install: one shared credentials file, no account dirs. */
function writeLegacyKey(key: string): void {
  writeFileSync(join(configDir, "lunchflow-credentials.json"), JSON.stringify({ api_key: key }));
}

function bankAccount(id: number, name: string): Record<string, unknown> {
  return {
    id,
    name,
    institution_name: "Northstar",
    institution_logo: null,
    provider: "gocardless",
  };
}

/** A fetch stub returning a canned status/body for `GET /accounts`. */
function probe(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

/** A fetch stub whose `GET /accounts` answer depends on which key called it. */
function probeByKey(byKey: Record<string, unknown[]>): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const key = String((init?.headers as Record<string, string> | undefined)?.["x-api-key"] ?? "");
    const accounts = byKey[key];
    if (!accounts) throw new Error(`probeByKey: no canned response for key ${key || "(none)"}`);
    return new Response(JSON.stringify({ accounts, total: accounts.length }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("deriveAccountId", () => {
  test("is stable for a key and never embeds it", () => {
    const id = String(deriveAccountId("lf_secret"));
    expect(id).toBe(String(deriveAccountId("lf_secret")));
    expect(id).not.toContain("lf_secret");
    expect(id.startsWith("lunchflow-")).toBe(true);
  });

  test("two keys are two accounts", () => {
    // A shared literal collapsed every key onto one id, so a second key
    // overwrote the first connection instead of adding one.
    expect(String(deriveAccountId("key-a"))).not.toBe(String(deriveAccountId("key-b")));
  });
});

describe("loadApiKey / hasCredentials", () => {
  test("reads an account's own stored key", async () => {
    await authFlow(
      undefined,
      { credentials: { api_key: "lf_secret" } },
      { configDir },
      { fetchImpl: probe(200, { accounts: [], total: 0 }) },
    );
    const accountId = String(deriveAccountId("lf_secret"));
    expect(await loadApiKey(accountId, configDir)).toBe("lf_secret");
    expect(hasCredentials(accountId, configDir)).toBe(true);
  });

  test("adopts a pre-per-account shared key on first read", async () => {
    writeLegacyKey("legacy_key");
    expect(hasCredentials(LUNCHFLOW_ACCOUNT_ID, configDir)).toBe(true);
    expect(await loadApiKey(LUNCHFLOW_ACCOUNT_ID, configDir)).toBe("legacy_key");
    expect(hasProviderAccountCredentials("lunchflow", LUNCHFLOW_ACCOUNT_ID, configDir)).toBe(true);
  });

  test("missing credentials → MissingCredentialsError / false", async () => {
    const err = await loadApiKey("nobody", configDir).then(
      () => undefined,
      (e) => e,
    );
    expect(isMissingCredentialsError(err)).toBe(true);
    expect(hasCredentials("nobody", configDir)).toBe(false);
  });
});

describe("discoverAccounts", () => {
  test("returns nothing before any connection", () => {
    expect(discoverAccounts(configDir)).toEqual([]);
  });

  test("returns each connected account", async () => {
    const fetchImpl = probeByKey({
      "key-a": [bankAccount(481, "Everyday")],
      "key-b": [bankAccount(902, "Savings")],
    });
    await authFlow(undefined, { credentials: { api_key: "key-a" } }, { configDir }, { fetchImpl });
    await authFlow(undefined, { credentials: { api_key: "key-b" } }, { configDir }, { fetchImpl });
    expect(discoverAccounts(configDir).map(String).sort()).toEqual(
      [String(deriveAccountId("key-a")), String(deriveAccountId("key-b"))].sort(),
    );
  });

  test("resolves a pre-per-account install to its legacy account id", () => {
    // The shared file exists but nothing recorded which account owns it.
    // Returning nothing would stop the provider instantiating, which is what
    // performs the adoption — the source would vanish with no route back.
    writeLegacyKey("legacy_key");
    expect(discoverAccounts(configDir).map(String)).toEqual([LUNCHFLOW_ACCOUNT_ID]);
  });
});

describe("authFlow", () => {
  test("stores a pasted key under its derived account", async () => {
    const accountId = await authFlow(
      undefined,
      { credentials: { api_key: "lf_secret" } },
      { configDir },
      { fetchImpl: probe(200, { accounts: [bankAccount(481, "Everyday")], total: 1 }) },
    );
    expect(String(accountId)).toBe(String(deriveAccountId("lf_secret")));
    expect(hasProviderAccountCredentials("lunchflow", String(accountId), configDir)).toBe(true);
  });

  test("a second key covering different banks connects alongside the first", async () => {
    const fetchImpl = probeByKey({
      "key-a": [bankAccount(481, "Everyday")],
      "key-b": [bankAccount(902, "Savings")],
    });
    await authFlow(undefined, { credentials: { api_key: "key-a" } }, { configDir }, { fetchImpl });
    await authFlow(undefined, { credentials: { api_key: "key-b" } }, { configDir }, { fetchImpl });
    expect(listProviderAccountIds("lunchflow", configDir)).toHaveLength(2);
  });

  test("refuses a key that covers a bank another connection already syncs", async () => {
    // Transactions are keyed on the BANK account id, and the upsert rewrites
    // the column recording which Omnesis account owns a row — so two
    // connections over one bank would overwrite each other's ownership, and
    // removing either would then delete the other's history.
    const shared = bankAccount(481, "Everyday");
    const fetchImpl = probeByKey({
      "key-a": [shared],
      "key-b": [shared, bankAccount(902, "Savings")],
    });
    await authFlow(undefined, { credentials: { api_key: "key-a" } }, { configDir }, { fetchImpl });

    await expect(
      authFlow(undefined, { credentials: { api_key: "key-b" } }, { configDir }, { fetchImpl }),
    ).rejects.toThrow(/already connected/i);
    expect(listProviderAccountIds("lunchflow", configDir)).toHaveLength(1);
  });

  test("a rejected key surfaces as SyncError(auth) and stores nothing", async () => {
    await expect(
      authFlow(
        undefined,
        { credentials: { api_key: "bad" } },
        { configDir },
        { fetchImpl: probe(403, { error: "Forbidden" }) },
      ),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(listProviderAccountIds("lunchflow", configDir)).toEqual([]);
  });

  test("missing key throws before any probe", async () => {
    const err = await authFlow(
      undefined,
      {},
      { configDir },
      { fetchImpl: probe(200, { accounts: [], total: 0 }) },
    ).then(
      () => undefined,
      (e) => e,
    );
    expect(isMissingCredentialsError(err)).toBe(true);
  });
});

describe("cleanupCredentials", () => {
  test("removing one connection leaves the other's key intact", async () => {
    const fetchImpl = probeByKey({
      "key-a": [bankAccount(481, "Everyday")],
      "key-b": [bankAccount(902, "Savings")],
    });
    await authFlow(undefined, { credentials: { api_key: "key-a" } }, { configDir }, { fetchImpl });
    await authFlow(undefined, { credentials: { api_key: "key-b" } }, { configDir }, { fetchImpl });

    await cleanupCredentials(String(deriveAccountId("key-a")), configDir);

    expect(
      hasProviderAccountCredentials("lunchflow", String(deriveAccountId("key-a")), configDir),
    ).toBe(false);
    expect(await loadApiKey(String(deriveAccountId("key-b")), configDir)).toBe("key-b");
  });

  test("the last connection takes the pre-per-account shared file with it", async () => {
    writeLegacyKey("legacy_key");
    await loadApiKey(LUNCHFLOW_ACCOUNT_ID, configDir);

    await cleanupCredentials(LUNCHFLOW_ACCOUNT_ID, configDir);

    expect(existsSync(join(configDir, "lunchflow-credentials.json"))).toBe(false);
    expect(discoverAccounts(configDir)).toEqual([]);
  });
});

describe("connecting through the typed session", () => {
  /** A session that answers the one question this flow asks. */
  function session(answer: Record<string, string>, overrides: Partial<AuthSession> = {}) {
    const shown: Array<{ kind: string; title: string }> = [];
    const asked: Array<{ kind: string; title: string }> = [];
    const s: AuthSession = {
      reason: overrides.accountId ? "reauthenticate" : "connect",
      flowId: "flow-1",
      supplied: {},
      host: { ...fakeProviderHost(), configDir },
      canShow: () => true,
      show: (c) => void shown.push({ kind: c.kind, title: c.title }),
      ask: (c) => {
        asked.push({ kind: c.kind, title: c.title });
        return Promise.resolve(answer as never);
      },
      ...overrides,
    };
    return { session: s, shown, asked };
  }

  async function failureFrom(fetchImpl: typeof fetch): Promise<AuthFailure> {
    const caught = await authenticateWith(session({ api_key: "lf_secret" }).session, {
      fetchImpl,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(AuthFailure);
    return caught as AuthFailure;
  }

  test("the descriptor connects through the session", () => {
    expect(typeof lunchflowProvider.authenticate).toBe("function");
  });

  test("asks for the key, says it is checking it, and stores it", async () => {
    const { session: s, asked, shown } = session({ api_key: "lf_secret" });

    const result = await authenticateWith(s, {
      fetchImpl: probe(200, { accounts: [bankAccount(481, "Everyday")], total: 1 }),
    });

    // Compared case-insensitively: the platform's own name is a proper noun,
    // and a scanner guarding the tree against real names cannot tell one from
    // the other in a test file.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.kind).toBe("fields");
    expect(asked[0]?.title.toLowerCase()).toBe("connect lunch flow");
    expect(shown).toEqual([{ kind: "wait", title: "Checking the API key" }]);
    expect(result.accounts).toEqual([
      { accountId: String(deriveAccountId("lf_secret")), state: { status: "connected" } },
    ]);
    expect(await loadApiKey(String(deriveAccountId("lf_secret")), configDir)).toBe("lf_secret");
  });

  test("takes a key a client already collected rather than asking twice", async () => {
    const { session: s, asked } = session(
      { api_key: "never-asked" },
      { supplied: { api_key: "lf_secret" } },
    );

    const result = await authenticateWith(s, {
      fetchImpl: probe(200, { accounts: [], total: 0 }),
    });

    expect(asked).toEqual([]);
    expect(result.accounts[0]?.accountId).toBe(String(deriveAccountId("lf_secret")));
  });

  test("refuses a key covering banks another connection already syncs", async () => {
    // Transactions are keyed on the BANK account id and the upsert rewrites
    // the column recording which Omnesis account owns a row, so two
    // connections over one bank would overwrite each other's ownership.
    const shared = bankAccount(481, "Everyday");
    const fetchImpl = probeByKey({ "key-a": [shared], "key-b": [shared, bankAccount(902, "Bs")] });
    await authFlow(undefined, { credentials: { api_key: "key-a" } }, { configDir }, { fetchImpl });

    const failure = await authenticateWith(session({ api_key: "key-b" }).session, {
      fetchImpl,
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AuthFailure);
    // Nothing refused the key. Omnesis declined it.
    expect((failure as AuthFailure).code).toBe("duplicate");
    expect((failure as AuthFailure).remedy).toMatch(/overwrite each other's data/);
    expect(listProviderAccountIds("lunchflow", configDir)).toHaveLength(1);
  });

  test("a renewal is not refused for covering the banks it already covers", async () => {
    // A renewed key reaches the same banks as the key it replaces, so running
    // the overlap check on a renewal would refuse every renewal against its
    // own account.
    const shared = bankAccount(481, "Everyday");
    const fetchImpl = probeByKey({ "key-a": [shared], "key-a2": [shared] });
    await authFlow(undefined, { credentials: { api_key: "key-a" } }, { configDir }, { fetchImpl });
    const existing = String(deriveAccountId("key-a"));

    const result = await authenticateWith(
      session({ api_key: "key-a2" }, { accountId: existing }).session,
      { fetchImpl },
    );

    expect(result.accounts[0]?.accountId).toBe(existing);
    expect(await loadApiKey(existing, configDir)).toBe("key-a2");
  });

  test("a key the platform will not act on is the operator's to replace", async () => {
    // 401 and 403 arrive as one message, so the two cannot be told apart —
    // and need not be: either way a credential was presented and refused.
    for (const status of [401, 403]) {
      const rejected = await failureFrom(probe(status, { error: "Forbidden" }));
      expect(rejected.code).toBe("credential-rejected");
      expect(rejected.remedy).toMatch(/API destination/);
      expect(isRetryable(rejected.code)).toBe(true);
      expect(listProviderAccountIds("lunchflow", configDir)).toEqual([]);
    }
  });

  test("tells an unreachable platform apart from an answer it cannot read", async () => {
    const unreachable = await failureFrom((async () => {
      throw Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    }) as unknown as typeof fetch);
    expect(unreachable.code).toBe("unavailable");
    expect(isRetryable(unreachable.code)).toBe(true);

    const throttled = await failureFrom(probe(429, { error: "Too many requests" }));
    expect(throttled.code).toBe("unavailable");

    // A server error whose own Retry-After is longer than the client will wait
    // is handed back rather than retried in place.
    const serverError = await failureFrom(
      (async () =>
        new Response("{}", {
          status: 500,
          headers: { "retry-after": "3600" },
        })) as unknown as typeof fetch,
    );
    expect(serverError.code).toBe("unavailable");

    // Nothing classifies a body that is not the answer the endpoint promises.
    const unreadable = await failureFrom(
      (async () =>
        new Response("<html>maintenance</html>", { status: 200 })) as unknown as typeof fetch,
    );
    expect(unreadable.code).toBe("unknown");
  });

  test("an empty answer is missing credentials, not a rejected one", async () => {
    const err = await authenticateWith(session({ api_key: "  " }).session, {
      fetchImpl: (() => {
        throw new Error("the probe must not run without a key");
      }) as unknown as typeof fetch,
    }).catch((e: unknown) => e);

    expect(isMissingCredentialsError(err)).toBe(true);
  });

  test("an authenticated key that cannot be stored is reported as such", async () => {
    // The key may be unrecoverable — the platform shows it once — so a client
    // has to know to keep what was typed and offer a retry.
    const occupied = join(configDir, "occupied");
    writeFileSync(occupied, "");
    const { session: s } = session({ api_key: "lf_secret" }, {
      host: { ...fakeProviderHost(), configDir: occupied },
    } as Partial<AuthSession>);

    const err = await authenticateWith(s, {
      fetchImpl: probe(200, { accounts: [], total: 0 }),
    }).catch((e: unknown) => e);

    expect(isCredentialPersistError(err)).toBe(true);
  });
});
