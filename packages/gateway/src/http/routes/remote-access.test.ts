// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SCOPE_ADMIN } from "@omnesis/types";
import { CloudRelayManagementFailure } from "@omnesis/cloud-relay";
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
import type { CloudRelayManagement, GatewayEnrollment } from "@omnesis/cloud-relay";
import type { TailscaleEmbedService } from "../../tailscale-embed/service.js";
import type { AppEnv } from "./types.js";
import type { LocalMcpState } from "../../local-mcp-listener.js";

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
  home = null as string[] | null,
  localMcp = undefined as LocalMcpState | undefined,
  account = undefined as ReturnType<typeof linkedAccount> | undefined,
  joining = undefined as ReturnType<typeof tailscaleDevice> | undefined,
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
          // Every ceremony is answered: what matters here is which requests ask for one.
          stepUpCeremony: (binding: string) => ({
            purpose: "step-up",
            challenge: "c".repeat(43),
            binding,
            webauthnChallenge: "w".repeat(43),
          }),
          verifyStepUp: async () => true,
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
      ...(home ? { home: { origins: () => Promise.resolve(home) } } : {}),
    }),
    hostAccess,
    publicAddress,
    tailscaleEmbed: device,
    ...(localMcp ? { localMcp: () => localMcp } : {}),
    ...(account ? { relay: account.service } : {}),
    ...(joining ? { tailscale: joining.service } : {}),
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

/** The linked Omnesis account's policy for new devices, as the relay's management service keeps it. */
function linkedAccount({ linked = true } = {}) {
  const state = { policy: "automatic" as "ask" | "automatic", fails: false };
  const setEnrollmentPolicy = vi.fn(async (policy: "ask" | "automatic") => {
    if (state.fails) throw new CloudRelayManagementFailure(503, "account-unavailable");
    state.policy = policy;
    return { deviceEnrollment: { policy } };
  });
  const service = {
    accountPairingIdentity: () => (linked ? {} : undefined),
    setEnrollmentPolicy,
  } as unknown as CloudRelayManagement;
  return { service, state, setEnrollmentPolicy };
}

