// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { SyncError } from "@omnesis/types";
import {
  ImmichClient,
  isSupportedVersion,
  missingPermission,
  normalizeBaseUrl,
  parseNextPage,
} from "./client.js";

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }),
    );
  };
  return { fetchImpl, calls };
}

describe("normalizeBaseUrl", () => {
  it.each([
    ["http://immich.local:2283", "http://immich.local:2283"],
    ["http://Immich.Local:2283/", "http://immich.local:2283"],
    ["https://photos.example.org/api", "https://photos.example.org"],
    ["https://photos.example.org/immich/api/", "https://photos.example.org/immich"],
    ["  https://photos.example.org  ", "https://photos.example.org"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeBaseUrl(raw)).toBe(expected);
  });

  it.each([
    "",
    "immich.local",
    "ftp://immich.local",
    "https://user:secret@example.com",
    "https://immich.local/?a=1",
  ])("refuses %j", (raw) => {
    expect(normalizeBaseUrl(raw)).toBeNull();
  });
});

describe("ImmichClient", () => {
  it("sends the key, a user agent and a JSON body to the API path", async () => {
    const { fetchImpl, calls } = respond(200, { assets: { items: [], nextPage: null } });
    const client = new ImmichClient("http://immich.local:2283", "secret-key", { fetchImpl });
    const signal = new AbortController().signal;
    await client.searchAssets({ page: 1, size: 10, order: "asc" }, { signal });
    expect(calls[0]!.url).toBe("http://immich.local:2283/api/search/metadata");
    const headers = new Headers(calls[0]!.init!.headers);
    expect(headers.get("x-api-key")).toBe("secret-key");
    expect(headers.get("user-agent")).toMatch(/Omnesis/);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ page: 1, size: 10, order: "asc" });
    expect(calls[0]!.init!.signal).toBe(signal);
  });

  it("maps a refused key to a connection-wide auth error", async () => {
    const { fetchImpl } = respond(401, { message: "Invalid API key" });
    const err = await new ImmichClient("http://h", "k", { fetchImpl })
      .me()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect(err).toMatchObject({ kind: "auth", scope: "connection" });
    expect((err as Error).message).toContain("Invalid API key");
    expect((err as Error).message).not.toContain('k"');
  });

  it("maps a missing permission to a permission error that names it", async () => {
    const { fetchImpl } = respond(403, { message: "Missing required permission: album.read" });
    const err = (await new ImmichClient("http://h", "k", { fetchImpl })
      .listAlbums()
      .catch((e: unknown) => e)) as SyncError;
    expect(err.kind).toBe("permission");
    expect(err.remediation?.summary).toContain("album.read");
  });

  it("maps 5xx to transient, 429 to a rate limit and a failed fetch to network", async () => {
    await expect(
      new ImmichClient("http://h", "k", respond(503, "down")).version(),
    ).rejects.toMatchObject({ kind: "transient" });
    await expect(
      new ImmichClient("http://h", "k", respond(429, {}, { "retry-after": "7" })).version(),
    ).rejects.toMatchObject({ kind: "rate-limit", retryAfterMs: 7000, quota: { kind: "account" } });
    const failing: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
    await expect(
      new ImmichClient("http://h", "k", { fetchImpl: failing }).version(),
    ).rejects.toMatchObject({ kind: "network" });
  });

  it("rethrows an abort as it is rather than as a network failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborting: typeof fetch = () => Promise.reject(new DOMException("aborted", "AbortError"));
    const err = await new ImmichClient("http://h", "k", { fetchImpl: aborting })
      .version({ signal: controller.signal })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SyncError);
  });

  it("reads every asset id of an album across pages", async () => {
    const pages = [
      { assets: { items: [{ id: "a" }, { id: "b" }], nextPage: "2" } },
      { assets: { items: [{ id: "c" }], nextPage: null } },
    ];
    let i = 0;
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response(JSON.stringify(pages[i++])));
    expect(
      await new ImmichClient("http://h", "k", { fetchImpl }).albumAssetIds("album", 2),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("helpers", () => {
  it("parses Immich's string page numbers and refuses anything else", () => {
    expect(parseNextPage(null)).toBeNull();
    expect(parseNextPage("3")).toBe(3);
    expect(() => parseNextPage("next")).toThrow(SyncError);
    expect(() => parseNextPage(4)).toThrow(SyncError);
  });

  it("reads the permission out of Immich's message", () => {
    expect(missingPermission("Missing required permission: asset.read")).toBe("asset.read");
    expect(missingPermission("Forbidden")).toBeUndefined();
  });

  it("accepts v3 and later only", () => {
    expect(isSupportedVersion({ major: 3, minor: 0, patch: 0 })).toBe(true);
    expect(isSupportedVersion({ major: 2, minor: 5, patch: 6 })).toBe(false);
  });
});
