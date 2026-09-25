// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { AccountId, SourceType } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import {
  createDevice,
  listDevices,
  setNotificationDeliveryHealth,
} from "../../data/repositories/DeviceRepository.js";
import { createSource } from "../../data/repositories/SourceRepository.js";
import { replaceMobilePermissionHealth } from "../../data/repositories/MobilePermissionHealthRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { claimNotification } from "../queue.js";
import { updateSourceWithPermissionInvalidation } from "../mobile-permission-operations.js";
import {
  collapseId,
  resolveSourcePermissionReminderConfig,
  SourcePermissionNotifier,
  type SourcePermissionNotifierOptions,
} from "./source-permission.js";
import type { DurableNotificationPublisher } from "../broadcast.js";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const knownLossCapability = {
  id: "background",
  label: "Background access",
  state: "background-access-missing" as const,
  requirement: "required" as const,
  impact: "Background collection stops.",
  remediation: "Enable background access.",
  repairAction: "open-system-settings" as const,
};

function fixture(
  capabilities: Parameters<typeof replaceMobilePermissionHealth>[1]["report"]["capabilities"],
) {
  const db = createDatabase(":memory:");
  databases.push(db);
  const owner = createDevice(db, { name: "Fictional source phone", kind: "ios" });
  const receiver = createDevice(db, { name: "Fictional alert phone", kind: "android" });
  db.prepare("UPDATE devices SET push_transport = 'direct-fcm' WHERE id = ?").run(receiver.id);
  setNotificationDeliveryHealth(db, receiver.id, "healthy", 900);
  const source = createSource(db, {
    type: SourceType("fictional-mobile"),
    accountId: AccountId("local"),
    deviceId: owner.id,
  });
  replaceMobilePermissionHealth(db, {
    sourceId: source.id,
    deviceId: owner.id,
    report: { checkedAt: 1_000, validForMs: 60_000, capabilities },
    receivedAt: 1_000,
  });
  const retentionDeviceIds = vi.fn<DurableNotificationPublisher["retentionDeviceIds"]>(() => [
    receiver.id,
  ]);
  const wakeAuthorized = vi.fn<DurableNotificationPublisher["wakeAuthorized"]>(async () => []);
  const options: SourcePermissionNotifierOptions = {
    db,
    writeGate: directWriteGate(db),
    publisher: { retentionDeviceIds, wakeAuthorized },
    listDevices: () => listDevices(db),
    deviceName: (deviceId) =>
      listDevices(db).find((device) => device.id === deviceId)?.name ?? "the affected device",
    sourceName: () => "mobile source example",
    config: {
      initialDelayMs: 10_000,
      multiplier: 2,
      maxDelayMs: 100_000,
      reservationTtlMs: 5_000,
      scanIntervalMs: 1_000,
    },
    now: () => 1_001,
  };
  const notifier = new SourcePermissionNotifier(options);
  return {
    db,
    source,
    receiver,
    notifier,
    options,
    retentionDeviceIds,
    wakeAuthorized,
  };
}

