// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi } from "vitest";
import { SyncError } from "@omnesis/types";
import { GranolaClient } from "./client.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("GranolaClient", () => {
  test("sends the bearer token and parses the notes envelope", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ notes: [{ id: "not_1" }], hasMore: true, cursor: "c2" }),
    );
    const client = new GranolaClient("grn_test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const res = await client.listNotes({ pageSize: 20, cursor: "c1", updatedAfter: "2026-01-01" });
    expect(res.cursor).toBe("c2");
    expect(res.hasMore).toBe(true);

    const [url, opts] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/notes?");
    expect(String(url)).toContain("page_size=20");
    expect(String(url)).toContain("cursor=c1");
    expect(String(url)).toContain("updated_after=2026-01-01");
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: "Bearer grn_test" });
  });

  test("requests the transcript when asked", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ id: "not_1", transcript: [] }),
    );
    const client = new GranolaClient("grn_test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.getNote("not_1", { includeTranscript: true });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/notes/not_1?include=transcript");
  });

  test("maps 401 to a SyncError of kind auth", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const client = new GranolaClient("bad", { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.listNotes()).rejects.toMatchObject({
      name: "SyncError",
      kind: "auth",
    });
  });

  test("surfaces Granola's reason when it rejects the key (401)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: "INVALID_API_KEY", message: "Invalid API key format" }, { status: 401 }),
    );
    const client = new GranolaClient("bad", { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.listNotes()).rejects.toMatchObject({
      kind: "auth",
      message: "Granola rejected the API key (HTTP 401): Invalid API key format (INVALID_API_KEY)",
    });
  });

  // An invalid key is a credential failure, not just this request's — every
  // source configured on this account is affected, not only this one.
  test("scopes a 401 to the whole connection", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const client = new GranolaClient("bad", { fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await client.listNotes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).scope).toBe("connection");
  });

  // A lapsed workspace subscription authenticates fine but is refused: it must
  // not be reported as an auth failure, or the operator is told to re-auth a
  // key that is already valid.
  test("maps a 403 to kind permission and surfaces the reason", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          code: "SUBSCRIPTION_INACTIVE",
          message: "Workspace subscription is not active. Please renew your subscription.",
        },
        { status: 403 },
      ),
    );
    const client = new GranolaClient("grn_valid", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.listNotes()).rejects.toMatchObject({
      name: "SyncError",
      kind: "permission",
      message:
        "Granola refused the request (HTTP 403): Workspace subscription is not active. " +
        "Please renew your subscription. (SUBSCRIPTION_INACTIVE)",
    });
  });

  test("leaves a 403 at the default source scope", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const client = new GranolaClient("grn_valid", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await client.listNotes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).scope).toBe("source");
  });

  // A real envelope carries a requestId and timestamp, pushing it past the
  // detail cap. Truncating before parsing left invalid JSON and leaked the raw
  // (clipped) body into the operator-facing message.
  test("parses a full-size envelope with requestId and timestamp", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          code: "SUBSCRIPTION_INACTIVE",
          message:
            "Workspace subscription is not active. Please renew your subscription to use the API.",
          requestId: "54a42ecf-2d29-4653-a2c4-50cfb2a89e34",
          timestamp: "2026-07-16T12:16:24.180Z",
        },
        { status: 403 },
      ),
    );
    const client = new GranolaClient("grn_valid", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.listNotes()).rejects.toMatchObject({
      kind: "permission",
      message:
        "Granola refused the request (HTTP 403): Workspace subscription is not active. " +
        "Please renew your subscription to use the API. (SUBSCRIPTION_INACTIVE)",
    });
  });

  test("truncates an unreasonably long reason", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "x".repeat(500) }, { status: 403 }),
    );
    const client = new GranolaClient("grn_valid", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.listNotes()).rejects.toMatchObject({
      kind: "permission",
      message: `Granola refused the request (HTTP 403): ${"x".repeat(200)}…`,
    });
  });

  test("falls back to the raw body when a 403 is not a JSON envelope", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const client = new GranolaClient("grn_valid", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.listNotes()).rejects.toMatchObject({
      kind: "permission",
      message: "Granola refused the request (HTTP 403): forbidden",
    });
  });

  test("retries a short 429 inline, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ notes: [], hasMore: false, cursor: null }));
    const sleep = vi.fn(async () => {});
    const client = new GranolaClient("grn_test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    const res = await client.listNotes();
    expect(res.notes).toEqual([]);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("surfaces a long 429 as a rate-limit SyncError carrying retryAfterMs and an account-scoped quota", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }),
    );
    const client = new GranolaClient("grn_test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.listNotes()).rejects.toMatchObject({
      name: "SyncError",
      kind: "rate-limit",
      retryAfterMs: 120_000,
      quota: { kind: "account" },
    });
  });

  test("scopes a 404 to the single item, since the rest of the page is unaffected", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));
    const client = new GranolaClient("grn_test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await client.getNote("not_gone").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).scope).toBe("item");
  });

  // The list endpoint names no single note in its path, so a 404 there would
  // mean the route itself is broken, not that one item is gone — it must not
  // carry the same item scope as a 404 on a note's own detail fetch.
  test("leaves a 404 on the list endpoint at the default source scope", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));
    const client = new GranolaClient("grn_test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await client.listNotes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).scope).toBe("source");
  });

  test("wraps a network failure as a SyncError of kind network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = new GranolaClient("grn_test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await client.listNotes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe("network");
    expect((err as SyncError).scope).toBe("source");
  });
});
