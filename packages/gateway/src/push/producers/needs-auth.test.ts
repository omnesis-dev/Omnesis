// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { createDatabase } from "../../db.js";
import {
  createDevice,
  setNotificationDeliveryHealth,
} from "../../data/repositories/DeviceRepository.js";
import { claimNotification } from "../queue.js";
import { DEFAULT_NOTIFICATION_TTL_MS } from "../broadcast.js";
import { directWriteGate } from "../../write-gate.js";
import { NeedsAuthNotifier, needsAuthCollapseId, needsAuthCollapsePrefix } from "./needs-auth.js";
import type { DeviceId } from "@omnesis/types";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

/** The collector whose grant lapsed. */
const LAPTOP = "00000000-0000-4000-8000-00000000000a" as DeviceId;
const LAPTOP_NAME = "Maya-Laptop";
const STUDIO = "00000000-0000-4000-8000-00000000000b" as DeviceId;
const STUDIO_NAME = "Studio-Mini";

/** The device-name lookup the gateway wires from its device repository. */
function nameOf(deviceId: DeviceId): string {
  return deviceId === LAPTOP ? LAPTOP_NAME : deviceId === STUDIO ? STUDIO_NAME : deviceId;
}

function harness(due = true) {
  const deviceId = "00000000-0000-4000-8000-000000000001" as DeviceId;
  const retentionDeviceIds = vi.fn(() => [deviceId]);
  const wakeAuthorized = vi.fn(async () => []);
  const reserve = vi.fn(async () => (due ? "reservation" : null));
  const retain = vi.fn(async (_reservation, _message, ids: readonly DeviceId[]) => ids);
  const release = vi.fn(async () => undefined);
  const recover = vi.fn(async () => undefined);
  const deviceName = vi.fn(nameOf);
  return {
    deviceId,
    retentionDeviceIds,
    wakeAuthorized,
    deviceName,
    reserve,
    retain,
    release,
    recover,
    notifier: new NeedsAuthNotifier({
      publisher: { retentionDeviceIds, wakeAuthorized },
      deviceName,
      reserve,
      retain,
      release,
      recover,
    }),
  };
}

