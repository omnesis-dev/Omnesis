// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { DeviceId, TokenId, Scope } from "@omnesis/types";
import { browserFindSuggestions } from "../../search/find/direct-results.js";
import { browserFindSuggestBody } from "../schemas/browser-find.js";
import { BrowserFindService } from "./BrowserFindService.js";
import type { DeviceService } from "./DeviceService.js";
import type { AuthContext } from "../routes/types.js";
import type { FindSearchResult } from "../../search/find/types.js";
import type { SearchResponse } from "../../search/types.js";

beforeEach(() => vi.stubEnv("OMNESIS_EXPERIMENTAL", "1"));
afterEach(() => vi.unstubAllEnvs());
function result(id: string, url: string): FindSearchResult {
  return {
    id,
    documentId: id,
    title: "Fictional guide",
    sourceUrl: url,
    sourceId: "example:account",
    chunkText: "An invented guide",
  };
}
function fixture() {
  const auth: AuthContext = {
    authMethod: "bearer",
    deviceId: DeviceId(randomUUID()),
    tokenId: TokenId(randomUUID()),
    scopes: [Scope("read")],
  };
  const tokenIsActive = vi.fn(() => true);
  const search = vi.fn(
    async () =>
      ({
        results: [
          result("guide", "https://example.org/guide"),
          result("duplicate", "https://example.org/guide/"),
          result("private", "https://secret@example.org/private"),
          result("native", "exampleapp://note"),
          result("second", "https://example.org/second"),
        ],
      }) as unknown as SearchResponse,
  );
  const service = new BrowserFindService({
    devices: {
      getById: () => ({ kind: "browser", revokedAt: null }),
      tokenIsActive,
    } as unknown as DeviceService,
    writeGate: { createToken: vi.fn(), revokeToken: vi.fn() },
    scope: "read",
    feature: "browser-find",
    label: "browser-search",
    sourceLabels: () => ({}),
    sourceIcons: () => ({}),
    searchPipeline: { search },
  });
  return { service, auth, search, tokenIsActive };
}

test("suggestions call the index pipeline directly and filter unsafe or duplicate destinations", async () => {
  const f = fixture();
  const response = await f.service.suggest(
    f.auth,
    { text: "guid", limit: 5 },
    new AbortController().signal,
  );
  expect(response.results.map((hit) => hit.id)).toEqual(["guide", "second"]);
  expect(f.search).toHaveBeenCalledExactlyOnceWith({ text: "guid", limit: 50 }, undefined, {
    prefixLastToken: true,
  });
});

test("suggestion authorization is checked before work and again after an awaited index read", async () => {
  const f = fixture();
  await expect(
    f.service.suggest(
      { ...f.auth, scopes: [Scope("write:web")] },
      { text: "guide", limit: 5 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(f.search).not.toHaveBeenCalled();
  f.search.mockImplementationOnce(async () => {
    f.tokenIsActive.mockReturnValue(false);
    return { results: [] } as unknown as SearchResponse;
  });
  await expect(
    f.service.suggest(f.auth, { text: "guide", limit: 5 }, new AbortController().signal),
  ).rejects.toMatchObject({ status: 403 });
});

test("strict experimental-off blocks suggestions despite an existing read credential or synthetic mode", async () => {
  const f = fixture();
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  vi.stubEnv("OMNESIS_SYNTHETIC", "1");
  await expect(
    f.service.suggest(f.auth, { text: "guide", limit: 5 }, new AbortController().signal),
  ).rejects.toMatchObject({ status: 404 });
  expect(f.search).not.toHaveBeenCalled();
});

test("aborted previews return no stale data", async () => {
  const f = fixture();
  const abort = new AbortController();
  f.search.mockImplementationOnce(async () => {
    abort.abort();
    return { results: [] } as unknown as SearchResponse;
  });
  await expect(
    f.service.suggest(f.auth, { text: "guide", limit: 5 }, abort.signal),
  ).rejects.toThrow();
});

test("suggestions respect source-declared browser identity while preserving unknown account routes", () => {
  const results = browserFindSuggestions(
    [
      result("first", "https://notes.example.org/Planning-123456781234123412341234567890ab"),
      result("same", "https://notes.example.org/12345678-1234-1234-1234-1234567890ab"),
      result("account-one", "https://example.org/?account=one#route"),
      result("account-two", "https://example.org/?account=two#route"),
    ],
    3,
    [
      {
        hosts: ["notes.example.org"],
        rules: [],
        browserIdentity: { part: "path", format: "uuid-suffix" },
      },
    ],
  );
  expect(results.map((hit) => hit.id)).toEqual(["first", "account-one", "account-two"]);
});

test("preview boundary caps versions, query size and the suggestion count", () => {
  expect(browserFindSuggestBody.parse({ version: 1, text: " guide " })).toEqual({
    version: 1,
    text: "guide",
    limit: 5,
  });
  for (const body of [
    { version: 2, text: "guide" },
    { version: 1, text: " " },
    { version: 1, text: "x".repeat(1025) },
    { version: 1, text: "guide", limit: 9 },
  ])
    expect(browserFindSuggestBody.safeParse(body).success).toBe(false);
});
