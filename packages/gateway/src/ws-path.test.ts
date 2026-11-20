// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { makeCommand, makeEvent, PROTOCOL_VERSION } from "@omnesis/core";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { createDatabase } from "./db.js";
import { createDevice } from "./data/repositories/DeviceRepository.js";
import { createToken } from "./data/repositories/TokenRepository.js";
import { directWriteGate } from "./write-gate.js";
import { createServer } from "./server.js";
import { DeviceWsServer } from "./ws.js";

test("advisory path updates require an authenticated session, cannot target other devices, and never change scopes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-path-ws-"));
  const db = createDatabase(join(dir, "test.sqlite"));
  const device = createDevice(db, { name: "Fictional paired CLI", kind: "cli" });
  const token = createToken(db, device.id, [SCOPE_READ]);
  const gate = directWriteGate(db);
  const touch = vi.spyOn(gate, "touchDevice");
  const events = vi.fn();
  const server = new DeviceWsServer({ db, writeGate: gate, onDeviceEvent: events });
  const sent: string[] = [];
  const first = { send: (x: string) => sent.push(x), close: vi.fn() };
  const second = { send: vi.fn(), close: vi.fn() };
  const legacy = { send: vi.fn(), close: vi.fn() };
  const auth = { tokenId: token.id, deviceId: device.id, scopes: [SCOPE_READ] };
  try {
    server.onOpen(first, "fictional-peer", { ...auth, connectionPath: "relay" });
    server.onMessage(first, JSON.stringify(makeEvent("connection.path", { path: "local" })));
    expect(server.connectionPath(device.id)).toBeUndefined();
    server.onMessage(
      first,
      JSON.stringify(makeCommand("hello", { protocolVersion: PROTOCOL_VERSION })),
    );
    await vi.waitFor(() => expect(server.isConnected(device.id)).toBe(true));
    expect(server.connectionPath(device.id)).toBe("relay");
    const touches = touch.mock.calls.length;
    for (const payload of [
      { path: "local", deviceId: "other-device" },
      { path: "reconnecting" },
      { path: "local", admin: true },
    ])
      server.onMessage(first, JSON.stringify(makeEvent("connection.path", payload)));
    expect(server.connectionPath(device.id)).toBe("relay");
    server.onMessage(first, JSON.stringify(makeEvent("connection.path", { path: "local" })));
    expect(server.connectionPath(device.id)).toBe("local");
    expect(server.isConnected(device.id, SCOPE_ADMIN)).toBe(false);
    expect(touch.mock.calls.length).toBe(touches);
    expect(events).not.toHaveBeenCalled();
    server.onOpen(second, "fictional-peer", { ...auth, connectionPath: "relay" });
    server.onMessage(
      second,
      JSON.stringify(makeCommand("hello", { protocolVersion: PROTOCOL_VERSION })),
    );
    await vi.waitFor(() => expect(second.send).toHaveBeenCalled());
    expect(server.connectionPath(device.id)).toBe("relay");
    server.onClose(second);
    expect(server.connectionPath(device.id)).toBe("local");
    server.onClose(first);
    expect(server.connectionPath(device.id)).toBe("reconnecting");
    server.onOpen(legacy, "fictional-peer", auth);
    server.onMessage(
      legacy,
      JSON.stringify(makeCommand("hello", { protocolVersion: PROTOCOL_VERSION })),
    );
    await vi.waitFor(() => expect(legacy.send).toHaveBeenCalled());
    expect(server.connectionPath(device.id)).toBeUndefined();
    server.disconnectDevice(device.id);
    server.onMessage(legacy, JSON.stringify(makeEvent("connection.path", { path: "relay" })));
    expect(server.connectionPath(device.id)).toBeUndefined();
  } finally {
    for (const ws of [first, second, legacy]) server.onClose(ws);
    server.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gateway device listing associates HTTP observations only with the validated device credential", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-path-http-"));
  const path = join(dir, "gateway.sqlite");
  const db = createDatabase(path);
  const device = createDevice(db, { name: "Fictional CLI transport", kind: "cli" });
  const token = createToken(db, device.id, [SCOPE_READ]);
  const admin = createToken(db, device.id, [SCOPE_ADMIN]);
  const server = new DeviceWsServer({ db, writeGate: directWriteGate(db) });
  const app = createServer(db, path, { wsServer: server });
  try {
    expect(
      (
        await app.request("/whoami", {
          headers: {
            authorization: "Bearer invalid-test-token",
            "x-omnesis-connection-path": "relay",
            "x-forwarded-for": "127.0.0.1",
          },
        })
      ).status,
    ).toBe(401);
    expect(server.connectionPath(device.id)).toBeUndefined();
    expect(
      (
        await app.request("/whoami", {
          headers: { authorization: `Bearer ${token.token}`, "x-omnesis-connection-path": "local" },
        })
      ).status,
    ).toBe(200);
    const response = await app.request("/admin/devices", {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(response.status).toBe(200);
    expect(
      (await response.json()).items.find((row: { id: string }) => row.id === device.id)
        .connectionPath,
    ).toBe("local");
    expect(server.isConnected(device.id)).toBe(false);
  } finally {
    server.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
