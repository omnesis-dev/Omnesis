// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A `sync.status` error that names its remedy: the remedy lands on the
 * reporting device's own entry and its own persisted row, a sibling member's
 * report never carries it, and the reporting device's recovery clears it.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SCOPE_WRITE_ALL, SourceId, parseSourceId } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { addSourceMember, createSource } from "../../data/repositories/SourceRepository.js";
import { SyncStatusRegistry } from "../../sync-status.js";
import { WsEventHandler } from "./WsEventHandler.js";
import type { WsEvent } from "@omnesis/core";
import type { WriteGate } from "../../write-gate.js";
import type { AuthFlowRegistry } from "../../auth-flows.js";
import type { DeviceConnection } from "../../ws.js";

const SRC = "apple-notes:local";
const REMEDY = {
  summary: "Disk access is required",
  steps: ["Open the pane.", "Add the executable."],
  executable: "/opt/example/bin/node",
  restartRequired: true,
};

let dbPath: string;
let db: ReturnType<typeof createDatabase>;
let conn: DeviceConnection;

beforeEach(() => {
  dbPath = `/tmp/omnesis-ws-remediation-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  const device = createDevice(db, { name: "Maya-Laptop", kind: "collector" });
  conn = { deviceId: device.id, scopes: [SCOPE_WRITE_ALL] };
  const parsed = parseSourceId(SourceId(SRC));
  createSource(db, {
    type: parsed.sourceType,
    accountId: parsed.accountId,
    deviceId: conn.deviceId,
    multiDeviceMode: "replicated",
  });
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function statusEvent(state: string, extra: Record<string, unknown> = {}): WsEvent {
  return { kind: "event", type: "sync.status", payload: { sourceId: SRC, state, ...extra } };
}

function makeHandler() {
  const writeGate = {
    setSyncError: vi.fn(() => Promise.resolve(undefined)),
    clearSyncError: vi.fn(() => Promise.resolve(undefined)),
  };
  const syncStatus = new SyncStatusRegistry();
  const handler = new WsEventHandler({
    db,
    writeGate: writeGate as unknown as WriteGate,
    syncStatus,
    authFlows: {} as AuthFlowRegistry,
  });
  return { handler, syncStatus, writeGate };
}

describe("WsEventHandler — structured remediation", () => {
  test("an error with a remedy is held live and persisted with it", () => {
    const { handler, syncStatus, writeGate } = makeHandler();

    handler.handleEvent(
      conn,
      statusEvent("error", { errorMessage: "Cannot open the database", remediation: REMEDY }),
    );

    expect(syncStatus.get(SourceId(SRC))?.remediation).toEqual(REMEDY);
    expect(writeGate.setSyncError).toHaveBeenCalledWith(
      SRC,
      "Cannot open the database",
      conn.deviceId,
      REMEDY,
    );
  });

  test("an error without a remedy persists none", () => {
    const { handler, syncStatus, writeGate } = makeHandler();

    handler.handleEvent(conn, statusEvent("error", { errorMessage: "connection refused" }));

    expect(syncStatus.get(SourceId(SRC))?.remediation).toBeUndefined();
    expect(writeGate.setSyncError).toHaveBeenCalledWith(
      SRC,
      "connection refused",
      conn.deviceId,
      undefined,
    );
  });

  test("a remedy that violates the wire shape is dropped alone; the failure still lands", () => {
    const { handler, syncStatus, writeGate } = makeHandler();

    handler.handleEvent(
      conn,
      statusEvent("error", { errorMessage: "refused", remediation: { ...REMEDY, steps: [] } }),
    );

    expect(syncStatus.get(SourceId(SRC))).toMatchObject({
      state: "error",
      errorMessage: "refused",
    });
    expect(syncStatus.get(SourceId(SRC))?.remediation).toBeUndefined();
    expect(writeGate.setSyncError).toHaveBeenCalledWith(SRC, "refused", conn.deviceId, undefined);
  });

  test("on a replicated source only the reporting member carries it, and its recovery clears it", () => {
    const { handler, syncStatus, writeGate } = makeHandler();
    const sibling = createDevice(db, { name: "Jamie-Desk", kind: "collector" });
    addSourceMember(db, SourceId(SRC), sibling.id);
    const siblingConn: DeviceConnection = { deviceId: sibling.id, scopes: [SCOPE_WRITE_ALL] };

    handler.handleEvent(
      conn,
      statusEvent("error", { errorMessage: "Cannot open the database", remediation: REMEDY }),
    );
    handler.handleEvent(siblingConn, statusEvent("completed"));

    const members = syncStatus.listMembers(SourceId(SRC));
    expect(members.find((m) => m.deviceId === conn.deviceId)?.remediation).toEqual(REMEDY);
    expect(members.find((m) => m.deviceId === sibling.id)?.remediation).toBeUndefined();
    expect(writeGate.setSyncError).toHaveBeenCalledWith(
      SRC,
      "Cannot open the database",
      conn.deviceId,
      REMEDY,
    );

    handler.handleEvent(conn, statusEvent("completed"));
    expect(
      syncStatus.listMembers(SourceId(SRC)).find((m) => m.deviceId === conn.deviceId)?.remediation,
    ).toBeUndefined();
    expect(writeGate.clearSyncError).toHaveBeenCalledWith(SRC, conn.deviceId);
  });
});
