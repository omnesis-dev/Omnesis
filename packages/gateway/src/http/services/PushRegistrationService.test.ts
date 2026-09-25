// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { DeviceId, type DeviceRecord } from "@omnesis/types";

import { PushRegistrationService } from "./PushRegistrationService.js";
import type { DeviceService } from "./DeviceService.js";

const deviceId = DeviceId("11111111-1111-4111-8111-111111111111");

function iosDevice(patch: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: deviceId,
    kind: "ios",
    name: "Fictional iPhone",
    capabilities: { pushAppId: "dev.omnesis.ios" },
    relayConsent: null,
    ...patch,
  } as DeviceRecord;
}

function androidDevice(patch: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    ...iosDevice(),
    kind: "android",
    name: "android-test-device",
    capabilities: { pushAppId: "dev.omnesis.android" },
    ...patch,
  } as DeviceRecord;
}

function subject(
  options: {
    device?: DeviceRecord;
    enabled?: boolean;
    url?: string;
    directBundleId?: string;
    directFcmAppId?: string;
    directFcmProjectId?: string;
    registrationWritten?: boolean;
  } = {},
) {
  const writeGate = {
    setDeviceApnsToken: vi.fn(),
    setDeviceFcmToken: vi.fn(),
    setDeviceRelayPushConsent: vi.fn().mockResolvedValue("granted"),
    withdrawDeviceRelayPushConsent: vi.fn().mockResolvedValue(true),
    setDeviceRelayPushRegistration: vi.fn().mockResolvedValue(options.registrationWritten ?? true),
  };
  const onDeviceChanged = vi.fn();
  const getById = vi.fn(() => options.device ?? iosDevice());
  const service = new PushRegistrationService({
    devices: { getById } as unknown as DeviceService,
    writeGate,
    getConfig: () =>
      ({
        gateway: {
          ...(options.directBundleId ? { apns: { bundleId: options.directBundleId } } : {}),
          ...(options.directFcmAppId ? { fcm: { appId: options.directFcmAppId } } : {}),
        },
      }) as never,
    getRelaySettings: () => ({
      enabled: options.enabled ?? false,
      url: options.url ?? "https://push.omnesis.app",
    }),
    getFcmProjectId: async () => options.directFcmProjectId,
    onDeviceChanged,
    now: () => 123,
  });
  return { service, writeGate, onDeviceChanged, getById };
}

