// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { AccountId, DeviceId, SourceId, SourceType } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import {
  createSource,
  getSource,
  listSourceMembers,
} from "../../data/repositories/SourceRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { SyncStatusRegistry } from "../../sync-status.js";
import { SourceDataRemovalService } from "./SourceDataRemovalService.js";
import { SourceService } from "./SourceService.js";
import type { StatusCache } from "./StatusCache.js";
import type { DeviceWsServer } from "../../ws.js";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

/**
 * Cross-device source ownership. A source configured on one device
 * must never be silently adopted by another: the add paths reject, and the
 * one legitimate re-home (PATCH deviceId) tears the instance down on the
 * losing host without deleting its data.
 */
function fixture() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const capabilities = {
    hostableSourceTypes: [SourceType("test-source")],
    memberScopedParams: { "test-source": [] },
  };
  const alpha = createDevice(db, { name: "collector-alpha", kind: "collector", capabilities });
  const beta = createDevice(db, { name: "collector-beta", kind: "collector", capabilities });
  const sendCommand = vi.fn(async () => ({ ok: true }));
  const notifySourceChange = vi.fn();
  const writeGate = directWriteGate(db);
  const syncStatus = new SyncStatusRegistry();
  const service = new SourceService({
    db,
    writeGate,
    statusCache: { bump: vi.fn() } as unknown as StatusCache,
    wsServer: { sendCommand } as unknown as DeviceWsServer,
    sourceDataRemoval: new SourceDataRemovalService({
      db,
      writeGate,
      purgeAnnotationsFor: async () => {},
    }),
    listDevices: () => [],
    syncStatus,
    notifySourceChange,
    syncSourceSettingsToConfig: vi.fn(async () => {}),
  });
  return { db, alpha, beta, service, sendCommand, notifySourceChange, syncStatus };
}

