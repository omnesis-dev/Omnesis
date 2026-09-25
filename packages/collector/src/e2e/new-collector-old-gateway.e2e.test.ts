// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Frozen old-peer surface from release v0.4.22, commit
 * c77ba95eced1cea1f8b09cd0b51901d0db99de2e:
 * gateway/http/routes/status.ts (/health), core/ws-protocol.ts (envelopes),
 * core/ws-messages.ts (hello response; protocol version 1).
 *
 * This is a deliberately permissive transport peer, not a second gateway
 * implementation. Every non-health HTTP request and source-progress event is
 * recorded: a missing guard cannot pass merely because an old route rejects
 * a modern payload. No installed release checkout or operator state is used.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import { expect, test } from "vitest";
import { SOURCE_CONTRACT_WIRE_RANGE } from "@omnesis/core";
import { SourceId, ProviderId } from "@omnesis/types";
import {
  GatewayWsClient,
  HttpGatewayClient,
  requireGatewaySourceContract,
} from "@omnesis/gateway-client";
import { createGatewayCommandHandler } from "../gateway-command-handler.js";
import { e2eGatewayEnv, e2eTsxCommand } from "./gateway-env.js";
import { registerSubprocessGroup, killSubprocessGroup } from "./subprocess-reaper.js";

const OLD_HEALTH = {
  status: "ok",
  version: "0.4.22",
  experimental: false,
  capabilities: { subscriptions: false },
  compat: { schema: 171, ws: 1, pairing: 4, watchPrivacyPolicy: 1 },
};
const OLD_HELLO = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  deviceName: "fixture-collector",
  deviceKind: "collector",
  scopes: ["read", "write:*", "admin"],
  protocolVersion: 1,
};
const SOURCE = SourceId("fictional:local");

