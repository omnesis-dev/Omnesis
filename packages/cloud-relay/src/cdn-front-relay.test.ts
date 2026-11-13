// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, createServer, type Socket } from "node:net";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { echoGateway, fixture as relayFixture, until } from "../test/support.js";
import { parseTrustedProxies, type CdnFront } from "./cdn-front.js";
import { ProxyProtocolPeers } from "./proxy-protocol.js";
import { startRelayDaemon } from "./runtime.js";

beforeEach(() => vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1"));
afterEach(() => vi.unstubAllEnvs());

const EDGE = "::1";
const fixture = (extra: Parameters<typeof relayFixture>[0] = {}) =>
  relayFixture(extra, { ipv6Loopback: true });
const limits = { maxConcurrent: 8, maxPerMinute: 60, maxPerMinutePerClient: 2 };

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
}

/** One request to the control listener from `from`, optionally over a prepared connection. */
function send(
  url: string,
  from: string,
  path: string,
  headers: Record<string, string | string[]> = {},
  socket?: Socket,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = path === "/_relay/v1/login" ? JSON.stringify({ idToken: "not-a-token" }) : "";
    const req = httpRequest(
      new URL(path, url),
      {
        ...(socket ? { createConnection: () => socket } : { hostname: from, localAddress: from }),
        method: body ? "POST" : "GET",
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          "content-length": Buffer.byteLength(body),
          connection: "close",
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve({ status: res.statusCode!, headers: res.headers }));
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

const login = async (url: string, from: string, client?: string | string[]) =>
  (await send(url, from, "/_relay/v1/login", client ? { "cf-connecting-ip": client } : {})).status;

test("without a reverse proxy configured nothing reads a client address header", async () => {
  const f = await fixture({ loginLimits: limits });
  try {
    expect(f.relay.server.keepAliveTimeout).toBeLessThan(120_000);
    // Three callers behind one address stay one bucket whatever they claim.
    expect(await login(f.url, EDGE, "203.0.113.1")).toBe(401);
    expect(await login(f.url, EDGE, "203.0.113.2")).toBe(401);
    expect(await login(f.url, EDGE, "203.0.113.3")).toBe(429);
    // Every route stays reachable directly, and a gateway offering to move is served in place.
    expect((await send(f.url, "127.0.0.1", "/_relay/v2/gateways")).status).toBe(401);
    const health = await send(f.url, "127.0.0.1", "/healthz");
    expect(health.status).toBe(200);
    expect(health.headers["cache-control"]).toBe("no-store");
    const gatewayId = f.register();
    const control = new WebSocket(
      f.url.replace("127.0.0.1", "[::1]").replace("http", "ws") + "/_relay/v1/tunnel",
      {
        localAddress: EDGE,
        headers: {
          "x-omnesis-relay-session": f.session.token,
          "x-omnesis-gateway-id": gatewayId,
          "x-omnesis-tunnel-protocol": "2",
          "x-omnesis-tunnel-direct": "1",
        },
      },
    );
    await once(control, "open");
    control.terminate();
  } finally {
    await f.close();
  }
});

test("sign-ins are counted by the client a trusted proxy names, and by nobody else's claim", async () => {
  const f = await fixture({
    loginLimits: limits,
    cdn: { proxies: parseTrustedProxies(EDGE), clientAddressHeader: "cf-connecting-ip" },
  });
  try {
    expect(f.relay.server.keepAliveTimeout).toBe(120_000);
    // Through the proxy: each named client has its own bucket.
    expect(await login(f.url, EDGE, "203.0.113.1")).toBe(401);
    expect(await login(f.url, EDGE, "203.0.113.1")).toBe(401);
    expect(await login(f.url, EDGE, "203.0.113.1")).toBe(429);
    expect(await login(f.url, EDGE, "203.0.113.2")).toBe(401);
    // Not through the proxy: the header is a claim, and the caller's own address is counted.
    // The fixture's successful setup login already used one IPv4 loopback slot.
    expect(await login(f.url, "127.0.0.1", "203.0.113.3")).toBe(401);
    expect(await login(f.url, "127.0.0.1", "203.0.113.4")).toBe(429);
    expect(await login(f.url, "127.0.0.1", "203.0.113.5")).toBe(429);
    // The proxy naming two clients names none: its own address is the bucket.
    expect(await login(f.url, EDGE, ["203.0.113.6", "203.0.113.7"])).toBe(401);
    expect(await login(f.url, EDGE)).toBe(401);
    expect(await login(f.url, EDGE, "client.example.test")).toBe(429);
    // Nothing a shared cache may keep, on a served route, an unknown one or a refusal.
    for (const path of ["/healthz", "/nothing-here", "/_relay/v2/gateways"])
      expect((await send(f.url, EDGE, path)).headers["cache-control"]).toBe("no-store");
  } finally {
    await f.close();
  }
});

test("behind a PROXY protocol front, the proxy is whoever that front says connected", async () => {
  const FRONT = "::1";
  const f = await fixture({
    loginLimits: limits,
    proxyProtocolPeers: ProxyProtocolPeers.parse(FRONT),
    cdn: {
      proxies: parseTrustedProxies("198.51.100.0/24"),
      clientAddressHeader: "cf-connecting-ip",
    },
  });
  const port = Number(new URL(f.url).port);
  const through = async (source: string, client: string) => {
    const socket = connect({ host: FRONT, port, localAddress: FRONT });
    await once(socket, "connect");
    socket.write(`PROXY TCP4 ${source} 192.0.2.1 50000 443\r\n`);
    return (await send(f.url, FRONT, "/_relay/v1/login", { "cf-connecting-ip": client }, socket))
      .status;
  };
  try {
    // The front reports a proxy address: the proxy's header names the client.
    expect(await through("198.51.100.4", "203.0.113.1")).toBe(401);
    expect(await through("198.51.100.4", "203.0.113.1")).toBe(401);
    expect(await through("198.51.100.4", "203.0.113.1")).toBe(429);
    expect(await through("198.51.100.5", "203.0.113.2")).toBe(401);
    // The front reports anyone else: their header is ignored and they are their own bucket.
    expect(await through("203.0.113.9", "203.0.113.2")).toBe(401);
    expect(await through("203.0.113.9", "203.0.113.3")).toBe(401);
    expect(await through("203.0.113.9", "203.0.113.4")).toBe(429);
    // The front's own address is not a proxy address, so a header-less direct peer is nobody.
    expect(await login(f.url, "127.0.0.1", "203.0.113.5")).toBe(401);
  } finally {
    await f.close();
  }
});

/** A stand-in for the reverse proxy: forwards bytes to the relay from the proxy's address. */
async function edge(target: string) {
  const port = Number(new URL(target).port);
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((client) => {
    connections++;
    const upstream = connect({ host: EDGE, port, localAddress: EDGE });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    connections: () => connections,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Whether a request to the gateway's public name is answered through the relay. */
function relayed(gatewayUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      gatewayUrl + "/ready",
      { hostname: "127.0.0.1", servername: "gateway.example.test", rejectUnauthorized: false },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.end();
  });
}

function refusal(ws: WebSocket): Promise<IncomingMessage> {
  // Ending a refused handshake reports it once more as an error.
  ws.on("error", () => {});
  return new Promise((resolve) =>
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response);
    }),
  );
}

