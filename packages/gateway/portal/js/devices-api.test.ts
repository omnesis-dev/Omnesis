// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import * as deviceApi from "./api.js";

const {
  buildPairQrPayload,
  checkSession,
  getFleetDoctor,
  getHostFleetUpdate,
  getPairAddresses,
  pairDevice,
  setDeviceAccessLevel,
  requestFleetDoctor,
  startHostFleetUpdate,
} = deviceApi;

afterEach(() => vi.unstubAllGlobals());

describe("device API wrappers", () => {
  test("pairing sends only the kind and leaves the grant to the gateway", async () => {
    const response = { pairingCode: "FICTION-2486", expiresAt: 1 };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(pairDevice({ kind: "ios" })).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/admin/devices/pair",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ kind: "ios" });
  });

  test("repair pairing binds the code to the existing device", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ pairingCode: "ABCDEF0123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await pairDevice({ kind: "android", repairDeviceId: "device_existing" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      kind: "android",
      repairDeviceId: "device_existing",
    });
  });

  test("QR requests opt into automatic stable trust selection", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ qrPayload: "{}" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await buildPairQrPayload({
      pairingCode: "ABCDEF0123",
      gatewayUrl: "https://gateway.example.com",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      pairingCode: "ABCDEF0123",
      gatewayUrl: "https://gateway.example.com",
      trustMode: "auto",
    });
  });

  test("asks for pairing addresses with the code in the body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ platform: "ios", addresses: [], recommendedUrl: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getPairAddresses({ pairingCode: "ABCDEF0123" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/admin/devices/pair-addresses");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      pairingCode: "ABCDEF0123",
    });
  });

  test("reads the fleet doctor state without starting a run", async () => {
    const response = { devices: [] };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getFleetDoctor()).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/admin/fleet/doctor",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("requests all devices when ids are omitted and preserves an explicit empty subset", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ devices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await requestFleetDoctor();
    await requestFleetDoctor([]);
    await requestFleetDoctor(["device_collector"]);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({});
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ deviceIds: [] });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      deviceIds: ["device_collector"],
    });
  });

  test("reads the host plan without caching and starts only its opaque id with portal CSRF", async () => {
    const csrfToken = "d".repeat(64);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, scopes: ["admin"], csrfToken }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ plan: null, operation: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ operation: { id: "operation-fictional" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await checkSession();
    await getHostFleetUpdate();
    await startHostFleetUpdate("plan-fictional");

    expect(fetchMock.mock.calls[1]).toEqual([
      "/admin/fleet/host-update",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    ]);
    expect(
      ((fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>)[
        "X-Omnesis-CSRF"
      ],
    ).toBe(csrfToken);
    const start = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(JSON.parse(String(start.body))).toEqual({ planId: "plan-fictional" });
    expect((start.headers as Record<string, string>)["X-Omnesis-CSRF"]).toBe(csrfToken);
  });
  test("setDeviceAccessLevel PUTs the level with its revision and the portal CSRF token", async () => {
    const csrfToken = "e".repeat(64);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, scopes: ["admin"], csrfToken }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ deviceId: "d1", level: null }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await checkSession();
    await setDeviceAccessLevel("d1", "level-1", 3);
    await setDeviceAccessLevel("d1", null);

    const put = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(put[0]).toBe("/admin/access/devices/d1/level");
    expect(put[1].method).toBe("PUT");
    expect(JSON.parse(String(put[1].body))).toEqual({ levelId: "level-1", expectedLevelRevision: 3 });
    expect((put[1].headers as Record<string, string>)["X-Omnesis-CSRF"]).toBe(csrfToken);
    expect(JSON.parse(String((fetchMock.mock.calls[2] as [string, RequestInit])[1].body))).toEqual({
      levelId: null,
    });
  });
  test("pairDevice sends an integration's name and access level", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ pairingCode: "ABCDEF1234", scopes: ["answer"], expiresAt: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await pairDevice({ kind: "integration", name: "Studio voice", accessLevelId: "level-voice" });
    await pairDevice({ kind: "cli" });
    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String((call as unknown as [string, RequestInit])[1].body)),
    );
    expect(bodies).toEqual([
      { kind: "integration", name: "Studio voice", accessLevelId: "level-voice" },
      { kind: "cli" },
    ]);
  });
});