describe("PushRegistrationService relay consent", () => {
  test("the legacy global switch does not authorize a published app", () => {
    const { service } = subject({ enabled: true });

    expect(service.plan(deviceId, { platform: "ios", appId: "dev.omnesis.ios" })).toEqual({
      transport: "unavailable",
      reasonCode: "relay-disabled",
      reason: "relay notifications are not authorized for this device",
    });
  });

  test("adopts a missing declaration instead of forcing a re-pair", async () => {
    const missing = subject({ device: iosDevice({ capabilities: {} }) });

    await missing.service.grantRelayConsent(deviceId, {
      platform: "ios",
      appId: "dev.omnesis.ios",
    });
    // The write adopts the attested identity; the service passes it through.
    expect(missing.writeGate.setDeviceRelayPushConsent).toHaveBeenCalledWith(deviceId, {
      appId: "dev.omnesis.ios",
      grantedAt: 123,
    });
    expect(missing.onDeviceChanged).toHaveBeenCalledOnce();

    const consentedWithoutDeclaration = subject({
      device: iosDevice({
        capabilities: {},
        relayConsent: { appId: "dev.omnesis.ios", grantedAt: 1 },
      }),
    });
    let planError: unknown;
    try {
      consentedWithoutDeclaration.service.plan(deviceId, {
        platform: "ios",
        appId: "dev.omnesis.ios",
      });
    } catch (error) {
      planError = error;
    }
    expect(planError).toMatchObject({
      message: "push app identity does not match the paired device",
      detail: { reason: "identity-missing" },
    });
  });

  test("maps the transaction's conflict and missing-device outcomes", async () => {
    const conflicting = subject({
      device: iosDevice({ capabilities: { pushAppId: "dev.example.other-ios" } }),
    });
    conflicting.writeGate.setDeviceRelayPushConsent.mockResolvedValue("identity-mismatch");

    const conflict = await conflicting.service
      .grantRelayConsent(deviceId, {
        platform: "ios",
        appId: "dev.omnesis.ios",
      })
      .then(
        () => {
          throw new Error("expected grantRelayConsent to reject");
        },
        (cause: unknown) => cause,
      );
    expect(conflict).toMatchObject({
      message: "push app identity does not match the paired device",
      detail: { reason: "identity-mismatch" },
    });
    expect(conflicting.onDeviceChanged).not.toHaveBeenCalled();

    const missing = subject();
    missing.writeGate.setDeviceRelayPushConsent.mockResolvedValue("device-not-found");
    await expect(
      missing.service.grantRelayConsent(deviceId, {
        platform: "ios",
        appId: "dev.omnesis.ios",
      }),
    ).rejects.toThrow("active phone not found");
    expect(missing.onDeviceChanged).not.toHaveBeenCalled();
  });

  test("keeps gateway-first direct APNs compatibility for an older client", async () => {
    const legacy = subject({
      device: iosDevice({ capabilities: {} }),
      directBundleId: "dev.example.legacy-ios",
    });

    expect(
      legacy.service.plan(deviceId, {
        platform: "ios",
        appId: "dev.example.legacy-ios",
      }),
    ).toEqual({ transport: "direct-apns" });
    await legacy.service.register(deviceId, {
      transport: "direct-apns",
      deviceToken: "a".repeat(64),
      environment: "production",
      bundleId: "dev.example.legacy-ios",
    });
    expect(legacy.writeGate.setDeviceApnsToken).toHaveBeenCalledOnce();

    await expect(
      legacy.service.register(deviceId, {
        transport: "direct-apns",
        deviceToken: "b".repeat(64),
        environment: "production",
        bundleId: "dev.example.uncovered-ios",
      }),
    ).rejects.toThrow("configured APNs credential does not cover this bundle id");
  });

  test("keeps gateway-first direct FCM compatibility for an older client", async () => {
    const legacy = subject({
      device: androidDevice({ capabilities: {} }),
      directFcmAppId: "dev.example.legacy-android",
      directFcmProjectId: "fictional-project",
    });

    expect(
      legacy.service.plan(deviceId, {
        platform: "android",
        appId: "dev.example.legacy-android",
      }),
    ).toEqual({ transport: "direct-fcm" });
    await legacy.service.register(deviceId, {
      transport: "direct-fcm",
      registrationToken: "fictional-registration-token",
      projectId: "fictional-project",
    });
    expect(legacy.writeGate.setDeviceFcmToken).toHaveBeenCalledOnce();

    await expect(
      legacy.service.register(deviceId, {
        transport: "direct-fcm",
        registrationToken: "fictional-registration-token",
        projectId: "uncovered-project",
      }),
    ).rejects.toThrow("configured FCM credential does not cover this project id");
  });

  test("rejects an explicitly mismatched direct app identity", async () => {
    const mismatched = subject({
      device: iosDevice({ capabilities: { pushAppId: "dev.example.other-ios" } }),
      directBundleId: "dev.example.covered-ios",
    });

    expect(() =>
      mismatched.service.plan(deviceId, {
        platform: "ios",
        appId: "dev.example.covered-ios",
      }),
    ).toThrow("push app identity does not match the paired device");
    await expect(
      mismatched.service.register(deviceId, {
        transport: "direct-apns",
        deviceToken: "c".repeat(64),
        environment: "production",
        bundleId: "dev.example.covered-ios",
      }),
    ).rejects.toThrow("push app identity does not match the paired device");

    const mismatchedFcm = subject({
      device: androidDevice({
        capabilities: { pushAppId: "dev.example.other-android" },
      }),
      directFcmAppId: "dev.example.covered-android",
      directFcmProjectId: "fictional-project",
    });
    await expect(
      mismatchedFcm.service.register(deviceId, {
        transport: "direct-fcm",
        registrationToken: "fictional-registration-token",
        projectId: "fictional-project",
      }),
    ).rejects.toThrow("push app identity does not match the paired device");
  });

  test("computes a plan from the supplied cache snapshot without a device lookup", () => {
    const { service, getById } = subject({ directBundleId: "dev.example.cached-ios" });
    const snapshot = iosDevice({
      capabilities: {},
      relayConsent: null,
    });

    expect(
      service.planForDevice(snapshot, {
        platform: "ios",
        appId: "dev.example.cached-ios",
      }),
    ).toEqual({ transport: "direct-apns" });
    expect(getById).not.toHaveBeenCalled();
  });

  test("grants consent only for a published app without direct coverage", async () => {
    const { service, writeGate, onDeviceChanged } = subject();

    await service.grantRelayConsent(deviceId, {
      platform: "ios",
      appId: "dev.omnesis.ios",
    });
    expect(writeGate.setDeviceRelayPushConsent).toHaveBeenCalledWith(deviceId, {
      appId: "dev.omnesis.ios",
      grantedAt: 123,
    });
    expect(onDeviceChanged).toHaveBeenCalledOnce();

    const direct = subject({ directBundleId: "dev.omnesis.ios" });
    const directError = await direct.service
      .grantRelayConsent(deviceId, {
        platform: "ios",
        appId: "dev.omnesis.ios",
      })
      .then(
        () => {
          throw new Error("expected grantRelayConsent to reject");
        },
        (cause: unknown) => cause,
      );
    expect(directError).toMatchObject({
      message: "direct push already covers dev.omnesis.ios; relay consent is not needed",
      detail: { reason: "direct-coverage" },
    });
  });

  test("names the cause when consent is unavailable", async () => {
    const unpublished = subject({ device: iosDevice({ capabilities: {} }) });
    const unpublishedError = await unpublished.service
      .grantRelayConsent(deviceId, {
        platform: "ios",
        appId: "dev.example.unknown-ios",
      })
      .then(
        () => {
          throw new Error("expected grantRelayConsent to reject");
        },
        (cause: unknown) => cause,
      );
    expect(unpublishedError).toMatchObject({
      message: expect.stringContaining("no push credential covers dev.example.unknown-ios"),
      detail: { reason: "unpublished-app" },
    });
    expect(unpublished.writeGate.setDeviceRelayPushConsent).not.toHaveBeenCalled();
  });

  test("uses the live relay endpoint after this device grants exact-app consent", () => {
    const { service } = subject({
      enabled: false,
      url: "https://relay-one.example.com",
      device: iosDevice({
        relayConsent: { appId: "dev.omnesis.ios", grantedAt: 1 },
      }),
    });

    expect(service.plan(deviceId, { platform: "ios", appId: "dev.omnesis.ios" })).toEqual({
      transport: "relay",
      relayUrl: "https://relay-one.example.com",
    });
  });

  test("withdraws consent through the atomic writer operation", async () => {
    const { service, writeGate, onDeviceChanged } = subject();

    await service.withdrawRelayConsent(deviceId);

    expect(writeGate.withdrawDeviceRelayPushConsent).toHaveBeenCalledWith(deviceId);
    expect(onDeviceChanged).toHaveBeenCalledOnce();
  });

  test("derives relay registration identity from exact persisted capability and consent", async () => {
    const { service, writeGate } = subject({
      device: iosDevice({ relayConsent: { appId: "dev.omnesis.ios", grantedAt: 1 } }),
    });
    const registration = {
      transport: "relay" as const,
      relayUrl: "https://push.omnesis.app",
      credential: "cred_fictional",
    };

    await service.register(deviceId, registration);
    expect(writeGate.setDeviceRelayPushRegistration).toHaveBeenCalledWith(deviceId, {
      relayUrl: registration.relayUrl,
      credential: registration.credential,
      appId: "dev.omnesis.ios",
    });

    const mismatched = subject({
      device: iosDevice({ relayConsent: { appId: "dev.omnesis.android", grantedAt: 1 } }),
    });
    await expect(mismatched.service.register(deviceId, registration)).rejects.toThrow(
      "relay push is not authorized for this device",
    );
  });

  test("rejects an unconsented registration and a withdrawal race", async () => {
    const registration = {
      transport: "relay" as const,
      relayUrl: "https://push.omnesis.app",
      credential: "cred_fictional",
    };
    await expect(subject().service.register(deviceId, registration)).rejects.toThrow(
      "relay push is not authorized for this device",
    );

    const raced = subject({
      device: iosDevice({ relayConsent: { appId: "dev.omnesis.ios", grantedAt: 1 } }),
      registrationWritten: false,
    });
    await expect(raced.service.register(deviceId, registration)).rejects.toThrow(
      "relay consent was withdrawn before registration completed",
    );
  });

  test("rejects a registration for a different relay endpoint", async () => {
    const { service } = subject({
      device: iosDevice({ relayConsent: { appId: "dev.omnesis.ios", grantedAt: 1 } }),
    });

    await expect(
      service.register(deviceId, {
        transport: "relay",
        relayUrl: "https://relay-old.example",
        credential: "cred_fictional",
      }),
    ).rejects.toThrow("relay registration does not match the configured endpoint");
  });
});
