// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { SyncError } from "@omnesis/types";
import { EB_RATE_LIMIT_RETRY_MS, EnableBankingClient } from "./client.js";
import { EB_JWT_IAT_BACKDATE_SECONDS } from "./jwt.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const APP_ID = "11111111-2222-3333-4444-555555555555";
const NOW = new Date("2026-06-01T12:00:00.000Z");

function makeClient(fetchImpl: typeof fetch): EnableBankingClient {
  return new EnableBankingClient({
    applicationId: APP_ID,
    privateKeyPem,
    fetchImpl,
    now: () => NOW,
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("EnableBankingClient", () => {
  test("sends a freshly minted RS256 JWT on every request", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ aspsps: [] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.getAspsps("DE");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.enablebanking.com/aspsps?country=DE");
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const payload = JSON.parse(
      Buffer.from(auth.split(" ")[1].split(".")[1], "base64url").toString("utf-8"),
    );
    expect(payload.iss).toBe("enablebanking.com");
    expect(payload.iat).toBe(Math.floor(NOW.getTime() / 1000) - EB_JWT_IAT_BACKDATE_SECONDS);
  });

  test("startAuth posts the consent body with state and redirect_url", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ url: "https://bank.example/sca" }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const res = await client.startAuth({
      validUntil: "2026-11-28T12:00:00.000Z",
      aspspName: "Revolut",
      country: "DE",
      redirectUrl: "https://gateway.example:7600/oauth/callback",
      state: "flow-123",
    });
    expect(res.url).toBe("https://bank.example/sca");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.enablebanking.com/auth");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      access: { valid_until: "2026-11-28T12:00:00.000Z" },
      aspsp: { name: "Revolut", country: "DE" },
      state: "flow-123",
      redirect_url: "https://gateway.example:7600/oauth/callback",
      psu_type: "personal",
    });
  });

  test("getTransactions forwards date_from, transaction_status, continuation_key", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL) => jsonResponse({ transactions: [] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.getTransactions("uid-1", {
      dateFrom: "2026-03-03",
      transactionStatus: "BOOK",
      continuationKey: "ck-2",
    });
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("/accounts/uid-1/transactions?");
    expect(url).toContain("date_from=2026-03-03");
    expect(url).toContain("transaction_status=BOOK");
    expect(url).toContain("continuation_key=ck-2");
  });

  test("maps 401 and 403 to SyncError auth", async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn(async () => new Response("{}", { status }));
      const client = makeClient(fetchImpl as unknown as typeof fetch);
      await expect(client.getBalances("uid-1")).rejects.toMatchObject({
        name: "SyncError",
        kind: "auth",
        // The response carries no signal telling apart a lapsed per-bank
        // consent from a bad application key, so this keeps the default
        // per-source scope rather than guessing "connection".
        scope: "source",
      });
    }
  });

  test("429 throws rate-limit with the 6h retry hint immediately — no retry, no sleep", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "ASPSP_RATE_LIMIT_EXCEEDED" }, { status: 429 }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const err = await client.getTransactions("uid-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe("rate-limit");
    expect((err as SyncError).retryAfterMs).toBe(EB_RATE_LIMIT_RETRY_MS);
    expect((err as SyncError).message).toContain("ASPSP_RATE_LIMIT_EXCEEDED");
    // The ASPSP's unattended-access cap is this one connected bank's own
    // allowance, not a budget shared with every other connected bank.
    expect((err as SyncError).quota).toEqual({ kind: "account" });
    // Thrown straight through — exactly one fetch, no inline backoff.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("5xx maps to transient", async () => {
    const fetchImpl = vi.fn(async () => new Response("oops", { status: 503 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.getBalances("uid-1")).rejects.toMatchObject({
      kind: "transient",
    });
  });

  test("a thrown fetch maps to network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.getAspsps("DE")).rejects.toMatchObject({ kind: "network" });
  });

  test("error messages never leak the account uid or response bodies", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: "WRONG_REQUEST_PARAMETERS", error_description: "secret detail" },
        { status: 422 },
      ),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const err = await client.getTransactions("uid-secret-1").catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("uid-secret-1");
    expect((err as Error).message).not.toContain("secret detail");
    expect((err as Error).message).toContain("WRONG_REQUEST_PARAMETERS");
    expect((err as Error).message).toContain("422");
  });

  test("a response failing schema validation surfaces as a loud unknown error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ nope: true }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const err = await client.getBalances("uid-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe("unknown");
    expect((err as Error).message).toContain("failed validation");
  });

  test("createSession posts the code and parses accounts with identification_hash", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        session_id: "sess-1",
        accounts: [
          {
            uid: "uid-1",
            identification_hash: "hash-aaa",
            account_id: { iban: "DE89975713758667268881" },
            currency: "EUR",
          },
        ],
        access: { valid_until: "2026-11-28T12:00:00.000Z" },
        aspsp: { name: "Revolut", country: "DE" },
      }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const session = await client.createSession("the-code");
    expect(session.session_id).toBe("sess-1");
    expect(session.accounts[0].identification_hash).toBe("hash-aaa");

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ code: "the-code" });
  });
});
