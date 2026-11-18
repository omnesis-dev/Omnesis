// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * MCP per public address through the whole gateway: real OAuth credentials,
 * the MCP client, the access overview the portal reads, and the owner's
 * switches on /admin/remote-access.
 *
 * The first guarantee is the upgrade: an agent that connected through the
 * relay, the tailnet, Tailscale on this computer or the owner's own domain
 * before the switches existed keeps working on a gateway with no
 * remote-access.json, or with one written before them, and that file is left
 * exactly as it was.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { authorizeInteractiveAccess } from "./access/test-utils.js";
import { MCP_ACCESS_SCOPE } from "./access/types.js";
import { AnalyticsDb } from "./analytics-db.js";
import { createDevice } from "./data/repositories/DeviceRepository.js";
import { createToken } from "./data/repositories/TokenRepository.js";
import { createDatabase } from "./db.js";
import { fixedPublicAddress } from "./public-address.js";
import { createServer } from "./server.js";
import { recordTailnetCaller } from "./tailscale-embed/caller.js";
import { TailscaleEmbedService } from "./tailscale-embed/service.js";
import type { IncomingMessage } from "node:http";
import type { CloudRelayManagement } from "@omnesis/cloud-relay";
import type { McpHttpRuntime } from "./http/routes/mcp-streamable.js";
import type { SearchPipeline } from "./search/pipeline.js";

const RELAY = "https://gw-fictional.relay.example.net";
const TAILNET = "https://omnesis-gw.example-net.ts.net";
const HOST = "https://studio.example-net.ts.net";
const DOMAIN = "https://omnesis.example.org";
const PRE_FEATURE_FILE = `${JSON.stringify(
  { setupCompletedAt: "2026-05-01T10:00:00.000Z", first: "relay" },
  null,
  2,
)}\n`;

// Tailscale on this computer answers with a fixed name; no Tailscale command runs.
vi.mock("./remote-access/host-tailscale.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./remote-access/host-tailscale.js")>();
  class FixedHostTailscale extends actual.HostTailscaleService {
    override async status() {
      return {
        state: "available" as const,
        dnsName: "studio.example-net.ts.net",
        version: "1.104.6",
        port: 443,
        url: "https://studio.example-net.ts.net",
        servesGateway: true,
        publicGateway: false,
        taken: [],
      };
    }
  }
  return { ...actual, HostTailscaleService: FixedHostTailscale };
});

/** The device's tailnet name is fixed here; the helper itself never runs. */
class FixedTailnetDevice extends TailscaleEmbedService {
  override tailnetOrigin(): string {
    return TAILNET;
  }
}

let dir: string;
let db: ReturnType<typeof createDatabase>;
let analyticsDb: AnalyticsDb;
let admin: string;
const closeables: Array<{ close(): Promise<unknown> | unknown }> = [];
const apps = new Set<ReturnType<typeof createServer>>();

beforeEach(async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  dir = mkdtempSync(join(tmpdir(), "omnesis-mcp-addresses-"));
  db = createDatabase(join(dir, "gateway.db"));
  analyticsDb = new AnalyticsDb(join(dir, "analytics.db"));
  await analyticsDb.open();
  const device = createDevice(db, { name: "Fictional admin CLI", kind: "cli" });
  admin = createToken(db, device.id, [SCOPE_ADMIN, SCOPE_READ]).token;
});

