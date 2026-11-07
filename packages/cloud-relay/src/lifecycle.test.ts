// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { connect } from "node:net";
import { request } from "node:http";
import { once } from "node:events";
import { PassThrough, type Duplex } from "node:stream";
import { WebSocket } from "ws";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fixture, listen, localToken } from "../test/support.js";
import { createRelayClientProxy } from "./client-proxy.js";
import { SESSION_HEADER } from "./network.js";
import * as network from "./network.js";

beforeEach(() => vi.stubEnv("OMNESIS_EXPERIMENTAL", "1"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("adapter restricts listeners to IPv4/IPv6 loopback and rejects closing an unbound server", async () => {
  const options = { gatewayUrl: "https://localhost:1", gatewayFingerprint: "a".repeat(64) };
  const invalid = createRelayClientProxy(options);
  const error = once(invalid.server, "error");
  invalid.server.listen(0, "0.0.0.0");
  expect((await error)[0].message).toContain("loopback");
  await expect(invalid.close()).rejects.toThrow();
  const ipv6 = createRelayClientProxy(options);
  ipv6.server.listen(0, "::1");
  await once(ipv6.server, "listening");
  await ipv6.close();
});

test("adapter destroys late TLS connections when HTTP or WebSocket clients disappear", async () => {
  const f = await fixture();
  let release!: (stream: Duplex) => void;
  let entered!: () => void;
  let called = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(network, "connectOrigin").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
        entered();
      }),
  );
  const proxy = createRelayClientProxy({
    gatewayUrl: "https://localhost:1",
    gatewayFingerprint: "a".repeat(64),
  });
  const url = await listen(proxy.server);
  try {
    let accepted!: Duplex;
    const incoming = new Promise<void>((resolve) =>
      proxy.server.once("request", (req) => {
        accepted = req.socket;
        resolve();
      }),
    );
    const req = request(`${url}/api/status`);
    req.on("error", () => {});
    req.end();
    await incoming;
    await called;
    const closed = once(accepted, "close");
    req.destroy();
    await closed;
    expect(vi.mocked(network.connectOrigin).mock.calls.at(-1)![2]!.aborted).toBe(true);
    const late = new PassThrough();
    release(late);
    await turn();
    await turn();
    expect(late.destroyed).toBe(true);
    called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const upgraded = new Promise<void>((resolve) =>
      proxy.server.once("upgrade", (_req, socket) => {
        accepted = socket;
        resolve();
      }),
    );
    const ws = new WebSocket(url.replace("http", "ws") + "/device/ws");
    ws.on("error", () => {});
    await upgraded;
    await called;
    const upgradeClosed = new Promise<void>((resolve) => accepted.once("close", resolve));
    accepted.emit("error", new Error("connection reset"));
    await upgradeClosed;
    expect(vi.mocked(network.connectOrigin).mock.calls.at(-1)![2]!.aborted).toBe(true);
    const lateUpgrade = new PassThrough();
    release(lateUpgrade);
    await turn();
    await turn();
    expect(lateUpgrade.destroyed).toBe(true);
    ws.terminate();
  } finally {
    await proxy.close();
    await f.close();
  }
});

test("upgrade authentication is safe when a socket resets during identity verification", async () => {
  const f = await fixture();
  let complete!: (value: { accountId: string; expiresAt: number }) => void;
  let entered!: () => void;
  const called = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(f.sessions, "verify").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
        entered();
      }),
  );
  try {
    let accepted!: Duplex;
    const upgraded = new Promise<void>((resolve) =>
      f.relay.server.once("upgrade", (_req, socket) => {
        accepted = socket;
        resolve();
      }),
    );
    const ws = new WebSocket(f.url.replace("http", "ws") + "/device/ws", {
      headers: { [SESSION_HEADER]: f.session.token },
    });
    ws.on("error", () => {});
    await upgraded;
    await called;
    const closed = new Promise<void>((resolve) => accepted.once("close", resolve));
    accepted.emit("error", new Error("connection reset"));
    await closed;
    complete(f.session);
    await turn();
    ws.terminate();
  } finally {
    await f.close();
  }
});

test("unexpected service failures return sanitized status and preserve already-written headers", async () => {
  const f = await fixture();
  try {
    vi.spyOn(f.accounts, "registerAccount").mockImplementation(() => {
      throw new Error("private database detail");
    });
    const input = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: await localToken(f.key) }),
    };
    const error = await fetch(`${f.url}/_relay/v1/login`, input);
    expect(error.status).toBe(500);
    expect(await error.text()).toBe("");
    f.relay.server.prependOnceListener("request", (_req, res) => res.writeHead(202));
    expect((await fetch(`${f.url}/_relay/v1/login`, input)).status).toBe(202);
    vi.spyOn(f.accounts, "bindGateway").mockImplementation(() => {
      throw new Error("private routing detail");
    });
    const ws = new WebSocket(f.url.replace("http", "ws") + "/_relay/v1/tunnel", {
      headers: {
        [SESSION_HEADER]: f.session.token,
        "x-omnesis-tunnel-protocol": "2",
        "x-omnesis-gateway-id": "00000000-0000-4000-8000-000000000001",
      },
    });
    await expect(once(ws, "open")).rejects.toThrow("500");
  } finally {
    await f.close();
  }
  await expect(f.relay.close()).rejects.toThrow();
});

test("rejected upgrades flush their response and destroy a peer withholding its FIN", async () => {
  const f = await fixture();
  const proxy = createRelayClientProxy({
    gatewayUrl: "https://localhost:1",
    gatewayFingerprint: "a".repeat(64),
  });
  const adapterUrl = await listen(proxy.server);
  try {
    for (const [server, url, path] of [
      [f.relay.server, f.url, "/device/ws"],
      [proxy.server, adapterUrl, "/_relay/forbidden"],
    ] as const) {
      let accepted!: Duplex;
      const received = new Promise<void>((resolve) =>
        server.once("upgrade", (_req, socket) => {
          accepted = socket;
          resolve();
        }),
      );
      const socket = connect({
        host: "127.0.0.1",
        port: Number(new URL(url).port),
        allowHalfOpen: true,
      });
      await once(socket, "connect");
      const data: Buffer[] = [];
      socket.on("data", (chunk) => data.push(chunk));
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
      await received;
      await once(socket, "end");
      await turn();
      expect(Buffer.concat(data).toString()).toMatch(/HTTP\/1.1 (401|403)/);
      expect(accepted.destroyed).toBe(true);
      socket.destroy();
    }
  } finally {
    await proxy.close();
    await f.close();
  }
});
