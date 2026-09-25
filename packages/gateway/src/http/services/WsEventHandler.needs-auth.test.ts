// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Covers the needs-auth re-auth reminder edge (#617, #683): a source
 * in `needs-auth` invokes the notifier so the persisted backoff gate can
 * decide whether a reminder is due, a successful sync after needs-auth
 * resets that device's reminder backoff (#683), and a notifier failure
 * never breaks sync-status ingestion. Credentials are held per member
 * device, so both the reminder and its reset are attributed to the
 * reporting device — a sibling member's healthy sync leaves a lapsed
 * member's reminder in place.
 *
 * The per-(connection, device) de-dup + exponential backoff itself lives
 * in the notifier's persisted gate (`needs-auth.test.ts` +
 * `ReauthRemindersRepository.test.ts`); here the notifier is mocked so we
 * assert WsEventHandler's edge detection in isolation.
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

beforeEach(() => {
  dbPath = `/tmp/omnesis-ws-needs-auth-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  const device = createDevice(db, { name: "Maya-Laptop", kind: "collector" });
  conn = { deviceId: device.id, scopes: [SCOPE_WRITE_ALL] };
  registerSource("gmail:you@example.com");
  registerSource("outlook:demo");
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

/** A second collector joined to `sourceId` as a member, reporting on its own connection. */
function joinMember(sourceId: string, name: string): DeviceConnection {
  const device = createDevice(db, { name, kind: "collector" });
  addSourceMember(db, SourceId(sourceId), device.id);
  return { deviceId: device.id, scopes: [SCOPE_WRITE_ALL] };
}

function syncStatusEvent(sourceId: string, state: string, providerId?: string): WsEvent {
  return {
    kind: "event",
    type: "sync.status",
    payload: { sourceId, state, providerId, errorMessage: "needs reauth: token expired" },
  };
}

/** WriteGate stub — only the two sync-error methods are exercised here. */
function stubWriteGate(): WriteGate {
  return {
    setSyncError: vi.fn(() => Promise.resolve(undefined)),
    clearSyncError: vi.fn(() => Promise.resolve(undefined)),
  } as unknown as WriteGate;
}

const stubAuthFlows = {} as AuthFlowRegistry;

function makeHandler(
  notify: ReturnType<typeof vi.fn>,
  reset: ReturnType<typeof vi.fn> = vi.fn(() => Promise.resolve(undefined)),
): {
  handler: WsEventHandler;
  syncStatus: SyncStatusRegistry;
} {
  const syncStatus = new SyncStatusRegistry();
  // Mock the notifier's `notify` / `reset` directly so we assert on the
  // edge detection in WsEventHandler, not the APNs fan-out or the backoff
  // gate (those are covered in needs-auth.test.ts).
  const notifier = { notify, reset } as unknown as NeedsAuthNotifier;
  const handler = new WsEventHandler({
    db,
    writeGate: stubWriteGate(),
    syncStatus,
    authFlows: stubAuthFlows,
    needsAuthNotifier: notifier,
  });
  return { handler, syncStatus };
}

describe("WsEventHandler — needs-auth re-auth reminder (#617)", () => {
  test("transition idle → needs-auth pushes exactly one reminder attributed to the reporting device", () => {
    const notify = vi.fn(() => Promise.resolve(undefined));
    const { handler } = makeHandler(notify);

    handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", "idle"));
    handler.handleEvent(
      conn,
      syncStatusEvent("gmail:you@example.com", "needs-auth", "google:you@example.com"),
    );

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      sourceId: "gmail:you@example.com",
      providerId: "google:you@example.com",
      deviceId: conn.deviceId,
    });
  });

  test("transition error → needs-auth also pushes", () => {
    const notify = vi.fn(() => Promise.resolve(undefined));
    const { handler } = makeHandler(notify);

    handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", "error"));
    handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", "needs-auth"));

    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("first-ever event being needs-auth (no prior state) pushes once", () => {
    const notify = vi.fn(() => Promise.resolve(undefined));
    const { handler } = makeHandler(notify);

    handler.handleEvent(conn, syncStatusEvent("outlook:demo", "needs-auth"));

    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("steady-state needs-auth ticks still consult the persisted backoff gate", () => {
    const notify = vi.fn(() => Promise.resolve(undefined));
    const { handler } = makeHandler(notify);

    handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", "needs-auth"));
    handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", "needs-auth"));
    handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", "needs-auth"));

    expect(notify).toHaveBeenCalledTimes(3);
  });

  test("leaving and re-entering needs-auth is a fresh transition (new push)", () => {
    const notify = vi.fn(() => Promise.resolve(undefined));
    const { handler } = makeHandler(notify);

    handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", "needs-auth"));
    handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", "syncing"));
    handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", "needs-auth"));

    expect(notify).toHaveBeenCalledTimes(2);
  });

  test("non-needs-auth states never push", () => {
    const notify = vi.fn(() => Promise.resolve(undefined));
    const { handler } = makeHandler(notify);

    for (const state of ["idle", "syncing", "completed", "error"]) {
      handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", state));
    }

    expect(notify).not.toHaveBeenCalled();
  });

  test("a re-auth (needs-auth → syncing → completed) resets the device's backoff (#683)", () => {
    const notify = vi.fn(() => Promise.resolve(undefined));
    const reset = vi.fn(() => Promise.resolve(undefined));
    const { handler } = makeHandler(notify, reset);

    // The realistic re-auth path: by the time `completed` lands, the prior
    // in-memory state is `syncing`, not `needs-auth` — so the reset edge
    // must key on the transition INTO completed, not on a prior needs-auth.
    handler.handleEvent(
      conn,
      syncStatusEvent("gmail:you@example.com", "needs-auth", "google:you@example.com"),
    );
    handler.handleEvent(
      conn,
      syncStatusEvent("gmail:you@example.com", "syncing", "google:you@example.com"),
    );
    handler.handleEvent(
      conn,
      syncStatusEvent("gmail:you@example.com", "completed", "google:you@example.com"),
    );

    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith({
      sourceId: "gmail:you@example.com",
      providerId: "google:you@example.com",
      deviceId: conn.deviceId,
    });
  });

  test("reset fires once per completed sync cycle, not every steady-state tick", () => {
    const notify = vi.fn(() => Promise.resolve(undefined));
    const reset = vi.fn(() => Promise.resolve(undefined));
    const { handler } = makeHandler(notify, reset);

    // syncing → completed → completed → completed: only the edge INTO
    // completed clears the (no-op when absent) backoff row.
    handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", "syncing"));
    handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", "completed"));
    handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", "completed"));
    handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", "completed"));

    expect(reset).toHaveBeenCalledTimes(1);
  });

  test("a notifier rejection does not break sync-status ingestion", () => {
    const notify = vi.fn(() => Promise.reject(new Error("notifier blew up")));
    const { handler, syncStatus } = makeHandler(notify);

    // The void-dispatched notify rejects asynchronously; ingestion must
    // still complete and the registry must reflect the new state.
    expect(() =>
      handler.handleEvent(conn, syncStatusEvent("gmail:you@example.com", "needs-auth")),
    ).not.toThrow();
    expect(syncStatus.get("gmail:you@example.com" as never)?.state).toBe("needs-auth");
  });
});

describe("WsEventHandler — needs-auth is per member device", () => {
  const SOURCE = "gmail:you@example.com";
  const PROVIDER = "google:you@example.com";

  test("the reminder is attributed to the member whose grant lapsed, not the owner", () => {
    const notify = vi.fn(() => Promise.resolve(undefined));
    const { handler } = makeHandler(notify);
    const studio = joinMember(SOURCE, "Studio-Mini");

    handler.handleEvent(studio, syncStatusEvent(SOURCE, "needs-auth", PROVIDER));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      sourceId: SOURCE,
      providerId: PROVIDER,
      deviceId: studio.deviceId,
    });
  });

  test("a sibling member's completed sync does not reset the lapsed member's reminder", () => {
    const notify = vi.fn(() => Promise.resolve(undefined));
    const reset = vi.fn(() => Promise.resolve(undefined));
    const { handler, syncStatus } = makeHandler(notify, reset);
    const studio = joinMember(SOURCE, "Studio-Mini");

    handler.handleEvent(studio, syncStatusEvent(SOURCE, "needs-auth", PROVIDER));
    handler.handleEvent(conn, syncStatusEvent(SOURCE, "syncing", PROVIDER));
    handler.handleEvent(conn, syncStatusEvent(SOURCE, "completed", PROVIDER));

    // The owner's own edge into completed resets the owner's episode only.
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith({
      sourceId: SOURCE,
      providerId: PROVIDER,
      deviceId: conn.deviceId,
    });
    expect(reset).not.toHaveBeenCalledWith(expect.objectContaining({ deviceId: studio.deviceId }));
    // The lapsed member still reads needs-auth in its own entry.
    expect(
      syncStatus.listMembers(SourceId(SOURCE)).find((m) => m.deviceId === studio.deviceId)?.state,
    ).toBe("needs-auth");
  });

  test("the lapsed member's own completed sync resets its reminder", () => {
    const notify = vi.fn(() => Promise.resolve(undefined));
    const reset = vi.fn(() => Promise.resolve(undefined));
    const { handler } = makeHandler(notify, reset);
    const studio = joinMember(SOURCE, "Studio-Mini");

    handler.handleEvent(studio, syncStatusEvent(SOURCE, "needs-auth", PROVIDER));
    handler.handleEvent(studio, syncStatusEvent(SOURCE, "syncing", PROVIDER));
    handler.handleEvent(studio, syncStatusEvent(SOURCE, "completed", PROVIDER));

    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith({
      sourceId: SOURCE,
      providerId: PROVIDER,
      deviceId: studio.deviceId,
    });
  });

  test("a member's edge into completed is seen even when a sibling already reads completed", () => {
    const notify = vi.fn(() => Promise.resolve(undefined));
    const reset = vi.fn(() => Promise.resolve(undefined));
    const { handler } = makeHandler(notify, reset);
    const studio = joinMember(SOURCE, "Studio-Mini");

    // The owner completes first, so the source's aggregate already reads
    // `completed` by the time the member re-auths and completes.
    handler.handleEvent(conn, syncStatusEvent(SOURCE, "completed", PROVIDER));
    handler.handleEvent(studio, syncStatusEvent(SOURCE, "needs-auth", PROVIDER));
    handler.handleEvent(studio, syncStatusEvent(SOURCE, "syncing", PROVIDER));
    handler.handleEvent(studio, syncStatusEvent(SOURCE, "completed", PROVIDER));

    expect(reset).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenLastCalledWith({
      sourceId: SOURCE,
      providerId: PROVIDER,
      deviceId: studio.deviceId,
    });
  });
});
