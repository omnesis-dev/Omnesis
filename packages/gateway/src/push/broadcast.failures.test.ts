// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";

import { DeviceId, type DeviceRecord } from "@omnesis/types";
import { PushBroadcaster, type PushBroadcasterOptions } from "./broadcast.js";
import type { EnqueueNotificationInput } from "./queue.js";

function id(n: number) {
  return DeviceId(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
}

function device(deviceId: DeviceId, patch: Partial<DeviceRecord>): DeviceRecord {
  return {
    id: deviceId,
    name: `Fictional phone ${deviceId.slice(-1)}`,
    kind: "ios",
    capabilities: {},
    pairedAt: 1,
    lastSeenAt: null,
    revokedAt: null,
    installId: null,
    version: null,
    versionSeenAt: null,
    protocolVersion: null,
    desiredVersion: null,
    updateState: null,
    updateDetail: null,
    updateStateAt: null,
    selfEmails: [],
    selfPhones: [],
    accessLevelId: null,
    apnsRegistration: null,
    fcmRegistration: null,
    pushTransport: null,
    relayUrl: null,
    relayCredential: null,
    ...patch,
  };
}

function broadcaster(
  devices: DeviceRecord[],
  patch: Partial<PushBroadcasterOptions>,
): PushBroadcaster {
  return new PushBroadcaster({
    queue: {
      enqueueNotification: vi.fn(({ deviceIds }: EnqueueNotificationInput) =>
        Promise.resolve({
          notificationId: "notification-fictional",
          deliveryIds: deviceIds.map((_deviceId: DeviceId, index: number) => `delivery-${index}`),
          deviceIds: [...deviceIds],
        }),
      ),
      leaseNotificationWakes: vi.fn(({ deviceIds = [] }) =>
        Promise.resolve(
          deviceIds.map((deviceId: DeviceId, index: number) => ({
            deliveryId: `delivery-${index}`,
            deviceId,
            leaseToken: `lease-${index}`,
            attempt: 1,
            expiresAt: 100_000,
          })),
        ),
      ),
      settleNotificationWake: vi.fn(() => Promise.resolve(true)),
    },
    listDevices: () => devices,
    apnsClient: null,
    fcmClient: null,
    relayClient: { wake: vi.fn() },
    socket: null,
    now: () => 1_000,
    ...patch,
  });
}

const message = {
  kind: "brief" as const,
  title: "Fictional brief",
  body: "An invented summary is ready.",
  data: { briefId: "brief-fictional" },
  collapseId: "brief:fictional",
};

describe("PushBroadcaster carrier failures", () => {
  test("clears APNs and FCM registrations reported as unregistered", async () => {
    const iosId = id(1);
    const androidId = id(2);
    const clearApnsRegistration = vi.fn(() => Promise.resolve(true));
    const clearFcmRegistration = vi.fn(() => Promise.resolve(true));
    const subject = broadcaster(
      [
        device(iosId, {
          pushTransport: "direct-apns",
          apnsRegistration: {
            deviceToken: "a".repeat(64),
            environment: "production",
            bundleId: "dev.example.ios",
            updatedAt: 1,
          },
        }),
        device(androidId, {
          kind: "android",
          pushTransport: "direct-fcm",
          fcmRegistration: { registrationToken: "fictional-fcm-token", updatedAt: 1 },
        }),
      ],
      {
        apnsClient: {
          send: vi.fn(() =>
            Promise.resolve({
              ok: false as const,
              statusCode: 410,
              reason: "Unregistered",
              rawBody: "",
              unregistered: true,
            }),
          ),
        },
        fcmClient: {
          send: vi.fn(() =>
            Promise.resolve({
              ok: false as const,
              statusCode: 404,
              reason: "UNREGISTERED",
              rawBody: "",
              unregistered: true,
            }),
          ),
        },
        clearApnsRegistration,
        clearFcmRegistration,
      },
    );

    const results = await subject.publish(message);

    expect(clearApnsRegistration).toHaveBeenCalledOnce();
    expect(clearApnsRegistration).toHaveBeenCalledWith(iosId, {
      deviceToken: "a".repeat(64),
      environment: "production",
      bundleId: "dev.example.ios",
      updatedAt: 1,
    });
    expect(clearFcmRegistration).toHaveBeenCalledOnce();
    expect(clearFcmRegistration).toHaveBeenCalledWith(androidId, {
      registrationToken: "fictional-fcm-token",
      updatedAt: 1,
    });
    expect(results).toEqual([
      expect.objectContaining({ deviceId: iosId, transport: "direct-apns", ok: false }),
      expect.objectContaining({ deviceId: androidId, transport: "direct-fcm", ok: false }),
    ]);
  });

  test("a carrier throw for one device does not starve its sibling", async () => {
    const firstId = id(3);
    const secondId = id(4);
    const send = vi.fn(({ deviceToken }: { deviceToken: string }) => {
      if (deviceToken === "b".repeat(64)) {
        return Promise.reject(new Error("carrier unavailable"));
      }
      return Promise.resolve({ ok: true as const, statusCode: 200 as const, apnsId: null });
    });
    const subject = broadcaster(
      [
        device(firstId, {
          pushTransport: "direct-apns",
          apnsRegistration: {
            deviceToken: "b".repeat(64),
            environment: "production",
            bundleId: "dev.example.ios",
            updatedAt: 1,
          },
        }),
        device(secondId, {
          pushTransport: "direct-apns",
          apnsRegistration: {
            deviceToken: "c".repeat(64),
            environment: "production",
            bundleId: "dev.example.ios",
            updatedAt: 1,
          },
        }),
      ],
      { apnsClient: { send } },
    );

    const results = await subject.publish(message);

    expect(send).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      {
        deviceId: firstId,
        transport: "direct-apns",
        ok: false,
        reason: "carrier unavailable",
      },
      { deviceId: secondId, transport: "direct-apns", ok: true },
    ]);
  });
});
