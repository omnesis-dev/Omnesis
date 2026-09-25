// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { unlinkSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import {
  makeCommand,
  makeEvent,
  makeResponseOk,
  newCorrelationId,
  PROTOCOL_VERSION,
  websocketAuthProtocol,
  type WsEnvelope,
  type WsCommand,
  type WsEvent,
  type WsResponse,
} from "@omnesis/core";
import {
  DEVICE_HOSTED_SOURCE_TYPES,
  SCOPE_ADMIN,
  SCOPE_READ,
  SCOPE_SUBSCRIPTIONS_RECEIVE,
  SCOPE_WRITE_ALL,
  Scope,
  SourceType,
  writeScope,
  type DeviceId,
  type DeviceKind,
} from "@omnesis/types";
import { createDatabase } from "./db.js";
import { createServer } from "./server.js";
import { DeviceWsServer } from "./ws.js";
import { mountDeviceWsRoute } from "./device-ws-route.js";
import { createDevice } from "./data/repositories/DeviceRepository.js";
import { createToken, listTokens } from "./data/repositories/TokenRepository.js";
import { directWriteGate } from "./write-gate.js";
import type { Server } from "node:http";

let httpUrl: string;
let wsUrl: string;
let dbPath: string;
let db: ReturnType<typeof createDatabase>;
let wsServer: DeviceWsServer;
let server: Server;
let COLLECTOR_ID: DeviceId;
let COLLECTOR_TOKEN: string;
let ADMIN_ID: DeviceId;
let ADMIN_TOKEN: string;

async function listeningPort(listener: Server): Promise<number> {
  if (!listener.listening) await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP test listener");
  }
  return address.port;
}

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function waitForOpen(ws: WebSocket, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error("WS open timeout")), timeout);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function waitForClose(ws: WebSocket, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(() => reject(new Error("WS close timeout")), timeout);
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitForMessage<T = WsEnvelope>(ws: WebSocket, timeout = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS message timeout")), timeout);
    const handler = (ev: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(JSON.parse(ev.data as string) as T);
    };
    ws.addEventListener("message", handler);
  });
}

function waitFor<T = WsEnvelope>(
  ws: WebSocket,
  pred: (msg: T) => boolean,
  timeout = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS match timeout")), timeout);
    const handler = (ev: MessageEvent) => {
      const parsed = JSON.parse(ev.data as string) as T;
      if (pred(parsed)) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(parsed);
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function connectAndHello(
  token: string,
  capabilities: Record<string, unknown> = {},
): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl, websocketAuthProtocol(token));
  await waitForOpen(ws);
  const hello = makeCommand("hello", { capabilities, protocolVersion: PROTOCOL_VERSION });
  ws.send(JSON.stringify(hello));
  const res = await waitForMessage<WsResponse>(ws);
  if (!res.ok) throw new Error(`hello failed: ${JSON.stringify(res)}`);
  return ws;
}

