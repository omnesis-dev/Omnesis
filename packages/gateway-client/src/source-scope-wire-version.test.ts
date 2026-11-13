// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it, vi, afterEach } from "vitest";
import { SourceId, ProviderId } from "@omnesis/types";
import { sourceScopeWireVersion, parseScopeRefreshEpochs } from "./source-scope-wire-version.js";
import { HttpGatewayClient } from "./http-gateway-client.js";

afterEach(() => vi.unstubAllGlobals());
it("distinguishes legacy facts from hierarchy and explicit refresh witnesses", () => {
  expect(sourceScopeWireVersion(undefined, undefined)).toBe(0);
  expect(
    sourceScopeWireVersion(
      {
        refreshes: [
          { kind: "label", active: true, requestId: "11111111-1111-4111-8111-111111111111" },
        ],
      },
      undefined,
    ),
  ).toBe(2);
  expect(
    sourceScopeWireVersion({ readiness: [{ kind: "label", complete: true }] }, undefined),
  ).toBe(1);
  expect(sourceScopeWireVersion({ hierarchy: { kind: "folder", nodes: [] } }, undefined)).toBe(2);
  expect(
    sourceScopeWireVersion(
      { refreshes: [{ kind: "label", active: false, epoch: "cut" }] },
      undefined,
    ),
  ).toBe(2);
  expect(
    sourceScopeWireVersion(
      {
        documents: [
          {
            externalId: "one",
            kinds: ["label"],
            facts: { facts: [], complete: [], refreshEpochs: { label: "cut" } },
          },
        ],
      },
      undefined,
    ),
  ).toBe(2);
  expect(
    sourceScopeWireVersion(
      {
        conversations: [
          {
            id: "one",
            participants: [],
            mode: "snapshot",
            observedAt: "2026-01-01T00:00:00.000Z",
            revision: { epoch: "native", sequence: 1 },
            refreshEpoch: "cut",
          },
        ],
      },
      undefined,
    ),
  ).toBe(2);
});
it("does not send hierarchy fields after rollback to a version1 scope gateway", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ compat: { sourceScopes: { min: 1, max: 1 } } }),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    new HttpGatewayClient("https://gateway.example.org", "fictional-token").upsertWithCursor({
      sourceId: SourceId("fictional:one"),
      providerId: ProviderId("fictional"),
      hasMore: false,
      cursor: {},
      scopeUpdates: { hierarchy: { kind: "folder", nodes: [] } },
    }),
  ).rejects.toMatchObject({ kind: "transient" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("negotiates version2 independently while preserving version1 sources", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    let maximum = 1;
    const fetcher = vi.fn(async () =>
      Response.json({ compat: { sourceScopes: { min: 1, max: maximum } } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = new HttpGatewayClient("https://gateway.example.org", "fictional-token");
    expect(await client.supportsSourceScopes()).toBe(true);
    expect(await client.supportsSourceScopes(2)).toBe(false);
    // Both questions of one page are answered by a single probe.
    expect(fetcher).toHaveBeenCalledTimes(1);
    maximum = 2;
    expect(await client.supportsSourceScopes(2)).toBe(false);
    // The answer expires, so an upgraded or rolled-back gateway is noticed.
    vi.advanceTimersByTime(30_000);
    expect(await client.supportsSourceScopes(2)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
it.each([
  ["the request fails", () => Promise.reject(new TypeError("fetch failed"))],
  [
    "the gateway answers with an error",
    () => Promise.resolve(new Response("down", { status: 503 })),
  ],
  ["the answer is not JSON", () => Promise.resolve(new Response("<html>", { status: 200 }))],
  [
    "the gateway advertises no source filters",
    () => Promise.resolve(Response.json({ status: "ok", compat: {} })),
  ],
])(
  "answers that source filters are unsupported, without throwing, when %s",
  async (_name, respond) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let healthy = false;
      const fetcher = vi.fn(() =>
        healthy
          ? Promise.resolve(Response.json({ compat: { sourceScopes: { min: 1, max: 2 } } }))
          : respond(),
      );
      vi.stubGlobal("fetch", fetcher);
      const client = new HttpGatewayClient("https://gateway.example.org", "fictional-token");
      expect(await client.supportsSourceScopes()).toBe(false);
      expect(await client.supportsSourceScopes(2)).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(1);
      // The probe carries a short deadline of its own.
      expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeInstanceOf(
        AbortSignal,
      );
      // A recovered gateway is asked again and believed.
      healthy = true;
      vi.advanceTimersByTime(10 * 60_000);
      expect(await client.supportsSourceScopes(2)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  },
);
it("does not probe a gateway without source filters again until the collector reconnects", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    let advertised = false;
    const fetcher = vi.fn(async (path: string) =>
      path.endsWith("/health")
        ? Response.json({ compat: advertised ? { sourceScopes: { min: 1, max: 2 } } : {} })
        : Response.json({ ok: true, count: 0 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = new HttpGatewayClient("https://gateway.example.org", "fictional-token");
    const probes = () => fetcher.mock.calls.filter(([path]) => path.endsWith("/health")).length;
    // Page after page over several minutes: one probe.
    for (let page = 0; page < 20; page++) {
      expect(await client.supportsSourceScopes()).toBe(false);
      vi.advanceTimersByTime(20_000);
    }
    expect(probes()).toBe(1);
    // The gateway restarts with filters in use; the collector reconnects and
    // republishes its declarations, and the next page carries facts.
    advertised = true;
    await client.setSourceScopes([]);
    expect(await client.supportsSourceScopes()).toBe(true);
    expect(probes()).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
it("accepts only bounded known refresh epoch fields from gateway state", () => {
  expect(
    parseScopeRefreshEpochs({ label: "cut", folder: 42, participant: "", future: "ignored" }),
  ).toEqual({ label: "cut" });
  expect(parseScopeRefreshEpochs("not-an-object")).toEqual({});
});
