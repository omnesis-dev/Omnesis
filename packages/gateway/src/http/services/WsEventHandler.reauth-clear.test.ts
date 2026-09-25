// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Covers the gateway half of the atomic re-auth recovery: when the
 * collector re-registers a provider after a successful re-auth, it
 * broadcasts a `sync.completed` (wire state `completed`) for every source
 * that was stuck in `needs-auth`. This test pins the contract that emit
 * relies on — a `completed` event must drop the source out of `needs-auth`
 * in the in-memory registry AND clear the persisted error, so the next
 * `/admin/sync/status` poll shows the whole provider recovered at once
 * rather than one source at a time.
 *
 * The persisted-error clearing is asserted against a `WriteGate` stub; the
 * real DB clear is covered in `SyncStateRepository` tests.
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
import type { NeedsAuthNotifier } from "../../push/producers/needs-auth.js";
import type { WriteGate } from "../../write-gate.js";
import type { AuthFlowRegistry } from "../../auth-flows.js";
import type { DeviceConnection } from "../../ws.js";

let dbPath: string;
let db: ReturnType<typeof createDatabase>;
let conn: DeviceConnection;

const SIBLINGS = [
  "gmail:you@example.com",
  "google-calendar:you@example.com",
  "google-contacts:you@example.com",
  "google-drive:you@example.com",
];

