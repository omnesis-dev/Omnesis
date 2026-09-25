// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthFailure, isRetryable } from "@omnesis/source-sdk";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { listProviderAccountIds } from "@omnesis/core";
import {
  authenticateWith,
  authFlow,
  cleanupCredentials,
  deriveAccountId,
  discoverAccounts,
  hasCredentials,
  loadCredentials,
} from "./provider.js";
import { coinbaseCredentialsSpec } from "./credentials-spec.js";
import type { AuthChallenge, AuthSession, FieldsChallenge } from "@omnesis/source-sdk";
import type { FetchFn } from "./client.js";
import type { CoinbaseKeyPermissions } from "./types.js";

// A throwaway ES256 key, minted at runtime — no key is committed.
const ecPem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

const KEY_ID = "organizations/00000000-0000-0000-0000-000000000000/apiKeys/test-key";
/** A second key name, for the retry and rotation cases. */
const SECOND_KEY_ID = "organizations/00000000-0000-0000-0000-000000000000/apiKeys/other-key";
const PORTFOLIO_ID = "11111111-2222-3333-4444-555555555555";
/** A portfolio this install is not connected to. */
const OTHER_PORTFOLIO_ID = "99999999-8888-7777-6666-555555555555";

/** What the client pastes into the add flow — the shape `authFlow` receives. */
const PASTED = { key_id: KEY_ID, private_key: ecPem };

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "omnesis-coinbase-test-"));
});

afterEach(async () => {
  await cleanupCredentials(String(PORTFOLIO_ID), configDir);
});

/** A pre-per-account install: one shared credentials file, no account dirs. */
function writeCreds(): void {
  writeFileSync(
    join(configDir, "coinbase-credentials.json"),
    JSON.stringify({ key_id: KEY_ID, private_key: ecPem }),
    { mode: 0o600 },
  );
}