async function oldPeer() {
  let modern = false;
  let downgradeOnNextWrite = false;
  const requests: Array<{ method: string; path: string; old: boolean; authorization?: string }> =
    [];
  const events: unknown[] = [];
  const responses = new Map<string, { ok: boolean; error?: { message: string } }>();
  let socket: WebSocket | undefined;
  let connections = 0;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://fixture.example").pathname;
    requests.push({
      method: request.method!,
      path,
      old: !modern,
      authorization: request.headers.authorization,
    });
    for await (const chunk of request) {
      // Drain real request bodies before replying; their contents are irrelevant.
      void chunk;
    }
    response.setHeader("Content-Type", "application/json");
    if (path === "/health") {
      response.end(
        JSON.stringify(
          modern
            ? {
                ...OLD_HEALTH,
                capabilities: {
                  ...OLD_HEALTH.capabilities,
                  sourceContract: SOURCE_CONTRACT_WIRE_RANGE,
                },
              }
            : OLD_HEALTH,
        ),
      );
    } else if (downgradeOnNextWrite) {
      downgradeOnNextWrite = false;
      modern = false;
      response.writeHead(503, { "Retry-After": "1" });
      response.end(JSON.stringify({ error: "Gateway replacement" }));
    } else {
      response.end(
        JSON.stringify({ ok: true, ingested: 0, reconciledDeleted: 0, indexCleanedRows: 0 }),
      );
    }
  });
  const websocket = new WebSocketServer({ server, path: "/device/ws" });
  websocket.on("connection", (connected) => {
    connections++;
    socket = connected;
    connected.on("message", (bytes) => {
      const message = JSON.parse(String(bytes));
      if (message.kind === "command" && message.type === "hello") {
        connected.send(
          JSON.stringify({
            kind: "response",
            correlationId: message.id,
            ok: true,
            result: OLD_HELLO,
          }),
        );
      } else if (message.kind === "response") responses.set(message.correlationId, message);
      else events.push(message);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture listen address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    events,
    connections: () => connections,
    upgrade: () => {
      modern = true;
    },
    replaceAfterFailure: () => {
      modern = true;
      downgradeOnNextWrite = true;
    },
    command: async (type: string, payload: unknown) => {
      const id = randomUUID();
      socket!.send(JSON.stringify({ kind: "command", id, type, payload }));
      await expect.poll(() => responses.has(id), { timeout: 10_000 }).toBe(true);
      return responses.get(id)!;
    },
    close: async () => {
      for (const connected of websocket.clients) connected.terminate();
      await new Promise<void>((resolve, reject) =>
        websocket.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("the real collector refuses a released gateway before pairing or starting sources", async () => {
  const peer = await oldPeer();
  const configDir = await mkdtemp(join(tmpdir(), "omnesis-old-peer-"));
  let child: ChildProcess | undefined;
  try {
    const command = e2eTsxCommand("packages/collector/src/main.ts");
    child = spawn(command.command, command.args, {
      cwd: join(import.meta.dirname, "../../../.."),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...e2eGatewayEnv(),
        OMNESIS_CONFIG_DIR: configDir,
        OMNESIS_GATEWAY_URL: peer.url,
        OMNESIS_SYNTHETIC: "1",
      },
    });
    registerSubprocessGroup(child);
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr!.on("data", (chunk) => {
      output += String(chunk);
    });
    await expect.poll(() => child!.exitCode, { timeout: 30_000 }).not.toBeNull();
    expect(child.exitCode, output).toBe(1);
    expect(output).toContain("Gateway upgrade required");
    expect(peer.requests.length).toBeGreaterThan(0);
    expect(
      peer.requests.every((request) => request.method === "GET" && request.path === "/health"),
    ).toBe(true);
    expect(peer.connections()).toBe(0);
  } finally {
    if (child) await killSubprocessGroup(child);
    await peer.close();
    await rm(configDir, { recursive: true, force: true });
  }
}, 45_000);

test("real HTTP retries and WS source/auth commands are refused after gateway downgrade, then recover", async () => {
  const peer = await oldPeer();
  const requireContract = () => requireGatewaySourceContract(peer.url);
  const client = new HttpGatewayClient(peer.url, "fictional-token", {
    beforeRequest: requireContract,
  });
  const websocket = new GatewayWsClient(peer.url, "fictional-token");
  const dispatched: string[] = [];
  websocket.onCommand(
    createGatewayCommandHandler(requireContract, [
      {
        handle: async (command) => {
          dispatched.push(command.type);
          if (command.type === "source.sync")
            websocket.emitEvent("sync.status", {
              sourceId: SOURCE,
              state: "syncing",
              progress: { processed: 1 },
            });
          return { ok: true };
        },
      },
    ]),
  );
  try {
    for (const operation of [
      () => client.setSyncState(SOURCE, { bookmark: 1 }),
      () =>
        client.ingestAnalyticsPage({
          tableName: "fixture_rows",
          records: [{ id: "one" }],
          sourceId: SOURCE,
        }),
      () =>
        client.upsertWithCursor({
          sourceId: SOURCE,
          providerId: ProviderId("fictional:local"),
          hasMore: false,
          cursor: {},
          presentClaims: [],
        }),
    ])
      await expect(operation()).rejects.toThrow("Gateway upgrade required");
    websocket.connect();
    await expect.poll(() => websocket.isAuthenticated(), { timeout: 10_000 }).toBe(true);
    for (const type of ["sources.snapshot", "source.sync", "auth.begin"]) {
      expect(await peer.command(type, {})).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("Gateway upgrade required") },
      });
    }
    expect(dispatched).toEqual([]);
    expect(peer.events).toEqual([]);
    expect((await peer.command("device.doctor", {})).ok).toBe(true);
    expect(dispatched).toEqual(["device.doctor"]);
    peer.replaceAfterFailure();
    await expect(client.setSyncState(SOURCE, { bookmark: 2 })).rejects.toThrow(
      "Gateway upgrade required",
    );
    expect(peer.requests.filter((request) => request.path !== "/health")).toEqual([
      expect.objectContaining({
        method: "POST",
        path: `/sync-state/${encodeURIComponent(SOURCE)}`,
        old: false,
      }),
    ]);
    peer.upgrade();
    await client.setSyncState(SOURCE, { bookmark: 3 });
    expect((await peer.command("source.sync", {})).ok).toBe(true);
    await expect.poll(() => peer.events.length).toBe(1);
    expect(peer.events).toEqual([
      expect.objectContaining({
        type: "sync.status",
        payload: expect.objectContaining({ progress: { processed: 1 } }),
      }),
    ]);
    expect(peer.requests.filter((request) => request.old && request.path !== "/health")).toEqual(
      [],
    );
    expect(
      peer.requests
        .filter((request) => request.path === "/health")
        .every((request) => request.authorization === undefined),
    ).toBe(true);
  } finally {
    websocket.disconnect();
    await peer.close();
  }
}, 30_000);
