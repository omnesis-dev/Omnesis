// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SCOPE_ADMIN } from "@omnesis/types";
import { AddressChecks } from "../../remote-access/address-check.js";
import { McpAddresses } from "../../remote-access/mcp-addresses.js";
import { RemoteAccessSettingsStore } from "../../remote-access/settings.js";
import { errorResponse, HttpError } from "../errors.js";
import { strictRoute } from "../scope.js";
import { mountStepUp } from "../step-up.js";
import { mountRemoteAccessRoutes } from "./remote-access.js";
import type { HostTailscaleService } from "../../remote-access/host-tailscale.js";
import type { DeviceId, TokenId } from "@omnesis/types";
import type { GatewayEnrollment } from "@omnesis/cloud-relay";
import type { AppEnv } from "./types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "remote-access-routes-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function app({ stepUp = false, configured = null as string | null, hostRunning = false } = {}) {
  const host = {
    status: vi.fn(async () =>
      hostRunning
        ? {
            state: "available",
            dnsName: "studio.example-net.ts.net",
            url: "https://studio.example-net.ts.net",
            servesGateway: true,
            publicGateway: false,
          }
        : { state: "unavailable", reason: "Tailscale is not running on this computer." },
    ),
    publish: vi.fn(async () => ({ ok: true, url: "https://studio.example-net.ts.net" })),
  } as unknown as HostTailscaleService;
  const checks = new AddressChecks({
    resolve: async () => "203.0.113.7",
    certificateProblem: async () => null,
    fetch: async () => ({ status: 404, text: async () => "" }),
    now: () => Date.now(),
  });
  const router = strictRoute(new Hono<AppEnv>());
  router.onError((e, c) => {
    if (e instanceof HttpError) return errorResponse(c, e);
    if (e instanceof HTTPException) return e.getResponse();
    throw e;
  });
  router.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      deviceId: "dev_fictional" as DeviceId,
      tokenId: "tok_fictional" as TokenId,
      scopes: [SCOPE_ADMIN],
    });
    await next();
  });
  if (stepUp) {
    mountStepUp(router, {
      enrollment: () =>
        ({
          stepUpRequired: () => true,
          gatewayPasskey: () => ({ rpId: "relay.example.test", origin: "https://g.example.test" }),
        }) as unknown as GatewayEnrollment,
      enrollmentMethod: () => undefined,
    });
  }
  const settings = new RemoteAccessSettingsStore(dir);
  let publicAccess = false;
  const tailscale = {
    tailnetOrigin: () => "https://omnesis-gw.example-net.ts.net",
    settings: { get: () => ({ publicAccess }) },
    updateSettings: vi.fn(async (patch: { publicAccess?: boolean }) => {
      publicAccess = patch.publicAccess ?? publicAccess;
      return {} as never;
    }),
  };
  mountRemoteAccessRoutes(router, {
    settings,
    checks,
    mcpAddresses: new McpAddresses({
      settings,
      publicBaseUrl: () => "https://omnesis.example.org",
      relayOrigin: () => "https://gw-fictional.relay.example.net",
      relayState: async () => ({
        origin: "https://gw-fictional.relay.example.net",
        serving: true,
      }),
      tailscale: tailscale as unknown as ConstructorParameters<typeof McpAddresses>[0]["tailscale"],
      hostTailscale: host,
    }),
    hostTailscale: host,
    servingPublicBaseUrl: () => null,
    configuredPublicBaseUrl: () => configured,
  });
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    router.request(path, {
      method,
      headers: {
        ...headers,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { send, host, checks, settings, tailscale };
}

describe("remote access routes", () => {
  test("with neither way in of its own, no route exists", async () => {
    const { send } = app();
    for (const [method, path] of [
      ["GET", "/admin/remote-access"],
      ["PATCH", "/admin/remote-access"],
      ["POST", "/admin/remote-access/check-address"],
      ["GET", "/admin/remote-access/host-tailscale"],
      ["POST", "/admin/remote-access/host-tailscale/publish"],
      ["GET", "/.well-known/omnesis-address-check/abcdefghijklmnopqrstuv"],
    ] as const) {
      expect((await send(method, path, method === "GET" ? undefined : {})).status, path).toBe(404);
    }
  });

  test("with the relay only, the setup's state exists and Tailscale on the host does not", async () => {
    vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
    const { send } = app({ configured: "https://omnesis.example.org" });
    const state = await (await send("GET", "/admin/remote-access")).json();
    expect(state).toEqual({
      setupCompletedAt: null,
      first: "tailscale",
      features: { cloudRelay: true, tailscaleEmbed: false },
      publicBaseUrl: {
        serving: null,
        configured: "https://omnesis.example.org",
        restartNeeded: true,
      },
      mcpAddresses: [
        {
          id: "relay",
          url: "https://gw-fictional.relay.example.net",
          enabled: true,
          available: true,
        },
        { id: "host", url: null, enabled: true, available: false },
        { id: "domain", url: "https://omnesis.example.org", enabled: true, available: true },
      ],
    });
    expect((await send("GET", "/admin/remote-access/host-tailscale")).status).toBe(404);
    expect(
      (await send("POST", "/admin/remote-access/host-tailscale/publish", { public: false })).status,
    ).toBe(404);
  });

  test("the setup records its order and when it was finished, and refuses an empty or unknown change", async () => {
    vi.stubEnv("OMNESIS_TAILSCALE_EMBED_ENABLED", "1");
    const { send } = app();
    const changed = await (
      await send("PATCH", "/admin/remote-access", { first: "relay", setupCompleted: true })
    ).json();
    expect(changed).toMatchObject({
      first: "relay",
      features: { cloudRelay: false, tailscaleEmbed: true },
    });
    expect(Date.parse(changed.setupCompletedAt)).not.toBeNaN();
    const reopened = await (
      await send("PATCH", "/admin/remote-access", { setupCompleted: false })
    ).json();
    expect(reopened.setupCompletedAt).toBeNull();
    expect((await send("PATCH", "/admin/remote-access", {})).status).toBe(400);
    expect((await send("PATCH", "/admin/remote-access", { first: "carrier" })).status).toBe(400);
    expect((await send("PATCH", "/admin/remote-access", { mystery: true })).status).toBe(400);
  });

  test("checks only an https address, and answers only the nonce it issued", async () => {
    vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
    const { send } = app();
    expect(
      (
        await send("POST", "/admin/remote-access/check-address", {
          url: "http://omnesis.example.org",
        })
      ).status,
    ).toBe(400);
    expect(
      (await send("POST", "/admin/remote-access/check-address", { url: "not an address" })).status,
    ).toBe(400);
    const result = await (
      await send("POST", "/admin/remote-access/check-address", {
        url: "https://omnesis.example.org",
      })
    ).json();
    expect(result).toMatchObject({ url: "https://omnesis.example.org", ok: false });
    expect(result.steps.map((s: { id: string }) => s.id)).toEqual([
      "resolves",
      "certificate",
      "answers",
    ]);
    expect(
      (await send("GET", "/.well-known/omnesis-address-check/abcdefghijklmnopqrstuv")).status,
    ).toBe(404);
    expect((await send("GET", "/.well-known/omnesis-address-check/bad")).status).toBe(404);
  });

  test("the nonce route answers a nonce issued during a check, once", async () => {
    vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
    const { send, checks } = app();
    let seen = "";
    // A check whose address forwards back to this very router.
    (checks as unknown as { deps: { fetch: (url: string) => Promise<unknown> } }).deps.fetch =
      async (url: string) => {
        const res = await send("GET", new URL(url).pathname);
        seen = await res.clone().text();
        return { status: res.status, text: () => res.text() };
      };
    const result = await (
      await send("POST", "/admin/remote-access/check-address", {
        url: "https://omnesis.example.org",
      })
    ).json();
    expect(result.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(16);
    expect((await send("GET", `/.well-known/omnesis-address-check/${seen}`)).status).toBe(404);
  });

  test("Tailscale on the host is read freely, and publishing it asks for a step-up where required", async () => {
    vi.stubEnv("OMNESIS_TAILSCALE_EMBED_ENABLED", "1");
    vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
    const { send, host } = app({ stepUp: true });
    expect((await send("GET", "/admin/remote-access/host-tailscale")).status).toBe(200);
    const refused = await send(
      "POST",
      "/admin/remote-access/host-tailscale/publish",
      { public: true },
      { "x-omnesis-cloud-relay": "1" },
    );
    expect(refused.status).toBe(428);
    expect(host.publish).not.toHaveBeenCalled();
    const { send: plain, host: plainHost } = app();
    expect(
      await (
        await plain("POST", "/admin/remote-access/host-tailscale/publish", { public: false })
      ).json(),
    ).toEqual({
      ok: true,
      url: "https://studio.example-net.ts.net",
    });
    expect(plainHost.publish).toHaveBeenCalledWith(false);
    expect(
      (await plain("POST", "/admin/remote-access/host-tailscale/publish", { public: "yes" }))
        .status,
    ).toBe(400);
  });

  test("lists every address with its switch, on until the owner turns it off", async () => {
    vi.stubEnv("OMNESIS_TAILSCALE_EMBED_ENABLED", "1");
    vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
    const { send, settings, tailscale } = app({ hostRunning: true });
    const rows = (body: { mcpAddresses: Array<{ id: string; enabled: boolean }> }) =>
      Object.fromEntries(body.mcpAddresses.map((row) => [row.id, row.enabled]));
    const before = await (await send("GET", "/admin/remote-access")).json();
    expect(before.mcpAddresses).toEqual([
      {
        id: "relay",
        url: "https://gw-fictional.relay.example.net",
        enabled: true,
        available: true,
      },
      {
        id: "tailnet",
        url: "https://omnesis-gw.example-net.ts.net",
        enabled: true,
        available: true,
      },
      {
        id: "tailscalePublic",
        url: "https://omnesis-gw.example-net.ts.net",
        enabled: false,
        available: true,
      },
      { id: "host", url: "https://studio.example-net.ts.net", enabled: true, available: true },
      { id: "domain", url: "https://omnesis.example.org", enabled: true, available: true },
    ]);
    expect(before).not.toHaveProperty("mcp");
    const off = await send("PATCH", "/admin/remote-access", {
      mcp: { relay: false, domain: false, host: false },
    });
    expect(off.status).toBe(200);
    const state = await off.json();
    expect(rows(state)).toEqual({
      relay: false,
      tailnet: true,
      tailscalePublic: false,
      host: false,
      domain: false,
    });
    // The guided setup's own choices are untouched.
    expect(state).toMatchObject({ first: "tailscale", setupCompletedAt: null });
    expect(settings.get().mcp).toEqual({ relay: false, domain: false, host: false });
    // The public Tailscale address goes through the Tailscale device's own setting.
    const pub = await send("PATCH", "/admin/remote-access", { mcp: { tailscalePublic: true } });
    expect(rows(await pub.json()).tailscalePublic).toBe(true);
    expect(tailscale.updateSettings).toHaveBeenCalledWith({ publicAccess: true });
    expect(settings.get().mcp).toEqual({ relay: false, domain: false, host: false });
  });

  test("refuses an empty, unknown or malformed switch, and one for an address this gateway lacks", async () => {
    vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
    const { send, settings } = app();
    for (const mcp of [
      {},
      { carrier: false },
      { funnel: false },
      { domain: "off" },
      { tailnet: false },
      { tailscalePublic: true },
    ]) {
      expect(
        (await send("PATCH", "/admin/remote-access", { mcp })).status,
        JSON.stringify(mcp),
      ).toBe(400);
    }
    expect(settings.get().mcp).toBeUndefined();
  });

  test("turning an address on asks for a step-up where required; turning one off never does", async () => {
    vi.stubEnv("OMNESIS_TAILSCALE_EMBED_ENABLED", "1");
    vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
    const { send, settings, tailscale } = app({ stepUp: true });
    const viaRelay = { "x-omnesis-cloud-relay": "1" };
    const patch = (mcp: object) => send("PATCH", "/admin/remote-access", { mcp }, viaRelay);
    expect((await patch({ domain: false, relay: false, host: false })).status).toBe(200);
    // Already on: nothing loosens.
    expect((await patch({ tailnet: true })).status).toBe(200);
    expect((await patch({ domain: true })).status).toBe(428);
    expect((await patch({ host: true })).status).toBe(428);
    expect((await patch({ relay: true, tailnet: false })).status).toBe(428);
    expect((await patch({ tailscalePublic: true })).status).toBe(428);
    expect(tailscale.updateSettings).not.toHaveBeenCalled();
    expect(settings.get().mcp).toEqual({ domain: false, relay: false, host: false });
    // Turning the public Tailscale address off is stricter, so it never asks.
    expect((await patch({ tailscalePublic: false })).status).toBe(200);
    // The guided setup's other choices still never ask.
    expect((await send("PATCH", "/admin/remote-access", { first: "relay" }, viaRelay)).status).toBe(
      200,
    );
  });
});
