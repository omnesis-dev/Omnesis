// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The wipe epoch has to survive the wipe it guards against.
 *
 * A source's cursor is cleared when its data is wiped — a resync, or a
 * removal. `getSyncState` reports "no cursor" as null, which is the right
 * answer for cursors and the wrong one for the epoch: it threw the epoch away
 * in the exact situation the epoch exists for. The sync that follows a wipe
 * then bootstrapped with `wipeEpoch: undefined`, and the gateway's guard skips
 * an undefined epoch (it means "an older gateway that doesn't send one"), so
 * every page an already-in-flight sync wrote was accepted.
 *
 * The route sends `wipeEpoch` alongside a null cursor deliberately. Reading it
 * separately is what keeps the guard armed.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { SourceId } from "@omnesis/types";
import { HttpGatewayClient } from "./http-gateway-client.js";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const SOURCE = SourceId("gmail:maya.reeves@example.com");

describe("beginSyncAttempt", () => {
  test("claims a new write epoch for the source", async () => {
    mockFetch.mockResolvedValue(json({ wipeEpoch: 8 }));
    const client = new HttpGatewayClient("http://gw.example", "key");

    await expect(client.beginSyncAttempt(SOURCE)).resolves.toBe(8);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/sync-state/${encodeURIComponent(SOURCE)}/begin`),
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("binds begin and cancellation to one attempt id", async () => {
    mockFetch
      .mockResolvedValueOnce(json({ wipeEpoch: 8 }))
      .mockResolvedValueOnce(json({ revoked: true }));
    const client = new HttpGatewayClient("http://gw.example", "key");
    const attemptId = "b82d39cf-7bb4-4b5a-a59e-f65598bdc843";

    await expect(client.beginSyncAttempt(SOURCE, { attemptId })).resolves.toBe(8);
    await expect(client.revokeSyncAttempt(SOURCE, undefined, attemptId)).resolves.toBe(true);

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/begin"),
      expect.objectContaining({ body: JSON.stringify({ attemptId }) }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/revoke"),
      expect.objectContaining({ body: JSON.stringify({ attemptId }) }),
    );
  });

  test("falls back when an older gateway lacks the begin route", async () => {
    mockFetch.mockResolvedValue(new Response("missing", { status: 404 }));
    const client = new HttpGatewayClient("http://gw.example", "key");
    await expect(client.beginSyncAttempt(SOURCE)).resolves.toBeUndefined();
  });
});

describe("revokeSyncAttempt", () => {
  test("sends the exact timed-out epoch for compare-and-swap revocation", async () => {
    mockFetch.mockResolvedValue(json({ revoked: true }));
    const client = new HttpGatewayClient("http://gw.example", "key");

    await expect(client.revokeSyncAttempt(SOURCE, 7)).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/sync-state/${encodeURIComponent(SOURCE)}/revoke`),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ writeEpoch: 7 }) }),
    );
  });
});

describe("getWipeEpoch", () => {
  test("reports the epoch when the cursor has been wiped away", () => {
    // The post-wipe shape: no cursor, but an epoch that must still be echoed.
    mockFetch.mockResolvedValue(json({ cursor: null, wipeEpoch: 7 }));
    const client = new HttpGatewayClient("http://gw.example", "key");
    return expect(client.getWipeEpoch(SOURCE)).resolves.toBe(7);
  });

  test("reports the epoch when a cursor is present too", () => {
    mockFetch.mockResolvedValue(json({ cursor: { historyId: 5 }, wipeEpoch: 2 }));
    const client = new HttpGatewayClient("http://gw.example", "key");
    return expect(client.getWipeEpoch(SOURCE)).resolves.toBe(2);
  });

  test("is undefined against a gateway that does not send one", () => {
    // `undefined` must keep meaning "this gateway has no epoch to check",
    // never "freshly wiped" — the guard is skipped for it.
    mockFetch.mockResolvedValue(json({ cursor: null }));
    const client = new HttpGatewayClient("http://gw.example", "key");
    return expect(client.getWipeEpoch(SOURCE)).resolves.toBeUndefined();
  });

  test("ignores a non-numeric epoch rather than forwarding it", () => {
    mockFetch.mockResolvedValue(json({ cursor: null, wipeEpoch: "7" }));
    const client = new HttpGatewayClient("http://gw.example", "key");
    return expect(client.getWipeEpoch(SOURCE)).resolves.toBeUndefined();
  });
});

describe("getSyncState still reports no cursor as null", () => {
  test("so callers keep reading it as 'bootstrap from scratch'", async () => {
    mockFetch.mockResolvedValue(json({ cursor: null, wipeEpoch: 7 }));
    const client = new HttpGatewayClient("http://gw.example", "key");
    await expect(client.getSyncState(SOURCE)).resolves.toBeNull();
  });

  test("and carries the epoch when there IS a cursor", async () => {
    mockFetch.mockResolvedValue(
      json({ cursor: { historyId: 5 }, lastSyncedAt: "2026-03-10T00:00:00Z", wipeEpoch: 3 }),
    );
    const client = new HttpGatewayClient("http://gw.example", "key");
    await expect(client.getSyncState(SOURCE)).resolves.toMatchObject({ wipeEpoch: 3 });
  });
});