test("a gateway reaching the tunnel through the proxy is sent to the direct address; an older one is served", async () => {
  const cdn: CdnFront = {
    proxies: parseTrustedProxies(EDGE),
    clientAddressHeader: "cf-connecting-ip",
  };
  const f = await fixture({ cdn });
  const gateway = await echoGateway();
  const proxy = await edge(f.url);
  try {
    const gatewayId = f.register();
    const handshake = (direct: boolean, path = "/_relay/v1/tunnel") =>
      new WebSocket(proxy.url.replace("http", "ws") + path, {
        headers: {
          "x-omnesis-relay-session": f.session.token,
          "x-omnesis-gateway-id": gatewayId,
          "x-omnesis-tunnel-protocol": "2",
          ...(direct ? { "x-omnesis-tunnel-direct": "1" } : {}),
        },
      });
    // No direct address configured: served through the proxy even when it offers to move.
    const inPlace = handshake(true);
    await once(inPlace, "open");
    inPlace.terminate();
    await until(() => f.relay.metrics().includes("cloud_relay_online_gateways 0\n"));

    cdn.tunnelOrigin = f.url;
    // A gateway that cannot move keeps working through the proxy.
    const older = handshake(false);
    await once(older, "open");
    older.terminate();
    await until(() => f.relay.metrics().includes("cloud_relay_online_gateways 0\n"));
    // One that can is told where, before its session is even looked at.
    const moved = await refusal(handshake(true));
    expect(moved.statusCode).toBe(307);
    expect(moved.headers.location).toBe(f.url.replace("http", "ws") + "/_relay/v1/tunnel");
    expect(moved.headers["cache-control"]).toBe("no-store");
    // Only the tunnel moves: any other upgrade through the proxy is refused as before.
    expect((await refusal(handshake(true, "/_relay/v1/data"))).statusCode).toBe(403);

    // The real client follows it: one handshake through the proxy, then everything direct.
    const before = proxy.connections();
    const { GatewayTunnel } = await import("./tunnel-client.js");
    const tunnel = new GatewayTunnel({
      relayUrl: proxy.url,
      gatewayUrl: gateway.url,
      gatewayId,
      session: async () => f.session.token,
      reconnectMs: 20,
    });
    tunnel.start();
    try {
      await until(() => tunnel.status().state === "online");
      // A relayed request reaches the gateway over a data channel that never met the proxy.
      await until(() => relayed(f.gatewayUrl));
      expect(gateway.requests.map((request) => request.path)).toContain("/ready");
      expect(proxy.connections()).toBe(before + 1);
    } finally {
      tunnel.stop();
    }
  } finally {
    await proxy.close();
    await gateway.close();
    await f.close();
  }
});

