// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

function flags({ relay = true, tailscale = true } = {}) {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", relay ? "1" : "");
  vi.stubEnv("OMNESIS_TAILSCALE_EMBED_ENABLED", tailscale ? "1" : "");
}

function addresses(overrides: Partial<McpAddressesOptions> = {}) {
  let publicAccess = false;
  const tailscale = {
    tailnetOrigin: () => TAILNET,
    settings: { get: () => ({ publicAccess }) },
    updateSettings: vi.fn(async (patch: { publicAccess?: boolean }) => {
      publicAccess = patch.publicAccess ?? publicAccess;
      return {} as never;
    }),
  };
  let hostName: string | null = "Studio.example-net.ts.net";
  const hostTailscale = {
    status: vi.fn(async () =>
      hostName
        ? {
            state: "available" as const,
            dnsName: hostName,
            port: 443,
            url: `https://${hostName}`,
            servesGateway: true,
            publicGateway: false,
          }
        : { state: "unavailable" as const, reason: "Tailscale is not running on this computer." },
    ),
  };
  let clock = 1_000_000;
  const settings = new RemoteAccessSettingsStore(dir);
  const policy = new McpAddresses({
    settings,
    publicBaseUrl: () => DOMAIN,
    relayOrigin: () => RELAY,
    relayState: async () => ({ origin: RELAY, serving: true }),
    tailscale: tailscale as unknown as McpAddressesOptions["tailscale"],
    hostTailscale,
    now: () => clock,
    ...overrides,
  });
  return {
    policy,
    settings,
    tailscale,
    hostTailscale,
    renameHost: (name: string | null) => {
      hostName = name;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Each offered address and whether it is on, as the owner sees the list. */
async function switches(policy: McpAddresses) {
  return Object.fromEntries((await policy.list()).map((row) => [row.id, row.enabled]));
}

const mcp = (url: string, via: "tailnet" | "public" | null = null, relayed = false) => ({
  url,
  path: new URL(url).pathname,
  via,
  relayed,
});

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
  test("every address answers until the owner turns one off, and nothing is written for it", async () => {
    flags();
    const { policy } = addresses();
    expect(await policy.list()).toEqual([
      { id: "relay", url: RELAY, enabled: true, available: true },
      { id: "tailnet", url: TAILNET, enabled: true, available: true },
      { id: "tailscalePublic", url: TAILNET, enabled: false, available: true },
      { id: "host", url: HOST, enabled: true, available: true },
      { id: "domain", url: DOMAIN, enabled: true, available: true },
    ]);
    for (const url of [`${RELAY}/mcp`, `${TAILNET}/mcp`, `${HOST}/mcp`, `${DOMAIN}/mcp`]) {
      expect(await policy.refusal(mcp(url)), url).toBeNull();
      expect(policy.answersAt(url), url).toBe(true);
    }
    expect(await policy.refusal(mcp(`${TAILNET}/mcp`, "tailnet"))).toBeNull();
    expect(existsSync(join(dir, "remote-access.json"))).toBe(false);
  });

  test("an address that is not set up is listed as unavailable, with what is known of it", async () => {
    flags();
    const { policy, renameHost } = addresses({
      publicBaseUrl: () => undefined,
      relayOrigin: () => undefined,
      relayState: async () => ({ origin: undefined, serving: false }),
      tailscale: {
        tailnetOrigin: () => null,
        settings: { get: () => ({ publicAccess: false }) },
        updateSettings: vi.fn(),
      } as unknown as McpAddressesOptions["tailscale"],
    });
    renameHost(null);
    expect(await policy.list()).toEqual([
      { id: "relay", url: null, enabled: true, available: false },
      { id: "tailnet", url: null, enabled: true, available: false },
      { id: "tailscalePublic", url: null, enabled: false, available: false },
      { id: "host", url: null, enabled: true, available: false },
      { id: "domain", url: null, enabled: true, available: false },
    ]);
  });

  test("the relay row follows the relay's live state, not the origin known at start", async () => {
    flags();
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
    expect(await relayRow()).toEqual({ id: "relay", url: LIVE, enabled: true, available: false });
    status = { ...status, enrollment: { state: "enrolled" } };
    expect(await relayRow()).toMatchObject({ url: LIVE, available: true });
    // Turned off by the owner: enrolled, but no longer serving.
    status = { ...status, enabled: false };
    expect(await relayRow()).toMatchObject({ available: false });
    // Never configured.
    status = { publicOrigin: undefined, enabled: false, enrollment: { state: "unconfigured" } };
    expect(await relayRow()).toEqual({ id: "relay", url: null, enabled: true, available: false });
  });

  test("a relay whose state cannot be read is listed as unavailable", async () => {
    flags();
    const { policy } = addresses({
      relayState: async () => {
        throw new Error("status unreadable");
      },
    });
    expect((await policy.list())[0]).toEqual({
      id: "relay",
      url: RELAY,
      enabled: true,
      available: false,
    });
  });

  test("offers the relay only with the relay opt-in and the gateway's own Tailscale only with its opt-in", async () => {
    flags({ relay: false, tailscale: false });
    expect(await switches(addresses().policy)).toEqual({ host: true, domain: true });
    flags({ relay: true, tailscale: false });
    expect(await switches(addresses().policy)).toEqual({ relay: true, host: true, domain: true });
    flags({ relay: false, tailscale: true });
    expect(await switches(addresses().policy)).toEqual({
      tailnet: true,
      tailscalePublic: false,
      host: true,
      domain: true,
    });
    // Without the device wired there is no public-address switch to read.
    expect(await switches(addresses({ tailscale: undefined }).policy)).toEqual({
      tailnet: true,
      host: true,
      domain: true,
    });
    // Without a port to forward to, Tailscale on this computer is no address.
    expect(await switches(addresses({ hostTailscale: undefined }).policy)).toEqual({
      tailnet: true,
      tailscalePublic: false,
      domain: true,
    });
  });

  test("with neither opt-in, this computer's Tailscale and the own domain are still enforced", async () => {
    flags({ relay: false, tailscale: false });
    const { policy } = addresses();
    await policy.update({ host: false, domain: false });
    expect(await policy.refusal(mcp(`${HOST}/mcp`))).toBe("host");
    expect(await policy.refusal(mcp(`${DOMAIN}/oauth/token`))).toBe("domain");
    // The relay and tailnet names mean nothing here.
    expect(await policy.refusal(mcp(`${RELAY}/mcp`, null, true))).toBeNull();
    expect(await policy.refusal(mcp(`${TAILNET}/mcp`, "tailnet"))).toBeNull();
  });

  test("an address turned off refuses MCP's paths by host, whatever its case or port", async () => {
    flags();
    const { policy } = addresses();
    await policy.update({ domain: false });
    expect(await policy.refusal(mcp("https://OMNESIS.example.org:8443/mcp"))).toBe("domain");
    expect(await policy.refusal(mcp("https://omnesis.example.org/oauth/token"))).toBe("domain");
    expect(
      await policy.refusal(
        mcp("https://omnesis.example.org/.well-known/oauth-protected-resource/mcp"),
      ),
    ).toBe("domain");
    // The rest of that address, and the other addresses, are untouched.
    expect(await policy.refusal(mcp("https://omnesis.example.org/portal"))).toBeNull();
    expect(await policy.refusal(mcp("https://omnesis.example.org/oauth/callback"))).toBeNull();
    expect(await policy.refusal(mcp(`${RELAY}/mcp`))).toBeNull();
    expect(await policy.refusal(mcp(`${TAILNET}/mcp`))).toBeNull();
    expect(await policy.refusal(mcp(`${HOST}/mcp`))).toBeNull();
    expect(policy.answersAt(`${DOMAIN}/mcp`)).toBe(false);
    expect(policy.answersAt(`${RELAY}/mcp`)).toBe(true);

    await policy.update({ domain: true, relay: false });
    expect(await policy.refusal(mcp(`${DOMAIN}/mcp`))).toBeNull();
    expect(await policy.refusal(mcp(`${RELAY}/oauth/authorize`))).toBe("relay");
  });

  test("a domain on an IPv6 address is matched with its brackets", async () => {
    flags();
    const { policy } = addresses({ publicBaseUrl: () => "https://[2001:db8::7]:7600" });
    await policy.update({ domain: false });
    expect(await policy.refusal(mcp("https://[2001:db8::7]:7600/mcp"))).toBe("domain");
    expect(await policy.refusal(mcp("https://[2001:DB8::7]/mcp"))).toBe("domain");
    expect(await policy.refusal(mcp("https://[2001:db8::8]:7600/mcp"))).toBeNull();
  });

  test("loopback always answers, even when it is the configured domain", async () => {
    flags();
    const { policy } = addresses({ publicBaseUrl: () => "https://localhost:7600" });
    await policy.update({ domain: false, relay: false, tailnet: false, host: false });
    for (const url of [
      "https://localhost:7600/mcp",
      "https://127.0.0.1:7600/mcp",
      "https://[::1]:7600/mcp",
    ]) {
      expect(await policy.refusal(mcp(url)), url).toBeNull();
    }
    expect(await policy.refusal(mcp("https://192.0.2.20:7600/mcp"))).toBeNull();
  });

  test("a request through the relay is the relay address whatever Host it names", async () => {
    flags();
    const { policy } = addresses();
    await policy.update({ relay: false });
    expect(await policy.refusal(mcp("https://localhost:7600/mcp", null, true))).toBe("relay");
    expect(await policy.refusal(mcp(`${DOMAIN}/oauth/token`, null, true))).toBe("relay");
    expect(await policy.refusal(mcp("https://localhost:7600/mcp"))).toBeNull();
    flags({ relay: false });
    expect(await policy.refusal(mcp("https://localhost:7600/mcp", null, true))).toBeNull();
  });

  test("the tailnet address is a request from the tailnet, or one naming the device; the public address is not", async () => {
    flags();
    const { policy } = addresses();
    await policy.update({ tailnet: false });
    expect(await policy.refusal(mcp("https://192.0.2.9/mcp", "tailnet"))).toBe("tailnet");
    expect(await policy.refusal(mcp(`${TAILNET}/mcp`, "tailnet"))).toBe("tailnet");
    expect(await policy.refusal(mcp(`${TAILNET}/mcp`))).toBe("tailnet");
    // A request through the public address is that address's, whose own switch the helper applies.
    expect(await policy.refusal(mcp(`${TAILNET}/mcp`, "public"))).toBeNull();
    expect(await policy.refusal(mcp(`${TAILNET}/portal`, "tailnet"))).toBeNull();
  });

  test("this computer's address is recognised by its MagicDNS name, whatever its case", async () => {
    flags();
    const { policy } = addresses();
    await policy.update({ host: false });
    expect(await policy.refusal(mcp("https://STUDIO.example-net.ts.net/mcp"))).toBe("host");
    expect(await policy.refusal(mcp("https://studio.example-net.ts.net./oauth/register"))).toBe(
      "host",
    );
    expect(await policy.refusal(mcp(`${HOST}/portal`))).toBeNull();
    expect(await policy.refusal(mcp(`${DOMAIN}/mcp`))).toBeNull();
    expect(policy.answersAt(`${HOST}/mcp`)).toBe(false);
  });

  test("a switch already off refuses by this computer's name from the first request after a start", async () => {
    flags();
    const first = addresses();
    await first.policy.update({ host: false });
    // A new gateway on the same file: the first request waits for the name.
    const { policy, hostTailscale } = addresses();
    expect(await policy.refusal(mcp(`${HOST}/mcp`))).toBe("host");
    expect(hostTailscale.status).toHaveBeenCalledTimes(1);
    // Paths outside MCP never ask Tailscale.
    await policy.refusal(mcp(`${HOST}/portal`));
    expect(hostTailscale.status).toHaveBeenCalledTimes(1);
  });

  test("this computer's name is looked up again in the background once a minute old", async () => {
    flags();
    const { policy, hostTailscale, renameHost, advance } = addresses();
    await policy.update({ host: false });
    const looks = hostTailscale.status.mock.calls.length;
    renameHost("atelier.example-net.ts.net");
    advance(30_000);
    expect(await policy.refusal(mcp(`${HOST}/mcp`))).toBe("host");
    expect(hostTailscale.status).toHaveBeenCalledTimes(looks);
    advance(30_000);
    // The stale name still answers this request; the new one is learnt for the next.
    expect(await policy.refusal(mcp(`${HOST}/mcp`))).toBe("host");
    await vi.waitFor(() => expect(hostTailscale.status).toHaveBeenCalledTimes(looks + 1));
    expect(await policy.refusal(mcp("https://atelier.example-net.ts.net/mcp"))).toBe("host");
    expect(await policy.refusal(mcp(`${HOST}/mcp`))).toBeNull();
  });

  test("while this computer's address and the domain answer, Tailscale is never asked on a request", async () => {
    flags();
    const { policy, hostTailscale } = addresses();
    await policy.update({ tailnet: false });
    await policy.refusal(mcp(`${HOST}/mcp`));
    await policy.settle();
    expect(hostTailscale.status).not.toHaveBeenCalled();
  });

  test("a failed look keeps refusing by the name already known", async () => {
    flags();
    const { policy, hostTailscale, advance } = addresses();
    await policy.update({ host: false });
    hostTailscale.status.mockRejectedValueOnce(new Error("timed out"));
    advance(60_000);
    await policy.settle();
    await vi.waitFor(() => expect(hostTailscale.status).toHaveBeenCalledTimes(2));
    expect(await policy.refusal(mcp(`${HOST}/mcp`))).toBe("host");
  });

  test("discovery keeps the tailnet name while either the tailnet or the public address answers", async () => {
    flags();
    const { policy } = addresses();
    await policy.update({ tailnet: false });
    expect(policy.answersAt(`${TAILNET}/mcp`)).toBe(false);
    await policy.update({ tailscalePublic: true });
    expect(policy.answersAt(`${TAILNET}/mcp`)).toBe(true);
  });

  test("a public address that is the relay's is the relay's, under the relay's switch alone", async () => {
    flags();
    const { policy } = addresses({ publicBaseUrl: () => RELAY });
    expect(await policy.publicAddressWay()).toBe("relay");
    expect((await policy.list()).find((row) => row.id === "domain")?.available).toBe(false);
    await policy.update({ domain: false });
    expect(await policy.refusal(mcp(`${RELAY}/mcp`))).toBeNull();
    await policy.update({ relay: false });
    expect(await policy.refusal(mcp(`${RELAY}/mcp`))).toBe("relay");
  });

  test("a public address that is this computer's Tailscale name has one row and one switch, the host's", async () => {
    flags();
    const { policy } = addresses({ publicBaseUrl: () => HOST });
    expect(await policy.publicAddressWay()).toBe("host");
    const rows = (await policy.list()).filter((row) => row.available);
    expect(rows.map((row) => row.id)).not.toContain("domain");
    expect(rows.find((row) => row.id === "host")?.url).toBe(HOST);
    // A domain switch turned off before the address was the host's no longer refuses it.
    await policy.update({ domain: false });
    expect(await policy.refusal(mcp(`${HOST}/mcp`))).toBeNull();
    await policy.update({ host: false });
    expect(await policy.refusal(mcp(`${HOST}/mcp`))).toBe("host");
  });

  test("a domain switch already off waits for this computer's name before refusing its own address", async () => {
    flags();
    const first = addresses({ publicBaseUrl: () => HOST });
    await first.policy.update({ domain: false });
    const { policy, hostTailscale } = addresses({ publicBaseUrl: () => HOST });
    expect(await policy.refusal(mcp(`${HOST}/mcp`))).toBeNull();
    expect(hostTailscale.status).toHaveBeenCalled();
  });

  test("a public address that is the gateway's own Tailscale device is the tailnet's", async () => {
    flags();
    const { policy } = addresses({ publicBaseUrl: () => TAILNET });
    expect(await policy.publicAddressWay()).toBe("tailnet");
    expect((await policy.list()).find((row) => row.id === "domain")?.available).toBe(false);
  });

  test("the owner's own domain is nobody else's, and keeps its row", async () => {
    flags();
    const { policy } = addresses();
    expect(await policy.publicAddressWay()).toBeNull();
    expect((await policy.list()).find((row) => row.id === "domain")).toMatchObject({
      url: DOMAIN,
      available: true,
    });
  });

  test("a relay address is recognised only with the relay opt-in", async () => {
    flags();
    const { policy, settings } = addresses();
    await policy.update({ relay: false });
    flags({ relay: false });
    expect(await policy.refusal(mcp(`${RELAY}/mcp`))).toBeNull();
    // The choice is kept for when the opt-in returns.
    expect(settings.get().mcp).toEqual({ relay: false });
  });

  test("the public Tailscale address is the device's own setting, read and written through it", async () => {
    flags();
    const { policy, settings, tailscale } = addresses();
    await policy.update({ tailscalePublic: true });
    expect((await switches(policy)).tailscalePublic).toBe(true);
    expect(tailscale.updateSettings).toHaveBeenCalledWith({ publicAccess: true });
    expect(settings.get().mcp).toBeUndefined();
    // Asking for what is already so writes nothing.
    await policy.update({ tailscalePublic: true });
    expect(tailscale.updateSettings).toHaveBeenCalledTimes(1);
  });

  test("only turning an address on loosens the gateway", async () => {
    flags();
    const { policy } = addresses();
    expect(policy.loosens({ relay: false, domain: false, host: false })).toBe(false);
    expect(policy.loosens({ domain: true, host: true })).toBe(false);
    expect(policy.loosens({ tailscalePublic: true })).toBe(true);
    expect(policy.loosens({ tailscalePublic: false })).toBe(false);
    await policy.update({ domain: false, host: false });
    expect(policy.loosens({ domain: true })).toBe(true);
    expect(policy.loosens({ host: true })).toBe(true);
    expect(policy.loosens({ relay: true, domain: false })).toBe(false);
    for (const unreadable of [undefined, null, "domain", 1, { domain: "yes" }]) {
      expect(policy.loosens(unreadable)).toBe(false);
    }
  });

  test("refuses a switch for an address the gateway does not offer", async () => {
    flags({ relay: false, tailscale: false });
    const { policy, settings } = addresses();
    await expect(policy.update({ relay: false })).rejects.toThrow(/relay/);
    await expect(policy.update({ tailscalePublic: true })).rejects.toThrow(/tailscalePublic/);
    expect(settings.get().mcp).toBeUndefined();
  });
});
