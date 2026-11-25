// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as realTimeout } from "node:timers";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { closeServer, fixture, listen, tlsFiles } from "../test/support.js";
import { RelaySessions } from "./identity.js";
import { SESSION_HEADER } from "./network.js";
import { GatewayTunnel } from "./tunnel-client.js";
import { DEFAULT_TUNNEL_LIMITS } from "./tunnels.js";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";

const SIX_HOURS = 6 * 60 * 60_000;
const limits = {
  ...DEFAULT_TUNNEL_LIMITS,
  heartbeatMs: SIX_HOURS,
  idleTimeoutMs: SIX_HOURS,
};

// Date and product timers advance deliberately; real loopback I/O still gets turns.
async function settled(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => realTimeout(resolve, 5));
  }
  throw new Error("Loopback state did not settle");
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function setup() {
  const sessions = new RelaySessions(randomBytes(32), 120);
  const relay = await fixture({ sessions, limits });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await relay.close();
  };
  cleanup.push(stop);
  return { relay, sessions, stop };
}

async function control(relay: Awaited<ReturnType<typeof fixture>>, gatewayId = relay.register()) {
  const socket = new WebSocket(relay.url.replace("http:", "ws:") + "/_relay/v1/tunnel", {
    headers: {
      [SESSION_HEADER]: relay.session.token,
      "x-omnesis-gateway-id": gatewayId,
      "x-omnesis-tunnel-protocol": "2",
      "x-omnesis-tunnel-renewal": "1",
    },
  });
  socket.on("error", () => {});
  cleanup.push(async () => {
    socket.terminate();
  });
  const [raw] = await once(socket, "message");
  const ready = JSON.parse(raw.toString()) as Record<string, unknown>;
  expect(ready).toMatchObject({
    type: "ready",
    version: 1,
    sessionExpiresAt: relay.session.expiresAt,
  });
  return { socket, gatewayId };
}

async function renewed(socket: WebSocket, token: string): Promise<Record<string, unknown>> {
  const reply = once(socket, "message");
  socket.send(JSON.stringify({ type: "renew", version: 1, session: token }));
  const [raw] = await reply;
  return JSON.parse(raw.toString()) as Record<string, unknown>;
}
async function refused(socket: WebSocket, token: string): Promise<void> {
  const closed = once(socket, "close");
  socket.send(JSON.stringify({ type: "renew", version: 1, session: token }));
  await closed;
  expect(socket.readyState).toBe(WebSocket.CLOSED);
}

// This crosses the real server authenticator, broker, WebSockets, opaque TLS,
// and client credential source. Only time moves artificially.
test("five renewals keep the same HTTP response and SSE alive across expired grants and authenticate later data with fresh credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-renewal-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const files = tlsFiles(directory, "gateway.example.test");
  const certificate = await readFile(files.certFile, "utf8");
  let slow: ServerResponse | undefined;
  let events: ServerResponse | undefined;
  const server = createServer(
    { cert: certificate, key: await readFile(files.keyFile) },
    (req, res) => {
      if (req.url === "/slow") {
        slow = res;
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("first-");
      } else if (req.url === "/events") {
        events = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
      } else res.end("new request");
    },
  );
  const gatewayUrl = (await listen(server)).replace("http:", "https:");
  cleanup.push(() => closeServer(server));
  const { relay } = await setup();
  const gatewayId = relay.register();
  const dataCredentials: string[] = [];
  let acceptedControls = 0;
  relay.relay.server.on("upgrade", (req) => {
    if (req.url === "/_relay/v1/tunnel") acceptedControls++;
    if (req.url === "/_relay/v1/data") dataCredentials.push(String(req.headers[SESSION_HEADER]));
  });
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  let latest = relay.session;
  let invalidated = false;
  let acquisitions = 0;
  const tunnel = new GatewayTunnel({
    relayUrl: relay.url,
    gatewayUrl,
    gatewayId,
    reconnectMs: 1000,
    invalidateSession: () => {
      invalidated = true;
    },
    session: async () => {
      acquisitions++;
      if (invalidated) {
        latest = await relay.login();
        invalidated = false;
      }
      return latest.token;
    },
  });
  cleanup.push(() => tunnel.close());
  tunnel.start();
  await vi.advanceTimersByTimeAsync(0);
  await settled(() => tunnel.status().state === "online");
  const connectedAt = tunnel.status().lastConnectedAt;
  const requests: ClientRequest[] = [];
  cleanup.push(async () => {
    for (const req of requests) req.destroy();
  });
  const start = async (path: string): Promise<IncomingMessage> =>
    new Promise((resolve, reject) => {
      const req = request(
        relay.gatewayUrl + path,
        {
          hostname: "127.0.0.1",
          servername: "gateway.example.test",
          ca: certificate,
          agent: false,
        },
        resolve,
      );
      requests.push(req);
      req.on("error", reject);
      req.end();
    });
  const http = await start("/slow");
  const sse = await start("/events");
  const httpBytes: Buffer[] = [];
  const sseBytes: Buffer[] = [];
  http.on("data", (chunk: Buffer) => httpBytes.push(chunk));
  sse.on("data", (chunk: Buffer) => sseBytes.push(chunk));
  await settled(() => httpBytes.length > 0 && sseBytes.length > 0);
  expect(dataCredentials).toEqual([relay.session.token, relay.session.token]);
  for (let cycle = 0; cycle < 5; cycle++) {
    const oldGrant = latest;
    // Advance past renewal's due time but retain twenty seconds of its accepted
    // grant while the real login and control exchange receive network turns.
    await vi.advanceTimersByTimeAsync(oldGrant.expiresAt * 1000 - Date.now() - 20_000);
    await settled(() => latest.token !== oldGrant.token);
    expect(latest.expiresAt).toBeGreaterThan(oldGrant.expiresAt);
    // A fresh token reaches data handshakes only after the real acknowledgement.
    await settled(async () => {
      const response = await start(`/after-ack-${cycle}`);
      const ended = once(response, "end");
      response.resume();
      await ended;
      return dataCredentials.at(-1) === latest.token;
    });
    await vi.advanceTimersByTimeAsync(oldGrant.expiresAt * 1000 - Date.now() + 1000);
    expect(tunnel.status().state).toBe("online");
    expect(tunnel.status().lastConnectedAt).toBe(connectedAt);
    expect(acceptedControls).toBe(1);
    expect(acquisitions).toBe(cycle + 2);
    expect(http.destroyed || http.complete).toBe(false);
    expect(sse.destroyed || sse.complete).toBe(false);
    // Each expired grant is also tested by a completely new TLS/data channel.
    const later = await start(`/after-expiry-${cycle}`);
    const body: Buffer[] = [];
    for await (const chunk of later) body.push(Buffer.from(chunk));
    expect(Buffer.concat(body).toString()).toBe("new request");
    expect(dataCredentials.at(-1)).toBe(latest.token);
  }
  const done = once(http, "end");
  slow!.end("last");
  events!.write("data: after-renewal\n\n");
  await done;
  await settled(() => Buffer.concat(sseBytes).toString().includes("after-renewal"));
  expect(Buffer.concat(httpBytes).toString()).toBe("first-last");
  expect(Buffer.concat(sseBytes).toString()).toBe("data: first\n\ndata: after-renewal\n\n");
  expect(relay.relay.metrics()).toContain(
    'cloud_relay_tunnel_events_total{event="session_renewed"} 5',
  );
  expect(relay.relay.metrics()).not.toContain(
    'cloud_relay_tunnel_events_total{event="session_expired"}',
  );
});