async function waitForCondition(fn: () => boolean, timeoutMs = 3000, pollMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("waitForCondition timeout");
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

beforeAll(async () => {
  dbPath = `/tmp/omnesis-ws-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);

  const collector = createDevice(db, { name: "collector", kind: "collector" });
  COLLECTOR_ID = collector.id;
  COLLECTOR_TOKEN = createToken(db, COLLECTOR_ID, [SCOPE_WRITE_ALL]).token;

  const admin = createDevice(db, { name: "admin-cli", kind: "cli" });
  ADMIN_ID = admin.id;
  ADMIN_TOKEN = createToken(db, ADMIN_ID, [SCOPE_ADMIN, SCOPE_READ]).token;

  wsServer = new DeviceWsServer({
    authTimeoutMs: 1000,
    heartbeatIntervalMs: 200,
    db,
    writeGate: directWriteGate(db),
  });

  const app = createServer(db, dbPath, {
    onDocumentsUpserted: (sourceId, count) => {
      wsServer.broadcast(makeEvent("documents.upserted", { sourceId, count }));
    },
    wsServer,
  });

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  mountDeviceWsRoute(app, wsServer, upgradeWebSocket);

  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  injectWebSocket(server);

  wsServer.start();
  const port = await listeningPort(server);
  httpUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/device/ws`;
});

afterAll(async () => {
  wsServer.stop();
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  db.close();
  cleanupDb(dbPath);
});

describe("DeviceWsServer", () => {
  test("the production Hermes adapter completes an older wake's lifecycle on the real device route", async () => {
    // Keep the production-adapter probe on its own server. The suite exercises
    // the real WS authentication limiter elsewhere; sharing that limiter made
    // this test order-dependent once enough hello attempts accumulated.
    const localDbPath = `/tmp/omnesis-ws-hermes-${randomUUID()}.db`;
    const localDb = createDatabase(localDbPath);
    const agent = createDevice(localDb, { name: "fictional-hermes-agent", kind: "agent" });
    const token = createToken(localDb, agent.id, [SCOPE_SUBSCRIPTIONS_RECEIVE]).token;
    const wss = new DeviceWsServer({
      db: localDb,
      writeGate: directWriteGate(localDb),
      authTimeoutMs: 1_000,
      heartbeatIntervalMs: 10_000,
    });
    const app = createServer(localDb, localDbPath, { wsServer: wss });
    const { injectWebSocket: injectLocal, upgradeWebSocket: upgradeLocal } = createNodeWebSocket({
      app,
    });
    mountDeviceWsRoute(app, wss, upgradeLocal);
    const localServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    injectLocal(localServer);
    wss.start();
    const localPort = await listeningPort(localServer);

    const sourceDirectory = dirname(fileURLToPath(import.meta.url));
    const probe = resolve(sourceDirectory, "../../agent-integration/test/hermes_gateway_probe.py");
    const adapter = resolve(sourceDirectory, "../../agent-integration/hermes/adapter.py");
    const stateDirectory = mkdtempSync(join(tmpdir(), "omnesis-hermes-probe-"));
    const statePath = join(stateDirectory, "integration.sqlite");
    const probeProcess = spawn("python3", ["-B", probe], {
      env: {
        ...process.env,
        OMNESIS_HERMES_ADAPTER_PATH: adapter,
        OMNESIS_HERMES_GATEWAY_URL: `http://127.0.0.1:${localPort}`,
        OMNESIS_HERMES_DELIVERY_TOKEN: token,
        OMNESIS_HERMES_STATE_PATH: statePath,
        OMNESIS_HERMES_EXPECT_RESPONSES: "7",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let probeStdout = "";
    let probeStderr = "";
    probeProcess.stdout.setEncoding("utf8");
    probeProcess.stderr.setEncoding("utf8");
    probeProcess.stdout.on("data", (chunk: string) => {
      probeStdout += chunk;
    });
    probeProcess.stderr.on("data", (chunk: string) => {
      probeStderr += chunk;
    });
    const probeExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        probeProcess.once("error", rejectExit);
        probeProcess.once("exit", (code, signal) => resolveExit({ code, signal }));
      },
    );
    try {
      // The probe's own output on the way in: without it a hello the gateway
      // refused looks identical to a probe that never started, and the failure
      // says only that a condition timed out.
      try {
        await waitForCondition(() => wss.isConnected(agent.id, SCOPE_SUBSCRIPTIONS_RECEIVE), 5_000);
      } catch (error) {
        throw new Error(
          `the probe never connected\nstderr:\n${probeStderr}\nstdout:\n${probeStdout}`,
          {
            cause: error,
          },
        );
      }
      const acceptedPayload = {
        protocolVersion: 3 as const,
        deliveryId: "adl_probe_accepted",
        firingId: "trf_probe_accepted",
        subscriptionId: "sub_probe",
        workflowHandle: "wf_probe",
        reaction: { instruction: "Review the fictional probe update." },
        answer: {
          token: "omn_probe_first",
          expiresAt: Date.now() + 60_000,
          endpoint: "/subscriptions/firings/trf_probe_accepted/answer",
        },
      };
      await expect(
        wss.sendCommand(
          agent.id,
          "subscription.prepare",
          acceptedPayload,
          2_000,
          SCOPE_SUBSCRIPTIONS_RECEIVE,
        ),
      ).resolves.toMatchObject({ status: "prepared", duplicate: false });
      const firstCommit = await wss.sendCommand(
        agent.id,
        "subscription.commit",
        { protocolVersion: 3, deliveryId: acceptedPayload.deliveryId },
        2_000,
        SCOPE_SUBSCRIPTIONS_RECEIVE,
      );
      expect(firstCommit).toMatchObject({ status: "accepted", duplicate: false });

      await expect(
        wss.sendCommand(
          agent.id,
          "subscription.prepare",
          {
            ...acceptedPayload,
            answer: {
              ...acceptedPayload.answer,
              token: "omn_probe_rotated",
              expiresAt: acceptedPayload.answer.expiresAt + 60_000,
            },
          },
          2_000,
          SCOPE_SUBSCRIPTIONS_RECEIVE,
        ),
      ).resolves.toMatchObject({ status: "prepared", duplicate: true });
      await expect(
        wss.sendCommand(
          agent.id,
          "subscription.commit",
          { protocolVersion: 3, deliveryId: acceptedPayload.deliveryId },
          2_000,
          SCOPE_SUBSCRIPTIONS_RECEIVE,
        ),
      ).resolves.toEqual({ ...firstCommit, duplicate: true });

      const cancelledPayload = {
        ...acceptedPayload,
        deliveryId: "adl_probe_cancelled",
        firingId: "trf_probe_cancelled",
        answer: {
          ...acceptedPayload.answer,
          endpoint: "/subscriptions/firings/trf_probe_cancelled/answer",
        },
      };
      await expect(
        wss.sendCommand(
          agent.id,
          "subscription.prepare",
          cancelledPayload,
          2_000,
          SCOPE_SUBSCRIPTIONS_RECEIVE,
        ),
      ).resolves.toMatchObject({ status: "prepared", duplicate: false });
      await expect(
        wss.sendCommand(
          agent.id,
          "subscription.cancel",
          { protocolVersion: 3, deliveryId: cancelledPayload.deliveryId },
          2_000,
          SCOPE_SUBSCRIPTIONS_RECEIVE,
        ),
      ).resolves.toMatchObject({ status: "cancelled", duplicate: false });
      await expect(
        wss.sendCommand(
          agent.id,
          "subscription.commit",
          { protocolVersion: 3, deliveryId: cancelledPayload.deliveryId },
          2_000,
          SCOPE_SUBSCRIPTIONS_RECEIVE,
        ),
      ).rejects.toMatchObject({ code: "cancelled" });

      const exited = await Promise.race([
        probeExit,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Hermes protocol probe exit timeout")), 5_000);
        }),
      ]);
      expect(exited, probeStderr).toEqual({ code: 0, signal: null });
      expect(JSON.parse(probeStdout.trim())).toEqual({
        status: "PROTOCOL_OK",
        starts: 1,
        states: {
          adl_probe_accepted: "accepted",
          adl_probe_cancelled: "cancelled",
        },
        answerThread: true,
      });
      expect(
        JSON.parse(
          localDb
            .prepare<
              [string],
              { capabilities: string }
            >("SELECT capabilities FROM devices WHERE id = ?")
            .get(agent.id)!.capabilities,
        ),
      ).toMatchObject({
        platform: "hermes",
        agentIntegration: {
          harness: "hermes",
          // The range the shipped adapter offers, recorded as it sent it: the
          // gateway picks the highest version they share per wake, so what is
          // stored here has to be the span rather than a single number.
          deliveryProtocolMin: 3,
          deliveryProtocolMax: 4,
          maxConcurrentRuns: 1,
        },
      });
    } finally {
      if (probeProcess.exitCode === null && probeProcess.signalCode === null) {
        probeProcess.kill("SIGTERM");
        await probeExit.catch(() => undefined);
      }
      rmSync(stateDirectory, { recursive: true, force: true });
      wss.stop();
      await new Promise<void>((resolve) => {
        localServer.closeAllConnections?.();
        localServer.close(() => resolve());
      });
      localDb.close();
      cleanupDb(localDbPath);
    }
  });

  test("upgrade token plus hello authenticates and returns deviceId + scopes", async () => {
    const ws = new WebSocket(wsUrl, websocketAuthProtocol(COLLECTOR_TOKEN));
    await waitForOpen(ws);
    ws.send(
      JSON.stringify(
        makeCommand("hello", {
          protocolVersion: PROTOCOL_VERSION,
        }),
      ),
    );
    const res = await waitForMessage<WsResponse>(ws);
    expect(res.kind).toBe("response");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { deviceId: string }).deviceId).toBe(COLLECTOR_ID);
      expect((res.result as { scopes: string[] }).scopes).toEqual([SCOPE_WRITE_ALL]);
      expect((res.result as { deviceKind: string }).deviceKind).toBe("collector");
    }
    ws.close();
    await waitForClose(ws);
  });

  test("invalid token rejects before WebSocket upgrade", async () => {
    const res = await fetch(`${httpUrl}/device/ws`, {
      headers: { "Sec-WebSocket-Protocol": websocketAuthProtocol("omn_bogus") },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
  });

  test("missing token rejects before WebSocket upgrade", async () => {
    const res = await fetch(`${httpUrl}/device/ws`);
    expect(res.status).toBe(401);
  });

  test("connection that doesn't hello in time is closed", async () => {
    const ws = new WebSocket(wsUrl, websocketAuthProtocol(COLLECTOR_TOKEN));
    await waitForOpen(ws);
    const res = await waitForMessage<WsResponse>(ws, 3000);
    expect(res.ok).toBe(false);
    await waitForClose(ws);
  });

  test("updates device capabilities on hello", async () => {
    const ws = await connectAndHello(COLLECTOR_TOKEN, { hostname: "mac-01", platform: "macos" });
    const row = db
      .prepare<[string], { capabilities: string }>("SELECT capabilities FROM devices WHERE id = ?")
      .get(COLLECTOR_ID)!;
    expect(JSON.parse(row.capabilities).hostname).toBe("mac-01");
    ws.close();
    await waitForClose(ws);
  });

  test("broadcast reaches authenticated connections", async () => {
    const ws = await connectAndHello(COLLECTOR_TOKEN);
    const eventPromise = waitFor<WsEvent>(
      ws,
      (m) => m.kind === "event" && m.type === "documents.upserted",
    );

    // Use the HTTP /documents endpoint to trigger a broadcast.
    const res = await fetch(`${httpUrl}/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${COLLECTOR_TOKEN}` },
      body: JSON.stringify({
        documents: [
          {
            providerId: "google",
            sourceId: "gmail",
            externalId: `ws-${randomUUID()}`,
            title: "hi",
            content: "body",
            contentHash: `h-${randomUUID()}`,
            metadata: {},
            sourceCreatedAt: "2024-01-15T10:00:00Z",
            sourceUpdatedAt: "2024-01-15T10:00:00Z",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const evt = await eventPromise;
    expect(evt.payload).toEqual({ sourceId: "gmail", count: 1 });
    ws.close();
    await waitForClose(ws);
  });

  test("broadcast with SCOPE_ADMIN filter only reaches admin connections", async () => {
    const adminWs = await connectAndHello(ADMIN_TOKEN);
    const collectorWs = await connectAndHello(COLLECTOR_TOKEN);

    // admin should get the event; collector (write:*, no admin) should not.
    const adminP = waitFor<WsEvent>(
      adminWs,
      (m) => m.kind === "event" && m.type === "device.status",
    );

    // Fire an admin-only event by triggering another device's hello, but we
    // can also just broadcast directly for this test.
    wsServer.broadcast(makeEvent("admin.only", { foo: 1 }), SCOPE_ADMIN);

    const raced = await Promise.race([
      waitFor<WsEvent>(adminWs, (m) => m.kind === "event" && m.type === "admin.only").then(
        () => "admin-got",
      ),
      waitFor<WsEvent>(collectorWs, (m) => m.kind === "event" && m.type === "admin.only", 500)
        .then(() => "collector-got")
        .catch(() => "collector-timeout"),
    ]);
    expect(raced).toBe("admin-got");

    adminWs.close();
    collectorWs.close();
    await Promise.all([waitForClose(adminWs), waitForClose(collectorWs)]);

    // Use the admin.only promise we set up but didn't await so TS knows it was used.
    void adminP;
  });

  test("sendCommand round-trip via device echo", async () => {
    // Wire an onDeviceCommand that ignores; we set up a dedicated server here
    // to exercise sendCommand (gateway → device).
    const localDbPath = `/tmp/omnesis-ws-rt-${randomUUID()}.db`;
    const localDb = createDatabase(localDbPath);
    const device = createDevice(localDb, { name: "rt", kind: "collector" });
    const tok = createToken(localDb, device.id, [SCOPE_WRITE_ALL]).token;

    const wss = new DeviceWsServer({
      db: localDb,
      writeGate: directWriteGate(localDb),
      authTimeoutMs: 1000,
      heartbeatIntervalMs: 10_000,
    });
    const app = createServer(localDb, localDbPath, { wsServer: wss });

    const { injectWebSocket: injectLocal, upgradeWebSocket: upgradeLocal } = createNodeWebSocket({
      app,
    });
    mountDeviceWsRoute(app, wss, upgradeLocal);
    const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    injectLocal(s);
    wss.start();
    const localPort = await listeningPort(s);

    const ws = new WebSocket(`ws://127.0.0.1:${localPort}/device/ws`, websocketAuthProtocol(tok));
    await waitForOpen(ws);
    ws.send(
      JSON.stringify(
        makeCommand("hello", {
          protocolVersion: PROTOCOL_VERSION,
        }),
      ),
    );
    await waitForMessage<WsResponse>(ws);

    // Device returns a schema-valid source.debug response.
    ws.addEventListener("message", (ev) => {
      const envelope = JSON.parse(ev.data as string) as WsEnvelope;
      if (envelope.kind === "command") {
        ws.send(
          JSON.stringify(
            makeResponseOk(envelope.id, {
              status: { echoed: envelope.payload },
            }),
          ),
        );
      }
    });

    // Wait until the device shows up in wss.
    await waitForCondition(() => wss.isConnected(device.id));

    // Use a real registry command so the typed sendCommand<K> infers.
    const result = await wss.sendCommand(device.id, "source.debug", { sourceId: "gmail:x" });
    expect(result.status).toEqual({ echoed: { sourceId: "gmail:x" } });

    ws.close();
    await waitForClose(ws);
    wss.stop();
    await new Promise<void>((resolve) => {
      s.closeAllConnections?.();
      s.close(() => resolve());
    });
    localDb.close();
    cleanupDb(localDbPath);
  });

  test("sendCommand selects only a socket carrying the required receive scope", async () => {
    const localDbPath = `/tmp/omnesis-ws-scoped-${randomUUID()}.db`;
    const localDb = createDatabase(localDbPath);
    const device = createDevice(localDb, { name: "fictional-agent", kind: "agent" });
    const managementToken = createToken(localDb, device.id, [SCOPE_ADMIN]).token;
    const receiveToken = createToken(localDb, device.id, [SCOPE_SUBSCRIPTIONS_RECEIVE]).token;
    const wss = new DeviceWsServer({
      db: localDb,
      writeGate: directWriteGate(localDb),
      authTimeoutMs: 1000,
      heartbeatIntervalMs: 10_000,
    });
    const app = createServer(localDb, localDbPath, { wsServer: wss });
    const { injectWebSocket: injectLocal, upgradeWebSocket: upgradeLocal } = createNodeWebSocket({
      app,
    });
    mountDeviceWsRoute(app, wss, upgradeLocal);
    const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    injectLocal(s);
    wss.start();
    const localPort = await listeningPort(s);

    const managementWs = new WebSocket(
      `ws://127.0.0.1:${localPort}/device/ws`,
      websocketAuthProtocol(managementToken),
    );
    let receiveWs: WebSocket | undefined;
    try {
      await waitForOpen(managementWs);
      managementWs.send(
        JSON.stringify(makeCommand("hello", { protocolVersion: PROTOCOL_VERSION })),
      );
      await waitForMessage<WsResponse>(managementWs);
      await waitForCondition(() => wss.isConnected(device.id));
      expect(wss.isConnected(device.id, SCOPE_SUBSCRIPTIONS_RECEIVE)).toBe(false);
      const payload = {
        protocolVersion: 3 as const,
        deliveryId: "sdel_fictional",
        firingId: "sfiring_fictional",
        subscriptionId: "sub_fictional",
        workflowHandle: "wf_fictional",
        reaction: { instruction: "Prepare a fictional checklist." },
        answer: {
          token: "omn_fictional_token",
          expiresAt: Date.now() + 60_000,
          endpoint: "/subscriptions/firings/sfiring_fictional/answer",
        },
      };
      await expect(
        wss.sendCommand(
          device.id,
          "subscription.prepare",
          payload,
          1_000,
          SCOPE_SUBSCRIPTIONS_RECEIVE,
        ),
      ).rejects.toThrow(/required scope subscriptions:receive/);

      receiveWs = new WebSocket(
        `ws://127.0.0.1:${localPort}/device/ws`,
        websocketAuthProtocol(receiveToken),
      );
      await waitForOpen(receiveWs);
      receiveWs.send(JSON.stringify(makeCommand("hello", { protocolVersion: PROTOCOL_VERSION })));
      await waitForMessage<WsResponse>(receiveWs);
      await waitForCondition(() => wss.isConnected(device.id, SCOPE_SUBSCRIPTIONS_RECEIVE));
      let deliveryCommandCount = 0;
      receiveWs.addEventListener("message", (event) => {
        const envelope = JSON.parse(event.data as string) as WsEnvelope;
        if (envelope.kind !== "command" || envelope.type !== "subscription.prepare") return;
        deliveryCommandCount += 1;
        if (deliveryCommandCount === 1) {
          // A second authenticated socket for the same device cannot spoof the
          // acknowledgement, even when it guesses the correlation id and sends
          // a schema-valid payload first.
          managementWs.send(
            JSON.stringify(
              makeResponseOk(envelope.id, {
                status: "prepared",
                preparedAt: Date.now(),
                duplicate: false,
              }),
            ),
          );
          setTimeout(() => {
            receiveWs!.send(
              JSON.stringify(
                makeResponseOk(envelope.id, {
                  status: "prepared",
                  preparedAt: Date.now(),
                  duplicate: false,
                }),
              ),
            );
          }, 25);
          return;
        }
        // A response from the correct socket is still rejected when it does
        // not satisfy the registry's command-specific response schema.
        receiveWs!.send(
          JSON.stringify(
            makeResponseOk(envelope.id, {
              status: "prepared",
            }),
          ),
        );
      });
      await expect(
        wss.sendCommand(
          device.id,
          "subscription.prepare",
          payload,
          1_000,
          SCOPE_SUBSCRIPTIONS_RECEIVE,
        ),
      ).resolves.toMatchObject({ status: "prepared", duplicate: false });
      await expect(
        wss.sendCommand(
          device.id,
          "subscription.prepare",
          payload,
          1_000,
          SCOPE_SUBSCRIPTIONS_RECEIVE,
        ),
      ).rejects.toThrow(/invalid subscription\.prepare response payload/);
    } finally {
      managementWs.close();
      receiveWs?.close();
      await Promise.all([
        waitForClose(managementWs),
        receiveWs ? waitForClose(receiveWs) : Promise.resolve(),
      ]);
      wss.stop();
      await new Promise<void>((resolve) => {
        s.closeAllConnections?.();
        s.close(() => resolve());
      });
      localDb.close();
      cleanupDb(localDbPath);
    }
  });

  // Closing a device socket mid-command should reject the
  // pending sendCommand promise immediately, not after `commandTimeoutMs`
  // (default 30s). The pending command is now tagged with the WsHandle
  // it was dispatched on; `onClose` walks `pending` and rejects the
  // matching entries with "device disconnected".
  test("sendCommand rejects on device disconnect without waiting for timeout", async () => {
    const localDbPath = `/tmp/omnesis-ws-disc-${randomUUID()}.db`;
    const localDb = createDatabase(localDbPath);
    const device = createDevice(localDb, { name: "disc", kind: "collector" });
    const tok = createToken(localDb, device.id, [SCOPE_WRITE_ALL]).token;

    const wss = new DeviceWsServer({
      db: localDb,
      writeGate: directWriteGate(localDb),
      authTimeoutMs: 1000,
      heartbeatIntervalMs: 10_000,
      // Generous default so the assertion is meaningful — we expect
      // rejection well before this fires.
      commandTimeoutMs: 30_000,
    });
    const app = createServer(localDb, localDbPath, { wsServer: wss });

    const { injectWebSocket: injectLocal, upgradeWebSocket: upgradeLocal } = createNodeWebSocket({
      app,
    });
    mountDeviceWsRoute(app, wss, upgradeLocal);
    const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    injectLocal(s);
    wss.start();
    const localPort = await listeningPort(s);

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${localPort}/device/ws`, websocketAuthProtocol(tok));
      await waitForOpen(ws);
      ws.send(
        JSON.stringify(
          makeCommand("hello", {
            protocolVersion: PROTOCOL_VERSION,
          }),
        ),
      );
      await waitForMessage<WsResponse>(ws);

      // The device deliberately ignores incoming commands — it doesn't
      // echo, so without the disconnect the sendCommand would sit
      // there until the 30s timeout fires.
      await waitForCondition(() => wss.isConnected(device.id));

      const startMs = Date.now();
      // Use a real registry command — the device deliberately doesn't
      // respond, so the type doesn't actually matter for the assertion;
      // it just has to satisfy the typed sendCommand<K> constraint.
      const pending = wss.sendCommand(device.id, "source.debug", { sourceId: "gmail:x" });
      // Close the device side after a short tick so the command is
      // already registered in `pending` when `onClose` walks the map.
      setTimeout(() => ws.close(), 50);

      await expect(pending).rejects.toThrow(/device disconnected/);
      const elapsed = Date.now() - startMs;
      // Generous bound — must be well under commandTimeoutMs (30s).
      expect(elapsed).toBeLessThan(2000);
    } finally {
      wss.stop();
      await new Promise<void>((resolve) => {
        s.closeAllConnections?.();
        s.close(() => resolve());
      });
      localDb.close();
      cleanupDb(localDbPath);
    }
  });

  test("authenticatedClientCount reflects active sessions", async () => {
    await waitForCondition(() => wsServer.authenticatedClientCount === 0);
    const a = await connectAndHello(COLLECTOR_TOKEN);
    const b = await connectAndHello(ADMIN_TOKEN);
    expect(wsServer.authenticatedClientCount).toBe(2);
    a.close();
    await waitForClose(a);
    await waitForCondition(() => wsServer.authenticatedClientCount === 1);
    b.close();
    await waitForClose(b);
  });

  test("invalid JSON returns error envelope", async () => {
    const ws = new WebSocket(wsUrl, websocketAuthProtocol(COLLECTOR_TOKEN));
    await waitForOpen(ws);
    ws.send("not valid json {{{");
    const res = await waitForMessage<WsResponse>(ws);
    expect(res.ok).toBe(false);
    ws.close();
    await waitForClose(ws);
  });
});

/**
 * A device paired before one of its hosted sources shipped is missing that
 * source's `write:<source-type>` scope, so the gateway 403s its pushes. On the
 * phone the offline buffer drains strictly FIFO, so those rejections stall
 * every other source's batches behind them and the whole device goes silently
 * stale. Re-deriving the grant on each handshake heals it without a re-pair.
 *
 * Driven against a dedicated server so these connections don't spend the
 * shared suite's per-IP hello budget.
 */
describe("DeviceWsServer scope reconciliation on handshake", () => {
  let scopeDbPath: string;
  let scopeDb: ReturnType<typeof createDatabase>;
  let srv: DeviceWsServer;

  beforeEach(() => {
    scopeDbPath = `/tmp/omnesis-ws-scope-${randomUUID()}.db`;
    scopeDb = createDatabase(scopeDbPath);
    srv = new DeviceWsServer({
      db: scopeDb,
      writeGate: directWriteGate(scopeDb),
      authTimeoutMs: 60_000,
    });
  });

  afterEach(() => {
    scopeDb.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(scopeDbPath + suffix)) unlinkSync(scopeDbPath + suffix);
    }
  });

  /** Drive one hello and return the handshake response payload. */
  async function hello(deviceKind: DeviceKind, scopes: Scope[]): Promise<Record<string, unknown>> {
    const device = createDevice(scopeDb, { name: `phone-${randomUUID()}`, kind: deviceKind });
    const { id: tokenId } = createToken(scopeDb, device.id, scopes);
    const sent: string[] = [];
    const ws = { send: (d: string) => sent.push(d), close: () => {} };

    srv.onOpen(ws, "test-client", { tokenId, deviceId: device.id, scopes });
    srv.onMessage(ws, JSON.stringify(makeCommand("hello", { protocolVersion: PROTOCOL_VERSION })));
    // handleHello awaits the writer gate before replying.
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    srv.onClose(ws);

    const res = JSON.parse(sent[0]!) as WsResponse;
    expect(res.ok).toBe(true);
    return (res as { result: Record<string, unknown> }).result;
  }

  test("grants a device the write scopes its kind hosts", async () => {
    // Paired back when the iOS grant covered only the health source.
    const result = await hello("ios", [SCOPE_ADMIN, SCOPE_READ, Scope("write:apple-health")]);

    const scopes = result.scopes as string[];
    for (const type of DEVICE_HOSTED_SOURCE_TYPES.ios) {
      expect(scopes).toContain(writeScope(type));
    }
  });

  test("never widens a deliberately narrowed token beyond write scopes", async () => {
    // An operator who stripped `admin` off a phone token keeps it stripped.
    const result = await hello("ios", [SCOPE_READ]);

    const scopes = result.scopes as string[];
    expect(scopes).toContain(SCOPE_READ);
    expect(scopes).not.toContain(SCOPE_ADMIN);
    expect(scopes).toContain(writeScope(SourceType("apple-health")));
  });

  test("leaves a collector's write:* grant untouched", async () => {
    const result = await hello("collector", [SCOPE_WRITE_ALL]);

    expect(result.scopes).toEqual([SCOPE_WRITE_ALL]);
  });

  // The grant is the handshake's only suspension point. A socket that closes
  // while it is pending must not be registered as connected afterwards: at
  // that moment `state.deviceId` is still null, so `dropConnection` skips its
  // byDevice cleanup and the entry would survive until process restart —
  // reported online by `isConnected` and preferred by `sendCommand` forever.
  test("a socket closed during the grant is never registered as connected", async () => {
    const device = createDevice(scopeDb, { name: "phone-drops", kind: "ios" });
    const { id: tokenId } = createToken(scopeDb, device.id, [SCOPE_READ]);
    const scopes = [SCOPE_READ];
    const ws = { send: () => {}, close: () => {} };

    srv.onOpen(ws, "test-client", { tokenId, deviceId: device.id, scopes });
    srv.onMessage(ws, JSON.stringify(makeCommand("hello", { protocolVersion: PROTOCOL_VERSION })));
    // Close before the writer round-trip settles.
    srv.onClose(ws);

    await vi.waitFor(() => {
      expect(listTokens(scopeDb).find((t) => t.id === tokenId)?.scopes).toContain(
        writeScope(SourceType("apple-health")),
      );
    });
    expect(srv.isConnected(device.id)).toBe(false);
  });
});

describe("DeviceWsServer collector presence lifecycle", () => {
  test("awaits connect publication and disconnects only after the last socket", async () => {
    const localDbPath = `/tmp/omnesis-ws-presence-${randomUUID()}.db`;
    const localDb = createDatabase(localDbPath);
    const collector = createDevice(localDb, { name: "presence-collector", kind: "collector" });
    const { id: tokenId } = createToken(localDb, collector.id, [SCOPE_WRITE_ALL]);
    let releaseConnect: (() => void) | undefined;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const onCollectorConnected = vi.fn(() => connectGate);
    const onCollectorDisconnected = vi.fn(async () => {});
    const srv = new DeviceWsServer({
      db: localDb,
      writeGate: directWriteGate(localDb),
      authTimeoutMs: 60_000,
      onCollectorConnected,
      onCollectorDisconnected,
    });
    const sentA: string[] = [];
    const sentB: string[] = [];
    const wsA = { send: (data: string) => sentA.push(data), close: vi.fn() };
    const wsB = { send: (data: string) => sentB.push(data), close: vi.fn() };
    const auth = {
      tokenId,
      deviceId: collector.id,
      scopes: [SCOPE_WRITE_ALL],
    };

    try {
      srv.onOpen(wsA, "test-client-a", auth);
      srv.onMessage(
        wsA,
        JSON.stringify(makeCommand("hello", { protocolVersion: PROTOCOL_VERSION })),
      );
      await vi.waitFor(() => expect(onCollectorConnected).toHaveBeenCalledTimes(1));
      expect(sentA).toEqual([]);

      releaseConnect?.();
      await vi.waitFor(() => expect(sentA).toHaveLength(1));

      srv.onOpen(wsB, "test-client-b", auth);
      srv.onMessage(
        wsB,
        JSON.stringify(makeCommand("hello", { protocolVersion: PROTOCOL_VERSION })),
      );
      await vi.waitFor(() => expect(sentB).toHaveLength(1));

      srv.onClose(wsA);
      expect(onCollectorDisconnected).not.toHaveBeenCalled();
      srv.onClose(wsB);
      await vi.waitFor(() => expect(onCollectorDisconnected).toHaveBeenCalledTimes(1));
      expect(onCollectorDisconnected).toHaveBeenCalledWith(collector.id);
    } finally {
      localDb.close();
      cleanupDb(localDbPath);
    }
  });
});

/**
 * Socket liveness.
 *
 * A phone can lose connectivity without a TCP FIN — a tunnel collapsing, a
 * radio switching off, an access point dying. The socket stays OPEN on the
 * gateway and `ws.send()` on it only buffers, so nothing about the write path
 * reveals that the peer is gone. That matters far beyond the socket itself:
 * `selectPushTransport` short-circuits to the `socket` transport whenever the
 * device is connected, and a socket wake that does not throw settles the
 * notification as sent — no APNs/FCM/relay fallback, no retry. A ghost entry
 * in the connection table therefore swallows every banner it is offered.
 *
 * The heartbeat answers it with a WebSocket ping frame per tick and one tick
 * of grace.
 */
describe("DeviceWsServer socket liveness", () => {
  let livenessDbPath: string;
  let livenessDb: ReturnType<typeof createDatabase>;
  let srv: DeviceWsServer;

  beforeEach(() => {
    livenessDbPath = `/tmp/omnesis-ws-liveness-${randomUUID()}.db`;
    livenessDb = createDatabase(livenessDbPath);
    srv = new DeviceWsServer({
      db: livenessDb,
      writeGate: directWriteGate(livenessDb),
      authTimeoutMs: 60_000,
      heartbeatIntervalMs: 25,
    });
  });

  afterEach(() => {
    srv.stop();
    livenessDb.close();
    cleanupDb(livenessDbPath);
  });

  /**
   * A connected phone whose peer either answers ping frames or has silently
   * vanished behind an OPEN socket.
   */
  async function connectPhone(answersPings: boolean) {
    const device = createDevice(livenessDb, { name: `phone-${randomUUID()}`, kind: "ios" });
    const { id: tokenId } = createToken(livenessDb, device.id, [SCOPE_READ]);
    const counts = { pings: 0, terminated: 0 };
    const ws = { send: () => {}, close: () => {} };
    const liveness = {
      ping: () => {
        counts.pings += 1;
        // A live peer's WebSocket stack answers the frame itself.
        if (answersPings) srv.onPong(ws);
      },
      terminate: () => {
        counts.terminated += 1;
      },
    };

    srv.onOpen(
      ws,
      "fictional-liveness-client",
      { tokenId, deviceId: device.id, scopes: [SCOPE_READ] },
      liveness,
    );
    srv.onMessage(ws, JSON.stringify(makeCommand("hello", { protocolVersion: PROTOCOL_VERSION })));
    await vi.waitFor(() => expect(srv.isConnected(device.id)).toBe(true));
    return { device, counts };
  }

  test("a peer that stops answering ping frames stops counting as connected", async () => {
    const { device, counts } = await connectPhone(false);

    srv.start();

    await vi.waitFor(() => expect(srv.isConnected(device.id)).toBe(false), { timeout: 5_000 });
    // Destroyed, not politely closed: the close handshake would wait on a
    // reply the dead peer will never send.
    expect(counts.terminated).toBe(1);
  });

  test("a peer that answers keeps its socket across heartbeats", async () => {
    const { device, counts } = await connectPhone(true);

    srv.start();

    await vi.waitFor(() => expect(counts.pings).toBeGreaterThanOrEqual(3), { timeout: 5_000 });
    expect(srv.isConnected(device.id)).toBe(true);
    expect(counts.terminated).toBe(0);
  });
});

describe("DeviceWsServer connection cap (#58)", () => {
  test("refuses new connections past maxConnections, keeps existing ones", () => {
    const capPath = `/tmp/omnesis-ws-cap-${randomUUID()}.db`;
    const capDb = createDatabase(capPath);
    const srv = new DeviceWsServer({
      db: capDb,
      writeGate: directWriteGate(capDb),
      authTimeoutMs: 60_000,
      maxConnections: 3,
    });

    const makeWs = () => {
      const sent: string[] = [];
      const state = { closed: false };
      const ws: { send: (d: string) => void; close: () => void } = {
        send: (d) => sent.push(d),
        close: () => {
          state.closed = true;
        },
      };
      return { ws, sent, state };
    };

    // Fill to the cap.
    const filled = Array.from({ length: 3 }, (_, i) => {
      const m = makeWs();
      srv.onOpen(m.ws, `ip-${i}`);
      return m;
    });

    // The next open is refused: closed with a too_many_connections error and
    // never retained.
    const over = makeWs();
    srv.onOpen(over.ws, "ip-over");
    expect(over.state.closed).toBe(true);
    expect(over.sent.join("")).toContain("too_many_connections");

    // The connections already at the cap are untouched.
    expect(filled.every((m) => !m.state.closed)).toBe(true);

    // Once one closes, a new connection is admitted again.
    srv.onClose(filled[0]!.ws);
    const readmitted = makeWs();
    srv.onOpen(readmitted.ws, "ip-readmit");
    expect(readmitted.state.closed).toBe(false);

    // Clear the per-connection auth timers.
    srv.onClose(filled[1]!.ws);
    srv.onClose(filled[2]!.ws);
    srv.onClose(readmitted.ws);
    capDb.close();
    if (existsSync(capPath)) unlinkSync(capPath);
  });
});
