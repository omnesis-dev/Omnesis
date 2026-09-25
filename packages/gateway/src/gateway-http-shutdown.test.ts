// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createHttpsServer, request } from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { GatewayHttpShutdown } from "./gateway-http-shutdown.js";
import { resolveTlsBundle } from "./tls.js";
import type { AddressInfo } from "node:net";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("drains admitted work and refuses late pipelined requests before services are disposed", async () => {
  const shutdown = new GatewayHttpShutdown();
  const entered = deferred();
  const release = deferred();
  const late = deferred();
  const scheduler = vi.fn();
  const server = createServer(
    getRequestListener((req) => {
      const result = shutdown.guard(async () => {
        entered.resolve();
        await release.promise;
        scheduler();
        return new Response("saved");
      });
      if (req.url.endsWith("/late")) late.resolve();
      return result;
    }),
  );
  shutdown.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
  socket.setEncoding("utf8");
  let received = "";
  socket.on("data", (chunk: string) => {
    received += chunk;
  });
  await once(socket, "connect");
  socket.write("GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n");
  await entered.promise;
  const closed = once(socket, "close");
  try {
    let settled = false;
    const drain = shutdown.close(server, 2_000).then((clean) => {
      settled = true;
      return clean;
    });
    socket.write("GET /late HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    await late.promise;
    expect(settled).toBe(false);
    release.resolve();
    expect(await drain).toBe(true);
    await closed;
    expect(received).toContain("200 OK");
    expect(received).toContain("503 Service Unavailable");
    expect(scheduler).toHaveBeenCalledTimes(1);
    // The admission gate remains closed even after teardown.
    const refused = shutdown.guard(() => {
      throw new Error("scheduler disposed");
    });
    expect(refused.status).toBe(503);
  } finally {
    release.resolve();
    socket.destroy();
    server.closeAllConnections();
    server.close();
  }
});

test("bounds a stuck HTTPS handler and signals request cancellation", async () => {
  const shutdown = new GatewayHttpShutdown();
  const entered = deferred();
  const aborted = deferred();
  const configDir = mkdtempSync(join(tmpdir(), "omnesis-test-http-shutdown-"));
  const server = createHttpsServer(
    resolveTlsBundle({ configDir }),
    getRequestListener(async (req) => {
      const cancellation = new Promise<void>((resolve) => {
        req.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            resolve();
          },
          { once: true },
        );
      });
      entered.resolve();
      await cancellation;
      return new Response("cancelled");
    }),
  );
  shutdown.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = request({
    host: "127.0.0.1",
    port: (server.address() as AddressInfo).port,
    rejectUnauthorized: false,
  });
  const disconnected = new Promise<void>((resolve) => client.once("error", () => resolve()));
  client.end();
  await entered.promise;
  try {
    const drain = shutdown.close(server, 25);
    expect(shutdown.close(server, 25)).toBe(drain);
    expect(await drain).toBe(false);
    await Promise.all([aborted.promise, disconnected]);
  } finally {
    client.destroy();
    server.closeAllConnections();
    server.close();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("rejects late Hono WebSocket upgrades on an already accepted connection", async () => {
  const shutdown = new GatewayHttpShutdown();
  const app = new Hono();
  const entered = deferred();
  const release = deferred();
  const late = deferred();
  app.use("*", (c, next) => {
    const result = shutdown.guard(next);
    if (c.req.path === "/ws") late.resolve();
    return Promise.resolve(result);
  });
  app.get("/hold", async () => {
    entered.resolve();
    await release.promise;
    return new Response("done");
  });
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  const upgraded = vi.fn(() => ({}));
  app.get("/ws", upgradeWebSocket(upgraded));
  const server = createServer(getRequestListener(app.fetch));
  injectWebSocket(server);
  shutdown.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write("GET /hold HTTP/1.1\r\nHost: localhost\r\n\r\n");
  await entered.promise;
  try {
    const drain = shutdown.close(server, 2_000);
    socket.write(
      "GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    await late.promise;
    expect(upgraded).not.toHaveBeenCalled();
    release.resolve();
    expect(await drain).toBe(true);
  } finally {
    release.resolve();
    socket.destroy();
    wss.close();
    server.closeAllConnections();
    server.close();
  }
});

test("disconnects upgraded sockets without waiting for the HTTP drain timeout", async () => {
  const shutdown = new GatewayHttpShutdown();
  const server = createServer();
  server.on("upgrade", (_req, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n",
    );
  });
  shutdown.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    "GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n",
  );
  await once(socket, "data");
  const closed = once(socket, "close");
  expect(await shutdown.close(server, 2_000)).toBe(true);
  await closed;
  expect(socket.destroyed).toBe(true);
});
