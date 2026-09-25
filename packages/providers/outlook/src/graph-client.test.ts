// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SyncError } from "@omnesis/types";
import {
  GraphClient,
  DeltaExpiredError,
  AuthError,
  toConnectionAuthError,
} from "./graph-client.js";

describe("toConnectionAuthError", () => {
  it("carries the account-wide scope every Outlook source shares", () => {
    const source = new AuthError("token revoked");
    const error = toConnectionAuthError(source);
    expect(error).toBeInstanceOf(SyncError);
    expect(error.kind).toBe("auth");
    expect(error.scope).toBe("connection");
    expect(error.cause).toBe(source);
    expect(error.message).toBe("token revoked");
  });
});

describe("GraphClient.getBytes", () => {
  const getToken = vi.fn(async () => "test-token");
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    getToken.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the raw bytes and injects the bearer token", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => payload.buffer,
    });

    const client = new GraphClient(getToken);
    const bytes = await client.getBytes("/me/drive/items/item-1/content");

    expect(bytes).toEqual(payload);
    expect(getToken).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/drive/items/item-1/content");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("accepts absolute Graph URLs for delta pagination", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    });

    const client = new GraphClient(getToken);
    await client.getBytes("https://graph.microsoft.com/v1.0/me/drive/root/delta?$skiptoken=abc");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/drive/root/delta?$skiptoken=abc");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("rejects arbitrary absolute URLs before fetching or resolving a token", async () => {
    const client = new GraphClient(getToken);

    await expect(client.getBytes("https://download.example.com/blob?token=abc")).rejects.toThrow(
      /Refusing to send a Graph API bearer token/,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("follows Graph content redirects without forwarding the bearer token", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers({ Location: "https://download.example.com/blob?token=abc" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([7, 8]).buffer,
      });

    const client = new GraphClient(getToken);
    const bytes = await client.getBytes("/me/drive/items/item-1/content");

    expect(bytes).toEqual(new Uint8Array([7, 8]));
    const [graphUrl, graphInit] = fetchMock.mock.calls[0];
    expect(graphUrl).toBe("https://graph.microsoft.com/v1.0/me/drive/items/item-1/content");
    expect((graphInit.headers as Record<string, string>).Authorization).toBe("Bearer test-token");

    const [downloadUrl, downloadInit] = fetchMock.mock.calls[1];
    expect(downloadUrl).toBe("https://download.example.com/blob?token=abc");
    expect((downloadInit.headers as Record<string, string> | undefined)?.Authorization).toBe(
      undefined,
    );
  });

  it("maps 410 to DeltaExpiredError (shared with get)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 410, text: async () => "" });
    const client = new GraphClient(getToken);
    await expect(client.getBytes("/me/drive/items/x/content")).rejects.toBeInstanceOf(
      DeltaExpiredError,
    );
  });

  it("maps 401 to AuthError (shared with get)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "" });
    const client = new GraphClient(getToken);
    await expect(client.getBytes("/me/drive/items/x/content")).rejects.toBeInstanceOf(AuthError);
  });
});

describe("GraphClient.get", () => {
  const getToken = vi.fn(async () => "test-token");
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    getToken.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("still parses JSON after the request refactor", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ value: [{ id: "a" }] }) });
    const client = new GraphClient(getToken);
    const res = await client.get<{ value: { id: string }[] }>("/me/drive/root/delta");
    expect(res.value[0].id).toBe("a");
  });

  it("accepts absolute Graph nextLink URLs", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });

    const client = new GraphClient(getToken);
    await client.get(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc",
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("rejects non-Graph absolute URLs before attaching a bearer token", async () => {
    const client = new GraphClient(getToken);

    await expect(client.get("https://evil.example.com/v1.0/me/messages")).rejects.toThrow(
      /Refusing to send a Graph API bearer token/,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });
});
