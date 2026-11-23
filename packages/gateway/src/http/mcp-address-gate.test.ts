// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MCP_ADDRESS_OFF_MESSAGE } from "../mcp/address-off-server.js";
import { FUNNEL_REQUEST_HEADER, HostAccess } from "../remote-access/host-access.js";
import { McpAddresses } from "../remote-access/mcp-addresses.js";
import { RemoteAccessSettingsStore } from "../remote-access/settings.js";
import { mcpAddressGate } from "./mcp-address-gate.js";
import type { HostTailscaleService } from "../remote-access/host-tailscale.js";
import type { AppEnv } from "./routes/types.js";

const HOST = "https://studio.example-net.ts.net";

// The sockets the relay tunnel in this process dialled; the table itself is tested in cloud-relay.
const tunnelSockets = vi.hoisted(() => new Set<string>());
vi.mock("@omnesis/cloud-relay", async (original) => ({
  ...(await original<typeof import("@omnesis/cloud-relay")>()),
  isRelayTunnelPeer: (peer: { remoteAddress?: string; remotePort?: number }) =>
    tunnelSockets.has(`${peer.remoteAddress}|${peer.remotePort}`),
}));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-address-gate-"));
});
afterEach(() => {
  tunnelSockets.clear();
  rmSync(dir, { recursive: true, force: true });
});

/** Tailscale on this computer serving the gateway through Funnel, its pages kept off the Internet. */
function gateway() {
  const host = {
    status: vi.fn(async () => ({
      state: "available" as const,
      dnsName: "studio.example-net.ts.net",
      version: "1.104.6",
      port: 443,
      url: HOST,
      servesGateway: true,
      publicGateway: true,
      taken: [],
    })),
    publish: vi.fn(),
    unpublish: vi.fn(),
  } as unknown as HostTailscaleService;
  const settings = new RemoteAccessSettingsStore(dir);
  settings.update({ hostApi: "private" });
  const addresses = new McpAddresses({
    settings,
    publicBaseUrl: () => undefined,
    // A gateway that never connected to the relay.
    relayOrigin: () => undefined,
    host: new HostAccess(host, settings),
  });
  const app = new Hono<AppEnv>();
  app.use("*", mcpAddressGate(addresses));
  app.get("*", (c) => c.json({ ok: true }));
  return app;
}

/** The bindings a request arrives with: its own socket, as the Node server gives it. */
function arrivingOn(remotePort: number) {
  return { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort } } };
}

const funnel = { [FUNNEL_REQUEST_HEADER]: "?1" };

test("a request Funnel forwarded from the Internet reaches no page kept off it, whatever it claims", async () => {
  const app = gateway();
  const get = (headers: Record<string, string>) =>
    app.request(`${HOST}/portal/api/session`, { headers }, arrivingOn(41_000));
  expect((await get(funnel)).status).toBe(404);
  // Claiming to come through the relay does not lift the refusal.
  expect((await get({ ...funnel, "x-omnesis-cloud-relay": "1" })).status).toBe(404);
  // On the tailnet, without Funnel, the page answers.
  expect((await get({})).status).toBe(200);
});

test("only a request on the relay tunnel's own socket is the relay's, whatever its headers", async () => {
  const app = gateway();
  tunnelSockets.add("127.0.0.1|41001");
  const relayed = await app.request(
    `${HOST}/portal/api/session`,
    // The relay passes a client's headers on, a forged Funnel marker among them.
    { headers: funnel },
    arrivingOn(41_001),
  );
  expect(relayed.status).toBe(200);
  // Any other socket with the same headers is still a Funnel request.
  expect(
    (await app.request(`${HOST}/portal/api/session`, { headers: funnel }, arrivingOn(41_002)))
      .status,
  ).toBe(404);
});