beforeEach(() => {
  dbPath = `/tmp/omnesis-ws-reauth-clear-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  const device = createDevice(db, { name: "Maya-Laptop", kind: "collector" });
  conn = { deviceId: device.id, scopes: [SCOPE_WRITE_ALL] };
  for (const id of SIBLINGS) registerSource(id);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function registerSource(id: string): void {
  const parsed = parseSourceId(SourceId(id));
  createSource(db, {
    type: parsed.sourceType,
    accountId: parsed.accountId,
    deviceId: conn.deviceId,
  });
}

function syncStatusEvent(
  sourceId: string,
  state: string,
  providerId: string,
  errorMessage?: string,
): WsEvent {
  return {
    kind: "event",
    type: "sync.status",
    payload: { sourceId, state, providerId, errorMessage },
  };
}

const stubAuthFlows = {} as AuthFlowRegistry;

function makeHandler(): {
  handler: WsEventHandler;
  syncStatus: SyncStatusRegistry;
  setSyncError: ReturnType<typeof vi.fn>;
  clearSyncError: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
} {
  const syncStatus = new SyncStatusRegistry();
  const setSyncError = vi.fn(() => Promise.resolve(undefined));
  const clearSyncError = vi.fn(() => Promise.resolve(undefined));
  const writeGate = { setSyncError, clearSyncError } as unknown as WriteGate;
  const reset = vi.fn(() => Promise.resolve(undefined));
  const notifier = {
    notify: vi.fn(() => Promise.resolve(undefined)),
    reset,
  } as unknown as NeedsAuthNotifier;
  const handler = new WsEventHandler({
    db,
    writeGate,
    syncStatus,
    authFlows: stubAuthFlows,
    needsAuthNotifier: notifier,
  });
  return { handler, syncStatus, setSyncError, clearSyncError, reset };
}

/** A second collector joined to every sibling as a member, reporting on its own connection. */
function joinMember(name: string): DeviceConnection {
  const device = createDevice(db, { name, kind: "collector" });
  for (const id of SIBLINGS) addSourceMember(db, SourceId(id), device.id);
  return { deviceId: device.id, scopes: [SCOPE_WRITE_ALL] };
}

describe("WsEventHandler — completed clears a previously-needs-auth source (atomic re-auth)", () => {
  test("a sync.completed event drops the source out of needs-auth and clears the persisted error", () => {
    const { handler, syncStatus, setSyncError, clearSyncError } = makeHandler();
    const sourceId = "gmail:you@example.com";
    const providerId = "google:you@example.com";

    // Token expired → collector reports needs-auth with the recognisable
    // hint, gateway persists it so it survives a restart.
    handler.handleEvent(
      conn,
      syncStatusEvent(sourceId, "needs-auth", providerId, "needs reauth: token expired"),
    );
    expect(syncStatus.get(sourceId as never)?.state).toBe("needs-auth");
    expect(setSyncError).toHaveBeenCalledWith(
      sourceId,
      "needs reauth: token expired",
      "",
      undefined,
    );

    // Re-auth → collector re-registers the provider and broadcasts
    // `sync.completed` for the reactivated source (no error message).
    handler.handleEvent(conn, syncStatusEvent(sourceId, "completed", providerId));

    // In-memory state has left needs-auth, and the persisted error is cleared
    // (not re-persisted) — so deriveDisplayStatus no longer reports needs-auth.
    expect(syncStatus.get(sourceId as never)?.state).toBe("completed");
    expect(clearSyncError).toHaveBeenCalledTimes(1);
    expect(clearSyncError).toHaveBeenCalledWith(sourceId);
    // The completed event carried no error, so nothing new was persisted.
    expect(setSyncError).toHaveBeenCalledTimes(1);
  });

  test("clears every sibling when the whole provider is reactivated together", () => {
    const { handler, syncStatus, clearSyncError, reset } = makeHandler();
    const providerId = "google:you@example.com";

    // All siblings stuck in needs-auth (one shared, expired credential).
    for (const id of SIBLINGS) {
      handler.handleEvent(
        conn,
        syncStatusEvent(id, "needs-auth", providerId, "needs reauth: token expired"),
      );
      expect(syncStatus.get(id as never)?.state).toBe("needs-auth");
    }

    // One re-auth → the collector broadcasts completed for each sibling.
    for (const id of SIBLINGS) {
      handler.handleEvent(conn, syncStatusEvent(id, "completed", providerId));
    }

    for (const id of SIBLINGS) {
      expect(syncStatus.get(id as never)?.state).toBe("completed");
      expect(clearSyncError).toHaveBeenCalledWith(id);
      // Every sibling's recovery is attributed to the device that re-authed.
      expect(reset).toHaveBeenCalledWith({ sourceId: id, providerId, deviceId: conn.deviceId });
    }
    expect(clearSyncError).toHaveBeenCalledTimes(SIBLINGS.length);
    expect(reset).toHaveBeenCalledTimes(SIBLINGS.length);
  });

  test("reactivating the provider on one device leaves a sibling device's lapse in place", () => {
    const { handler, syncStatus, reset } = makeHandler();
    const providerId = "google:you@example.com";
    const studio = joinMember("Studio-Mini");

    // Both members hold their own grant for the account, and both lapsed.
    for (const id of SIBLINGS) {
      handler.handleEvent(
        conn,
        syncStatusEvent(id, "needs-auth", providerId, "needs reauth: token expired"),
      );
      handler.handleEvent(
        studio,
        syncStatusEvent(id, "needs-auth", providerId, "needs reauth: token expired"),
      );
    }

    // The operator re-auths on the laptop only.
    for (const id of SIBLINGS) {
      handler.handleEvent(conn, syncStatusEvent(id, "completed", providerId));
    }

    expect(reset).toHaveBeenCalledTimes(SIBLINGS.length);
    for (const id of SIBLINGS) {
      expect(reset).toHaveBeenCalledWith({ sourceId: id, providerId, deviceId: conn.deviceId });
      const members = syncStatus.listMembers(SourceId(id));
      expect(members.find((m) => m.deviceId === conn.deviceId)?.state).toBe("completed");
      expect(members.find((m) => m.deviceId === studio.deviceId)?.state).toBe("needs-auth");
    }
    expect(reset).not.toHaveBeenCalledWith(expect.objectContaining({ deviceId: studio.deviceId }));

    // Re-authing on the studio machine recovers its own episodes.
    for (const id of SIBLINGS) {
      handler.handleEvent(studio, syncStatusEvent(id, "completed", providerId));
    }
    expect(reset).toHaveBeenCalledTimes(2 * SIBLINGS.length);
    for (const id of SIBLINGS) {
      expect(reset).toHaveBeenCalledWith({ sourceId: id, providerId, deviceId: studio.deviceId });
    }
  });
});
