// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { SOURCE_CONTRACT_WIRE_RANGE } from "@omnesis/core";
import { ProviderId, SourceId } from "@omnesis/types";
import { HttpGatewayClient } from "./http-gateway-client.js";
import { requireGatewaySourceContract } from "./source-contract.js";

const url = "https://gateway.example.com";
const sourceId = SourceId("fictional:account");
const supported = { status: "ok", capabilities: { sourceContract: SOURCE_CONTRACT_WIRE_RANGE } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("collector request compatibility", () => {
  test("legacy gateway sees no document/cursor request", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status: "ok" }));
    vi.stubGlobal("fetch", fetcher);
    const client = new HttpGatewayClient(url, "fictional-token", {
      beforeRequest: () => requireGatewaySourceContract(url),
    });
    await expect(
      client.upsertWithCursor({
        providerId: ProviderId("fictional"),
        sourceId,
        hasMore: false,
        cursor: { bookmark: 7 },
        presentClaims: [],
      }),
    ).rejects.toThrow("Gateway upgrade required");
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([`${url}/health`]);
  });

  test("rechecks a running collector's next cursor request after gateway replacement", async () => {
    let health: unknown = supported;
    const cursors: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options?: RequestInit) => {
        if (path.endsWith("/health")) return Response.json(health);
        cursors.push(JSON.parse(options!.body as string));
        return Response.json({ ok: true });
      }),
    );
    const client = new HttpGatewayClient(url, "fictional-token", {
      beforeRequest: () => requireGatewaySourceContract(url),
    });
    await client.setSyncState(sourceId, { bookmark: 1 });
    health = { status: "ok" };
    await expect(client.setSyncState(sourceId, { bookmark: 2 })).rejects.toThrow(
      "Gateway upgrade required",
    );
    expect(cursors).toEqual([{ cursor: { bookmark: 1 } }]);
    health = supported;
    await client.setSyncState(sourceId, { bookmark: 2 });
    expect(cursors).toEqual([{ cursor: { bookmark: 1 } }, { cursor: { bookmark: 2 } }]);
  });

  test.each([503, 500, "network"] as const)(
    "rechecks before retrying a %s cursor failure",
    async (failure) => {
      vi.useFakeTimers();
      let health: unknown = supported;
      let writes = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (path: string) => {
          if (path.endsWith("/health")) return Response.json(health);
          writes++;
          health = { status: "ok" };
          if (failure === "network") throw new Error("fetch failed");
          return new Response("retry", { status: failure, headers: { "Retry-After": "1" } });
        }),
      );
      const client = new HttpGatewayClient(url, "fictional-token", {
        beforeRequest: () => requireGatewaySourceContract(url),
      });
      const rejection = expect(client.setSyncState(sourceId, { bookmark: 9 })).rejects.toThrow(
        "Gateway upgrade required",
      );
      await vi.runAllTimersAsync();
      await rejection;
      expect(writes).toBe(1);
    },
  );

  test("failed health probe refuses the request and sends no credential to health", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(requireGatewaySourceContract(url)).rejects.toThrow("health returned HTTP 503");
    expect(fetcher).toHaveBeenCalledWith(`${url}/health`, {
      signal: expect.any(AbortSignal),
      cache: "no-store",
    });
  });
});