describe("an MCP call on an address the owner turned MCP off on", () => {
  const RELAY = "https://gw-fictional.relay.example.net";
  const TAILNET = "https://omnesis-gw.example-net.ts.net";
  /** Tokens as the access store holds them: each valid for one resource only. */
  const TOKENS: Record<string, string> = {
    "relay-agent-token": `${RELAY}/mcp`,
    "tailnet-agent-token": `${TAILNET}/mcp`,
  };

  /** A gateway reached through the relay and its Tailscale device, the relay's MCP turned off. */
  function relayGateway() {
    const settings = new RemoteAccessSettingsStore(dir);
    const addresses = new McpAddresses({
      settings,
      publicBaseUrl: () => undefined,
      relayOrigin: () => RELAY,
    });
    settings.update({ mcp: { relay: false } });
    const served = vi.fn();
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      mcpAddressGate(addresses, (rawToken, resource) => TOKENS[rawToken] === resource),
    );
    // The real endpoint, which must never run while the address is off.
    app.all("/mcp", (c) => {
      served();
      return c.json({ tools: ["ask_omnesis"] });
    });
    app.get("*", (c) => c.json({ ok: true }));
    return { app, settings, served };
  }

  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "fictional-client", version: "1.0.0" },
    },
  });

  function post(app: Hono<AppEnv>, headers: Record<string, string>, body = initialize) {
    return app.request(`${RELAY}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body,
    });
  }

  async function connect(
    app: Hono<AppEnv>,
    token: string,
    era: "2026-07-28" | "2025-11-25",
  ): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${RELAY}/mcp`), {
      authProvider: { token: () => Promise.resolve(token) },
      fetch: (input, init) => app.fetch(new Request(input, init)),
    });
    const client =
      era === "2026-07-28"
        ? new Client(
            { name: "fictional-client", version: "1.0.0" },
            { versionNegotiation: { mode: { pin: era } }, defaultCacheTtlMs: 0 },
          )
        : new Client(
            { name: "fictional-client", version: "1.0.0" },
            {
              supportedProtocolVersions: [era],
              versionNegotiation: { mode: "legacy" },
              defaultCacheTtlMs: 0,
            },
          );
    await client.connect(transport);
    return client;
  }

  test.each(["2026-07-28", "2025-11-25"] as const)(
    "an agent connected there is told why, over MCP %s, and reaches no tool",
    async (era) => {
      const { app, served } = relayGateway();
      const client = await connect(app, "relay-agent-token", era);
      try {
        expect(client.getInstructions()).toBe(MCP_ADDRESS_OFF_MESSAGE);
        const call = await client.callTool({ name: "ask_omnesis", arguments: { question: "x" } });
        expect(call).toMatchObject({
          isError: true,
          content: [{ type: "text", text: MCP_ADDRESS_OFF_MESSAGE }],
        });
        await expect(client.listTools()).rejects.toThrow(MCP_ADDRESS_OFF_MESSAGE);
      } finally {
        await client.close();
      }
      expect(served).not.toHaveBeenCalled();
    },
  );

  test("the answer is an ordinary MCP exchange nothing may store", async () => {
    const { app } = relayGateway();
    const response = await post(app, { Authorization: "Bearer relay-agent-token" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    // A 2025-era request is answered on a stream holding its one result.
    const data = (await response.text()).match(/^data: (.+)$/mu)?.[1];
    expect(JSON.parse(data!)).toMatchObject({
      id: 1,
      result: { instructions: MCP_ADDRESS_OFF_MESSAGE },
    });
  });

  test("without a token valid for that address, the address still has no MCP", async () => {
    const { app, served } = relayGateway();
    const absent = [
      await post(app, {}),
      await post(app, { Authorization: "Bearer not-a-token" }),
      // A token for another of the gateway's addresses.
      await post(app, { Authorization: "Bearer tailnet-agent-token" }),
      await post(app, { Authorization: "relay-agent-token" }),
      // A browser page, which the endpoint never serves.
      await post(app, {
        Authorization: "Bearer relay-agent-token",
        Origin: "https://elsewhere.example.com",
      }),
    ];
    for (const response of absent) {
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("turned off");
    }
    expect(served).not.toHaveBeenCalled();
  });

  test("a token for the address opens none of the other paths MCP clients use there", async () => {
    const { app } = relayGateway();
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/oauth/register", "/mcp/"]) {
      const response = await app.request(`${RELAY}${path}`, {
        headers: { Authorization: "Bearer relay-agent-token" },
      });
      expect(response.status, path).toBe(404);
    }
  });

  test("turned on again, the request reaches the endpoint as before", async () => {
    const { app, settings, served } = relayGateway();
    settings.update({ mcp: {} });
    const response = await post(app, { Authorization: "Bearer relay-agent-token" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tools: ["ask_omnesis"] });
    expect(served).toHaveBeenCalledTimes(1);
  });
});
