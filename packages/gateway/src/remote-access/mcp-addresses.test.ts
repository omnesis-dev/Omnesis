// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HostAccess, marksFunnelRequests, TAILSCALE_TOO_OLD } from "./host-access.js";
import {
  addressHostname,
  isMcpClientPath,
  McpAddresses,
  relayStateFrom,
  type McpAddressesOptions,
} from "./mcp-addresses.js";
import { RemoteAccessSettingsStore } from "./settings.js";

const RELAY = "https://gw-fictional.relay.example.net";
const TAILNET = "https://omnesis-gw.example-net.ts.net";
const HOST = "https://studio.example-net.ts.net";
const DOMAIN = "https://omnesis.example.org:8443";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-addresses-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Tailscale on this computer as the gateway's host service sees it: a machine name, the
 * port it serves the gateway on, and whether Funnel is on there. Publishing turns it on
 * or off as asked unless `refuse` is set.
 */
function fakeHostTailscale() {
  const state = {
    name: "Studio.example-net.ts.net" as string | null,
    port: 443,
    served: true,
    funnel: false,
    refuse: false,
    version: "1.104.6" as string | null,
  };
  const url = () =>
    `https://${state.name!.toLowerCase()}${state.port === 443 ? "" : `:${state.port}`}`;
  const service = {
    status: vi.fn(async () =>
      state.name
        ? {
            state: "available" as const,
            dnsName: state.name,
            version: state.version,
            port: state.port,
            url: url(),
            servesGateway: state.served,
            publicGateway: state.served && state.funnel,
            taken: [],
          }
        : {
            state: "stopped" as const,
            reason: "Tailscale is installed on this computer but not running or not signed in.",
          },
    ),
    publish: vi.fn(async (publicly: boolean) => {
      if (state.refuse)
        return {
          ok: false as const,
          reason: "This gateway is not allowed to change Tailscale on this computer.",
          command: "tailscale funnel --bg https+insecure://localhost:7600",
        };
      state.served = true;
      state.funnel = publicly;
      return { ok: true as const, url: url() };
    }),
    unpublish: vi.fn(async () => {
      state.served = false;
      state.funnel = false;
      return { ok: true as const };
    }),
  };
  return { state, service };
}