describe("SourceService ownership", () => {
  test("POST-path createSource rejects a source hosted by another device with 409 naming the host", async () => {
    const { db, alpha, beta, service } = fixture();
    createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("acct1"),
      deviceId: alpha.id,
    });

    await expect(
      service.createSource({
        type: SourceType("test-source"),
        accountId: AccountId("acct1"),
        deviceId: beta.id,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "SOURCE_ALREADY_HOSTED",
      detail: { currentDeviceId: alpha.id, currentDeviceName: "collector-alpha" },
    });

    // Ownership did not move.
    expect(getSource(db, SourceId("test-source:acct1"))?.deviceId).toBe(alpha.id);
  });

  test("createSource on the owning device stays idempotent", async () => {
    const { db, alpha, service } = fixture();
    const first = createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("acct1"),
      deviceId: alpha.id,
    });
    const again = await service.createSource({
      type: SourceType("test-source"),
      accountId: AccountId("acct1"),
      deviceId: alpha.id,
    });
    expect(again.id).toBe(first.id);
    expect(again.deviceId).toBe(alpha.id);
  });

  test("bulkUpsertForDevice rejects a foreign-hosted source as an error entry, not a steal", async () => {
    const { db, alpha, beta, service } = fixture();
    createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("acct1"),
      deviceId: alpha.id,
    });

    const result = await service.bulkUpsertForDevice(beta.id, [
      { type: "test-source", accountId: "acct1" },
      { type: "test-source", accountId: "acct2" },
    ]);

    // The foreign-hosted entry is rejected with the host named...
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain("collector-alpha");
    // ...the fresh account registers normally on the caller...
    expect(result.sources.map((s) => s.id)).toEqual(["test-source:acct2"]);
    // ...and ownership of the contested source did not move.
    expect(getSource(db, SourceId("test-source:acct1"))?.deviceId).toBe(alpha.id);
  });

  test("PATCH-path move notifies the losing collector with a fresh snapshot and the gaining one with source.added", async () => {
    const { db, alpha, beta, service, sendCommand, notifySourceChange } = fixture();
    const source = createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("acct1"),
      deviceId: alpha.id,
    });

    const updated = await service.updateSource(source.id, { deviceId: beta.id });
    expect(updated?.deviceId).toBe(beta.id);

    // Gaining device learns the source as an add (it has never hosted it).
    expect(notifySourceChange).toHaveBeenCalledWith(
      "source.added",
      beta.id,
      expect.objectContaining({ source: expect.objectContaining({ id: source.id }) }),
    );
    // Losing device gets its authoritative (now-empty) snapshot — teardown
    // without data or credential loss.
    expect(sendCommand).toHaveBeenCalledWith(alpha.id, "sources.snapshot", { sources: [] });
  });

  test("a config-only PATCH still notifies source.updated to the owner, no snapshot", async () => {
    const { db, alpha, service, sendCommand, notifySourceChange } = fixture();
    const source = createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("acct1"),
      deviceId: alpha.id,
    });

    await service.updateSource(source.id, { enabled: false });

    expect(notifySourceChange).toHaveBeenCalledWith("source.updated", alpha.id, expect.anything());
    expect(sendCommand).not.toHaveBeenCalled();
  });

  test("a race loser on createSource gets the 409, not a false success", async () => {
    // Two devices add the same account concurrently: both pass the
    // pre-check, the writer serializes them, and create-or-get returns the
    // winner's row to the loser. The post-write ownership check must turn
    // that into the same 409 the pre-check would have thrown.
    const db = createDatabase(":memory:");
    databases.push(db);
    const alpha = createDevice(db, { name: "collector-alpha", kind: "collector" });
    const beta = createDevice(db, { name: "collector-beta", kind: "collector" });
    const gate = directWriteGate(db);
    const service = new SourceService({
      db,
      writeGate: {
        ...gate,
        // Interleave: the competing device's create commits first, inside
        // the window between this caller's pre-check and its write.
        createSource: async (opts) => {
          createSource(db, {
            type: SourceType("test-source"),
            accountId: AccountId("acct1"),
            deviceId: alpha.id,
          });
          return gate.createSource(opts);
        },
      },
      statusCache: { bump: vi.fn() } as unknown as StatusCache,
      sourceDataRemoval: new SourceDataRemovalService({
        db,
        writeGate: gate,
        purgeAnnotationsFor: async () => {},
      }),
      listDevices: () => [],
      notifySourceChange: vi.fn(),
      syncSourceSettingsToConfig: vi.fn(async () => {}),
    });

    await expect(
      service.createSource({
        type: SourceType("test-source"),
        accountId: AccountId("acct1"),
        deviceId: beta.id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "SOURCE_ALREADY_HOSTED" });
    expect(getSource(db, SourceId("test-source:acct1"))?.deviceId).toBe(alpha.id);
  });

  test("a race loser in bulkUpsertForDevice becomes an error entry, not a claimed success", async () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const alpha = createDevice(db, { name: "collector-alpha", kind: "collector" });
    const beta = createDevice(db, { name: "collector-beta", kind: "collector" });
    const gate = directWriteGate(db);
    const mirror = vi.fn(async () => {});
    const service = new SourceService({
      db,
      writeGate: {
        ...gate,
        createSource: async (opts) => {
          createSource(db, {
            type: SourceType("test-source"),
            accountId: AccountId("acct1"),
            deviceId: alpha.id,
          });
          return gate.createSource(opts);
        },
      },
      statusCache: { bump: vi.fn() } as unknown as StatusCache,
      sourceDataRemoval: new SourceDataRemovalService({
        db,
        writeGate: gate,
        purgeAnnotationsFor: async () => {},
      }),
      listDevices: () => [],
      notifySourceChange: vi.fn(),
      syncSourceSettingsToConfig: mirror,
    });

    const result = await service.bulkUpsertForDevice(beta.id, [
      { type: "test-source", accountId: "acct1" },
    ]);
    expect(result.sources).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain("collector-alpha");
    // The loser's config was never mirrored over the winner's.
    expect(mirror).not.toHaveBeenCalled();
    expect(getSource(db, SourceId("test-source:acct1"))?.deviceId).toBe(alpha.id);
  });

  test("simultaneous replicated adds join the race loser on both add paths", async () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const type = SourceType("replicated-synth");
    const capabilities = {
      hostableSourceTypes: [type],
      multiDeviceModes: { [type]: "replicated" as const },
      memberScopedParams: { [type]: [] },
      syncLease: true,
    };
    const alpha = createDevice(db, {
      name: "collector-alpha",
      kind: "collector",
      capabilities,
    });
    const beta = createDevice(db, {
      name: "collector-beta",
      kind: "collector",
      capabilities,
    });
    const gate = directWriteGate(db);
    const mirror = vi.fn(async () => {});
    const service = new SourceService({
      db,
      writeGate: {
        ...gate,
        createSource: async (opts) => {
          createSource(db, {
            type,
            accountId: opts.accountId,
            deviceId: alpha.id,
            multiDeviceMode: "replicated",
          });
          return gate.createSource(opts);
        },
      },
      statusCache: { bump: vi.fn() } as unknown as StatusCache,
      sourceDataRemoval: new SourceDataRemovalService({
        db,
        writeGate: gate,
        purgeAnnotationsFor: async () => {},
      }),
      listDevices: () => [alpha, beta],
      notifySourceChange: vi.fn(),
      syncSourceSettingsToConfig: mirror,
    });

    const adminJoined = await service.createSource({
      type,
      accountId: AccountId("admin-race"),
      deviceId: beta.id,
      config: { folder: "Example" },
    });
    expect(adminJoined.deviceId).toBe(alpha.id);
    expect(
      listSourceMembers(db, SourceId(`${type}:admin-race`))
        .map((m) => m.deviceId)
        .sort(),
    ).toEqual([alpha.id, beta.id].sort());

    const result = await service.bulkUpsertForDevice(beta.id, [
      { type, accountId: "bulk-race", config: { folder: "Example" } },
    ]);

    expect(result).toEqual({
      count: 1,
      sources: [{ id: `${type}:bulk-race`, updated: false }],
      errors: [],
    });
    expect(
      listSourceMembers(db, SourceId(`${type}:bulk-race`))
        .map((m) => m.deviceId)
        .sort(),
    ).toEqual([alpha.id, beta.id].sort());
    expect(mirror).not.toHaveBeenCalled();
  });

  test("a move to a nonexistent device is refused with 404", async () => {
    const { db, alpha, service } = fixture();
    const source = createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("acct1"),
      deviceId: alpha.id,
    });
    await expect(
      service.updateSource(source.id, { deviceId: DeviceId(crypto.randomUUID()) }),
    ).rejects.toMatchObject({ status: 404, code: "DEVICE_NOT_FOUND" });
    expect(getSource(db, source.id)?.deviceId).toBe(alpha.id);
  });

  test("a move to a device that cannot host the type is refused with 400", async () => {
    const { db, alpha, service } = fixture();
    const picky = createDevice(db, {
      name: "collector-gamma",
      kind: "collector",
      capabilities: { hostableSourceTypes: [SourceType("other-source")] },
    });
    const source = createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("acct1"),
      deviceId: alpha.id,
    });
    await expect(service.updateSource(source.id, { deviceId: picky.id })).rejects.toMatchObject({
      status: 400,
      code: "DEVICE_CANNOT_HOST_TYPE",
    });
    expect(getSource(db, source.id)?.deviceId).toBe(alpha.id);
  });

  test("a move whose loser is a phone sends no collector snapshot but still notifies the gainer", async () => {
    const { db, beta, service, sendCommand, notifySourceChange } = fixture();
    const phone = createDevice(db, { name: "fictional-phone", kind: "ios" });
    const source = createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("local"),
      deviceId: phone.id,
    });

    await service.updateSource(source.id, { deviceId: beta.id });

    expect(notifySourceChange).toHaveBeenCalledWith("source.added", beta.id, expect.anything());
    // The snapshot teardown is collector-specific; a phone loser gets
    // nothing here (its push rights are governed by gatePush).
    expect(sendCommand).not.toHaveBeenCalled();
  });

  test("POST-path add re-homes a push source between phones (phone replacement)", async () => {
    // A replacement phone paired under a NEW name self-registers its push
    // sources via POST /admin/sources. No collector is involved on either
    // side, so the add re-homes instead of refusing — refusing would
    // strand the source on the dead phone's row with no visible signal.
    const { db, service, notifySourceChange, syncStatus } = fixture();
    const oldPhone = createDevice(db, { name: "fictional-phone-old", kind: "ios" });
    const newPhone = createDevice(db, { name: "fictional-phone-new", kind: "ios" });
    const source = createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("local"),
      deviceId: oldPhone.id,
    });
    syncStatus.update({
      sourceId: source.id,
      deviceId: oldPhone.id,
      state: "completed",
      lastUpdated: Date.now(),
    });

    const rec = await service.createSource({
      type: SourceType("test-source"),
      accountId: AccountId("local"),
      deviceId: newPhone.id,
    });

    expect(rec.deviceId).toBe(newPhone.id);
    expect(getSource(db, source.id)?.deviceId).toBe(newPhone.id);
    expect(syncStatus.listMembers(source.id)).toEqual([]);
    expect(notifySourceChange).toHaveBeenCalledWith("source.added", newPhone.id, expect.anything());
  });

  test("a move to an offline device does not throw when the snapshot push fails", async () => {
    const { db, alpha, beta, service, sendCommand } = fixture();
    sendCommand.mockRejectedValue(new Error("device not connected"));
    const source = createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("acct1"),
      deviceId: alpha.id,
    });
    await expect(service.updateSource(source.id, { deviceId: beta.id })).resolves.toMatchObject({
      deviceId: beta.id,
    });
  });
});

// Repository-level invariant, colocated with the service tests that rely on
// it: create-or-get never re-homes.
describe("SourceRepository.createSource", () => {
  test("returns an existing row unchanged when a different device creates the same source", () => {
    const { db, alpha, beta } = fixture();
    const first = createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("acct1"),
      deviceId: alpha.id,
    });
    const second = createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("acct1"),
      deviceId: beta.id,
    });
    expect(second.id).toBe(first.id);
    expect(second.deviceId).toBe(alpha.id);
    expect(getSource(db, first.id)?.deviceId).toBe(alpha.id);
  });
});
