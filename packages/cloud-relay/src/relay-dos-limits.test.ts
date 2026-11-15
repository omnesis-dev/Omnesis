// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { echoGateway, fixture, listen, tlsFiles, until } from "../test/support.js";
import { RelayAccounts } from "./accounts.js";
import { registerGatewayKey } from "./gateway-key-client.js";
import { localIdentityProvider, RelaySessions } from "./identity.js";
import { ProxyProtocolPeers } from "./proxy-protocol.js";
import { createCloudRelay } from "./server.js";
import { DEFAULT_TUNNEL_LIMITS } from "./tunnels.js";

// F16: one client could take every gateway offline, by flooding sign-ins (which gateway
// session renewals shared) or by holding a gateway's streams, which never timed out.

beforeEach(() => vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1"));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** These run on Linux, which alone routes all of 127/8 to loopback. */
const onLinux = test.runIf(process.platform === "linux");
const GATEWAY = "gateway.example.test";

/** A TLS connection to the gateway's name through the data listener, or undefined if refused. */
function dialGateway(
  target: { port: number; from: string } | Socket,
): Promise<TLSSocket | undefined> {
  const tls = connectTls({
    ...("port" in target
      ? { host: "127.0.0.1", port: target.port, localAddress: target.from }
      : { socket: target }),
    servername: GATEWAY,
    rejectUnauthorized: false,
  });
  return new Promise((resolve) => {
    tls.once("secureConnect", () => resolve(tls));
    tls.once("error", () => resolve(undefined));
    tls.once("close", () => resolve(undefined));
  });
}

/** GET /ready on the gateway through the relay, from `from`: the status, or "refused". */
function ready(port: number, from: string): Promise<number | "refused"> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        localAddress: from,
        servername: GATEWAY,
        rejectUnauthorized: false,
        path: "/ready",
        headers: { connection: "close" },
        agent: false,
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode!));
      },
    );
    req.once("error", () => resolve("refused"));
    req.end();
  });
}

/** A sign-in with a token no identity provider accepts, from `from`: its status. */
function signIn(url: string, from: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ idToken: "not-a-real-token" });
    const req = httpRequest(
      `${url}/_relay/v1/login`,
      {
        method: "POST",
        localAddress: from,
        agent: false,
        headers: { "content-type": "application/json", "content-length": body.length },
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode!));
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

function proxyHeader(source: string): Buffer {
  const family = source.includes(":") ? "TCP6" : "TCP4";
  const destination = family === "TCP6" ? "2001:db8::1" : "192.0.2.1";
  return Buffer.from(`PROXY ${family} ${source} ${destination} 50000 443\r\n`);
}

