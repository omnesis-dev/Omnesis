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
  let maximum = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ compat: { sourceScopes: { min: 1, max: maximum } } })),
  );
  const client = new HttpGatewayClient("https://gateway.example.org", "fictional-token");
  expect(await client.supportsSourceScopes()).toBe(true);
  expect(await client.supportsSourceScopes(2)).toBe(false);
  maximum = 2;
  expect(await client.supportsSourceScopes(2)).toBe(true);
});
it("accepts only bounded known refresh epoch fields from gateway state", () => {
  expect(
    parseScopeRefreshEpochs({ label: "cut", folder: 42, participant: "", future: "ignored" }),
  ).toEqual({ label: "cut" });
  expect(parseScopeRefreshEpochs("not-an-object")).toEqual({});
});
