// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { SyncError } from "@omnesis/types";
import {
  PLAID_API_VERSION,
  PLAID_OPTIONAL_PRODUCTS,
  PLAID_PRODUCTS,
  PLAID_RATE_LIMIT_RETRY_MS,
  PLAID_TRANSACTIONS_DAYS_REQUESTED,
  PlaidApiError,
  PlaidClient,
} from "./client.js";
import { plaidHost } from "./types.js";

interface Captured {
  url: string;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}

function clientReturning(
  status: number,
  body: unknown,
  opts: { headers?: Record<string, string>; captured?: Captured[]; baseUrl?: string } = {},
): PlaidClient {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    opts.captured?.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: opts.headers,
    });
  }) as unknown as typeof fetch;
  return new PlaidClient({
    clientId: "test-client",
    secret: "test-secret",
    environment: "sandbox",
    baseUrl: opts.baseUrl,
    fetchImpl,
  });
}

describe("plaidHost", () => {
  test("maps environments to hosts", () => {
    expect(plaidHost("sandbox")).toBe("https://sandbox.plaid.com");
    expect(plaidHost("production")).toBe("https://production.plaid.com");
  });
});

describe("PlaidClient happy paths", () => {
  test("linkTokenCreate sends app credentials + products in the body, parses link_token", async () => {
    const captured: Captured[] = [];
    const client = clientReturning(
      200,
      { link_token: "link-sandbox-abc", expiration: "x" },
      {
        captured,
      },
    );
    const res = await client.linkTokenCreate({ clientUserId: "omnesis" });
    expect(res.link_token).toBe("link-sandbox-abc");
    expect(captured[0].url).toBe(`${plaidHost("sandbox")}/link/token/create`);
    expect(captured[0].body.client_id).toBe("test-client");
    expect(captured[0].body.secret).toBe("test-secret");
    // Pinned so every operator gets the response shapes the schemas expect.
    expect(captured[0].headers?.["Plaid-Version"]).toBe(PLAID_API_VERSION);
    expect(captured[0].body.products).toEqual([...PLAID_PRODUCTS]);
    // `investments` is optional so deposit-only institutions stay in the picker.
    expect(PLAID_PRODUCTS).not.toContain("investments");
    expect(captured[0].body.optional_products).toEqual([...PLAID_OPTIONAL_PRODUCTS]);
    // Plaid defaults to 90 days and fixes it per item — ask for the maximum.
    expect(captured[0].body.transactions).toEqual({
      days_requested: PLAID_TRANSACTIONS_DAYS_REQUESTED,
    });
    expect(PLAID_TRANSACTIONS_DAYS_REQUESTED).toBe(730);
    expect(captured[0].body.country_codes).toEqual(["US", "CA"]);
    expect(captured[0].body.user).toMatchObject({ client_user_id: "omnesis" });
  });

  test("linkTokenCreate in update mode sends access_token and omits products", async () => {
    const captured: Captured[] = [];
    const client = clientReturning(200, { link_token: "lt" }, { captured });
    await client.linkTokenCreate({ clientUserId: "omnesis", accessToken: "access-sandbox-1" });
    expect(captured[0].body.access_token).toBe("access-sandbox-1");
    expect(captured[0].body.products).toBeUndefined();
    expect(captured[0].body.optional_products).toBeUndefined();
    expect(captured[0].body.transactions).toBeUndefined();
  });

  test("itemRemove sends the access token to /item/remove and parses the ack", async () => {
    const captured: Captured[] = [];
    const client = clientReturning(200, { request_id: "req-1" }, { captured });
    const res = await client.itemRemove("access-sandbox-1");
    expect(res.request_id).toBe("req-1");
    expect(captured[0].url).toBe(`${plaidHost("sandbox")}/item/remove`);
    expect(captured[0].body.access_token).toBe("access-sandbox-1");
    expect(captured[0].body.client_id).toBe("test-client");
  });

  test("itemPublicTokenExchange parses access_token + item_id", async () => {
    const captured: Captured[] = [];
    const client = clientReturning(
      200,
      { access_token: "access-sandbox-9", item_id: "item-9" },
      { captured },
    );
    const res = await client.itemPublicTokenExchange("public-sandbox-9");
    expect(res.access_token).toBe("access-sandbox-9");
    expect(res.item_id).toBe("item-9");
    expect(captured[0].url).toBe(`${plaidHost("sandbox")}/item/public_token/exchange`);
    expect(captured[0].body.public_token).toBe("public-sandbox-9");
  });

  test("itemGet parses the item + consent_expiration_time", async () => {
    const client = clientReturning(200, {
      item: { item_id: "item-9", consent_expiration_time: "2026-09-01T00:00:00Z" },
    });
    const res = await client.itemGet("access-sandbox-9");
    expect(res.item.item_id).toBe("item-9");
    expect(res.item.consent_expiration_time).toBe("2026-09-01T00:00:00Z");
  });

  test("accountsGet sends the access token in the body and parses accounts", async () => {
    const captured: Captured[] = [];
    const client = clientReturning(
      200,
      {
        accounts: [
          {
            account_id: "acct-1",
            name: "Everyday Checking",
            type: "depository",
            subtype: "checking",
            balances: { available: 1500.25, current: 1620.5, iso_currency_code: "USD" },
          },
        ],
      },
      { captured },
    );
    const res = await client.accountsGet("access-sandbox-1");
    expect(captured[0].url).toBe(`${plaidHost("sandbox")}/accounts/get`);
    expect(captured[0].body.access_token).toBe("access-sandbox-1");
    expect(res.accounts).toHaveLength(1);
    expect(res.accounts[0].balances.current).toBe(1620.5);
  });

  test("investmentsHoldingsGet parses holdings + securities", async () => {
    const captured: Captured[] = [];
    const client = clientReturning(
      200,
      {
        holdings: [
          {
            account_id: "acct-invest",
            security_id: "sec-zzzx",
            quantity: 10,
            institution_value: 2505,
            cost_basis: 2000,
            iso_currency_code: "USD",
          },
        ],
        securities: [
          {
            security_id: "sec-zzzx",
            ticker_symbol: "ZZZX",
            name: "Stellar Index Fund",
            type: "etf",
          },
        ],
      },
      { captured },
    );
    const res = await client.investmentsHoldingsGet("access-sandbox-1");
    expect(captured[0].url).toBe(`${plaidHost("sandbox")}/investments/holdings/get`);
    expect(captured[0].body.access_token).toBe("access-sandbox-1");
    expect(res.holdings[0].security_id).toBe("sec-zzzx");
    expect(res.securities[0].ticker_symbol).toBe("ZZZX");
  });

  test("investmentsHoldingsGet parses an item with no positions (empty arrays)", async () => {
    const client = clientReturning(200, { holdings: [], securities: [] });
    const res = await client.investmentsHoldingsGet("access-sandbox-1");
    expect(res.holdings).toEqual([]);
    expect(res.securities).toEqual([]);
  });

  test("production environment hits the production host", async () => {
    const captured: Captured[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      captured.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
      return new Response(JSON.stringify({ link_token: "lt" }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new PlaidClient({
      clientId: "c",
      secret: "s",
      environment: "production",
      fetchImpl,
    });
    await client.linkTokenCreate({ clientUserId: "omnesis" });
    expect(captured[0].url).toBe("https://production.plaid.com/link/token/create");
  });
});

describe("PlaidClient error mapping", () => {
  test("a Plaid error is a PlaidApiError carrying its error_code", async () => {
    const err: unknown = await clientReturning(400, { error_code: "ITEM_NOT_FOUND" })
      .itemGet("a")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaidApiError);
    expect(err).toMatchObject({ kind: "auth", errorCode: "ITEM_NOT_FOUND" });
  });

  test.each([
    "USER_PERMISSION_REVOKED",
    "INVALID_CREDENTIALS",
    "ITEM_LOCKED",
    "USER_SETUP_REQUIRED",
    "ITEM_CONCURRENTLY_DELETED",
  ])("%s (only the user can clear it) → SyncError(auth)", async (code) => {
    await expect(clientReturning(400, { error_code: code }).itemGet("a")).rejects.toMatchObject({
      kind: "auth",
      errorCode: code,
    });
  });

  test.each(["INSTITUTION_DOWN", "INSTITUTION_NOT_RESPONDING", "PRODUCT_NOT_READY"])(
    "%s clears on its own → SyncError(transient)",
    async (code) => {
      await expect(
        clientReturning(400, { error_code: code }).investmentsHoldingsGet("a"),
      ).rejects.toMatchObject({ kind: "transient", errorCode: code });
    },
  );

  test.each(["INVALID_MFA", "USER_INPUT_TIMEOUT", "INSUFFICIENT_CREDENTIALS", "NO_ACCOUNTS"])(
    "%s needs the user back in Link → SyncError(auth), not an endless retry",
    async (code) => {
      // Nothing clears these during a background sync, so treating them as
      // transient would retry every interval forever and never prompt.
      await expect(
        clientReturning(400, { error_code: code }).transactionsSync({ accessToken: "a" }),
      ).rejects.toMatchObject({ kind: "auth", errorCode: code });
    },
  );

  test("an error_code that is not Plaid-shaped is dropped from the message", async () => {
    const hostile = "<script>".padEnd(300, "x");
    const err: unknown = await clientReturning(400, { error_code: hostile })
      .itemGet("a")
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "unknown", errorCode: undefined });
    expect((err as Error).message).not.toContain("<script>");
  });

  test("ITEM_LOGIN_REQUIRED → SyncError(auth)", async () => {
    await expect(
      clientReturning(400, { error_code: "ITEM_LOGIN_REQUIRED" }).itemGet("a"),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  test("INVALID_SECRET / 401 → SyncError(auth)", async () => {
    await expect(
      clientReturning(400, { error_code: "INVALID_SECRET" }).linkTokenCreate({ clientUserId: "u" }),
    ).rejects.toMatchObject({ kind: "auth" });
    await expect(
      clientReturning(401, { error_code: "UNAUTHORIZED" }).linkTokenCreate({ clientUserId: "u" }),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  test.each(["INVALID_API_KEYS", "INVALID_CLIENT_ID", "INVALID_SECRET"])(
    "%s scopes the failure to the whole connection — every item shares this app credential",
    async (code) => {
      await expect(clientReturning(400, { error_code: code }).itemGet("a")).rejects.toMatchObject({
        kind: "auth",
        scope: "connection",
      });
    },
  );

  test("an item-specific auth code (ITEM_NOT_FOUND) keeps the default source scope", async () => {
    await expect(
      clientReturning(400, { error_code: "ITEM_NOT_FOUND" }).itemGet("a"),
    ).rejects.toMatchObject({ kind: "auth", scope: "source" });
  });

  test("a plain 401 with no error_code keeps the default source scope", async () => {
    await expect(
      clientReturning(401, { error_code: "UNAUTHORIZED" }).itemGet("a"),
    ).rejects.toMatchObject({ kind: "auth", scope: "source" });
  });

  test("RATE_LIMIT_EXCEEDED honors Retry-After, else the default", async () => {
    await expect(
      clientReturning(
        429,
        { error_code: "RATE_LIMIT_EXCEEDED" },
        { headers: { "retry-after": "30" } },
      ).itemGet("a"),
    ).rejects.toMatchObject({ kind: "rate-limit", retryAfterMs: 30_000 });
    await expect(
      clientReturning(429, { error_code: "RATE_LIMIT_EXCEEDED" }).itemGet("a"),
    ).rejects.toMatchObject({ kind: "rate-limit", retryAfterMs: PLAID_RATE_LIMIT_RETRY_MS });
  });

  test("5xx → SyncError(transient)", async () => {
    await expect(
      clientReturning(503, { error_code: "INTERNAL_SERVER_ERROR" }).itemGet("a"),
    ).rejects.toMatchObject({ kind: "transient" });
  });

  test("an unrecognized 4xx → SyncError(unknown)", async () => {
    await expect(
      clientReturning(422, { error_code: "INVALID_FIELD" }).itemGet("a"),
    ).rejects.toMatchObject({ kind: "unknown", errorCode: "INVALID_FIELD" });
  });

  test("a network failure → SyncError(network)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new PlaidClient({
      clientId: "c",
      secret: "s",
      environment: "sandbox",
      fetchImpl,
    });
    await expect(client.itemGet("a")).rejects.toMatchObject({ kind: "network" });
  });

  test("a malformed success body → SyncError(unknown)", async () => {
    await expect(
      clientReturning(200, { wrong: "shape" }).itemPublicTokenExchange("p"),
    ).rejects.toBeInstanceOf(SyncError);
    await expect(clientReturning(200, "<<not json>>").itemGet("a")).rejects.toMatchObject({
      kind: "unknown",
    });
  });

  test("error messages never leak the secret or access token", async () => {
    let message = "";
    try {
      await clientReturning(400, { error_code: "INVALID_SECRET" }).linkTokenCreate({
        clientUserId: "u",
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("INVALID_SECRET");
    expect(message).not.toContain("test-secret");
  });
});

describe("PlaidClient.transactionsSync", () => {
  const okPage = {
    added: [],
    modified: [],
    removed: [],
    next_cursor: "cursor-1",
    has_more: false,
  };

  test("omits the cursor on the first sync, includes count + access token", async () => {
    const captured: Captured[] = [];
    const res = await clientReturning(200, okPage, { captured }).transactionsSync({
      accessToken: "access-1",
    });
    expect(captured[0].url).toBe("https://sandbox.plaid.com/transactions/sync");
    expect(captured[0].body.access_token).toBe("access-1");
    expect("cursor" in captured[0].body).toBe(false);
    expect(captured[0].body.count).toBe(500);
    // Operator credentials authenticate in the body, never a header.
    expect(captured[0].body.client_id).toBe("test-client");
    expect(captured[0].body.secret).toBe("test-secret");
    expect(res.next_cursor).toBe("cursor-1");
  });

  test("sends the cursor on an incremental sync", async () => {
    const captured: Captured[] = [];
    await clientReturning(200, okPage, { captured }).transactionsSync({
      accessToken: "access-1",
      cursor: "cursor-prev",
    });
    expect(captured[0].body.cursor).toBe("cursor-prev");
  });

  test("parses added/modified/removed and maps an auth error", async () => {
    const res = await clientReturning(200, {
      added: [
        {
          transaction_id: "t1",
          account_id: "a1",
          amount: 9.99,
          iso_currency_code: "USD",
          date: "2026-05-01",
        },
      ],
      modified: [],
      removed: [{ transaction_id: "t0" }],
      next_cursor: "c2",
      has_more: true,
    }).transactionsSync({ accessToken: "access-1", cursor: "c1" });
    expect(res.added).toHaveLength(1);
    expect(res.removed[0].transaction_id).toBe("t0");
    expect(res.has_more).toBe(true);

    await expect(
      clientReturning(400, { error_code: "ITEM_LOGIN_REQUIRED" }).transactionsSync({
        accessToken: "a",
      }),
    ).rejects.toMatchObject({ kind: "auth" });
  });
});