/** The gateway's own Tailscale device's policy for new devices. */
function tailscaleDevice({ enabled = true, fails = false } = {}) {
  const state = { joinPolicy: "ask" as "ask" | "automatic" | "off" };
  const updateSettings = vi.fn(async (patch: { joinPolicy?: "ask" | "automatic" | "off" }) => {
    if (fails) throw new Error("shutting down");
    state.joinPolicy = patch.joinPolicy ?? state.joinPolicy;
    return {};
  });
  const service = {
    state: () => ({ enabled, joinPolicy: state.joinPolicy, connection: "connected" }),
    joinPolicy: () => state.joinPolicy,
    updateSettings,
  } as unknown as TailscaleEmbedService;
  return { service, state, updateSettings };
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
      localMcp: { state: "off" },
    });
  });

  test("agents on the home network sign in only once the owner allows it, which asks for the step-up", async () => {
    const { send } = app({
      stepUp: true,
      home: ["https://omnesis.local:7600", "https://192.168.0.20:7600"],
      localMcp: { state: "listening", port: 7601, url: "http://localhost:7601" },
    });
    const state = await (await send("GET", "/admin/remote-access")).json();
    expect(state.mcpAddresses[0]).toEqual({
      id: "home",
      url: "https://omnesis.local:7600",
      urls: ["https://omnesis.local:7600", "https://192.168.0.20:7600"],
      reach: "off",
      choices: ["off", "on"],
      available: true,
    });
    expect(state.localMcp).toEqual({
      state: "listening",
      port: 7601,
      url: "http://localhost:7601",
    });
    // Allowing it lets agents sign in where they could not: the passkey comes first.
    const viaRelay = { "x-omnesis-cloud-relay": "1" };
    const refused = await send("PATCH", "/admin/remote-access", { mcp: { home: "on" } }, viaRelay);
    expect(refused.status).toBe(428);
    // Narrowing never asks.
    expect(
      (await send("PATCH", "/admin/remote-access", { mcp: { home: "off" } }, viaRelay)).status,
    ).toBe(200);
    expect((await (await send("GET", "/admin/remote-access")).json()).mcpAddresses[0].reach).toBe(
      "off",
    );
  });

  test("the home network is turned on and off, and off writes nothing back", async () => {
    const { send, settings } = app({ home: ["https://omnesis.local:7600"] });
    const on = await (await send("PATCH", "/admin/remote-access", { mcp: { home: "on" } })).json();
    expect(on.mcpAddresses[0]).toMatchObject({ id: "home", reach: "on" });
    expect(settings.get().mcp).toEqual({ home: true });
    const off = await (
      await send("PATCH", "/admin/remote-access", { mcp: { home: "off" } })
    ).json();
    expect(off.mcpAddresses[0]).toMatchObject({ id: "home", reach: "off" });
    expect(settings.get().mcp).toEqual({});
    expect((await send("PATCH", "/admin/remote-access", { mcp: { home: "public" } })).status).toBe(
      400,
    );
  });

  test("a gateway that listens on this machine alone offers no home-network choice", async () => {
    const { send } = app();
    const state = await (await send("GET", "/admin/remote-access")).json();
    expect(state.mcpAddresses.map((row: { id: string }) => row.id)).not.toContain("home");
    expect((await send("PATCH", "/admin/remote-access", { mcp: { home: "on" } })).status).toBe(400);
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

  describe("the answer for new devices", () => {
    const RELAYED = { "x-omnesis-cloud-relay": "1" };
    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

    test("sets the account's and the Tailscale device's policies in one request", async () => {
      const account = linkedAccount();
      const joining = tailscaleDevice();
      const { send } = app({ account, joining });
      const response = await send("PUT", "/admin/remote-access/new-devices", { policy: "ask" });
      expect(response.status).toBe(200);
      expect(account.state.policy).toBe("ask");
      expect(joining.state.joinPolicy).toBe("ask");
      // Both pages read what each way does now from the answer.
      expect(await response.json()).toEqual({
        relay: { deviceEnrollment: { policy: "ask" }, stepUpRequired: false },
        tailscale: { enabled: true, joinPolicy: "ask", connection: "connected" },
      });
    });

    test("letting devices join automatically asks for one step-up for both ways, which carries that one request once", async () => {
      const account = linkedAccount();
      account.state.policy = "ask";
      const joining = tailscaleDevice();
      const { send } = app({ stepUp: true, account, joining });
      const body = JSON.stringify({ policy: "automatic" });
      const refused = await send(
        "PUT",
        "/admin/remote-access/new-devices",
        { policy: "automatic" },
        RELAYED,
      );
      expect(refused.status).toBe(428);
      const { detail } = (await refused.json()) as { detail: { path: string } };
      expect(detail.path).toBe("/admin/remote-access/new-devices");
      expect(account.setEnrollmentPolicy).not.toHaveBeenCalled();
      expect(joining.updateSettings).not.toHaveBeenCalled();

      const target = { method: "PUT", path: detail.path, bodySha256: sha256(body) };
      const proof = {
        type: "gateway-passkey",
        challenge: "c".repeat(43),
        credential: {
          id: "Y3JlZA",
          rawId: "Y3JlZA",
          type: "public-key",
          clientExtensionResults: {},
          response: {
            clientDataJSON: "e30",
            authenticatorData: "AA",
            signature: "AA",
            userHandle: "dQ",
          },
        },
      };
      const issued = await send("POST", "/admin/step-up", { ...target, proof }, RELAYED);
      expect(issued.status).toBe(200);
      const { stepUpId } = (await issued.json()) as { stepUpId: string };
      const withStepUp = { ...RELAYED, "X-Omnesis-Step-Up": stepUpId };
      const done = await send(
        "PUT",
        "/admin/remote-access/new-devices",
        { policy: "automatic" },
        withStepUp,
      );
      expect(done.status).toBe(200);
      // One passkey changed both ways.
      expect(account.state.policy).toBe("automatic");
      expect(joining.state.joinPolicy).toBe("automatic");
      expect(
        ((await done.json()) as { relay: { stepUpRequired: boolean } }).relay.stepUpRequired,
      ).toBe(true);
      // The id is spent: the same request again needs a new step-up.
      expect(
        (await send("PUT", "/admin/remote-access/new-devices", { policy: "automatic" }, withStepUp))
          .status,
      ).toBe(428);
    });

    test("asking first or needing a code only makes the gateway stricter, so it never asks for a step-up", async () => {
      const joining = tailscaleDevice();
      joining.state.joinPolicy = "automatic";
      const { send } = app({ stepUp: true, joining });
      expect(
        (await send("PUT", "/admin/remote-access/new-devices", { policy: "ask" }, RELAYED)).status,
      ).toBe(200);
      expect(joining.state.joinPolicy).toBe("ask");
      // Without an account, a pairing code only turns joining through Tailscale off.
      expect(
        (await send("PUT", "/admin/remote-access/new-devices", { policy: "code" }, RELAYED)).status,
      ).toBe(200);
      expect(joining.state.joinPolicy).toBe("off");
    });

    test("only the ways that apply are set, and a code is refused while an account lets devices ask", async () => {
      const account = linkedAccount();
      const off = tailscaleDevice({ enabled: false });
      const { send } = app({ account, joining: off });
      const response = await send("PUT", "/admin/remote-access/new-devices", { policy: "ask" });
      expect(await response.json()).toEqual({
        relay: { deviceEnrollment: { policy: "ask" }, stepUpRequired: false },
      });
      expect(off.updateSettings).not.toHaveBeenCalled();
      const code = await send("PUT", "/admin/remote-access/new-devices", { policy: "code" });
      expect(code.status).toBe(409);
      expect((await code.json()).code).toBe("ACCOUNT_LETS_DEVICES_ASK");
      expect(account.state.policy).toBe("ask");
    });

    test("with no way for a device to ask, or an unknown answer, nothing is set", async () => {
      const unlinked = linkedAccount({ linked: false });
      const off = tailscaleDevice({ enabled: false });
      const { send } = app({ account: unlinked, joining: off });
      const none = await send("PUT", "/admin/remote-access/new-devices", { policy: "ask" });
      expect(none.status).toBe(409);
      expect((await none.json()).code).toBe("NO_WAY_TO_ASK");
      expect(
        (await send("PUT", "/admin/remote-access/new-devices", { policy: "sometimes" })).status,
      ).toBe(400);
      expect(unlinked.setEnrollmentPolicy).not.toHaveBeenCalled();
      expect(off.updateSettings).not.toHaveBeenCalled();
    });

    test("when the account's policy can't be saved, the Tailscale device's is put back, so the two never split", async () => {
      const account = linkedAccount();
      account.state.fails = true;
      const joining = tailscaleDevice();
      const { send } = app({ account, joining });
      const response = await send("PUT", "/admin/remote-access/new-devices", {
        policy: "automatic",
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "account-unavailable" });
      expect(joining.state.joinPolicy).toBe("ask");
      expect(joining.updateSettings).toHaveBeenLastCalledWith({ joinPolicy: "ask" });
    });

    test("when the Tailscale device's policy can't be saved, the account's is never touched", async () => {
      const account = linkedAccount();
      const joining = tailscaleDevice({ fails: true });
      const { send } = app({ account, joining });
      const response = await send("PUT", "/admin/remote-access/new-devices", { policy: "ask" });
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe("NEW_DEVICES_UNAVAILABLE");
      expect(account.setEnrollmentPolicy).not.toHaveBeenCalled();
    });

    test("an account that fails for any other reason also leaves both as they were", async () => {
      const account = linkedAccount();
      account.setEnrollmentPolicy.mockRejectedValueOnce(new Error("disk full"));
      const joining = tailscaleDevice();
      joining.state.joinPolicy = "automatic";
      const { send } = app({ account, joining });
      const response = await send("PUT", "/admin/remote-access/new-devices", { policy: "ask" });
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe("NEW_DEVICES_UNAVAILABLE");
      expect(joining.state.joinPolicy).toBe("automatic");
    });
  });
});
