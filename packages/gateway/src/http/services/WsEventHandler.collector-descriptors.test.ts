// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SCOPE_READ, SCOPE_WRITE_ALL, type DeviceId } from "@omnesis/types";
import { AuthFlowRegistry } from "../../auth-flows.js";
import { createDatabase } from "../../db.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { SyncStatusRegistry } from "../../sync-status.js";
import { WsEventHandler } from "./WsEventHandler.js";
import type { CollectorDescriptorCache } from "./CollectorDescriptorCache.js";
import type { DeviceWsServer } from "../../ws.js";
import type { WriteGate } from "../../write-gate.js";

let dbPath: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  dbPath = `/tmp/omnesis-ws-descriptors-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function makeHandler() {
  const calls: string[] = [];
  const collectorDescriptors = {
    prefetch: vi.fn((id: DeviceId) => calls.push(`prefetch ${id}`)),
    onDisconnected: vi.fn((id: DeviceId) => calls.push(`disconnected ${id}`)),
  };
  const handler = new WsEventHandler({
    db,
    writeGate: {} as WriteGate,
    syncStatus: new SyncStatusRegistry(),
    authFlows: new AuthFlowRegistry(),
    collectorDescriptors: collectorDescriptors as unknown as CollectorDescriptorCache,
  });
  handler.attachServer({
    sendCommand: vi.fn((id: DeviceId, type: string) => {
      calls.push(`${type} ${id}`);
      return Promise.resolve({ ok: true });
    }),
    isConnected: () => true,
  } as unknown as DeviceWsServer);
  return { handler, calls, collectorDescriptors };
}

describe("WsEventHandler — collector descriptors", () => {
  test("a collector that connects is asked for its descriptors before it is sent its snapshot", () => {
    const collector = createDevice(db, { name: "desk-collector", kind: "collector" });
    const { handler, calls } = makeHandler();

    handler.handleConnected({ deviceId: collector.id, scopes: [SCOPE_WRITE_ALL] });

    expect(calls).toEqual([`prefetch ${collector.id}`, `sources.snapshot ${collector.id}`]);
  });

  test("a phone that connects is not asked", () => {
    const phone = createDevice(db, { name: "pocket-phone", kind: "ios" });
    const { handler, collectorDescriptors } = makeHandler();

    handler.handleConnected({ deviceId: phone.id, scopes: [SCOPE_READ] });

    expect(collectorDescriptors.prefetch).not.toHaveBeenCalled();
  });

  test("every closed socket is reported, whatever its token's scopes", () => {
    const collector = createDevice(db, { name: "desk-collector", kind: "collector" });
    const { handler, collectorDescriptors } = makeHandler();

    handler.handleDisconnected({ deviceId: collector.id, scopes: [SCOPE_READ] });
    handler.handleDisconnected({ deviceId: collector.id, scopes: [SCOPE_WRITE_ALL] });

    expect(collectorDescriptors.onDisconnected).toHaveBeenCalledTimes(2);
    expect(collectorDescriptors.onDisconnected).toHaveBeenCalledWith(collector.id);
  });
});
