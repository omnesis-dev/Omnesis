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
import { HostAccess } from "../../remote-access/host-access.js";
import { McpAddresses } from "../../remote-access/mcp-addresses.js";
import { fixedPublicAddress, type PublicAddressSource } from "../../public-address.js";
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

function app({
  stepUp = false,
  configured = null as string | null,
  hostRunning = false,
  device = false,
  relay = true,
  publicAddress = fixedPublicAddress(configured ?? undefined) as PublicAddressSource,
} = {}) {
  const host = {
    status: vi.fn(async () =>
      hostRunning
        ? {
            state: "available",
            dnsName: "studio.example-net.ts.net",
            version: "1.104.6",
            url: "https://studio.example-net.ts.net",
            servesGateway: true,
            publicGateway: false,
          }
        : {
            state: "stopped",
            reason: "Tailscale is installed on this computer but not running or not signed in.",
          },
    ),
    publish: vi.fn(async () => ({ ok: true, url: "https://studio.example-net.ts.net" })),
    unpublish: vi.fn(async () => ({ ok: true })),
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
    state: () => ({ public: { state: publicAccess ? "on" : "off" } }),
    updateSettings: vi.fn(async (patch: { publicAccess?: boolean }) => {
      publicAccess = patch.publicAccess ?? publicAccess;
      return {} as never;
    }),
  };
  const hostAccess = new HostAccess(host, settings);
  mountRemoteAccessRoutes(router, {
    settings,
    checks,
    mcpAddresses: new McpAddresses({
      settings,
      publicBaseUrl: () => publicAddress.baseUrl(),
      // A gateway that never connected to the relay has no relay address.
      relayOrigin: () => (relay ? "https://gw-fictional.relay.example.net" : undefined),
      relayState: async () => ({
        origin: relay ? "https://gw-fictional.relay.example.net" : undefined,
        serving: relay,
      }),
      ...(device
        ? {
            tailscale: tailscale as unknown as ConstructorParameters<
              typeof McpAddresses
            >[0]["tailscale"],
          }
        : {}),
      host: hostAccess,
    }),
    hostAccess,
    publicAddress,
    tailscaleEmbed: device,
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
  test("with neither way in of its own, every route still exists", async () => {
    const { send } = app({ relay: false });
    const state = await (await send("GET", "/admin/remote-access")).json();
    expect(state.features).toEqual({ tailscaleEmbed: false });
    expect(state.mcpAddresses.map((row: { id: string }) => row.id)).toEqual([
      "relay",
      "host",
      "domain",
    ]);
    // The relay is offered but not connected, so no agent is pointed at it.
    expect(state.mcpAddresses[0]).toMatchObject({ url: null, available: false });
    expect((await send("GET", "/admin/remote-access/host-tailscale")).status).toBe(200);
    expect(
      (await send("POST", "/admin/remote-access/check-address", { url: "http://x" })).status,
    ).toBe(400);
  });

  test("the public address is the one in use now, and says when the environment sets it", async () => {
    let address: string | undefined;
    let fromEnvironment = false;
    const { send } = app({
      publicAddress: {
        baseUrl: () => address,
        mcpResourceUrls: () => (address ? [`${address}/mcp`] : []),
        setByEnvironment: () => fromEnvironment,
      },
    });
    const read = async () =>
      (await (await send("GET", "/admin/remote-access")).json()).publicBaseUrl;
    expect(await read()).toEqual({ configured: null, setByEnvironment: false, way: null });
    // Saved while the gateway runs: the next read has it, with no restart.
    address = "https://omnesis.example.org";
    expect(await read()).toEqual({
      configured: "https://omnesis.example.org",
      setByEnvironment: false,
      way: null,
    });
    address = "https://env.example.org";
    fromEnvironment = true;
    expect(await read()).toEqual({
      configured: "https://env.example.org",
      setByEnvironment: true,
      way: null,
    });
  });

  test("with the relay only, the setup's state lists the relay beside this computer and the domain", async () => {
    const { send } = app({ configured: "https://omnesis.example.org" });
    const state = await (await send("GET", "/admin/remote-access")).json();
    expect(state).toEqual({
      setupCompletedAt: null,
      first: "tailscale",
      features: { tailscaleEmbed: false },
      publicBaseUrl: {
        configured: "https://omnesis.example.org",
        setByEnvironment: false,
        way: null,
      },
      mcpAddresses: [
        {
          id: "relay",
          url: "https://gw-fictional.relay.example.net",
          reach: "public",
          choices: ["off", "public"],
          available: true,
        },
        {
          id: "host",
          url: null,
          reach: "private",
          choices: ["off", "private", "public"],
          available: false,
        },
        {
          id: "domain",
          url: "https://omnesis.example.org",
          reach: "on",
          choices: ["off", "on"],
          available: true,
        },
      ],
    });
  });

  test("the setup records its order and when it was finished, and refuses an empty or unknown change", async () => {
    const { send } = app({ device: true });
    const changed = await (
      await send("PATCH", "/admin/remote-access", { first: "relay", setupCompleted: true })
    ).json();
    expect(changed).toMatchObject({
      first: "relay",
      features: { tailscaleEmbed: true },
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
    const { send, host } = app({ stepUp: true, device: true });
    expect((await send("GET", "/admin/remote-access/host-tailscale")).status).toBe(200);
    const refused = await send(
      "POST",
      "/admin/remote-access/host-tailscale/publish",
      { public: true },
      { "x-omnesis-cloud-relay": "1" },
    );
    expect(refused.status).toBe(428);
    expect(host.publish).not.toHaveBeenCalled();
    const { send: plain, host: plainHost, settings } = app();
    expect(
      await (
        await plain("POST", "/admin/remote-access/host-tailscale/publish", { public: false })
      ).json(),
    ).toEqual({
      ok: true,
      url: "https://studio.example-net.ts.net",
    });
    expect(plainHost.publish).toHaveBeenCalledWith(false);
    // The pages and device API stay off the Internet, as asked.
    expect(settings.get().hostApi).toBe("private");
    expect(
      (await plain("POST", "/admin/remote-access/host-tailscale/publish", { public: "yes" }))
        .status,
    ).toBe(400);
  });

  test("unpublishing Tailscale on the host only closes the gateway, so it never asks for a step-up", async () => {
    const { send, host } = app({ stepUp: true });
    const res = await send(
      "POST",
      "/admin/remote-access/host-tailscale/unpublish",
      {},
      { "x-omnesis-cloud-relay": "1" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(host.unpublish).toHaveBeenCalledTimes(1);
  });

  test("a saved public address that is this computer's Tailscale name is said to be the host's", async () => {
    const { send } = app({ configured: "https://studio.example-net.ts.net", hostRunning: true });
    const state = (await (await send("GET", "/admin/remote-access")).json()) as {
      publicBaseUrl: { way: string | null };
    };
    expect(state.publicBaseUrl.way).toBe("host");
  });

  test("lists every address with where MCP answers, as far as it reaches until the owner chooses", async () => {
    const { send, settings, tailscale } = app({
      configured: "https://omnesis.example.org",
      hostRunning: true,
      device: true,
    });
    const rows = (body: { mcpAddresses: Array<{ id: string; reach: string }> }) =>
      Object.fromEntries(body.mcpAddresses.map((row) => [row.id, row.reach]));
    const before = await (await send("GET", "/admin/remote-access")).json();
    expect(before.features).toEqual({ tailscaleEmbed: true });
    expect(rows(before)).toEqual({
      relay: "public",
      tailnet: "private",
      host: "private",
      domain: "on",
    });
    expect(before).not.toHaveProperty("mcp");
    const off = await send("PATCH", "/admin/remote-access", {
      mcp: { relay: "off", domain: "off", host: "off" },
    });
    expect(off.status).toBe(200);
    const state = await off.json();
    expect(rows(state)).toEqual({ relay: "off", tailnet: "private", host: "off", domain: "off" });
    // The guided setup's own choices are untouched.
    expect(state).toMatchObject({ first: "tailscale", setupCompletedAt: null });
    expect(state).not.toHaveProperty("mcpRefusal");
    expect(settings.get().mcp).toEqual({ relay: false, domain: false, host: false });
    // The device's public address goes through the Tailscale device's own setting.
    const pub = await send("PATCH", "/admin/remote-access", { mcp: { tailnet: "public" } });
    expect(rows(await pub.json()).tailnet).toBe("public");
    expect(tailscale.updateSettings).toHaveBeenCalledWith({ publicAccess: true });
    expect(settings.get().mcp).toEqual({ relay: false, domain: false, host: false });
  });

  test("MCP put on the Internet through this computer turns Funnel on, and a refusal names the command", async () => {
    const { send, host, settings } = app({ hostRunning: true });
    vi.mocked(host.publish).mockResolvedValueOnce({
      ok: false,
      reason: "This gateway is not allowed to change Tailscale on this computer.",
      command: "tailscale funnel --bg https+insecure://localhost:7600",
    });
    const refused = await (
      await send("PATCH", "/admin/remote-access", { mcp: { host: "public" } })
    ).json();
    expect(host.publish).toHaveBeenCalledWith(true);
    expect(refused.mcpRefusal).toEqual({
      ok: false,
      reason: "This gateway is not allowed to change Tailscale on this computer.",
      command: "tailscale funnel --bg https+insecure://localhost:7600",
    });
    // The choice is kept, so the command makes it so; until then MCP is not on the Internet.
    expect(settings.get()).toMatchObject({ mcp: { host: "public" }, hostApi: "private" });
    expect(refused.mcpAddresses.find((row: { id: string }) => row.id === "host").reach).toBe(
      "private",
    );
    const res = await send("PATCH", "/admin/remote-access", { mcp: { host: "public" } });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("mcpRefusal");
  });

  test("refuses an empty, unknown or malformed choice, and one for an address this gateway lacks", async () => {
    const { send, settings } = app();
    for (const mcp of [
      {},
      { carrier: "off" },
      { funnel: "off" },
      { domain: false },
      { domain: "private" },
      { relay: "private" },
      { tailnet: "off" },
      { tailscalePublic: "public" },
    ]) {
      expect(
        (await send("PATCH", "/admin/remote-access", { mcp })).status,
        JSON.stringify(mcp),
      ).toBe(400);
    }
    expect(settings.get().mcp).toBeUndefined();
  });

  test("letting MCP answer further asks for a step-up where required; narrowing it never does", async () => {
    const { send, settings, tailscale } = app({ stepUp: true, device: true });
    const viaRelay = { "x-omnesis-cloud-relay": "1" };
    const patch = (mcp: object) => send("PATCH", "/admin/remote-access", { mcp }, viaRelay);
    expect((await patch({ domain: "off", relay: "off", host: "off" })).status).toBe(200);
    // Already so: nothing loosens.
    expect((await patch({ tailnet: "private" })).status).toBe(200);
    expect((await patch({ domain: "on" })).status).toBe(428);
    expect((await patch({ host: "private" })).status).toBe(428);
    expect((await patch({ relay: "public", tailnet: "off" })).status).toBe(428);
    expect((await patch({ tailnet: "public" })).status).toBe(428);
    expect(tailscale.updateSettings).not.toHaveBeenCalled();
    expect(settings.get().mcp).toEqual({ domain: false, relay: false, host: false });
    // Keeping the device to the Tailscale network is stricter, so it never asks.
    expect((await patch({ tailnet: "off" })).status).toBe(200);
    // The guided setup's other choices still never ask.
    expect((await send("PATCH", "/admin/remote-access", { first: "relay" }, viaRelay)).status).toBe(
      200,
    );
  });
});
