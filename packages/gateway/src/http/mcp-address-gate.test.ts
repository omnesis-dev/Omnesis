// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
