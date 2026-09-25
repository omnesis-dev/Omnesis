// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { SyncError } from "@omnesis/types";
import {
  LUNCHFLOW_RATE_LIMIT_RETRY_MS,
  LunchflowAccountGoneError,
  LunchflowClient,
} from "./client.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
}

function clientReturning(
  status: number,
  body: unknown,
  opts: {
    headers?: Record<string, string>;
    captured?: Captured[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
): LunchflowClient {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    opts.captured?.push({
      url: String(url),
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: opts.headers,
    });
  }) as unknown as typeof fetch;
  return new LunchflowClient({ apiKey: "test-key", fetchImpl, sleep: opts.sleep });
}

describe("LunchflowClient happy paths", () => {
  test("listAccounts parses the envelope and sends the API key header", async () => {
    const captured: Captured[] = [];
    const client = clientReturning(
      200,
      {
        accounts: [
          {
            id: 481,
            name: "Everyday",
            institution_name: "Northstar",
            institution_logo: null,
            provider: "gocardless",
          },
        ],
        total: 1,
      },
      { captured },
    );
    const accounts = await client.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe(481);
    expect(captured[0].url).toBe("https://www.lunchflow.app/api/v1/accounts");
    expect(captured[0].headers["x-api-key"]).toBe("test-key");
  });

  test("getTransactions builds the from/include_pending query", async () => {
    const captured: Captured[] = [];
    const client = clientReturning(200, { transactions: [], total: 0 }, { captured });
    await client.getTransactions("481", { from: "2025-01-01", includePending: false });
    expect(captured[0].url).toContain("/accounts/481/transactions?");
    expect(captured[0].url).toContain("from=2025-01-01");
    expect(captured[0].url).toContain("include_pending=false");
  });

  test("getBalance parses the single-balance envelope", async () => {
    const client = clientReturning(200, { balance: { amount: 1280.75, currency: "GBP" } });
    const balance = await client.getBalance("481");
    expect(balance.amount).toBe(1280.75);
    expect(balance.currency).toBe("GBP");
  });
});

describe("LunchflowClient error mapping", () => {
  test("401/403 → SyncError(auth)", async () => {
    await expect(
      clientReturning(401, { error: "Unauthorized" }).listAccounts(),
    ).rejects.toMatchObject({
      kind: "auth",
    });
    await expect(clientReturning(403, { error: "Forbidden" }).listAccounts()).rejects.toMatchObject(
      {
        kind: "auth",
      },
    );
  });

  test("429 → SyncError(rate-limit) honoring Retry-After, else the default", async () => {
    const withHeader = clientReturning(
      429,
      { error: "rate" },
      { headers: { "retry-after": "120" } },
    );
    await expect(withHeader.listAccounts()).rejects.toMatchObject({
      kind: "rate-limit",
      retryAfterMs: 120_000,
      quota: { kind: "account" },
    });
    const noHeader = clientReturning(429, { error: "rate" });
    await expect(noHeader.listAccounts()).rejects.toMatchObject({
      kind: "rate-limit",
      retryAfterMs: LUNCHFLOW_RATE_LIMIT_RETRY_MS,
      quota: { kind: "account" },
    });
  });

  test("retries a transient 5xx response before succeeding", async () => {
    let calls = 0;
    let cancelled = false;
    const delays: number[] = [];
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true;
            },
          }),
          { status: 503 },
        );
      }
      return new Response(JSON.stringify({ accounts: [], total: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new LunchflowClient({
      apiKey: "test-key",
      fetchImpl,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(client.listAccounts()).resolves.toEqual([]);
    expect(calls).toBe(2);
    expect(delays).toEqual([500]);
    expect(cancelled).toBe(true);
  });

  test("exhausts the bounded 5xx retry budget as SyncError(transient)", async () => {
    const captured: Captured[] = [];
    const delays: number[] = [];
    await expect(
      clientReturning(
        500,
        { error: "down" },
        {
          captured,
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      ).listAccounts(),
    ).rejects.toMatchObject({ kind: "transient" });
    expect(captured).toHaveLength(3);
    expect(delays).toEqual([500, 1_000]);
  });

  test("does not wait inline or misclassify a 5xx with a long Retry-After hint", async () => {
    const captured: Captured[] = [];
    const delays: number[] = [];
    await expect(
      clientReturning(
        503,
        { error: "down" },
        {
          headers: { "retry-after": "120" },
          captured,
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      ).listAccounts(),
    ).rejects.toMatchObject({ kind: "transient", retryAfterMs: 120_000 });
    expect(captured).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  test("parses an HTTP-date Retry-After hint on a 5xx response", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const captured: Captured[] = [];
      await expect(
        clientReturning(
          503,
          { error: "down" },
          {
            headers: { "retry-after": "Thu, 01 Jan 2026 00:02:00 GMT" },
            captured,
            sleep: async () => undefined,
          },
        ).listAccounts(),
      ).rejects.toMatchObject({ kind: "transient", retryAfterMs: 120_000 });
      expect(captured).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("404 on a per-account endpoint → LunchflowAccountGoneError", async () => {
    await expect(
      clientReturning(404, { error: "Not Found" }).getTransactions("999"),
    ).rejects.toBeInstanceOf(LunchflowAccountGoneError);
    await expect(
      clientReturning(404, { error: "Not Found" }).getBalance("999"),
    ).rejects.toBeInstanceOf(LunchflowAccountGoneError);
  });

  test("404 without an account context → SyncError(unknown)", async () => {
    await expect(clientReturning(404, { error: "Not Found" }).listAccounts()).rejects.toMatchObject(
      {
        kind: "unknown",
      },
    );
  });

  test("retries a network failure before succeeding", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ accounts: [], total: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new LunchflowClient({ apiKey: "k", fetchImpl, sleep: async () => undefined });
    await expect(client.listAccounts()).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  test("exhausted network errors include a safe nested cause code and redact account ids", async () => {
    const cause = Object.assign(new Error("socket closed for a sensitive URL"), {
      code: "UND_ERR_SOCKET",
    });
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed", { cause });
    }) as unknown as typeof fetch;
    const client = new LunchflowClient({ apiKey: "k", fetchImpl, sleep: async () => undefined });

    const error = await client.getBalance("secret-account-id").catch((err: unknown) => err);
    expect(error).toMatchObject({ kind: "network" });
    expect((error as Error).message).toContain("UND_ERR_SOCKET");
    expect((error as Error).message).toContain("/accounts/…/balance");
    expect((error as Error).message).not.toContain("secret-account-id");
    expect((error as Error).message).not.toContain("sensitive URL");
    expect(String((error as Error).cause)).not.toContain("secret-account-id");
    expect(String((error as Error).cause)).not.toContain("sensitive URL");
    expect((error as Error & { cause: { code?: string } }).cause.code).toBe("UND_ERR_SOCKET");
  });

  test("does not retry authentication failures", async () => {
    const captured: Captured[] = [];
    await expect(
      clientReturning(401, { error: "Unauthorized" }, { captured }).listAccounts(),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(captured).toHaveLength(1);
  });

  test("a malformed response body → SyncError(unknown)", async () => {
    await expect(clientReturning(200, { wrong: "shape" }).listAccounts()).rejects.toBeInstanceOf(
      SyncError,
    );
    await expect(clientReturning(200, "<<not json>>").listAccounts()).rejects.toMatchObject({
      kind: "unknown",
    });
  });
});