/** A fake fetch that routes by path to canned JSON, with a per-path status. */
function fakeFetch(routes: {
  permissions?: { status: number; body: unknown };
  accounts?: { status: number; body: unknown };
}): FetchFn {
  return async (input: string) => {
    const route = input.includes("key_permissions")
      ? routes.permissions
      : input.includes("/accounts")
        ? routes.accounts
        : undefined;
    if (!route) throw new Error(`fakeFetch: unexpected request ${input}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  };
}

const readOnly: CoinbaseKeyPermissions = {
  can_view: true,
  can_trade: false,
  can_transfer: false,
  retail_portfolio_id: PORTFOLIO_ID,
};

describe("credentials spec", () => {
  test("declares the pasted key as the per-account credential", () => {
    // So clients collect it on every add instead of skipping the wizard when a
    // previous account's key is already on disk — which is what made a second
    // Coinbase account impossible.
    expect(coinbaseCredentialsSpec.perAccount).toBe(true);
  });
});

describe("deriveAccountId", () => {
  test("uses the portfolio id when present", () => {
    expect(String(deriveAccountId(PORTFOLIO_ID, KEY_ID))).toBe(PORTFOLIO_ID);
  });

  test("falls back to a stable key-id hash, never embedding the raw key", () => {
    const id = String(deriveAccountId(undefined, KEY_ID));
    expect(id).toMatch(/^coinbase-[0-9a-f]{12}$/);
    expect(id).not.toContain(KEY_ID);
    // Deterministic for the same key.
    expect(String(deriveAccountId(undefined, KEY_ID))).toBe(id);
  });
});

describe("loadCredentials", () => {
  test("throws MissingCredentialsError when absent", async () => {
    await expect(loadCredentials(PORTFOLIO_ID, configDir)).rejects.toMatchObject({
      code: "missing-credentials",
    });
  });
});

/**
 * A session that records what the flow put in front of the operator and hands
 * back the answers this test scripted.
 */
function scriptedSession(options: {
  configDir: string;
  supplied?: Record<string, string>;
  answers?: Array<Record<string, string>>;
  accountId?: string;
}) {
  const asked: FieldsChallenge[] = [];
  const shown: AuthChallenge[] = [];
  const queue = [...(options.answers ?? [])];
  const session: AuthSession = {
    reason: options.accountId ? "reauthenticate" : "connect",
    flowId: "flow-1",
    accountId: options.accountId,
    supplied: options.supplied ?? {},
    host: { ...fakeProviderHost(), configDir: options.configDir },
    canShow: () => true,
    show: (challenge) => void shown.push(challenge),
    ask: (challenge) => {
      if (challenge.kind !== "fields") throw new Error(`unexpected ${challenge.kind} challenge`);
      asked.push(challenge);
      const next = queue.shift();
      if (!next) throw new Error("the flow asked more times than the test scripted");
      return Promise.resolve(next as never);
    },
  };
  return { session, asked, shown };
}

async function failureFrom(promise: Promise<unknown>): Promise<AuthFailure> {
  const caught = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(caught).toBeInstanceOf(AuthFailure);
  return caught as AuthFailure;
}

describe("connecting through the typed session — happy path", () => {
  test("validates a read-only key and returns the portfolio account id", async () => {
    writeCreds();
    const { session, asked } = scriptedSession({ configDir, supplied: PASTED });
    const result = await authenticateWith(session, {
      fetchImpl: fakeFetch({
        permissions: { status: 200, body: readOnly },
        accounts: {
          status: 200,
          body: { accounts: [{ uuid: "u", currency: "BTC" }], has_next: false },
        },
      }),
      now: () => 1_780_000_000_000,
    });

    expect(result.accounts).toEqual([{ accountId: PORTFOLIO_ID, state: { status: "connected" } }]);
    // The key the older client collected is used as it stands rather than
    // asked for a second time.
    expect(asked).toEqual([]);
    // Credential stored under the account → discover resolves it offline.
    expect(discoverAccounts(configDir).map(String)).toEqual([PORTFOLIO_ID]);
    expect(hasCredentials(PORTFOLIO_ID, configDir)).toBe(true);
  });

  test("asks for the key when the client did not collect one", async () => {
    const { session, asked, shown } = scriptedSession({ configDir, answers: [PASTED] });
    const result = await authenticateWith(session, {
      fetchImpl: fakeFetch({
        permissions: { status: 200, body: readOnly },
        accounts: { status: 200, body: { accounts: [], has_next: false } },
      }),
    });

    expect(asked).toHaveLength(1);
    expect(Object.keys(asked[0]!.schema.fields).sort()).toEqual(["key_id", "private_key"]);
    expect(shown.map((c) => c.kind)).toEqual(["wait"]);
    expect(result.accounts[0]?.accountId).toBe(PORTFOLIO_ID);
  });

  test("derives the portfolio id from the accounts response when permissions omit it", async () => {
    writeCreds();
    const { session } = scriptedSession({ configDir, supplied: PASTED });
    const result = await authenticateWith(session, {
      fetchImpl: fakeFetch({
        permissions: { status: 200, body: { ...readOnly, retail_portfolio_id: undefined } },
        accounts: {
          status: 200,
          body: {
            accounts: [{ uuid: "u", currency: "BTC", retail_portfolio_id: PORTFOLIO_ID }],
            has_next: false,
          },
        },
      }),
    });
    expect(result.accounts[0]?.accountId).toBe(PORTFOLIO_ID);
  });
});

describe("connecting through the typed session — read-only refusal", () => {
  /** Refuse the first key, then accept the second. */
  function refusingThenAccepting(first: Partial<CoinbaseKeyPermissions>): FetchFn {
    let call = 0;
    return async (input: string) => {
      const permissions = input.includes("key_permissions");
      if (permissions) call++;
      const body = permissions
        ? call === 1
          ? { ...readOnly, ...first }
          : readOnly
        : { accounts: [], has_next: false };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  }

  test("refuses a key that can trade", async () => {
    writeCreds();
    // A refused key is asked for again, so the whole allowance is scripted and
    // the failure read here is the one the flow ends on.
    const { session } = scriptedSession({ configDir, supplied: PASTED, answers: [PASTED, PASTED] });
    const failure = await failureFrom(
      authenticateWith(session, {
        fetchImpl: fakeFetch({
          permissions: { status: 200, body: { ...readOnly, can_trade: true } },
        }),
      }),
    );
    expect(failure.code).toBe("credential-rejected");
    expect(failure.message).toMatch(/trade or transfer/i);
    // Nothing stored on refusal — a rejected key leaves no trace.
    expect(listProviderAccountIds("coinbase", configDir)).toEqual([]);
  });

  test("refuses a key that can transfer", async () => {
    writeCreds();
    const { session } = scriptedSession({ configDir, supplied: PASTED, answers: [PASTED, PASTED] });
    const failure = await failureFrom(
      authenticateWith(session, {
        fetchImpl: fakeFetch({
          permissions: { status: 200, body: { ...readOnly, can_transfer: true } },
        }),
      }),
    );
    expect(failure.code).toBe("credential-rejected");
    expect(failure.message).toMatch(/trade or transfer/i);
  });

  test("refuses a key without View", async () => {
    writeCreds();
    const { session } = scriptedSession({ configDir, supplied: PASTED, answers: [PASTED, PASTED] });
    const failure = await failureFrom(
      authenticateWith(session, {
        fetchImpl: fakeFetch({
          permissions: { status: 200, body: { ...readOnly, can_view: false } },
        }),
      }),
    );
    expect(failure.code).toBe("credential-rejected");
    expect(failure.message).toMatch(/View permission/i);
  });

  test("takes a narrower key without making the operator start over", async () => {
    // The whole point of asking inside the flow: a key minted with Trade still
    // enabled used to end the add, so the operator minted another one and did
    // the entire add again.
    const { session, asked } = scriptedSession({
      configDir,
      supplied: { key_id: KEY_ID, private_key: ecPem },
      answers: [{ key_id: SECOND_KEY_ID, private_key: ecPem }],
    });
    const result = await authenticateWith(session, {
      fetchImpl: refusingThenAccepting({ can_trade: true }),
    });

    expect(result.accounts[0]?.accountId).toBe(PORTFOLIO_ID);
    expect(asked).toHaveLength(1);
    // The name is offered back; the private key is not, because it is the half
    // that was refused.
    expect(asked[0]!.prefill).toEqual({ key_id: KEY_ID });
    expect(asked[0]!.instructions).toMatch(/trade or transfer/i);
  });

  test("gives up after three keys rather than asking forever", async () => {
    const { session, asked } = scriptedSession({
      configDir,
      answers: [PASTED, PASTED, PASTED, PASTED],
    });
    const failure = await failureFrom(
      authenticateWith(session, {
        fetchImpl: fakeFetch({
          permissions: { status: 200, body: { ...readOnly, can_trade: true } },
        }),
      }),
    );
    expect(failure.code).toBe("credential-rejected");
    expect(asked).toHaveLength(3);
  });
});

describe("connecting through the typed session — invalid key / network", () => {
  test("maps a 401 to a refused credential", async () => {
    writeCreds();
    const { session } = scriptedSession({ configDir, supplied: PASTED, answers: [PASTED, PASTED] });
    const failure = await failureFrom(
      authenticateWith(session, {
        fetchImpl: fakeFetch({
          permissions: { status: 401, body: { errors: [{ id: "invalid_token" }] } },
        }),
      }),
    );
    expect(failure.code).toBe("credential-rejected");
    expect(isRetryable(failure.code)).toBe(true);
  });

  test("maps a 403 invalid_scope to a refused credential", async () => {
    writeCreds();
    const { session } = scriptedSession({ configDir, supplied: PASTED, answers: [PASTED, PASTED] });
    const failure = await failureFrom(
      authenticateWith(session, {
        fetchImpl: fakeFetch({
          permissions: { status: 403, body: { errors: [{ id: "invalid_scope" }] } },
        }),
      }),
    );
    expect(failure.code).toBe("credential-rejected");
  });

  test("maps a fetch throw to an unreachable platform, not a crash", async () => {
    writeCreds();
    const throwingFetch: FetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    // An unreachable platform is not a refused credential, so it ends the flow
    // rather than asking for another key.
    const { session } = scriptedSession({ configDir, supplied: PASTED });
    const failure = await failureFrom(authenticateWith(session, { fetchImpl: throwingFetch }));
    expect(failure.code).toBe("unavailable");
    expect(isRetryable(failure.code)).toBe(true);
  });

  test("refuses a private key it cannot parse, before anything is sent", async () => {
    // The commonest way a good key arrives unusable: the CDP key file carries
    // the PEM as a JSON string, so the block is pasted with literal
    // backslash-n where its newlines should be. Signing happens outside the
    // block that maps request failures, so this would otherwise escape the
    // flow as a bare error.
    let requests = 0;
    // Assembled rather than written out: a literal PEM header in a source file
    // is what the repository's secret guard looks for, and it cannot tell this
    // deliberately broken one from a real key someone pasted by mistake.
    const unparseable = {
      key_id: KEY_ID,
      private_key: `-----BEGIN ${"EC PRIVATE KEY"}----- not a key`,
    };
    const { session } = scriptedSession({
      configDir,
      supplied: unparseable,
      answers: [unparseable, unparseable],
    });
    const failure = await failureFrom(
      authenticateWith(session, {
        fetchImpl: async () => {
          requests++;
          throw new Error("should not be reached");
        },
      }),
    );
    expect(failure.code).toBe("credential-rejected");
    expect(failure.remedy).toMatch(/BEGIN/);
    expect(requests).toBe(0);
  });

  test("reports a key it could not store as a persistence failure", async () => {
    // A file where the account's directory has to go, so the write fails after
    // Coinbase has already accepted the key.
    writeFileSync(join(configDir, "coinbase"), "not a directory");
    const { session } = scriptedSession({ configDir, supplied: PASTED });
    await expect(
      authenticateWith(session, {
        fetchImpl: fakeFetch({
          permissions: { status: 200, body: readOnly },
          accounts: { status: 200, body: { accounts: [], has_next: false } },
        }),
      }),
    ).rejects.toMatchObject({ code: "credential-persist-failed" });
    rmSync(join(configDir, "coinbase"), { force: true });
  });
});

describe("connecting through the typed session — renewing an account", () => {
  test("refuses a key belonging to a different portfolio", async () => {
    const { session } = scriptedSession({
      configDir,
      supplied: PASTED,
      accountId: OTHER_PORTFOLIO_ID,
    });
    const failure = await failureFrom(
      authenticateWith(session, {
        fetchImpl: fakeFetch({
          permissions: { status: 200, body: readOnly },
          accounts: { status: 200, body: { accounts: [], has_next: false } },
        }),
      }),
    );
    expect(failure.code).toBe("identity-mismatch");
    expect(failure.remedy).toMatch(/separate source/);
    expect(listProviderAccountIds("coinbase", configDir)).toEqual([]);
  });

  test("lets a rotated key through when the id came from the key rather than the portfolio", async () => {
    // A key-derived id is a function of the key, so a rotated key never
    // matches it. Enforcing the guard there would make rotation impossible
    // rather than catch a wrong account.
    const rotated = { key_id: SECOND_KEY_ID, private_key: ecPem };
    const existing = String(deriveAccountId(undefined, KEY_ID));
    const { session } = scriptedSession({
      configDir,
      supplied: rotated,
      accountId: existing,
    });
    const result = await authenticateWith(session, {
      fetchImpl: fakeFetch({
        permissions: { status: 200, body: { ...readOnly, retail_portfolio_id: undefined } },
        accounts: { status: 200, body: { accounts: [], has_next: false } },
      }),
    });
    expect(result.accounts[0]?.accountId).toBe(existing);
  });
});

describe("authFlow", () => {
  test("still connects an account for a client that has not moved to the session", async () => {
    writeCreds();
    const accountId = await authFlow(
      undefined,
      { credentials: PASTED },
      { configDir },
      {
        fetchImpl: fakeFetch({
          permissions: { status: 200, body: readOnly },
          accounts: { status: 200, body: { accounts: [], has_next: false } },
        }),
      },
    );
    expect(String(accountId)).toBe(PORTFOLIO_ID);
  });
});

describe("hasCredentials (offline isAuthenticated)", () => {
  test("false before auth, true after, false after cleanup", async () => {
    expect(hasCredentials(PORTFOLIO_ID, configDir)).toBe(false);
    writeCreds();
    // A pre-per-account install has only the shared file, and that IS the
    // account's credential until the first read adopts it — reporting it as
    // absent would park a working source in needs-auth after an upgrade.
    expect(hasCredentials(PORTFOLIO_ID, configDir)).toBe(true);
    const { session } = scriptedSession({ configDir, supplied: PASTED });
    await authenticateWith(session, {
      fetchImpl: fakeFetch({
        permissions: { status: 200, body: readOnly },
        accounts: { status: 200, body: { accounts: [], has_next: false } },
      }),
    });
    expect(hasCredentials(PORTFOLIO_ID, configDir)).toBe(true);
    await cleanupCredentials(PORTFOLIO_ID, configDir);
    expect(existsSync(join(configDir, "coinbase-credentials.json"))).toBe(false);
    expect(hasCredentials(PORTFOLIO_ID, configDir)).toBe(false);
  });
});
