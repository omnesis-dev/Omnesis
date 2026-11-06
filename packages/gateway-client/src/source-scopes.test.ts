// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { HttpGatewayClient } from "./http-gateway-client.js";

const url = "https://gateway.example.com";
const entries = [
  {
    sourceType: "fictional-mail",
    scopes: {
      items: [
        { kind: "participant" as const, identifiers: ["email" as const], link: "changes" as const },
      ],
    },
  },
];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("source scope compatibility", () => {
  it.each([
    undefined,
    null,
    {},
    { min: 2, max: 2 },
    { min: 0, max: 1 },
    { min: "1", max: 1 },
    { min: 1, max: 0 },
  ])("does not publish to an unsupported gateway range %j", async (range) => {
    const fetcher = vi.fn(async () => Response.json({ compat: { sourceScopes: range } }));
    vi.stubGlobal("fetch", fetcher);
    await new HttpGatewayClient(url, "fictional-token").setSourceScopes(entries);
    expect(fetcher.mock.calls).toHaveLength(1);
  });
  it("rechecks after gateway upgrade and rollback without sending credentials to public health", async () => {
    let range: unknown = undefined;
    const writes: unknown[] = [];
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/health")) {
        expect(options?.headers).toBeUndefined();
        expect(options?.cache).toBe("no-store");
        return Response.json({ compat: { sourceScopes: range } });
      }
      writes.push(JSON.parse(options!.body as string));
      return Response.json({ ok: true, count: 1 });
    });
    vi.stubGlobal("fetch", fetcher);
    const client = new HttpGatewayClient(url, "fictional-token");
    await client.setSourceScopes(entries);
    range = { current: 2, min: 1, max: 2 };
    await client.setSourceScopes(entries);
    range = undefined;
    await client.setSourceScopes(entries);
    expect(writes).toEqual([{ entries }]);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      `${url}/health`,
      `${url}/health`,
      `${url}/admin/source-scopes`,
      `${url}/health`,
    ]);
  });
  it("does not publish after health failure", async () => {
    const fetcher = vi.fn(async () => new Response("Unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await new HttpGatewayClient(url, "fictional-token").setSourceScopes(entries);
    expect(fetcher.mock.calls).toHaveLength(1);
  });
});

describe("scope-bearing cursor write negotiation", () => {
  const page = {
    providerId: ProviderId("fictional:one"),
    sourceId: SourceId("fictional-mail:one"),
    hasMore: false,
    cursor: { labelVersion: 1 },
    scopeUpdates: { readiness: [{ kind: "label" as const, complete: true }] },
  };
  it("refuses a page prepared before a gateway rollback without sending its new fields", async () => {
    const fetcher = vi.fn(async () => Response.json({ compat: {} }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new HttpGatewayClient(url, "fictional-token").upsertWithCursor(page),
    ).rejects.toMatchObject({ kind: "transient" });
    expect(fetcher.mock.calls).toHaveLength(1);
  });
  it("rechecks support before retrying a scope-bearing page", async () => {
    vi.useFakeTimers();
    let supported = true;
    let writes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path.endsWith("/health"))
          return Response.json({ compat: supported ? { sourceScopes: { min: 1, max: 1 } } : {} });
        writes++;
        supported = false;
        return new Response("retry", { status: 503 });
      }),
    );
    const rejection = expect(
      new HttpGatewayClient(url, "fictional-token").upsertWithCursor(page),
    ).rejects.toMatchObject({ kind: "transient" });
    await vi.runAllTimersAsync();
    await rejection;
    expect(writes).toBe(1);
  });
  it("leaves legacy cursor writes free of new fields and scope probes", async () => {
    const fetcher = vi.fn(async (_path: string, _options?: RequestInit) =>
      Response.json({ ingested: 0 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { scopeUpdates: _updates, ...legacy } = page;
    await new HttpGatewayClient(url, "fictional-token").upsertWithCursor(legacy);
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${url}/documents/with-cursor`);
  });
});