function addresses(overrides: Partial<McpAddressesOptions> = {}) {
  let publicAccess = false;
  // Whether the device's public address is open yet.
  let opened = true;
  const tailscale = {
    tailnetOrigin: () => TAILNET,
    settings: { get: () => ({ publicAccess }) },
    state: () => ({ public: { state: publicAccess && opened ? "on" : "off" } }),
    holdOpening: (held: boolean) => {
      opened = !held;
    },
    updateSettings: vi.fn(async (patch: { publicAccess?: boolean }) => {
      publicAccess = patch.publicAccess ?? publicAccess;
      return {} as never;
    }),
  };
  const host = fakeHostTailscale();
  let clock = 1_000_000;
  const settings = new RemoteAccessSettingsStore(dir);
  const hostAccess = new HostAccess(host.service, settings);
  const policy = new McpAddresses({
    settings,
    publicBaseUrl: () => DOMAIN,
    relayOrigin: () => RELAY,
    relayState: async () => ({ origin: RELAY, serving: true }),
    tailscale: tailscale as unknown as McpAddressesOptions["tailscale"],
    host: hostAccess,
    now: () => clock,
    ...overrides,
  });
  return {
    policy,
    settings,
    tailscale,
    host,
    hostAccess,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Each offered address and where MCP answers there, as the owner sees the list. */
async function reaches(policy: McpAddresses) {
  return Object.fromEntries((await policy.list()).map((row) => [row.id, row.reach]));
}

const request = (
  url: string,
  {
    via = null,
    relayed = false,
    funnel = false,
  }: { via?: "tailnet" | "public" | null; relayed?: boolean; funnel?: boolean } = {},
) => ({ url, path: new URL(url).pathname, via, relayed, funnel });

describe("which paths an MCP client uses", () => {
  test("the endpoint, OAuth discovery and OAuth routes, but not a source's sign-in callback", () => {
    for (const path of [
      "/mcp",
      "/mcp/",
      "/MCP",
      "/mcp/answer",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/omnesis",
      "/.well-known/openid-configuration",
      "/omnesis/.well-known/openid-configuration",
      "/oauth/register",
      "/oauth/token",
      "/oauth/revoke",
      "/oauth/authorize",
      "/oauth/authorize/status",
      "/oauth/authorize/complete",
      "/oauth/consent",
    ]) {
      expect(isMcpClientPath(path), path).toBe(true);
    }
    for (const path of [
      "/oauth/callback",
      "/portal",
      "/portal/css/style.css",
      "/health",
      "/status",
      "/devices/pair",
      "/mcpx",
      "/.well-known/omnesis-address-check/abc",
    ]) {
      expect(isMcpClientPath(path), path).toBe(false);
    }
  });
});

describe("host names", () => {
  test("ignore case, port and a trailing dot, and keep IPv6 brackets", () => {
    expect(addressHostname("Omnesis.Example.ORG:8443")).toBe("omnesis.example.org");
    expect(addressHostname("omnesis.example.org.")).toBe("omnesis.example.org");
    expect(addressHostname("https://omnesis.example.org:8443/base")).toBe("omnesis.example.org");
    expect(addressHostname("[2001:db8::7]:7600")).toBe("[2001:db8::7]");
    expect(addressHostname("https://[2001:DB8::7]/")).toBe("[2001:db8::7]");
    expect(addressHostname("")).toBeNull();
    expect(addressHostname(undefined)).toBeNull();
    expect(addressHostname("not a host")).toBeNull();
  });
});

describe("MCP per address", () => {
  test("every address answers as far as it reaches until the owner chooses, and nothing is written for it", async () => {
    const { policy } = addresses();
    expect(await policy.list()).toEqual([
      { id: "relay", url: RELAY, reach: "public", choices: ["off", "public"], available: true },
      {
        id: "tailnet",
        url: TAILNET,
        reach: "private",
        choices: ["off", "private", "public"],
        available: true,
      },
      {
        id: "host",
        url: HOST,
        reach: "private",
        choices: ["off", "private", "public"],
        available: true,
      },
      { id: "domain", url: DOMAIN, reach: "on", choices: ["off", "on"], available: true },
    ]);
    for (const url of [`${RELAY}/mcp`, `${TAILNET}/mcp`, `${HOST}/mcp`, `${DOMAIN}/mcp`]) {
      expect(await policy.refusal(request(url)), url).toBeNull();
      expect(policy.answersAt(url), url).toBe(true);
    }
    expect(await policy.refusal(request(`${TAILNET}/mcp`, { via: "tailnet" }))).toBeNull();
    expect(existsSync(join(dir, "remote-access.json"))).toBe(false);
  });

  test("an address that is not set up is listed as unavailable, with what is known of it", async () => {
    const { policy, host } = addresses({
      publicBaseUrl: () => undefined,
      relayOrigin: () => undefined,
      relayState: async () => ({ origin: undefined, serving: false }),
      tailscale: {
        tailnetOrigin: () => null,
        settings: { get: () => ({ publicAccess: false }) },
        state: () => ({ public: { state: "off" } }),
        updateSettings: vi.fn(),
      } as unknown as McpAddressesOptions["tailscale"],
    });
    // The look the gateway starts with has finished; the next one finds Tailscale stopped.
    await policy.settle();
    host.state.name = null;
    expect((await policy.list()).map(({ id, url, available }) => ({ id, url, available }))).toEqual(
      [
        { id: "relay", url: null, available: false },
        { id: "tailnet", url: null, available: false },
        { id: "host", url: null, available: false },
        { id: "domain", url: null, available: false },
      ],
    );
  });

  test("this computer's row names the port Tailscale serves the gateway on", async () => {
    const { policy, host } = addresses();
    await policy.settle();
    host.state.port = 10000;
    expect((await policy.list()).find((row) => row.id === "host")?.url).toBe(
      "https://studio.example-net.ts.net:10000",
    );
  });

  test("the relay row follows the relay's live state, not the origin known at start", async () => {
    const LIVE = "https://g-fictional-2.relay.example.net";
    let status = {
      publicOrigin: LIVE as string | undefined,
      enabled: true,
      enrollment: { state: "pending" },
    };
    const { policy } = addresses({
      relayState: relayStateFrom({ status: async () => status as never }),
    });
    const relayRow = async () => (await policy.list()).find((row) => row.id === "relay");
    // Saved but not enrolled: the portal shows the relay as not connected.
    expect(await relayRow()).toMatchObject({ url: LIVE, available: false });
    status = { ...status, enrollment: { state: "enrolled" } };
    expect(await relayRow()).toMatchObject({ url: LIVE, available: true });
    // Turned off by the owner: enrolled, but no longer serving.
    status = { ...status, enabled: false };
    expect(await relayRow()).toMatchObject({ available: false });
    // Never configured.
    status = { publicOrigin: undefined, enabled: false, enrollment: { state: "unconfigured" } };
    expect(await relayRow()).toMatchObject({ url: null, available: false });
  });

  test("a relay whose state cannot be read is listed as unavailable", async () => {
    const { policy } = addresses({
      relayState: async () => {
        throw new Error("status unreadable");
      },
    });
    expect((await policy.list())[0]).toMatchObject({ id: "relay", url: RELAY, available: false });
  });

  test("offers the relay, the Tailscale device where it exists and this computer where there is a port", async () => {
    expect(Object.keys(await reaches(addresses({ tailscale: undefined }).policy))).toEqual([
      "relay",
      "host",
      "domain",
    ]);
    expect(Object.keys(await reaches(addresses({ host: undefined }).policy))).toEqual([
      "relay",
      "tailnet",
      "domain",
    ]);
    expect(Object.keys(await reaches(addresses().policy))).toEqual([
      "relay",
      "tailnet",
      "host",
      "domain",
    ]);
  });

  test("an address turned off refuses MCP's paths by host, whatever its case or port", async () => {
    const { policy } = addresses();
    await policy.update({ domain: "off" });
    expect(await policy.refusal(request("https://OMNESIS.example.org:8443/mcp"))).toBe("domain");
    expect(await policy.refusal(request("https://omnesis.example.org/oauth/token"))).toBe("domain");
    expect(
      await policy.refusal(
        request("https://omnesis.example.org/.well-known/oauth-protected-resource/mcp"),
      ),
    ).toBe("domain");
    // The rest of that address, and the other addresses, are untouched.
    expect(await policy.refusal(request("https://omnesis.example.org/portal"))).toBeNull();
    expect(await policy.refusal(request("https://omnesis.example.org/oauth/callback"))).toBeNull();
    expect(await policy.refusal(request(`${RELAY}/mcp`))).toBeNull();
    expect(await policy.refusal(request(`${TAILNET}/mcp`))).toBeNull();
    expect(await policy.refusal(request(`${HOST}/mcp`))).toBeNull();
    expect(policy.answersAt(`${DOMAIN}/mcp`)).toBe(false);
    expect(policy.answersAt(`${RELAY}/mcp`)).toBe(true);

    await policy.update({ domain: "on", relay: "off" });
    expect(await policy.refusal(request(`${DOMAIN}/mcp`))).toBeNull();
    expect(await policy.refusal(request(`${RELAY}/oauth/authorize`))).toBe("relay");
  });

  test("a domain on an IPv6 address is matched with its brackets", async () => {
    const { policy } = addresses({ publicBaseUrl: () => "https://[2001:db8::7]:7600" });
    await policy.update({ domain: "off" });
    expect(await policy.refusal(request("https://[2001:db8::7]:7600/mcp"))).toBe("domain");
    expect(await policy.refusal(request("https://[2001:DB8::7]/mcp"))).toBe("domain");
    expect(await policy.refusal(request("https://[2001:db8::8]:7600/mcp"))).toBeNull();
  });

  test("loopback always answers, even when it is the configured domain", async () => {
    const { policy } = addresses({ publicBaseUrl: () => "https://localhost:7600" });
    await policy.update({ domain: "off", relay: "off", tailnet: "off", host: "off" });
    for (const url of [
      "https://localhost:7600/mcp",
      "https://127.0.0.1:7600/mcp",
      "https://[::1]:7600/mcp",
    ]) {
      expect(await policy.refusal(request(url)), url).toBeNull();
    }
    expect(await policy.refusal(request("https://192.0.2.20:7600/mcp"))).toBeNull();
  });

  test("a request through the relay is the relay address whatever Host it names", async () => {
    const { policy } = addresses();
    await policy.update({ relay: "off" });
    expect(await policy.refusal(request("https://localhost:7600/mcp", { relayed: true }))).toBe(
      "relay",
    );
    expect(await policy.refusal(request(`${DOMAIN}/oauth/token`, { relayed: true }))).toBe("relay");
    expect(await policy.refusal(request("https://localhost:7600/mcp"))).toBeNull();
  });

  test("the tailnet address is a request from the tailnet, or one naming the device; the public address is not", async () => {
    const { policy } = addresses();
    await policy.update({ tailnet: "off" });
    expect(await policy.refusal(request("https://192.0.2.9/mcp", { via: "tailnet" }))).toBe(
      "tailnet",
    );
    expect(await policy.refusal(request(`${TAILNET}/mcp`, { via: "tailnet" }))).toBe("tailnet");
    expect(await policy.refusal(request(`${TAILNET}/mcp`))).toBe("tailnet");
    // A request through the public address is that address's, whose own choice the helper applies.
    expect(await policy.refusal(request(`${TAILNET}/mcp`, { via: "public" }))).toBeNull();
    expect(await policy.refusal(request(`${TAILNET}/portal`, { via: "tailnet" }))).toBeNull();
  });

  test("the Tailscale device's three choices are its MCP switch and its own public address", async () => {
    const { policy, settings, tailscale } = addresses();
    tailscale.holdOpening(true);
    await policy.update({ tailnet: "public" });
    expect((await reaches(policy)).tailnet).toBe("public");
    expect(tailscale.updateSettings).toHaveBeenCalledWith({ publicAccess: true });
    // The row says so while Tailscale has yet to open it; the device's page shows what it needs.
    expect((await policy.list()).find((row) => row.id === "tailnet")?.opening).toBe(true);
    tailscale.holdOpening(false);
    expect((await policy.list()).find((row) => row.id === "tailnet")).not.toHaveProperty("opening");
    expect(settings.get().mcp).toEqual({});
    // Asking for what is already so writes nothing.
    await policy.update({ tailnet: "public" });
    expect(tailscale.updateSettings).toHaveBeenCalledTimes(1);

    await policy.update({ tailnet: "off" });
    expect((await reaches(policy)).tailnet).toBe("off");
    expect(tailscale.updateSettings).toHaveBeenLastCalledWith({ publicAccess: false });
    expect(settings.get().mcp).toEqual({ tailnet: false });
    expect(policy.answersAt(`${TAILNET}/mcp`)).toBe(false);

    await policy.update({ tailnet: "private" });
    expect((await reaches(policy)).tailnet).toBe("private");
    expect(settings.get().mcp).toEqual({});
    expect(policy.answersAt(`${TAILNET}/mcp`)).toBe(true);
  });

  test("this computer's address is recognised by its MagicDNS name, whatever its case", async () => {
    const { policy } = addresses();
    await policy.update({ host: "off" });
    expect(await policy.refusal(request("https://STUDIO.example-net.ts.net/mcp"))).toBe("host");
    expect(await policy.refusal(request("https://studio.example-net.ts.net./oauth/register"))).toBe(
      "host",
    );
    expect(await policy.refusal(request(`${HOST}/portal`))).toBeNull();
    expect(await policy.refusal(request(`${DOMAIN}/mcp`))).toBeNull();
    expect(policy.answersAt(`${HOST}/mcp`)).toBe(false);
  });

  test("a choice already off refuses by this computer's name from the first request after a start", async () => {
    const first = addresses();
    await first.policy.update({ host: "off" });
    // A new gateway on the same file: the first request waits for the name it is looking up.
    const { policy, host } = addresses();
    expect(await policy.refusal(request(`${HOST}/mcp`))).toBe("host");
    expect(host.service.status).toHaveBeenCalledTimes(1);
    // Paths outside MCP never ask Tailscale.
    await policy.refusal(request(`${HOST}/portal`));
    expect(host.service.status).toHaveBeenCalledTimes(1);
  });

  test("this computer's name is looked up again in the background once a minute old", async () => {
    const { policy, host, advance } = addresses();
    await policy.update({ host: "off" });
    const looks = host.service.status.mock.calls.length;
    host.state.name = "atelier.example-net.ts.net";
    advance(30_000);
    expect(await policy.refusal(request(`${HOST}/mcp`))).toBe("host");
    expect(host.service.status).toHaveBeenCalledTimes(looks);
    advance(30_000);
    // The stale name still answers this request; the new one is learnt for the next.
    expect(await policy.refusal(request(`${HOST}/mcp`))).toBe("host");
    await vi.waitFor(() => expect(host.service.status).toHaveBeenCalledTimes(looks + 1));
    expect(await policy.refusal(request("https://atelier.example-net.ts.net/mcp"))).toBe("host");
    expect(await policy.refusal(request(`${HOST}/mcp`))).toBeNull();
  });

  test("a failed look keeps refusing by the name already known", async () => {
    const { policy, host, advance } = addresses();
    await policy.update({ host: "off" });
    const looks = host.service.status.mock.calls.length;
    host.service.status.mockRejectedValueOnce(new Error("timed out"));
    advance(60_000);
    await policy.settle();
    await vi.waitFor(() => expect(host.service.status).toHaveBeenCalledTimes(looks + 1));
    expect(await policy.refusal(request(`${HOST}/mcp`))).toBe("host");
  });

  test("discovery keeps the tailnet name while either the tailnet or the public address answers", async () => {
    const { policy, tailscale } = addresses();
    await policy.update({ tailnet: "off" });
    expect(policy.answersAt(`${TAILNET}/mcp`)).toBe(false);
    // A device made public by its own page answers there too.
    await tailscale.updateSettings({ publicAccess: true });
    expect(policy.answersAt(`${TAILNET}/mcp`)).toBe(true);
    expect((await reaches(policy)).tailnet).toBe("public");
  });

  test("a public address that is the relay's is the relay's, under the relay's choice alone", async () => {
    const { policy } = addresses({ publicBaseUrl: () => RELAY });
    expect(await policy.publicAddressWay()).toBe("relay");
    expect((await policy.list()).find((row) => row.id === "domain")?.available).toBe(false);
    await policy.update({ domain: "off" });
    expect(await policy.refusal(request(`${RELAY}/mcp`))).toBeNull();
    await policy.update({ relay: "off" });
    expect(await policy.refusal(request(`${RELAY}/mcp`))).toBe("relay");
  });

  test("a public address that is this computer's Tailscale name has one row and one choice, the host's", async () => {
    const { policy } = addresses({ publicBaseUrl: () => HOST });
    expect(await policy.publicAddressWay()).toBe("host");
    const rows = (await policy.list()).filter((row) => row.available);
    expect(rows.map((row) => row.id)).not.toContain("domain");
    expect(rows.find((row) => row.id === "host")?.url).toBe(HOST);
    // A domain choice turned off before the address was the host's no longer refuses it.
    await policy.update({ domain: "off" });
    expect(await policy.refusal(request(`${HOST}/mcp`))).toBeNull();
    await policy.update({ host: "off" });
    expect(await policy.refusal(request(`${HOST}/mcp`))).toBe("host");
  });

  test("a public address that is the gateway's own Tailscale device is the tailnet's", async () => {
    const { policy } = addresses({ publicBaseUrl: () => TAILNET });
    expect(await policy.publicAddressWay()).toBe("tailnet");
    expect((await policy.list()).find((row) => row.id === "domain")?.available).toBe(false);
  });

  test("the owner's own domain is nobody else's, and keeps its row", async () => {
    const { policy } = addresses();
    expect(await policy.publicAddressWay()).toBeNull();
    expect((await policy.list()).find((row) => row.id === "domain")).toMatchObject({
      url: DOMAIN,
      available: true,
    });
  });

  test("a gateway that never connected to the relay has no relay address, and nothing matches one", async () => {
    const { policy, settings } = addresses({
      relayOrigin: () => undefined,
      relayState: async () => ({ origin: undefined, serving: false }),
    });
    expect((await policy.list())[0]).toMatchObject({ id: "relay", url: null, available: false });
    await policy.update({ relay: "off" });
    // Only a request that came through the tunnel is the relay's; no Host names it.
    expect(await policy.refusal(request(`${RELAY}/mcp`))).toBeNull();
    expect(await policy.refusal(request(`${DOMAIN}/mcp`))).toBeNull();
    expect(await policy.refusal(request("https://localhost:7600/mcp"))).toBeNull();
    expect(await policy.publicAddressWay(RELAY)).toBeNull();
    expect(settings.get().mcp).toEqual({ relay: false });
  });

  test("only letting MCP answer further loosens the gateway", async () => {
    const { policy } = addresses();
    expect(policy.loosens({ relay: "off", domain: "off", host: "off" })).toBe(false);
    expect(policy.loosens({ domain: "on", host: "private", tailnet: "private" })).toBe(false);
    expect(policy.loosens({ tailnet: "public" })).toBe(true);
    // Funnel is off, so MCP answers on the tailnet only: the Internet is further.
    expect(policy.loosens({ host: "public" })).toBe(true);
    await policy.update({ domain: "off", host: "private" });
    expect(policy.loosens({ domain: "on" })).toBe(true);
    expect(policy.loosens({ host: "public" })).toBe(true);
    expect(policy.loosens({ host: "private" })).toBe(false);
    expect(policy.loosens({ relay: "public", domain: "off" })).toBe(false);
    for (const unreadable of [undefined, null, "domain", 1, { domain: true }]) {
      expect(policy.loosens(unreadable)).toBe(false);
    }
  });

  test("refuses a choice for an address the gateway does not offer, or one it lacks", async () => {
    const { policy, settings } = addresses({ tailscale: undefined });
    await expect(policy.update({ relay: "private" })).rejects.toThrow(/relay/);
    await expect(policy.update({ tailnet: "public" })).rejects.toThrow(/tailnet/);
    await expect(policy.update({ domain: "private" })).rejects.toThrow(/domain/);
    expect(settings.get().mcp).toBeUndefined();
  });
});

describe("Tailscale on this computer and the Internet", () => {
  const funnel = (path: string) => request(`${HOST}${path}`, { funnel: true });

  test("an owner who turned Funnel on before these choices keeps everything on the Internet", async () => {
    const { policy, host } = addresses();
    await policy.settle();
    host.state.funnel = true;
    expect((await reaches(policy)).host).toBe("public");
    expect(await policy.refusal(funnel("/mcp"))).toBeNull();
    expect(await policy.refusal(funnel("/portal"))).toBeNull();
    expect(await policy.refusal(funnel("/devices/pair"))).toBeNull();
    expect(existsSync(join(dir, "remote-access.json"))).toBe(false);
  });

  test("MCP put on the Internet turns Funnel on for MCP alone and keeps the pages and API off it", async () => {
    const { policy, host, settings } = addresses();
    expect(await policy.update({ host: "public" })).toBeNull();
    expect(host.service.publish).toHaveBeenCalledWith(true);
    expect(settings.get()).toMatchObject({ mcp: { host: "public" }, hostApi: "private" });
    expect((await reaches(policy)).host).toBe("public");
    expect(await policy.refusal(funnel("/mcp"))).toBeNull();
    expect(await policy.refusal(funnel("/oauth/token"))).toBeNull();
    expect(await policy.refusal(funnel("/portal"))).toBe("host-internet-api");
    expect(await policy.refusal(funnel("/devices/pair"))).toBe("host-internet-api");
    // The owner's Tailscale network still reaches everything.
    expect(await policy.refusal(request(`${HOST}/portal`))).toBeNull();
    expect(await policy.refusal(request(`${HOST}/mcp`))).toBeNull();

    // Kept to the Tailscale network again: Funnel is no longer needed, so it goes.
    await policy.update({ host: "private" });
    expect(host.service.publish).toHaveBeenLastCalledWith(false);
    expect(host.state.funnel).toBe(false);
    expect((await reaches(policy)).host).toBe("private");
  });

  test("MCP kept off the Internet while the pages and API are on it keeps Funnel, and refuses MCP through it", async () => {
    const { policy, host, settings } = addresses();
    host.state.funnel = true;
    await policy.update({ host: "private" });
    expect(host.service.publish).not.toHaveBeenCalled();
    expect(settings.get()).toMatchObject({ mcp: { host: "private" }, hostApi: "public" });
    expect(await policy.refusal(funnel("/mcp"))).toBe("host");
    expect(await policy.refusal(funnel("/.well-known/oauth-authorization-server"))).toBe("host");
    expect(await policy.refusal(funnel("/portal"))).toBeNull();
    expect(await policy.refusal(request(`${HOST}/mcp`))).toBeNull();
    expect(policy.hostReach(`${HOST}/mcp`)).toBe("private");
    // Off altogether: the Tailscale network loses MCP too.
    await policy.update({ host: "off" });
    expect(await policy.refusal(request(`${HOST}/mcp`))).toBe("host");
  });

  test("the Funnel header marks the request whatever Host it names, but not one through the relay or the device", async () => {
    const { policy, hostAccess } = addresses();
    await hostAccess.publish(false);
    await policy.update({ host: "private" });
    expect(await policy.refusal(request("https://localhost:7600/mcp", { funnel: true }))).toBe(
      "host",
    );
    expect(
      await policy.refusal(request(`${RELAY}/mcp`, { relayed: true, funnel: true })),
    ).toBeNull();
    expect(
      await policy.refusal(request(`${TAILNET}/mcp`, { via: "tailnet", funnel: true })),
    ).toBeNull();
    // A gateway with no Tailscale of its computer to forward to ignores the header.
    const { policy: portless } = addresses({ host: undefined });
    expect(
      await portless.refusal(request("https://localhost:7600/portal", { funnel: true })),
    ).toBeNull();
  });

  test("a choice Tailscale refuses to apply is kept, and the refusal names the command", async () => {
    const { policy, host, settings } = addresses();
    host.state.refuse = true;
    expect(await policy.update({ host: "public" })).toMatchObject({
      ok: false,
      command: "tailscale funnel --bg https+insecure://localhost:7600",
    });
    expect(settings.get().mcp).toEqual({ host: "public" });
    // Nothing is public until the command runs.
    expect((await reaches(policy)).host).toBe("private");
  });

  test("a choice made while Tailscale does not serve the gateway is kept for when it does", async () => {
    const { policy, host, settings, hostAccess } = addresses();
    host.state.served = false;
    await policy.update({ host: "public" });
    expect(host.service.publish).not.toHaveBeenCalled();
    expect(settings.get().mcp).toEqual({ host: "public" });
    // Serving it later with the pages and API kept private still opens Funnel for MCP.
    await hostAccess.publish(false);
    expect(host.service.publish).toHaveBeenLastCalledWith(true);
    expect(await hostAccess.status()).toMatchObject({ publicGateway: false, publicMcp: true });
  });

  test("the pages and API go on the Internet with MCP the owner never chose following them", async () => {
    const { host, hostAccess } = addresses();
    host.state.served = false;
    await hostAccess.publish(true);
    expect(host.service.publish).toHaveBeenLastCalledWith(true);
    expect(await hostAccess.status()).toMatchObject({ publicGateway: true, publicMcp: true });
    await hostAccess.publish(false);
    expect(host.service.publish).toHaveBeenLastCalledWith(false);
    expect(await hostAccess.status()).toMatchObject({
      funnel: false,
      publicGateway: false,
      publicMcp: false,
    });
  });
});

describe("Tailscale on this computer: what the Funnel header may and may not do", () => {
  const funnel = (url: string) => request(url, { funnel: true });

  test("with only MCP on the Internet, an agent's sign-in page still loads its styles and scripts", async () => {
    const { policy } = addresses();
    await policy.update({ host: "public" });
    for (const path of [
      "/oauth/consent",
      "/portal/css/style.css",
      "/portal/js/oauth-consent-controller.js",
    ])
      expect(await policy.refusal(funnel(`${HOST}${path}`)), path).toBeNull();
    expect(await policy.refusal(funnel(`${HOST}/portal/`))).toBe("host-internet-api");
    expect(await policy.refusal(funnel(`${HOST}/devices/pair`))).toBe("host-internet-api");
    // With MCP kept off the Internet, they are refused like the rest.
    await policy.update({ host: "private" });
    await policy.settle();
    expect(await policy.refusal(funnel(`${HOST}/portal/css/style.css`))).toBe("host-internet-api");
  });

  test("a request that claims the header is still held to the address it names", async () => {
    const { policy } = addresses();
    await policy.update({ domain: "off" });
    expect(await policy.refusal(funnel(`${DOMAIN}/mcp`))).toBe("domain");
    expect(await policy.refusal(funnel(`${DOMAIN}/oauth/token`))).toBe("domain");
  });

  test("putting MCP on the Internet loosens the gateway whenever it is not there now", async () => {
    const { policy, host } = addresses();
    await policy.settle();
    // Nothing chosen and Funnel off: MCP answers on the tailnet only, so Internet is further.
    expect(policy.loosens({ host: "public" })).toBe(true);
    host.state.funnel = true;
    await policy.list();
    expect(policy.loosens({ host: "public" })).toBe(false);
  });

  test("an earlier version's `true` is no choice: MCP follows the address", async () => {
    writeFileSync(
      join(dir, "remote-access.json"),
      JSON.stringify({ setupCompletedAt: null, first: "tailscale", mcp: { host: true } }),
    );
    const { host, hostAccess } = addresses();
    host.state.funnel = true;
    await hostAccess.publish(false);
    expect(host.service.publish).toHaveBeenLastCalledWith(false);
  });

  test("keeping anything off the Internet while Funnel is on needs a Tailscale that marks Funnel requests", async () => {
    const { policy, host, hostAccess, settings } = addresses();
    host.state.version = "1.96.2";
    expect(await policy.update({ host: "public" })).toEqual({
      ok: false,
      reason: TAILSCALE_TOO_OLD,
    });
    expect(host.service.publish).not.toHaveBeenCalled();
    expect(settings.get().mcp).toBeUndefined();
    // Everything on the Internet, or nothing, needs no header.
    expect(await hostAccess.publish(true)).toMatchObject({ ok: true });
    expect(await hostAccess.publish(false)).toMatchObject({ ok: true });
    host.state.version = null;
    expect(await policy.update({ host: "public" })).toMatchObject({ reason: TAILSCALE_TOO_OLD });
    expect(marksFunnelRequests("1.104.0")).toBe(true);
    expect(marksFunnelRequests("2.0.1")).toBe(true);
    expect(marksFunnelRequests("1.103.9")).toBe(false);
    expect(marksFunnelRequests("unknown")).toBe(false);
  });

  test("a failed look keeps this computer's address as an issuer", async () => {
    const { policy, host, advance } = addresses();
    await policy.settle();
    expect(policy.hostIssuer()).toEqual([HOST]);
    host.service.status.mockRejectedValueOnce(new Error("timed out"));
    advance(60_000);
    await policy.settle();
    await vi.waitFor(() => expect(host.service.status).toHaveBeenCalledTimes(2));
    expect(policy.hostIssuer()).toEqual([HOST]);
  });
});

describe("this computer's Tailscale address as an OAuth issuer", () => {
  test("is offered while it serves the gateway and MCP answers there", async () => {
    const { policy, host } = addresses();
    await policy.settle();
    expect(policy.hostIssuer()).toEqual([HOST]);
    await policy.update({ host: "off" });
    expect(policy.hostIssuer()).toEqual([]);
    await policy.update({ host: "private" });
    host.state.served = false;
    await policy.list();
    expect(policy.hostIssuer()).toEqual([]);
  });

  test("gives way to a public address saved on the same origin, as an upgraded gateway has", async () => {
    const { policy } = addresses({ publicBaseUrl: () => `${HOST}/` });
    await policy.settle();
    expect(policy.hostIssuer()).toEqual([]);
  });

  test("names the port Tailscale serves the gateway on", async () => {
    const { policy, host } = addresses();
    await policy.settle();
    host.state.port = 8443;
    await policy.list();
    expect(policy.hostIssuer()).toEqual(["https://studio.example-net.ts.net:8443"]);
    expect(policy.hostReach("https://studio.example-net.ts.net:8443/mcp")).toBe("private");
    expect(policy.hostReach(`${DOMAIN}/mcp`)).toBeNull();
    host.state.funnel = true;
    await policy.list();
    expect(policy.hostReach("https://studio.example-net.ts.net:8443/mcp")).toBe("public");
  });
});

describe("the home network", () => {
  const HOME = ["https://omnesis.local:7600", "https://192.168.0.20:7600"];
  const homeRequest = (
    url: string,
    over: Partial<Parameters<McpAddresses["homeSignIn"]>[0]> = {},
  ) => ({
    url,
    via: null,
    relayed: false,
    funnel: false,
    fromHomeNetwork: true,
    ...over,
  });

  test("is offered only where the gateway listens beyond this machine, and starts off", async () => {
    expect(addresses().policy.offered()).not.toContain("home");
    const { policy, settings } = addresses({ home: { origins: () => Promise.resolve(HOME) } });
    expect(policy.offered()[0]).toBe("home");
    expect((await policy.list())[0]).toEqual({
      id: "home",
      url: HOME[0],
      urls: HOME,
      reach: "off",
      choices: ["off", "on"],
      available: true,
    });
    expect(await policy.homeNetwork()).toEqual({ allowed: false, origins: HOME });
    // Off is the default: nothing is written until the owner chooses.
    expect(settings.get().mcp).toBeUndefined();
  });

  test("without any address of its own on the home network the row is not available", async () => {
    const { policy } = addresses({ home: { origins: () => Promise.resolve([]) } });
    expect((await policy.list())[0]).toMatchObject({ id: "home", url: null, available: false });
  });

  test("turning it on is a loosening, and nothing about it ever refuses a request", async () => {
    const { policy } = addresses({ home: { origins: () => Promise.resolve(HOME) } });
    expect(policy.loosens({ home: "on" })).toBe(true);
    expect(policy.loosens({ home: "off" })).toBe(false);
    for (const allowed of ["off", "on"] as const) {
      await policy.update({ home: allowed });
      expect(await policy.refusal(request("https://omnesis.local:7600/mcp"))).toBeNull();
      expect(await policy.refusal(request("https://192.168.0.20:7600/oauth/token"))).toBeNull();
    }
    expect(policy.loosens({ home: "on" })).toBe(false);
  });

  test("a request signs in on the home network only while it is on, straight from a private network", async () => {
    const { policy } = addresses({ home: { origins: () => Promise.resolve(HOME) } });
    const lan = "https://192.168.0.20:7600/oauth/token";
    expect(await policy.homeSignIn(homeRequest(lan))).toBe(false);
    expect(policy.homeResource("https://omnesis.local:7600/mcp")).toBe(false);
    await policy.update({ home: "on" });
    expect(await policy.homeSignIn(homeRequest(lan))).toBe(true);
    // The port may differ, as behind Docker's published one: the name is what counts.
    expect(await policy.homeSignIn(homeRequest("https://omnesis.local:8443/mcp"))).toBe(true);
    expect(policy.homeResource("https://omnesis.local:7600/mcp")).toBe(true);
    // Not through the relay, the tailnet device or Funnel, and not from outside.
    expect(await policy.homeSignIn(homeRequest(lan, { relayed: true }))).toBe(false);
    expect(await policy.homeSignIn(homeRequest(lan, { via: "tailnet" }))).toBe(false);
    expect(await policy.homeSignIn(homeRequest(lan, { funnel: true }))).toBe(false);
    expect(await policy.homeSignIn(homeRequest(lan, { fromHomeNetwork: false }))).toBe(false);
    // A name the client makes up never becomes an issuer, however local it looks.
    for (const made of [
      "https://studio.lan:7600/mcp",
      "https://attacker:7600/mcp",
      "https://192.168.0.99:7600/mcp",
      "https://localhost:7600/mcp",
      "https://omnesis.example.org/mcp",
    ])
      expect(await policy.homeSignIn(homeRequest(made)), made).toBe(false);
    await policy.update({ home: "off" });
    expect(await policy.homeSignIn(homeRequest(lan))).toBe(false);
    expect(policy.homeResource("https://192.168.0.20:7600/mcp")).toBe(false);
  });

  test("a home-network name that is the owner's own public address keeps its own issuer", async () => {
    const { policy } = addresses({
      home: { origins: () => Promise.resolve(HOME) },
      publicBaseUrl: () => "https://omnesis.local:7600",
    });
    await policy.update({ home: "on" });
    expect(await policy.homeSignIn(homeRequest("https://omnesis.local:7600/mcp"))).toBe(false);
    expect(await policy.homeSignIn(homeRequest("https://192.168.0.20:7600/mcp"))).toBe(true);
  });

  test("its addresses are looked up again only once they are half a minute old", async () => {
    const origins = vi.fn(() => Promise.resolve(HOME));
    const { policy, advance } = addresses({ home: { origins } });
    await policy.list();
    await policy.homeNetwork();
    expect(origins).toHaveBeenCalledTimes(1);
    advance(30_000);
    await policy.homeNetwork();
    expect(origins).toHaveBeenCalledTimes(2);
  });
});

describe("each address's own MCP resource", () => {
  test("is the address's origin and /mcp, once the address is known", async () => {
    const { policy, host } = addresses();
    // This computer's name is not known until Tailscale there has been asked.
    expect(policy.resourceAt("host")).toBeNull();
    await policy.settle();
    expect(policy.resourceAt("relay")).toBe(`${RELAY}/mcp`);
    expect(policy.resourceAt("tailnet")).toBe(`${TAILNET}/mcp`);
    expect(policy.resourceAt("host")).toBe(`${HOST}/mcp`);
    expect(policy.resourceAt("domain")).toBe(`${DOMAIN}/mcp`);
    expect(policy.resourceAt("home")).toBeNull();
    host.state.port = 8443;
    await policy.list();
    expect(policy.resourceAt("host")).toBe(`${HOST}:8443/mcp`);
  });

  test("is none for an address the gateway does not have", () => {
    const { policy } = addresses({
      relayOrigin: () => undefined,
      publicBaseUrl: () => undefined,
      tailscale: undefined,
      host: undefined,
    });
    for (const id of ["relay", "tailnet", "host", "domain"] as const)
      expect(policy.resourceAt(id)).toBeNull();
  });
});