describe("NeedsAuthNotifier.notify", () => {
  test("atomically retains a tagged message keyed on the provider principal and device before waking", async () => {
    const { notifier, reserve, retain, wakeAuthorized, deviceId } = harness();
    await notifier.notify({
      sourceId: "fictional-mail:account@example.com",
      providerId: "fictional-provider:account@example.com",
      deviceId: LAPTOP,
    });
    expect(reserve).toHaveBeenCalledWith("fictional-provider:account@example.com", LAPTOP);
    const message = {
      kind: "needs-auth",
      title: "Re-auth needed",
      body: "Sign in again on Maya-Laptop to keep fictional-provider:account@example.com syncing.",
      data: {
        sourceId: "fictional-mail:account@example.com",
        providerId: "fictional-provider:account@example.com",
      },
      collapseId: needsAuthCollapseId("fictional-provider:account@example.com", LAPTOP),
    };
    expect(retain).toHaveBeenCalledWith("reservation", message, [deviceId]);
    expect(wakeAuthorized).toHaveBeenCalledWith([deviceId]);
  });

  test("falls back to source id when no provider id is known", async () => {
    const { notifier, retain } = harness();
    await notifier.notify({
      sourceId: "fictional-mail:account@example.com",
      deviceId: LAPTOP,
    });
    expect(retain.mock.calls[0]?.[1]).toMatchObject({
      body: "Sign in again on Maya-Laptop to keep fictional-mail:account@example.com syncing.",
      data: { sourceId: "fictional-mail:account@example.com" },
      collapseId: needsAuthCollapseId("fictional-mail:account@example.com", LAPTOP),
    });
  });

  test("a backoff verdict suppresses retention and waking, and never resolves the device name", async () => {
    const { notifier, retain, wakeAuthorized, deviceName } = harness(false);
    await notifier.notify({
      sourceId: "fictional-mail:account@example.com",
      deviceId: LAPTOP,
    });
    expect(retain).not.toHaveBeenCalled();
    expect(wakeAuthorized).not.toHaveBeenCalled();
    expect(deviceName).not.toHaveBeenCalled();
  });

  test("the device name is resolved once per reminder, after the reservation is held", async () => {
    const { notifier, reserve, deviceName } = harness();
    const order: string[] = [];
    reserve.mockImplementation(async () => {
      order.push("reserve");
      return "reservation";
    });
    deviceName.mockImplementation((id) => {
      order.push("deviceName");
      return nameOf(id);
    });
    await notifier.notify({ sourceId: "fictional-mail:a", deviceId: LAPTOP });
    expect(order).toEqual(["reserve", "deviceName"]);
    expect(deviceName).toHaveBeenCalledWith(LAPTOP);
  });

  test("concurrent lapses on two devices both reserve; the same device twice reserves once", async () => {
    const { notifier, reserve } = harness();
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => (settle = resolve));
    reserve.mockImplementation(async () => {
      await gate;
      return "reservation";
    });
    const lapse = (deviceId: DeviceId) =>
      notifier.notify({ sourceId: "fictional-mail:a", providerId: "provider:account", deviceId });
    const inFlight = Promise.all([lapse(LAPTOP), lapse(STUDIO), lapse(LAPTOP)]);
    // The in-flight key is (principal, device): the laptop's second lapse
    // joins its first; the studio machine's is a separate episode.
    expect(reserve.mock.calls).toEqual([
      ["provider:account", LAPTOP],
      ["provider:account", STUDIO],
    ]);
    settle();
    await inFlight;
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  test("retention errors never break status ingestion", async () => {
    const setup = harness();
    setup.retain.mockRejectedValue(new Error("queue unavailable"));
    await expect(
      setup.notifier.notify({
        sourceId: "fictional-mail:account@example.com",
        deviceId: LAPTOP,
      }),
    ).resolves.toBeUndefined();
  });

  test("different sources under one provider on one device use the same backoff principal", async () => {
    const { notifier, reserve } = harness();
    await notifier.notify({
      sourceId: "fictional-mail:a",
      providerId: "provider:account",
      deviceId: LAPTOP,
    });
    await notifier.notify({
      sourceId: "fictional-calendar:a",
      providerId: "provider:account",
      deviceId: LAPTOP,
    });
    expect(reserve.mock.calls).toEqual([
      ["provider:account", LAPTOP],
      ["provider:account", LAPTOP],
    ]);
  });

  test("one provider on two devices is two episodes: separate reservations, bodies and collapse ids", async () => {
    const { notifier, reserve, retain } = harness();
    await notifier.notify({
      sourceId: "fictional-mail:a",
      providerId: "provider:account",
      deviceId: LAPTOP,
    });
    await notifier.notify({
      sourceId: "fictional-mail:a",
      providerId: "provider:account",
      deviceId: STUDIO,
    });
    expect(reserve.mock.calls).toEqual([
      ["provider:account", LAPTOP],
      ["provider:account", STUDIO],
    ]);
    const [laptop, studio] = retain.mock.calls.map((call) => call[1]);
    expect(laptop?.body).toBe("Sign in again on Maya-Laptop to keep provider:account syncing.");
    expect(studio?.body).toBe("Sign in again on Studio-Mini to keep provider:account syncing.");
    expect(laptop?.collapseId).not.toBe(studio?.collapseId);
    expect(
      laptop?.collapseId?.startsWith(needsAuthCollapsePrefix("provider:account", LAPTOP)),
    ).toBe(true);
    expect(
      studio?.collapseId?.startsWith(needsAuthCollapsePrefix("provider:account", LAPTOP)),
    ).toBe(false);
  });

  test("releases the reservation when no durable delivery target exists", async () => {
    const setup = harness();
    setup.retentionDeviceIds.mockReturnValue([]);

    await setup.notifier.notify({
      sourceId: "fictional-mail:a",
      deviceId: LAPTOP,
    });

    expect(setup.retain).not.toHaveBeenCalled();
    expect(setup.release).toHaveBeenCalledWith("reservation");
    expect(setup.wakeAuthorized).not.toHaveBeenCalled();
  });

  test("recovery between reservation and atomic retention creates no delivery or wake", async () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const device = createDevice(db, { name: "Fictional alert phone", kind: "ios" });
    db.prepare("UPDATE devices SET push_transport = 'direct-apns' WHERE id = ?").run(device.id);
    setNotificationDeliveryHealth(db, device.id, "healthy", 1_000);
    const gate = directWriteGate(db);
    const wakeAuthorized = vi.fn(async () => []);
    const principal = "fictional-provider:account@example.com";
    const notifier = new NeedsAuthNotifier({
      publisher: {
        retentionDeviceIds: () => [device.id],
        wakeAuthorized,
      },
      deviceName: nameOf,
      reserve: (value, deviceId) =>
        gate.reserveReauthReminder(value, deviceId, 1_000, {
          initialDelayMs: 1,
          multiplier: 2,
          maxDelayMs: 10,
          reservationTtlMs: 100,
        }),
      retain: async (token, message, deviceIds) => {
        await gate.recoverReauthReminder(
          principal,
          LAPTOP,
          needsAuthCollapsePrefix(principal, LAPTOP),
          1_001,
        );
        const retained = await gate.commitReauthReminderNotification(token, 1_001, {
          message,
          deviceIds,
          createdAt: 1_001,
          expiresAt: 1_001 + DEFAULT_NOTIFICATION_TTL_MS,
        });
        return retained?.deviceIds ?? null;
      },
      release: async (token) => {
        await gate.releaseReauthReminder(token);
      },
      recover: async () => undefined,
    });

    await notifier.notify({
      sourceId: "fictional-mail:a",
      providerId: principal,
      deviceId: LAPTOP,
    });

    expect(wakeAuthorized).not.toHaveBeenCalled();
    expect(claimNotification(db, { deviceId: device.id, now: 1_002 })).toBeNull();
  });

  test("a retry after a post-commit wake failure leaves one pending delivery", async () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const device = createDevice(db, { name: "Fictional alert phone", kind: "ios" });
    db.prepare("UPDATE devices SET push_transport = 'direct-apns' WHERE id = ?").run(device.id);
    setNotificationDeliveryHealth(db, device.id, "healthy", 1_000);
    const gate = directWriteGate(db);
    let now = 1_000;
    const wakeAuthorized = vi
      .fn<() => Promise<[]>>()
      .mockRejectedValueOnce(new Error("process stopped before wake"))
      .mockResolvedValue([]);
    const notifier = new NeedsAuthNotifier({
      publisher: {
        retentionDeviceIds: () => [device.id],
        wakeAuthorized,
      },
      deviceName: nameOf,
      reserve: (principal, deviceId) =>
        gate.reserveReauthReminder(principal, deviceId, now, {
          initialDelayMs: 1,
          multiplier: 1,
          maxDelayMs: 1,
          reservationTtlMs: 100,
        }),
      retain: async (token, message, deviceIds) => {
        const retained = await gate.commitReauthReminderNotification(token, now, {
          message,
          deviceIds,
          createdAt: now,
          expiresAt: now + DEFAULT_NOTIFICATION_TTL_MS,
        });
        return retained?.deviceIds ?? null;
      },
      release: async (token) => {
        await gate.releaseReauthReminder(token);
      },
      recover: async () => undefined,
    });

    await notifier.notify({
      sourceId: "fictional-mail:a",
      deviceId: LAPTOP,
    });
    now += 2;
    await notifier.notify({
      sourceId: "fictional-mail:a",
      deviceId: LAPTOP,
    });

    expect(claimNotification(db, { deviceId: device.id, now: now + 1 })).not.toBeNull();
    expect(claimNotification(db, { deviceId: device.id, now: now + 1 })).toBeNull();
  });

  test("one device's recovery supersedes only its own pending reminder", async () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const device = createDevice(db, { name: "Fictional alert phone", kind: "ios" });
    db.prepare("UPDATE devices SET push_transport = 'direct-apns' WHERE id = ?").run(device.id);
    setNotificationDeliveryHealth(db, device.id, "healthy", 1_000);
    const gate = directWriteGate(db);
    const principal = "fictional-provider:account@example.com";
    const cfg = { initialDelayMs: 1, multiplier: 1, maxDelayMs: 1, reservationTtlMs: 100 };
    const notifier = new NeedsAuthNotifier({
      publisher: { retentionDeviceIds: () => [device.id], wakeAuthorized: async () => [] },
      deviceName: nameOf,
      reserve: (value, deviceId) => gate.reserveReauthReminder(value, deviceId, 1_000, cfg),
      retain: async (token, message, deviceIds) => {
        const retained = await gate.commitReauthReminderNotification(token, 1_000, {
          message,
          deviceIds,
          createdAt: 1_000,
          expiresAt: 1_000 + DEFAULT_NOTIFICATION_TTL_MS,
        });
        return retained?.deviceIds ?? null;
      },
      release: async (token) => {
        await gate.releaseReauthReminder(token);
      },
      recover: async (value, deviceId, prefix) => {
        await gate.recoverReauthReminder(value, deviceId, prefix, 1_001);
      },
    });

    await notifier.notify({
      sourceId: "fictional-mail:a",
      providerId: principal,
      deviceId: LAPTOP,
    });
    await notifier.notify({
      sourceId: "fictional-mail:a",
      providerId: principal,
      deviceId: STUDIO,
    });
    await notifier.reset({ sourceId: "fictional-mail:a", providerId: principal, deviceId: LAPTOP });

    // The laptop's reminder is gone; the studio machine's is still owed.
    const remaining = claimNotification(db, { deviceId: device.id, now: 1_002 });
    expect(remaining?.body).toBe("Sign in again on Studio-Mini to keep " + principal + " syncing.");
    expect(claimNotification(db, { deviceId: device.id, now: 1_002 })).toBeNull();
  });
});

describe("NeedsAuthNotifier.reset", () => {
  test("atomically clears the device's episode and supersedes its queued or leased deliveries", async () => {
    const { notifier, recover } = harness();
    await notifier.reset({
      sourceId: "fictional-mail:a",
      providerId: "provider:account",
      deviceId: LAPTOP,
    });
    expect(recover).toHaveBeenCalledWith(
      "provider:account",
      LAPTOP,
      needsAuthCollapsePrefix("provider:account", LAPTOP),
    );
  });

  test("a reset failure does not propagate", async () => {
    const setup = harness();
    setup.recover.mockRejectedValue(new Error("writer unavailable"));
    await expect(
      setup.notifier.reset({
        sourceId: "fictional-mail:a",
        providerId: "provider:account",
        deviceId: LAPTOP,
      }),
    ).resolves.toBeUndefined();
  });
});