test("the server authenticates a renewed grant and refuses replay without extending the original control", async () => {
  const { relay } = await setup();
  const { socket } = await control(relay);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 30_000);
  const next = await relay.login();
  expect(await renewed(socket, next.token)).toEqual({
    type: "renewed",
    version: 1,
    expiresAt: next.expiresAt,
  });
  await refused(socket, next.token);
});

test.each(["foreign owner", "expired", "nonextending", "unregistered", "changed binding"] as const)(
  "actual server authentication refuses a %s renewal",
  async (scenario) => {
    const { relay, sessions } = await setup();
    const { socket } = await control(relay);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 30_000);
    let token = (await relay.login()).token;
    if (scenario === "foreign owner") token = (await relay.login("other-fictional-account")).token;
    if (scenario === "expired") {
      token = (
        await sessions.issue({
          issuer: "omnesis-local-test",
          subject: "fictional-account",
          expiresAt: Math.floor(Date.now() / 1000) + 1,
        })
      ).token;
      vi.setSystemTime(Date.now() + 2000);
    }
    if (scenario === "nonextending") token = relay.session.token;
    if (scenario === "unregistered") relay.accounts.deleteGateway(relay.session.accountId);
    if (scenario === "changed binding") {
      relay.accounts.deleteGateway(relay.session.accountId);
      relay.register(randomUUID());
    }
    await refused(socket, token);
  },
);

test.each(["revocation", "shutdown"] as const)(
  "a real renewal waiting for authentication cannot outlive %s",
  async (scenario) => {
    const { relay, sessions, stop } = await setup();
    const { socket } = await control(relay);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 30_000);
    const next = await relay.login();
    let reached: () => void = () => {};
    let release: () => void = () => {};
    const verifying = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actualVerify = sessions.verify.bind(sessions);
    let completed = false;
    vi.spyOn(sessions, "verify").mockImplementation(async (token) => {
      const grant = await actualVerify(token);
      reached();
      await gate;
      completed = true;
      return grant;
    });
    const replies: unknown[] = [];
    socket.on("message", (raw) => replies.push(JSON.parse(raw.toString())));
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "renew", version: 1, session: next.token }));
    await verifying;
    if (scenario === "revocation") relay.accounts.deleteGateway(relay.session.accountId);
    else await stop();
    release();
    await closed;
    await settled(() => completed);
    expect(replies).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    if (scenario === "revocation")
      expect(relay.relay.metrics()).toContain("cloud_relay_online_gateways 0");
  },
);
