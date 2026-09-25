// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  AccountId,
  SCOPE_READ,
  SourceId,
  SourceType,
  writeScope,
  type DeviceId,
} from "@omnesis/types";
import { AuthFlowRegistry } from "../../auth-flows.js";
import { createDatabase } from "../../db.js";
import {
  createDevice,
  updateDeviceCapabilities,
} from "../../data/repositories/DeviceRepository.js";
import { initializeOrAssertSourceMemberConfigContract } from "../../data/repositories/SourceMemberConfigContractRepository.js";
import { addSourceMember, createSource } from "../../data/repositories/SourceRepository.js";
import { ImportFlowRegistry } from "../../import-flows.js";
import { SyncStatusRegistry } from "../../sync-status.js";
import { WsEventHandler } from "./WsEventHandler.js";
import type { WsEvent } from "@omnesis/core";
import type { WriteGate } from "../../write-gate.js";
import type { DeviceConnection, DeviceWsServer } from "../../ws.js";

let dbPath: string;
let db: ReturnType<typeof createDatabase>;
let ownerDeviceId: DeviceId;
let otherDeviceId: DeviceId;

beforeEach(() => {
  dbPath = `/tmp/omnesis-ws-ownership-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  ownerDeviceId = createDevice(db, { name: "owner-collector", kind: "collector" }).id;
  otherDeviceId = createDevice(db, { name: "other-collector", kind: "collector" }).id;
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function registerSource(deviceId: DeviceId, id = "gmail:user@example.com"): SourceId {
  const sourceId = SourceId(id);
  createSource(db, {
    type: SourceType("gmail"),
    accountId: AccountId("user@example.com"),
    deviceId,
  });
  return sourceId;
}

function conn(deviceId: DeviceId, scopes = [writeScope(SourceType("gmail"))]): DeviceConnection {
  return { deviceId, scopes };
}

function syncStatusEvent(sourceId: SourceId, state = "syncing"): WsEvent {
  return { kind: "event", type: "sync.status", payload: { sourceId, state } };
}

function authUpdateEvent(flowId: string): WsEvent {
  return {
    kind: "event",
    type: "auth.update",
    payload: { flowId, type: "url", url: "https://auth.example.com/start" },
  };
}

function authCompleteEvent(flowId: string): WsEvent {
  return {
    kind: "event",
    type: "auth.complete",
    payload: { flowId, ok: true, accountId: "user@example.com" },
  };
}

function importProgressEvent(flowId: string): WsEvent {
  return {
    kind: "event",
    type: "import.progress",
    payload: { flowId, phase: "read", processed: 1, total: 2 },
  };
}

function importCompleteEvent(flowId: string): WsEvent {
  return {
    kind: "event",
    type: "import.complete",
    payload: { flowId, ok: true, imported: 2, merged: 0, skipped: 0 },
  };
}

function makeHandler(opts?: { authFlows?: AuthFlowRegistry; importFlows?: ImportFlowRegistry }): {
  handler: WsEventHandler;
  syncStatus: SyncStatusRegistry;
  broadcast: ReturnType<typeof vi.fn>;
  setSyncError: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
} {
  const syncStatus = new SyncStatusRegistry();
  const authFlows = opts?.authFlows ?? new AuthFlowRegistry();
  const importFlows = opts?.importFlows ?? new ImportFlowRegistry();
  const setSyncError = vi.fn(() => Promise.resolve(undefined));
  const handler = new WsEventHandler({
    db,
    writeGate: {
      setSyncError,
      clearSyncError: vi.fn(() => Promise.resolve(undefined)),
    } as unknown as WriteGate,
    syncStatus,
    authFlows,
    importFlows,
  });
  const broadcast = vi.fn();
  const sendCommand = vi.fn(() => Promise.resolve({ ok: true }));
  handler.attachServer({
    broadcast,
    sendCommand,
    isConnected: () => true,
  } as unknown as DeviceWsServer);
  return { handler, syncStatus, broadcast, setSyncError, sendCommand };
}

describe("WsEventHandler event ownership", () => {
  test("additive upgrades retain delivery and a unanimous repin refreshes siblings once", () => {
    const type = SourceType("visits-synth");
    const caps = (names: string[]) => ({
      hostableSourceTypes: [type],
      multiDeviceModes: { [type]: "partitioned" as const },
      memberScopedParams: { [type]: names },
      syncLease: true,
    });
    updateDeviceCapabilities(db, ownerDeviceId, caps([]));
    updateDeviceCapabilities(db, otherDeviceId, caps([]));
    const source = createSource(db, {
      type,
      accountId: AccountId("shared"),
      deviceId: ownerDeviceId,
      multiDeviceMode: "partitioned",
      memberScopedParams: [],
    });
    addSourceMember(db, source.id, otherDeviceId);
    const { handler, sendCommand } = makeHandler();
    handler.handleConnected({
      ...conn(ownerDeviceId),
      memberConfigChangedSourceIds: updateDeviceCapabilities(db, ownerDeviceId, caps(["folder"])),
    });
    expect(sendCommand).toHaveBeenCalledWith(ownerDeviceId, "sources.snapshot", {
      sources: [expect.objectContaining({ id: source.id })],
    });
    sendCommand.mockClear();
    handler.handleConnected({
      ...conn(otherDeviceId),
      memberConfigChangedSourceIds: updateDeviceCapabilities(db, otherDeviceId, caps(["folder"])),
    });
    expect(sendCommand).toHaveBeenCalledTimes(2);
    for (const deviceId of [ownerDeviceId, otherDeviceId]) {
      expect(sendCommand).toHaveBeenCalledWith(deviceId, "sources.snapshot", {
        sources: [expect.objectContaining({ id: source.id })],
      });
    }
    sendCommand.mockClear();
    handler.handleConnected({
      ...conn(otherDeviceId),
      memberConfigChangedSourceIds: updateDeviceCapabilities(db, otherDeviceId, caps(["folder"])),
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });
  test("a reconnect snapshot excludes a joined source after the member contract changes", () => {
    const type = SourceType("visits-synth");
    const capabilities = {
      hostableSourceTypes: [type],
      multiDeviceModes: { [type]: "partitioned" as const },
      memberScopedParams: { [type]: ["sessionsPath"] },
      syncLease: true,
    };
    updateDeviceCapabilities(db, ownerDeviceId, capabilities);
    updateDeviceCapabilities(db, otherDeviceId, capabilities);
    const source = createSource(db, {
      type,
      accountId: AccountId("shared"),
      deviceId: ownerDeviceId,
      multiDeviceMode: "partitioned",
    });
    addSourceMember(db, source.id, otherDeviceId);
    initializeOrAssertSourceMemberConfigContract(db, source.id, ["sessionsPath"]);
    updateDeviceCapabilities(db, otherDeviceId, {
      ...capabilities,
      memberScopedParams: { [type]: [] },
    });
    const { handler, sendCommand } = makeHandler();

    handler.handleConnected(conn(otherDeviceId));

    expect(sendCommand).toHaveBeenCalledWith(otherDeviceId, "sources.snapshot", { sources: [] });
  });

  test("a reconnect snapshot excludes a joined source after its persisted mode support is lost", () => {
    const type = SourceType("visits-synth");
    const capabilities = {
      hostableSourceTypes: [type],
      multiDeviceModes: { [type]: "replicated" as const },
      memberScopedParams: { [type]: [] },
      syncLease: true,
    };
    updateDeviceCapabilities(db, ownerDeviceId, capabilities);
    updateDeviceCapabilities(db, otherDeviceId, capabilities);
    const source = createSource(db, {
      type,
      accountId: AccountId("replicated-shared"),
      deviceId: ownerDeviceId,
      multiDeviceMode: "replicated",
    });
    addSourceMember(db, source.id, otherDeviceId);
    initializeOrAssertSourceMemberConfigContract(db, source.id, []);
    updateDeviceCapabilities(db, otherDeviceId, {
      ...capabilities,
      syncLease: false,
    });
    const { handler, sendCommand } = makeHandler();

    handler.handleConnected(conn(otherDeviceId));

    expect(sendCommand).toHaveBeenCalledWith(otherDeviceId, "sources.snapshot", { sources: [] });
  });

  test("a reconnect snapshot excludes a replica after its persisted row-version policy is lost", () => {
    const type = SourceType("tasks-synth");
    const capabilities = {
      hostableSourceTypes: [type],
      multiDeviceModes: { [type]: "replicated" as const },
      replicaVersionPolicies: { [type]: "source-updated-at" as const },
      memberScopedParams: { [type]: [] },
      syncLease: true,
    };
    updateDeviceCapabilities(db, ownerDeviceId, capabilities);
    updateDeviceCapabilities(db, otherDeviceId, capabilities);
    const source = createSource(db, {
      type,
      accountId: AccountId("versioned-shared"),
      deviceId: ownerDeviceId,
      multiDeviceMode: "replicated",
      replicaVersionPolicy: "source-updated-at",
    });
    addSourceMember(db, source.id, otherDeviceId);
    initializeOrAssertSourceMemberConfigContract(db, source.id, []);
    updateDeviceCapabilities(db, otherDeviceId, {
      ...capabilities,
      replicaVersionPolicies: {},
    });
    const { handler, sendCommand } = makeHandler();

    handler.handleConnected(conn(otherDeviceId));

    expect(sendCommand).toHaveBeenCalledWith(otherDeviceId, "sources.snapshot", { sources: [] });
  });

  test("drops sync.status when the source belongs to another device", () => {
    const sourceId = registerSource(ownerDeviceId);
    const { handler, syncStatus, broadcast } = makeHandler();

    handler.handleEvent(conn(otherDeviceId), syncStatusEvent(sourceId));

    expect(syncStatus.get(sourceId)).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("drops sync.status when the device token lacks the source write scope", () => {
    const sourceId = registerSource(ownerDeviceId);
    const { handler, syncStatus, broadcast } = makeHandler();

    handler.handleEvent(conn(ownerDeviceId, [SCOPE_READ]), syncStatusEvent(sourceId));

    expect(syncStatus.get(sourceId)).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("accepts sync.status from the owning device with a source write scope", () => {
    const sourceId = registerSource(ownerDeviceId);
    const { handler, syncStatus, broadcast } = makeHandler();
    const event = syncStatusEvent(sourceId);

    handler.handleEvent(conn(ownerDeviceId), event);

    expect(syncStatus.get(sourceId)?.state).toBe("syncing");
    expect(broadcast).toHaveBeenCalledWith(event);
  });

  test("persists sync status on the source's pinned cursor row despite conflicting announcements", () => {
    updateDeviceCapabilities(db, ownerDeviceId, {
      multiDeviceModes: { gmail: "replicated" },
    });
    updateDeviceCapabilities(db, otherDeviceId, {
      multiDeviceModes: { gmail: "handoff" },
    });
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(10, ownerDeviceId);
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(20, otherDeviceId);
    const sourceId = SourceId("gmail:user@example.com");
    createSource(db, {
      type: SourceType("gmail"),
      accountId: AccountId("user@example.com"),
      deviceId: ownerDeviceId,
      multiDeviceMode: "replicated",
    });
    const { handler, setSyncError } = makeHandler();

    handler.handleEvent(conn(ownerDeviceId), {
      kind: "event",
      type: "sync.status",
      payload: { sourceId, state: "error", errorMessage: "temporary sync failure" },
    });

    expect(setSyncError).toHaveBeenCalledWith(
      sourceId,
      "temporary sync failure",
      ownerDeviceId,
      undefined,
    );
  });

  test("accepts sync.status from a non-owning member of the source", () => {
    // Membership, not ownership, is the gate: a device listed in
    // source_devices may report even though sources.device_id names another.
    const sourceId = registerSource(ownerDeviceId);
    db.prepare("INSERT INTO source_devices (source_id, device_id, added_at) VALUES (?, ?, ?)").run(
      sourceId,
      otherDeviceId,
      Date.now(),
    );
    const { handler, syncStatus, broadcast } = makeHandler();
    const event = syncStatusEvent(sourceId);

    handler.handleEvent(conn(otherDeviceId), event);

    expect(syncStatus.get(sourceId)?.state).toBe("syncing");
    expect(broadcast).toHaveBeenCalledWith(event);
  });

  test("drops auth.update for a flow owned by another device", () => {
    const authFlows = new AuthFlowRegistry();
    const flow = authFlows.start({ sourceType: SourceType("gmail"), deviceId: ownerDeviceId });
    const subscriber = vi.fn();
    authFlows.subscribe(flow.id, subscriber);
    const { handler, broadcast } = makeHandler({ authFlows });

    handler.handleEvent(conn(otherDeviceId), authUpdateEvent(flow.id));

    expect(authFlows.get(flow.id)?.state).toBe("starting");
    expect(subscriber).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("accepts auth.update from the flow owner", () => {
    const authFlows = new AuthFlowRegistry();
    const flow = authFlows.start({ sourceType: SourceType("gmail"), deviceId: ownerDeviceId });
    const subscriber = vi.fn();
    authFlows.subscribe(flow.id, subscriber);
    const { handler, broadcast } = makeHandler({ authFlows });
    const event = authUpdateEvent(flow.id);

    handler.handleEvent(conn(ownerDeviceId), event);

    expect(authFlows.get(flow.id)?.state).toBe("awaiting-user");
    expect(subscriber).toHaveBeenCalledWith({
      type: "url",
      url: "https://auth.example.com/start",
      data: undefined,
      kind: undefined,
      payload: undefined,
      message: undefined,
    });
    expect(broadcast).toHaveBeenCalledWith(event);
  });

  test("drops auth.complete for a flow owned by another device", () => {
    const authFlows = new AuthFlowRegistry();
    const flow = authFlows.start({ sourceType: SourceType("gmail"), deviceId: ownerDeviceId });
    const subscriber = vi.fn();
    authFlows.subscribe(flow.id, subscriber);
    const { handler, broadcast } = makeHandler({ authFlows });

    handler.handleEvent(conn(otherDeviceId), authCompleteEvent(flow.id));

    expect(authFlows.get(flow.id)?.state).toBe("starting");
    expect(subscriber).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  test.each(["completed", "error"] as const)(
    "drops late auth events for a %s flow before broadcast",
    (state) => {
      const authFlows = new AuthFlowRegistry();
      const flow = authFlows.start({ sourceType: SourceType("gmail"), deviceId: ownerDeviceId });
      authFlows.update(flow.id, { state });
      const { handler, broadcast } = makeHandler({ authFlows });
      handler.handleEvent(conn(ownerDeviceId), authUpdateEvent(flow.id));
      handler.handleEvent(conn(ownerDeviceId), authCompleteEvent(flow.id));
      expect(authFlows.get(flow.id)?.state).toBe(state);
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  test("drops import.progress for a flow owned by another device", () => {
    const importFlows = new ImportFlowRegistry();
    const flow = importFlows.start({ sourceId: "gmail:user@example.com", deviceId: ownerDeviceId });
    const subscriber = vi.fn();
    importFlows.subscribe(flow.id, subscriber);
    const { handler } = makeHandler({ importFlows });

    handler.handleEvent(conn(otherDeviceId), importProgressEvent(flow.id));

    expect(importFlows.get(flow.id)?.state).toBe("starting");
    expect(subscriber).not.toHaveBeenCalled();
  });

  test("accepts import.progress from the flow owner", () => {
    const importFlows = new ImportFlowRegistry();
    const flow = importFlows.start({ sourceId: "gmail:user@example.com", deviceId: ownerDeviceId });
    const subscriber = vi.fn();
    importFlows.subscribe(flow.id, subscriber);
    const { handler } = makeHandler({ importFlows });

    handler.handleEvent(conn(ownerDeviceId), importProgressEvent(flow.id));

    expect(importFlows.get(flow.id)?.state).toBe("running");
    expect(subscriber).toHaveBeenCalledWith({
      type: "progress",
      phase: "read",
      processed: 1,
      total: 2,
      detail: undefined,
    });
  });

  test("drops import.complete for a flow owned by another device", () => {
    const importFlows = new ImportFlowRegistry();
    const flow = importFlows.start({ sourceId: "gmail:user@example.com", deviceId: ownerDeviceId });
    const subscriber = vi.fn();
    importFlows.subscribe(flow.id, subscriber);
    const { handler } = makeHandler({ importFlows });

    handler.handleEvent(conn(otherDeviceId), importCompleteEvent(flow.id));

    expect(importFlows.get(flow.id)?.state).toBe("starting");
    expect(subscriber).not.toHaveBeenCalled();
  });
});