test("direct connections can be held to the tunnel once the proxy serves the rest", async () => {
  const cdn: CdnFront = {
    proxies: parseTrustedProxies(EDGE),
    clientAddressHeader: "cf-connecting-ip",
  };
  const f = await fixture({ cdn });
  const gateway = await echoGateway();
  try {
    cdn.directRoutes = "all";
    expect((await send(f.url, "127.0.0.1", "/_relay/v2/gateways")).status).toBe(401);
    cdn.directRoutes = "tunnel";
    // Not through the proxy: only the health check answers.
    for (const path of ["/_relay/v2/gateways", "/_relay/v1/login", "/nothing-here"]) {
      const refused = await send(f.url, "127.0.0.1", path, { "cf-connecting-ip": "203.0.113.1" });
      expect(refused.status).toBe(421);
      expect(refused.headers["cache-control"]).toBe("no-store");
    }
    expect((await send(f.url, "127.0.0.1", "/healthz")).status).toBe(200);
    expect((await send(f.url, "127.0.0.1", "/healthz?x=1")).status).toBe(421);
    // Through it: every route as before.
    expect((await send(f.url, EDGE, "/_relay/v2/gateways")).status).toBe(401);
    expect((await send(f.url, EDGE, "/_relay/v1/login")).status).toBe(401);
    expect((await send(f.url, EDGE, "/healthz")).status).toBe(200);
    // And a gateway's tunnel and data channels connect directly, as they must.
    await f.tunnel(gateway.url);
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("the daemon takes its reverse proxy from the environment, and none by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-relay-cdn-"));
  const key = join(directory, "relay.key");
  const ranges = join(directory, "proxies");
  await writeFile(key, randomBytes(32), { mode: 0o600 });
  await writeFile(ranges, `# the proxy\n${EDGE}\n`);
  const base = {
    OMNESIS_CLOUD_RELAY_KEY_FILE: key,
    OMNESIS_CLOUD_RELAY_DB: join(directory, "accounts.sqlite"),
    OMNESIS_CLOUD_RELAY_PORT: "0",
    OMNESIS_SYNTHETIC: "1",
  };
  const config = `/_relay/v2/config?gatewayId=${randomUUID()}`;
  try {
    const plain = await startRelayDaemon(base);
    try {
      expect((await send(plain.url, "127.0.0.1", config)).status).toBe(200);
    } finally {
      await plain.close();
    }
    const fronted = await startRelayDaemon({
      ...base,
      OMNESIS_CLOUD_RELAY_TRUSTED_PROXIES_FILE: ranges,
      OMNESIS_CLOUD_RELAY_DIRECT_ROUTES: "tunnel",
      OMNESIS_CLOUD_RELAY_TUNNEL_ORIGIN: "https://tunnel.example.test",
    });
    try {
      expect((await send(fronted.url, "127.0.0.1", config)).status).toBe(421);
      expect((await send(fronted.url, "127.0.0.1", "/healthz")).status).toBe(200);
    } finally {
      await fronted.close();
    }
    await writeFile(ranges, "127.0.0.1\n");
    const trusted = await startRelayDaemon({
      ...base,
      OMNESIS_CLOUD_RELAY_TRUSTED_PROXIES_FILE: ranges,
      OMNESIS_CLOUD_RELAY_DIRECT_ROUTES: "tunnel",
      OMNESIS_CLOUD_RELAY_TUNNEL_ORIGIN: "https://tunnel.example.test",
    });
    try {
      expect((await send(trusted.url, "127.0.0.1", config)).status).toBe(200);
    } finally {
      await trusted.close();
    }
    await expect(
      startRelayDaemon({ ...base, OMNESIS_CLOUD_RELAY_DIRECT_ROUTES: "tunnel" }),
    ).rejects.toThrow("require the trusted proxy ranges");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