onLinux(
  "F16: a sign-in flood from many clients does not stop a gateway renewing its session",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnesis-f16-renew-"));
    const accounts = new RelayAccounts(":memory:", 1);
    const sessions = new RelaySessions(randomBytes(32));
    const relay = createCloudRelay({
      accounts,
      sessions,
      controlOrigin: "https://relay.example.test",
      hostnameProof: async () => true,
      identity: localIdentityProvider(randomBytes(32), "127.0.0.1"),
      legacyRoutes: true,
    });
    const url = await listen(relay.server);
    try {
      const tls = tlsFiles(directory, GATEWAY);
      // The rest runs inside one rate window, after the certificate's start.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 1000);
      const gatewayId = randomUUID();
      const statuses: number[] = [];
      const options = {
        relayUrl: "https://relay.example.test",
        sessionFile: join(directory, "session.json"),
        gatewayId,
        publicOrigin: `https://${GATEWAY}`,
        certificateFile: tls.certFile,
        privateKeyFile: tls.keyFile,
        enrollmentTokenFile: join(directory, "invite.json"),
        fetch: (async (input, init) => {
          const response = await fetch(`${url}${new URL(String(input)).pathname}`, init);
          statuses.push(response.status);
          return response;
        }) as typeof fetch,
      };
      await writeFile(
        options.enrollmentTokenFile,
        JSON.stringify({
          enrollmentToken: await sessions.issueEnrollmentInvitation(gatewayId, options.relayUrl),
        }),
      );
      const first = await registerGatewayKey(options);
      await rm(options.enrollmentTokenFile);

      // Four clients, each inside its own per-client limit, use up the global sign-in rate.
      for (const from of ["127.0.0.2", "127.0.0.3", "127.0.0.4", "127.0.0.5"])
        while ((await signIn(url, from)) === 401);
      expect(await signIn(url, "127.0.0.6")).toBe(429);

      // The gateway still proves its keys to the relay and gets a new routing session.
      statuses.length = 0;
      const renewed = await registerGatewayKey(options);
      expect(renewed.accountId).toBe(first.accountId);
      expect(statuses).toEqual([200, 200]);
    } finally {
      await relay.close();
      accounts.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

onLinux(
  "F16: one client holding streams to a gateway name does not lock others out of it",
  async () => {
    const gateway = await echoGateway();
    const f = await fixture();
    const held: TLSSocket[] = [];
    try {
      await f.tunnel(gateway.url);
      // As many connections as the gateway takes, all from one client.
      const attempts = await Promise.all(
        Array.from({ length: DEFAULT_TUNNEL_LIMITS.maxStreamsPerGateway }, () =>
          dialGateway({ port: f.dataPort, from: "127.0.0.2" }),
        ),
      );
      for (const socket of attempts) if (socket) held.push(socket);
      // Half of them: the default per-client share of one gateway.
      expect(held.length).toBe(8);
      // Someone else still reaches the gateway.
      expect(await ready(f.dataPort, "127.0.0.3")).toBe(200);
    } finally {
      for (const socket of held) socket.destroy();
      await f.close();
      await gateway.close();
    }
  },
);

onLinux("F16: one client cannot hold every data connection on the relay", async () => {
  const gateway = await echoGateway();
  const f = await fixture({
    limits: { ...DEFAULT_TUNNEL_LIMITS, maxStreams: 8, maxStreamsPerClient: 4 },
  });
  const sockets: Socket[] = [];
  try {
    await f.tunnel(gateway.url);
    // Connections that never send a ClientHello, each held until the hello deadline.
    let refused = 0;
    for (let index = 0; index < 8; index++) {
      const socket = connect({ host: "127.0.0.1", port: f.dataPort, localAddress: "127.0.0.2" });
      socket.on("error", () => {});
      socket.once("close", () => refused++);
      sockets.push(socket);
      await once(socket, "connect");
    }
    await until(() => refused >= 4, 2000).catch(() => {});
    expect(refused).toBe(4);
    expect(await ready(f.dataPort, "127.0.0.3")).toBe(200);
  } finally {
    for (const socket of sockets) socket.destroy();
    await f.close();
    await gateway.close();
  }
});

onLinux(
  "F16: an idle routed connection is closed, and one that keeps talking stays open",
  async () => {
    const gateway = await echoGateway();
    const f = await fixture({ limits: { ...DEFAULT_TUNNEL_LIMITS, idleTimeoutMs: 300 } });
    let socket: WebSocket | undefined;
    try {
      await f.tunnel(gateway.url);
      const idle = await dialGateway({ port: f.dataPort, from: "127.0.0.2" });
      expect(idle).toBeDefined();
      const closed = once(idle!, "close").then(() => true);
      const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000));
      expect(await Promise.race([closed, timeout])).toBe(true);

      // ws passes TLS options such as servername through to tls.connect.
      const tlsOptions = {
        servername: GATEWAY,
        rejectUnauthorized: false,
        headers: { authorization: "Bearer fixture-token" },
      };
      socket = new WebSocket(`wss://127.0.0.1:${f.dataPort}/socket`, tlsOptions);
      await once(socket, "open");
      let echoes = 0;
      socket.on("message", () => echoes++);
      for (let index = 0; index < 12; index++) {
        socket.send("still here");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(echoes).toBeGreaterThan(0);
      // Once it stops, it is closed too.
      await once(socket, "close");
    } finally {
      socket?.terminate();
      await f.close();
      await gateway.close();
    }
  },
);

onLinux("F16: two IPv6 addresses in the same /64 share one stream budget", async () => {
  const FRONT = "127.0.0.9";
  const gateway = await echoGateway();
  const f = await fixture({
    proxyProtocolPeers: ProxyProtocolPeers.parse(`${FRONT}/32`),
    limits: { ...DEFAULT_TUNNEL_LIMITS, maxStreamsPerClientPerGateway: 1 },
  });
  const held: TLSSocket[] = [];
  const from = async (client: string) => {
    const socket = connect({ host: "127.0.0.1", port: f.dataPort, localAddress: FRONT });
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(proxyHeader(client));
    const tls = await dialGateway(socket);
    if (tls) held.push(tls);
    return tls !== undefined;
  };
  try {
    await f.tunnel(gateway.url);
    expect(await from("2001:db8:7:1::1")).toBe(true);
    // Another address in the same /64 is the same subscriber.
    expect(await from("2001:db8:7:1::2")).toBe(false);
    // The next /64 is someone else.
    expect(await from("2001:db8:7:2::1")).toBe(true);
  } finally {
    for (const socket of held) socket.destroy();
    await f.close();
    await gateway.close();
  }
});