describe("SourcePermissionNotifier", () => {
  test.each(["initialDelay", "maxDelay", "reservationTtl", "scanInterval"] as const)(
    "rejects a zero %s when runtime settings bypass schema parsing",
    (field) => {
      expect(() => resolveSourcePermissionReminderConfig({ [field]: "0ms" })).toThrow(
        /greater than zero/,
      );
    },
  );

  test("renders the capability that actually drives the aggregate", async () => {
    const { db, source, receiver, notifier } = fixture([
      {
        id: "uncertain-required",
        label: "Required check",
        state: "unknown",
        requirement: "required",
        impact: "This should not mask a known loss.",
        remediation: "Open the app.",
        repairAction: "none",
      },
      {
        id: "optional-loss",
        label: "Optional history",
        state: "unavailable",
        requirement: "optional",
        impact: "Optional history cannot sync.",
        remediation: "Enable history access.",
        repairAction: "open-system-settings",
      },
    ]);

    await expect(notifier.notify(source.id)).resolves.toBe(true);
    const claimed = claimNotification(db, { deviceId: receiver.id, now: 1_002 });
    expect(claimed?.body).toContain("Optional history");
    expect(claimed?.body).toContain("mobile source example on Fictional source phone");
    expect(claimed).toMatchObject({
      sourceName: "mobile source example",
      affectedDeviceName: "Fictional source phone",
    });
  });

  test("uses a bounded opaque collapse key", () => {
    const id = collapseId(`fictional:${"x".repeat(500)}` as never, "episode-example");
    expect(id).toMatch(/^source-permission:[a-f0-9]{20}:stale:[a-f0-9]{12}$/);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  test("keeps actionable prose when a known-loss report later becomes stale", async () => {
    const setup = fixture([knownLossCapability]);
    const notifier = new SourcePermissionNotifier({
      ...setup.options,
      now: () => 61_001,
    });

    await expect(notifier.notify(setup.source.id)).resolves.toBe(true);
    expect(claimNotification(setup.db, { deviceId: setup.receiver.id, now: 61_002 })).toMatchObject(
      {
        title: "Source permission needs attention",
        body: expect.not.stringContaining("any contributing device"),
      },
    );
  });

  test("normalizes long control-bearing display names before enqueue", async () => {
    const setup = fixture([knownLossCapability]);
    const notifier = new SourcePermissionNotifier({
      ...setup.options,
      sourceName: () => `  Fictional\n\u202E${"source".repeat(80)}  `,
      deviceName: () => `Fictional\u0000\u2066${"phone".repeat(80)}`,
    });

    await expect(notifier.notify(setup.source.id)).resolves.toBe(true);
    const claimed = claimNotification(setup.db, { deviceId: setup.receiver.id, now: 1_002 });
    expect(claimed?.sourceName).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/,
    );
    expect(claimed?.affectedDeviceName).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/,
    );
    expect(claimed?.sourceName?.length).toBeLessThanOrEqual(256);
    expect(claimed?.affectedDeviceName?.length).toBeLessThanOrEqual(256);
  });

  test("does not target an explicit-healthy phone without a push transport", async () => {
    const { db, source, notifier, retentionDeviceIds } = fixture([
      {
        id: "background",
        label: "Background access",
        state: "background-access-missing",
        requirement: "required",
        impact: "Background collection stops.",
        remediation: "Enable background access.",
        repairAction: "open-system-settings",
      },
    ]);
    const unavailable = createDevice(db, { name: "Fictional unavailable phone", kind: "ios" });
    setNotificationDeliveryHealth(db, unavailable.id, "healthy", 900);

    await notifier.notify(source.id);

    expect(retentionDeviceIds.mock.calls[0]?.[0]).not.toContain(unavailable.id);
  });

  test("does not treat an unclaimed carrier address as a viable push transport", async () => {
    const setup = fixture([
      {
        id: "background",
        label: "Background access",
        state: "background-access-missing",
        requirement: "required",
        impact: "Background collection stops.",
        remediation: "Enable background access.",
        repairAction: "open-system-settings",
      },
    ]);
    setup.db
      .prepare("UPDATE devices SET push_transport = NULL, fcm_registration_token = ? WHERE id = ?")
      .run("historical-token", setup.receiver.id);

    await expect(setup.notifier.notify(setup.source.id)).resolves.toBe(false);

    expect(setup.wakeAuthorized).not.toHaveBeenCalled();
    expect(
      setup.db
        .prepare<
          [string],
          { notify_count: number }
        >("SELECT notify_count FROM mobile_permission_health WHERE source_id = ?")
        .get(setup.source.id)?.notify_count,
    ).toBe(0);
  });

  test("pause between reservation and atomic retention creates no delivery or wake", async () => {
    const setup = fixture([
      {
        id: "background",
        label: "Background access",
        state: "background-access-missing",
        requirement: "required",
        impact: "Background collection stops.",
        remediation: "Enable background access.",
        repairAction: "open-system-settings",
      },
    ]);
    const gate = directWriteGate(setup.db);
    const commit = gate.commitMobilePermissionReminderNotification.bind(gate);
    gate.commitMobilePermissionReminderNotification = async (...args) => {
      updateSourceWithPermissionInvalidation(setup.db, setup.source.id, { enabled: false }, 1_001);
      return await commit(...args);
    };
    const wakeAuthorized = vi.fn<DurableNotificationPublisher["wakeAuthorized"]>(async () => []);
    const notifier = new SourcePermissionNotifier({
      db: setup.db,
      writeGate: gate,
      publisher: {
        retentionDeviceIds: () => [setup.receiver.id],
        wakeAuthorized,
      },
      listDevices: () => listDevices(setup.db),
      deviceName: () => "Fictional source phone",
      sourceName: () => "mobile source example",
      config: {
        initialDelayMs: 10_000,
        multiplier: 2,
        maxDelayMs: 100_000,
        reservationTtlMs: 5_000,
        scanIntervalMs: 1_000,
      },
      now: () => 1_001,
    });

    await expect(notifier.notify(setup.source.id)).resolves.toBe(false);
    expect(wakeAuthorized).not.toHaveBeenCalled();
    expect(claimNotification(setup.db, { deviceId: setup.receiver.id, now: 1_002 })).toBeNull();
  });
});