afterEach(async () => {
  const sessions = await Promise.allSettled(
    closeables.splice(0).map((closeable) => Promise.resolve().then(() => closeable.close())),
  );
  const servers = await Promise.allSettled(
    [...apps].map((app) => Promise.resolve().then(() => app.close())),
  );
  apps.clear();
  const failures = [...sessions, ...servers].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) {
    vi.unstubAllEnvs();
    throw new AggregateError(failures, "MCP address fixture cleanup failed", {
      cause:
        failures.find((error) => ownedProcessCleanupReceipt(error) !== undefined) ?? failures[0],
    });
  }
  await analyticsDb.close();
  db.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function gateway(
  extra: {
    cloudRelayManagement?: CloudRelayManagement;
    publicAddress?: ReturnType<typeof fixedPublicAddress>;
  } = {},
) {
  const app = createServer(db, join(dir, "gateway.db"), {
    configDir: dir,
    analyticsDb,
    searchPipeline: {} as SearchPipeline,
    port: 17631,
    // An agent reaches this computer's Tailscale name as a resource the owner configured.
    publicAddress: fixedPublicAddress(DOMAIN, [`${DOMAIN}/mcp`, `${HOST}/mcp`]),
    additionalOAuthIssuerUrls: [RELAY, TAILNET],
    relayPublicOrigin: () => RELAY,
    tailscaleEmbed: new FixedTailnetDevice({
      configDir: dir,
      tlsMaterial: () => ({ cert: "", key: "" }),
      joins: { notifyWaiting: () => {}, notifyJoined: () => {} },
      resolveBinary: () => ({ path: null, reason: "not in this test" }),
    }),
    onMcpHttpRuntime: (runtime: McpHttpRuntime) => closeables.push(runtime),
    ...extra,
  });
  apps.add(app);
  /** A request as the tailnet helper's socket hands it over. */
  const fromTailnet = (): { incoming: IncomingMessage } => {
    const incoming = {
      headers: {},
      socket: { remoteAddress: "127.0.0.1", remotePort: 0 },
    } as unknown as IncomingMessage;
    recordTailnetCaller(incoming, { via: "tailnet", client: "192.0.2.9:41000" });
    return { incoming };
  };
  /** A request as software on the gateway's own machine sends it, over loopback. */
  const fromThisMachine = (): { incoming: IncomingMessage } => ({
    incoming: {
      headers: {},
      socket: { remoteAddress: "127.0.0.1", remotePort: 50000 },
    } as unknown as IncomingMessage,
  });
  const send = (url: string, init: RequestInit = {}, from: boolean | "local" = false) =>
    app.fetch(
      new Request(url, init),
      from === "local" ? fromThisMachine() : from ? fromTailnet() : undefined,
    );
  const adminRequest = (method: string, body?: unknown) =>
    send("https://localhost:7600/admin/remote-access", {
      method,
      headers: {
        authorization: `Bearer ${admin}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, send, adminRequest };
}

/** An agent that connected to `origin` and holds its credential. */
function connectedAgent(origin: string) {
  return authorizeInteractiveAccess(db, {
    selection: {
      kind: "new-principal",
      principalName: `Agent on ${new URL(origin).hostname}`,
      grantName: "Whole-corpus Direct",
      rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
      credentialLabel: "Fictional agent credential",
      expiresAt: null,
    },
    resource: `${origin}/mcp`,
    scope: MCP_ACCESS_SCOPE,
  }).tokens.accessToken;
}

async function listTools(
  send: ReturnType<typeof gateway>["send"],
  origin: string,
  token: string,
): Promise<string[]> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    authProvider: { token: async () => token },
    fetch: async (input, init) =>
      send(
        String(input instanceof Request ? input.url : input),
        init,
        origin === TAILNET ? true : origin === LOCAL ? "local" : false,
      ),
  });
  const client = new Client(
    { name: "mcp-address-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  closeables.push(transport, client);
  await client.connect(transport);
  return (await client.listTools()).tools.map((tool) => tool.name);
}

const initialize = (token: string) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "mcp-address-test", version: "1.0.0" },
    },
  }),
});

async function listedResources(send: ReturnType<typeof gateway>["send"]) {
  const overview = (await (
    await send("https://localhost:7600/admin/access", {
      headers: { authorization: `Bearer ${admin}` },
    })
  ).json()) as { oauth: { resource: string; resources: Array<{ resource: string }> } };
  return {
    resource: overview.oauth.resource,
    resources: overview.oauth.resources.map((entry) => entry.resource),
  };
}

function reachById(state: { mcpAddresses: Array<{ id: string; reach: string }> }) {
  return Object.fromEntries(state.mcpAddresses.map((row) => [row.id, row.reach]));
}

/** The address software on the gateway's own machine signs in through. */
const LOCAL = "https://localhost:17631";

describe("upgrading leaves every connected agent working", () => {
  for (const [label, file] of [
    ["no remote-access.json", null],
    ["a remote-access.json written before the MCP switches", PRE_FEATURE_FILE],
  ] as const) {
    test(`with ${label}`, async () => {
      const path = join(dir, "remote-access.json");
      if (file) writeFileSync(path, file);
      const origins = [RELAY, TAILNET, HOST, DOMAIN];
      const tokens = Object.fromEntries(origins.map((origin) => [origin, connectedAgent(origin)]));
      const { send, adminRequest } = gateway();
      for (const origin of origins) {
        expect(await listTools(send, origin, tokens[origin]!), origin).toContain("run_sql");
      }
      expect(reachById(await (await adminRequest("GET")).json())).toEqual({
        relay: "public",
        tailnet: "private",
        host: "private",
        domain: "on",
      });
      // Discovery lists what it listed before the choices existed, in the same order.
      expect(await listedResources(send)).toEqual({
        resource: `${DOMAIN}/mcp`,
        resources: [`${DOMAIN}/mcp`, `${RELAY}/mcp`, `${TAILNET}/mcp`, `${HOST}/mcp`],
      });
      // Nothing was written on the way: the file is as it was, or still absent.
      if (file) expect(readFileSync(path, "utf8")).toBe(file);
      else expect(existsSync(path)).toBe(false);
    });
  }
});

describe("an address the owner turned MCP off on", () => {
  test("serves none of MCP's paths there, and the rest of the gateway as before", async () => {
    const { send, adminRequest } = gateway();
    const domainToken = connectedAgent(DOMAIN);
    const relayToken = connectedAgent(RELAY);
    const off = await adminRequest("PATCH", { mcp: { domain: "off" } });
    expect(off.status).toBe(200);
    expect(reachById(await off.json())).toMatchObject({ domain: "off", relay: "public" });

    expect((await send(`${DOMAIN}/mcp`, initialize(domainToken))).status).toBe(404);
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/oauth/authorize?client_id=x",
    ]) {
      expect((await send(`${DOMAIN}${path}`)).status, path).toBe(404);
    }
    expect(
      (
        await send(`${DOMAIN}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "grant_type=refresh_token&refresh_token=x",
        })
      ).status,
    ).toBe(404);
    // The same address still serves everything else, a data source's sign-in return included.
    expect((await send(`${DOMAIN}/health`)).status).toBe(200);
    expect((await send(`${DOMAIN}/portal/login`)).status).toBe(200);
    // A data source's sign-in return is served, and refuses a callback without its state.
    expect((await send(`${DOMAIN}/oauth/callback`)).status).toBe(400);
    // The other addresses, and the gateway's own machine, are untouched.
    expect(await listTools(send, RELAY, relayToken)).toContain("run_sql");
    expect((await send(`${RELAY}/.well-known/oauth-protected-resource/mcp`)).status).toBe(200);
    // On this machine MCP still answers, and asks an unknown credential to sign in there.
    const local = await send(`${LOCAL}/mcp`, initialize("x"), "local");
    expect(local.status).toBe(401);
    expect(local.headers.get("www-authenticate")).toContain(
      `${LOCAL}/.well-known/oauth-protected-resource/mcp`,
    );
    // Discovery drops it, so the portal never offers it.
    expect(await listedResources(send)).toEqual({
      resource: `${RELAY}/mcp`,
      resources: [`${RELAY}/mcp`, `${TAILNET}/mcp`, `${HOST}/mcp`],
    });

    // Turned back on, the agent's existing credential works again.
    expect((await adminRequest("PATCH", { mcp: { domain: "on" } })).status).toBe(200);
    expect(await listTools(send, DOMAIN, domainToken)).toContain("run_sql");
  });

  test("the tailnet address refuses MCP to requests from the tailnet", async () => {
    const { send, adminRequest } = gateway();
    const token = connectedAgent(TAILNET);
    expect((await adminRequest("PATCH", { mcp: { tailnet: "off" } })).status).toBe(200);
    expect((await send(`${TAILNET}/mcp`, initialize(token), true)).status).toBe(404);
    expect((await send(`${TAILNET}/health`, {}, true)).status).toBe(200);
    expect((await listedResources(send)).resources).toEqual([
      `${DOMAIN}/mcp`,
      `${RELAY}/mcp`,
      `${HOST}/mcp`,
    ]);
  });

  test("Tailscale on this computer refuses MCP by the machine's name", async () => {
    const { send, adminRequest } = gateway();
    const token = connectedAgent(HOST);
    expect((await adminRequest("PATCH", { mcp: { host: "off" } })).status).toBe(200);
    expect((await send(`${HOST}/mcp`, initialize(token))).status).toBe(404);
    expect((await send(`${HOST}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404);
    expect((await send(`${HOST}/health`)).status).toBe(200);
    expect((await listedResources(send)).resources).toEqual([
      `${DOMAIN}/mcp`,
      `${RELAY}/mcp`,
      `${TAILNET}/mcp`,
    ]);
    // A gateway started again on the same file refuses from its first request.
    const restarted = gateway();
    expect((await restarted.send(`${HOST}/mcp`, initialize(token))).status).toBe(404);
    expect((await restarted.adminRequest("PATCH", { mcp: { host: "private" } })).status).toBe(200);
    expect(await listTools(restarted.send, HOST, token)).toContain("run_sql");
  });

  test("a request through the relay cannot name another host to reach MCP", async () => {
    const { send, adminRequest } = gateway();
    expect((await adminRequest("PATCH", { mcp: { relay: "off" } })).status).toBe(200);
    const relayed = { "x-omnesis-cloud-relay": "1" };
    for (const url of [
      "https://localhost:7600/mcp",
      "https://localhost:7600/.well-known/oauth-authorization-server",
    ]) {
      expect((await send(url, { headers: relayed })).status, url).toBe(404);
    }
    expect((await send("https://localhost:7600/health", { headers: relayed })).status).toBe(200);
  });
});

describe("the relay row", () => {
  test("follows the relay management's live state, not the origin known at start", async () => {
    const live = "https://g-fictional-2.relay.example.net";
    let relay = { enabled: true, enrollment: "pending" };
    const management = {
      status: async () => ({
        publicOrigin: live,
        enabled: relay.enabled,
        enrollment: { state: relay.enrollment },
      }),
    } as unknown as CloudRelayManagement;
    const { adminRequest } = gateway({ cloudRelayManagement: management });
    const row = async () =>
      (
        (await (await adminRequest("GET")).json()) as {
          mcpAddresses: Array<{ id: string; url: string | null; available: boolean }>;
        }
      ).mcpAddresses.find((entry) => entry.id === "relay");
    // The account is not linked yet: the relay is not a way in, whatever origin is known.
    expect(await row()).toMatchObject({ id: "relay", url: live, available: false });
    relay = { enabled: true, enrollment: "enrolled" };
    expect(await row()).toMatchObject({ id: "relay", url: live, available: true });
    relay = { enabled: false, enrollment: "enrolled" };
    expect((await row())?.available).toBe(false);
  });
});

describe("Tailscale on this computer as a way in of its own", () => {
  test("a public address saved by hand as this computer's Tailscale name keeps every agent working", async () => {
    // Before the gateway knew Tailscale on its computer, the docs had owners save its name.
    const { send, adminRequest } = gateway({ publicAddress: fixedPublicAddress(HOST) });
    const token = connectedAgent(HOST);
    expect(await listTools(send, HOST, token)).toContain("run_sql");
    const state = await (await adminRequest("GET")).json();
    expect(state.publicBaseUrl).toEqual({ configured: HOST, setByEnvironment: false, way: "host" });
    expect(state.mcpAddresses.find((row: { id: string }) => row.id === "domain").available).toBe(
      false,
    );
    // It is listed once, ahead of the other ways in, as before.
    expect(await listedResources(send)).toEqual({
      resource: `${HOST}/mcp`,
      resources: [`${HOST}/mcp`, `${RELAY}/mcp`, `${TAILNET}/mcp`],
    });
    const metadata = await (await send(`${HOST}/.well-known/oauth-authorization-server`)).json();
    expect(metadata.issuer).toBe(HOST);
  });

  test("without a public address its name is an issuer of its own while it serves the gateway", async () => {
    const { send } = gateway({ publicAddress: fixedPublicAddress(undefined) });
    // The gateway learns the name with its first look; the overview waits for it.
    expect((await listedResources(send)).resources).toEqual([
      `${RELAY}/mcp`,
      `${TAILNET}/mcp`,
      `${HOST}/mcp`,
    ]);
    // The portal hears that it answers on the owner's Tailscale network only.
    const overview = (await (
      await send("https://localhost:7600/admin/access", {
        headers: { authorization: `Bearer ${admin}` },
      })
    ).json()) as { oauth: { resources: Array<{ resource: string; tailscaleHost?: string }> } };
    expect(
      overview.oauth.resources.find((entry) => entry.resource === `${HOST}/mcp`),
    ).toMatchObject({
      tailscaleHost: "private",
    });
    const metadata = await (await send(`${HOST}/.well-known/oauth-authorization-server`)).json();
    expect(metadata).toMatchObject({ issuer: HOST, token_endpoint: `${HOST}/oauth/token` });
    const token = connectedAgent(HOST);
    expect(await listTools(send, HOST, token)).toContain("run_sql");
  });

  test("software on the gateway's own machine signs in there, whatever public address the gateway has", async () => {
    const { send, adminRequest } = gateway();
    const resource = await (
      await send(`${LOCAL}/.well-known/oauth-protected-resource/mcp`, {}, "local")
    ).json();
    expect(resource).toMatchObject({ resource: `${LOCAL}/mcp`, authorization_servers: [LOCAL] });
    const metadata = await (
      await send(`${LOCAL}/.well-known/oauth-authorization-server`, {}, "local")
    ).json();
    expect(metadata).toMatchObject({ issuer: LOCAL, token_endpoint: `${LOCAL}/oauth/token` });
    // A request that only names localhost, through Funnel or from another machine, does not.
    const asNamed: Array<Record<string, string>> = [{ "tailscale-funnel-request": "?1" }, {}];
    for (const headers of asNamed) {
      const named = await (
        await send(`${LOCAL}/.well-known/oauth-authorization-server`, { headers })
      ).json();
      expect(named.issuer).toBe(DOMAIN);
    }
    const token = connectedAgent(LOCAL);
    expect(await listTools(send, LOCAL, token)).toContain("run_sql");
    // Its credential is for this machine only.
    expect((await send(`${DOMAIN}/mcp`, initialize(token))).status).toBe(401);
    // With MCP off on every address away from home, the portal still offers this machine's.
    const off = await adminRequest("PATCH", {
      mcp: { relay: "off", tailnet: "off", host: "off", domain: "off" },
    });
    expect(off.status).toBe(200);
    expect(await listedResources(send)).toEqual({
      resource: `${LOCAL}/mcp`,
      resources: [`${LOCAL}/mcp`],
    });
    expect(await listTools(send, LOCAL, token)).toContain("run_sql");
  });

  test("through Funnel, only what the owner put on the Internet answers", async () => {
    writeFileSync(
      join(dir, "remote-access.json"),
      JSON.stringify({
        setupCompletedAt: null,
        first: "tailscale",
        mcp: { host: "public" },
        hostApi: "private",
      }),
    );
    const { send } = gateway();
    const token = connectedAgent(HOST);
    const funnel = { "tailscale-funnel-request": "?1" };
    expect((await send(`${HOST}/portal/login`, { headers: funnel })).status).toBe(404);
    expect((await send(`${HOST}/health`, { headers: funnel })).status).toBe(404);
    expect(
      (await send(`${HOST}/.well-known/oauth-protected-resource/mcp`, { headers: funnel })).status,
    ).toBe(200);
    const mcp = await send(`${HOST}/mcp`, {
      ...initialize(token),
      headers: {
        ...initialize(token).headers,
        accept: "application/json, text/event-stream",
        ...funnel,
      },
    });
    expect(mcp.status).toBe(200);
    // An agent's sign-in page loads its styles and scripts through Funnel too.
    for (const path of ["/portal/css/style.css", "/portal/js/oauth-consent-controller.js"])
      expect((await send(`${HOST}${path}`, { headers: funnel })).status, path).toBe(200);
    // The owner's Tailscale network reaches everything.
    expect((await send(`${HOST}/portal/login`)).status).toBe(200);
  });
});
