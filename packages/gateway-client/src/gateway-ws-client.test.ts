// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  isWsCommand,
  isWsEnvelope,
  isWsEvent,
  makeCommand,
  makeEvent,
  makeResponseErr,
  makeResponseOk,
  websocketAuthProtocol,
  WsInvalidInputError,
} from "@omnesis/core";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { GatewayWsClient } from "./gateway-ws-client.js";
import type { WSContext } from "hono/ws";
import type { Server } from "node:http";

const HELLO_RESPONSE = {
  deviceId: "dev-1",
  scopes: ["write:*"],
  deviceName: "collector-alpha",
  deviceKind: "collector",
  protocolVersion: 1,
} as const;

const PORT = 18800;
const API_KEY = "test-ws-key";

let server: Server;
let lastHelloToken: string | null = null;
let helloCount = 0;
let lastAuthProtocol: string | null = null;
let connectedSockets: Set<WSContext>;
let helloBehavior: "accept" | "reject" = "accept";

function sendToAll(data: unknown) {
  for (const ws of connectedSockets) {
    ws.send(JSON.stringify(data));
  }
}

async function waitForCondition(fn: () => boolean, timeoutMs = 2000, pollMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("waitForCondition timed out");
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

beforeAll(() => {
  connectedSockets = new Set();

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  app.get(
    "/device/ws",
    upgradeWebSocket((c) => {
      lastAuthProtocol = c.req.header("sec-websocket-protocol") ?? null;
      return {
        onOpen(_e, ws) {
          connectedSockets.add(ws);
        },
        onMessage(e, ws) {
          const envelope = JSON.parse(String(e.data));
          if (!isWsEnvelope(envelope)) return;
          if (isWsCommand(envelope) && envelope.type === "hello") {
            const payload = envelope.payload as { token?: string } | null;
            lastHelloToken = payload?.token ?? null;
            helloCount += 1;
            if (helloBehavior === "accept") {
              ws.send(JSON.stringify(makeResponseOk(envelope.id, HELLO_RESPONSE)));
            } else {
              ws.send(JSON.stringify(makeResponseErr(envelope.id, "invalid_token", "bad token")));
            }
          }
        },
        onClose(_e, ws) {
          connectedSockets.delete(ws);
        },
      };
    }),
  );
  server = serve({ fetch: app.fetch, port: PORT });
  injectWebSocket(server);
});

afterEach(() => {
  lastHelloToken = null;
  helloCount = 0;
  lastAuthProtocol = null;
  helloBehavior = "accept";
});

afterAll(async () => {
  for (const ws of connectedSockets) ws.close();
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

describe("GatewayWsClient", () => {
  test("connects with upgrade token and sends tokenless hello", async () => {
    const client = new GatewayWsClient(`http://localhost:${PORT}`, API_KEY);
    client.connect();

    await waitForCondition(() => helloCount > 0);
    expect(lastAuthProtocol).toBe(websocketAuthProtocol(API_KEY));
    expect(lastHelloToken).toBeNull();
    await waitForCondition(() => client.getIdentity() !== null);
    expect(client.getIdentity()).toEqual(HELLO_RESPONSE);

    client.disconnect();
    expect(client.getIdentity()).toBeNull();
    await waitForCondition(() => connectedSockets.size === 0);
  });

  test("forwards events to handler", async () => {
    const client = new GatewayWsClient(`http://localhost:${PORT}`, API_KEY);
    const received: { type: string; payload: unknown }[] = [];

    client.onEvent((type, payload) => {
      received.push({ type, payload });
    });
    client.connect();
    await waitForCondition(() => helloCount > 0);
    await new Promise((r) => setTimeout(r, 50)); // let hello response land

    sendToAll(makeEvent("documents.upserted", { sourceId: "gmail", count: 5 }));
    await waitForCondition(() => received.length === 1);
    expect(received[0]).toEqual({
      type: "documents.upserted",
      payload: { sourceId: "gmail", count: 5 },
    });

    client.disconnect();
    await waitForCondition(() => connectedSockets.size === 0);
  });

  test("ignores ping events", async () => {
    const client = new GatewayWsClient(`http://localhost:${PORT}`, API_KEY);
    const received: { type: string; payload: unknown }[] = [];

    client.onEvent((type, payload) => {
      received.push({ type, payload });
    });
    client.connect();
    await waitForCondition(() => helloCount > 0);
    await new Promise((r) => setTimeout(r, 50));

    sendToAll(makeEvent("ping", { t: 1 }));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);

    client.disconnect();
    await waitForCondition(() => connectedSockets.size === 0);
  });

  test("handles hello rejection gracefully", async () => {
    helloBehavior = "reject";
    const client = new GatewayWsClient(`http://localhost:${PORT}`, "bad-key");
    client.connect();
    await waitForCondition(() => helloCount > 0);
    expect(lastAuthProtocol).toBe(websocketAuthProtocol("bad-key"));
    expect(lastHelloToken).toBeNull();
    client.disconnect();
    await waitForCondition(() => connectedSockets.size === 0);
  });

  test("reconnects after server drop", async () => {
    const client = new GatewayWsClient(`http://localhost:${PORT}`, API_KEY, { reconnectDelay: 50 });
    client.connect();

    await waitForCondition(() => connectedSockets.size >= 1);
    for (const ws of connectedSockets) ws.close();
    await waitForCondition(() => connectedSockets.size >= 1, 3000);

    client.disconnect();
    await waitForCondition(() => connectedSockets.size === 0);
  });

  test("disconnect() stops reconnection", async () => {
    const client = new GatewayWsClient(`http://localhost:${PORT}`, API_KEY, { reconnectDelay: 50 });
    client.connect();
    await waitForCondition(() => connectedSockets.size >= 1);
    client.disconnect();
    await waitForCondition(() => connectedSockets.size === 0);
    for (const ws of connectedSockets) ws.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(connectedSockets.size).toBe(0);
  });

  test("emitEvent and sendCommand round-trip", async () => {
    // Server listens for events and commands, echoes commands back.
    const eventsReceived: { type: string; payload: unknown }[] = [];
    const lp = 18802;
    const app = new Hono();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    app.get(
      "/device/ws",
      upgradeWebSocket(() => ({
        onMessage(e, ws) {
          const envelope = JSON.parse(String(e.data));
          if (!isWsEnvelope(envelope)) return;
          if (isWsCommand(envelope) && envelope.type === "hello") {
            ws.send(
              JSON.stringify(makeResponseOk(envelope.id, { ...HELLO_RESPONSE, deviceId: "x" })),
            );
            return;
          }
          if (isWsCommand(envelope)) {
            ws.send(JSON.stringify(makeResponseOk(envelope.id, { echoed: envelope.payload })));
            return;
          }
          if (isWsEvent(envelope)) {
            eventsReceived.push({ type: envelope.type, payload: envelope.payload });
          }
        },
      })),
    );
    const localServer = serve({ fetch: app.fetch, port: lp });
    injectWebSocket(localServer);

    const client = new GatewayWsClient(`http://localhost:${lp}`, "k");
    client.connect();
    await waitForCondition(() => eventsReceived.length === 0, 200).catch(() => {});
    // Wait for authentication before emitting.
    await new Promise((r) => setTimeout(r, 150));

    client.emitEvent("sync.status", { sourceId: "gmail", state: "syncing" });
    await waitForCondition(() => eventsReceived.length === 1, 2000);
    expect(eventsReceived[0]).toEqual({
      type: "sync.status",
      payload: { sourceId: "gmail", state: "syncing" },
    });

    // Use a real registry type so the typed `sendCommand<K>` infers the
    // request/response shape; the mock above echoes any command back as
    // `{echoed}`, but TS still sees the response as the registry type.
    const result = await client.sendCommand("source.discover", { descriptorId: "echo" });
    expect((result as unknown as { echoed: unknown }).echoed).toEqual({ descriptorId: "echo" });

    client.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    await new Promise<void>((resolve) => {
      localServer.closeAllConnections?.();
      localServer.close(() => resolve());
    });
  });

  test("onCommand dispatches gateway → device commands", async () => {
    const lp = 18803;
    const app = new Hono();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    app.get(
      "/device/ws",
      upgradeWebSocket(() => ({
        onMessage(e, ws) {
          const envelope = JSON.parse(String(e.data));
          if (isWsCommand(envelope) && envelope.type === "hello") {
            ws.send(
              JSON.stringify(makeResponseOk(envelope.id, { ...HELLO_RESPONSE, deviceId: "x" })),
            );
            // Immediately push a command so we can verify dispatch.
            ws.send(JSON.stringify(makeCommand("source.sync", { sourceId: "gmail" })));
          }
        },
      })),
    );
    const localServer = serve({ fetch: app.fetch, port: lp });
    injectWebSocket(localServer);

    const client = new GatewayWsClient(`http://localhost:${lp}`, "k");
    let received: { type: string; payload: unknown } | null = null;
    client.onCommand(async (command) => {
      received = { type: command.type, payload: command.payload };
      return { ok: true };
    });
    client.connect();
    await waitForCondition(() => received !== null, 3000);
    expect(received!.type).toBe("source.sync");
    expect(received!.payload).toEqual({ sourceId: "gmail" });
    client.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    await new Promise<void>((resolve) => {
      localServer.closeAllConnections?.();
      localServer.close(() => resolve());
    });
  });

  test.each([
    {
      thrown: () => new WsInvalidInputError('shelf-notes: unknown setting "colour"'),
      code: "invalid_input",
    },
    { thrown: () => new Error("disk unavailable"), code: "handler_error" },
  ])("a refused command answers $code", async ({ thrown, code }) => {
    // A device refusing what it was sent says so in the code, so the gateway can
    // tell the caller to change the request rather than report a failure.
    const lp = code === "invalid_input" ? 18804 : 18805;
    const app = new Hono();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    let reply: { code: string; message: string } | null = null;
    app.get(
      "/device/ws",
      upgradeWebSocket(() => ({
        onMessage(e, ws) {
          const envelope = JSON.parse(String(e.data));
          if (isWsCommand(envelope) && envelope.type === "hello") {
            ws.send(
              JSON.stringify(makeResponseOk(envelope.id, { ...HELLO_RESPONSE, deviceId: "x" })),
            );
            ws.send(JSON.stringify(makeCommand("source.sync", { sourceId: "gmail" })));
          } else if (envelope.kind === "response" && envelope.ok === false) {
            reply = envelope.error;
          }
        },
      })),
    );
    const localServer = serve({ fetch: app.fetch, port: lp });
    injectWebSocket(localServer);

    const client = new GatewayWsClient(`http://localhost:${lp}`, "k");
    client.onCommand(async () => {
      throw thrown();
    });
    client.connect();
    await waitForCondition(() => reply !== null, 3000);
    expect(reply!.code).toBe(code);
    expect(reply!.message).toBe(thrown().message);
    client.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    await new Promise<void>((resolve) => {
      localServer.closeAllConnections?.();
      localServer.close(() => resolve());
    });
  });
});
