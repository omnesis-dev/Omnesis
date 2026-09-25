// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { SourceId } from "@omnesis/types";
import { HttpGatewayClient } from "./http-gateway-client.js";

afterEach(() => vi.unstubAllGlobals());

test("pending page transport preserves the exact payload, source scope, and generation receipts", async () => {
  const page = {
    id: "11111111-1111-4111-8111-111111111111",
    result: {
      analytics: [{ tableName: "example_rows", records: [{ id: "original" }] }],
      cursor: { revision: 7 },
      hasMore: false,
    },
    meta: { label: "Example source" },
    documentTemporalProjections: [],
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(null))
    .mockResolvedValueOnce(Response.json({ ...page, cursorCommitted: false }))
    .mockResolvedValueOnce(Response.json({ ingested: 1 }))
    .mockResolvedValueOnce(Response.json({ ingested: 0, reconciledDeleted: 0 }))
    .mockResolvedValueOnce(Response.json({ acknowledged: true }));
  vi.stubGlobal("fetch", fetch);
  const client = new HttpGatewayClient("https://gateway.example", "fixture-token");
  const sourceId = SourceId("example:local");
  expect(await client.getPendingStructuredPage(sourceId)).toBeNull();
  expect(await client.prepareStructuredPage(sourceId, { ...page, writeEpoch: 4 })).toEqual({
    ...page,
    cursorCommitted: false,
  });
  await client.ingestAnalyticsPage({
    sourceId,
    tableName: "example_rows",
    records: [{ id: "original" }],
    pendingPageId: page.id,
    writeOrdinal: 0,
    writeEpoch: 4,
  });
  await client.upsertWithCursor({
    sourceId,
    providerId: "example:local" as Parameters<typeof client.upsertWithCursor>[0]["providerId"],
    cursor: page.result.cursor,
    hasMore: false,
    pendingPageId: page.id,
    wipeEpoch: 4,
  });
  expect(await client.acknowledgeStructuredPage(sourceId, { id: page.id, writeEpoch: 4 })).toEqual({
    acknowledged: true,
  });
  const calls = fetch.mock.calls;
  const path = `/sync-state/${encodeURIComponent(sourceId)}/pending-page`;
  expect(calls[0]?.[0]).toBe(`https://gateway.example${path}`);
  expect(JSON.parse(calls[1]?.[1].body)).toEqual({ ...page, writeEpoch: 4 });
  expect(JSON.parse(calls[2]?.[1].body)).toMatchObject({ pendingPageId: page.id, writeOrdinal: 0 });
  expect(JSON.parse(calls[3]?.[1].body)).toMatchObject({ pendingPageId: page.id });
  expect(calls[4]?.[1]).toMatchObject({
    method: "DELETE",
    body: JSON.stringify({ id: page.id, writeEpoch: 4 }),
  });
});
