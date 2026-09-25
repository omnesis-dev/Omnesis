// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { describe, expect, test } from "vitest";
import { DeviceId, SourceType, type DeviceRecord } from "@omnesis/types";
import {
  cursorDeviceFor,
  deviceSupportsMultiDeviceMode,
  resolveDeviceMultiDeviceMode,
} from "./multi-device-mode.js";

function device(
  n: number,
  patch: Partial<DeviceRecord> & { modes?: Record<string, string> },
): DeviceRecord {
  const { modes, ...rest } = patch;
  return {
    id: DeviceId(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
    name: `device-${n}`,
    kind: "collector",
    capabilities: modes ? { multiDeviceModes: modes as never } : {},
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
    notificationDeliveryHealth: null,
    notificationDeliveryHealthUpdatedAt: null,
    ...rest,
  };
}

describe("resolveDeviceMultiDeviceMode", () => {
  test("pins the intended host's valid declaration", () => {
    expect(
      resolveDeviceMultiDeviceMode(device(1, { modes: { notes: "replicated" } }), "notes"),
    ).toBe("replicated");
    expect(resolveDeviceMultiDeviceMode(device(2, { modes: { notes: "sideways" } }), "notes")).toBe(
      "exclusive",
    );
  });

  test("fails closed when a host omits or malforms its mode announcement", () => {
    expect(resolveDeviceMultiDeviceMode(undefined, "apple-health")).toBe("exclusive");
    expect(resolveDeviceMultiDeviceMode(device(2, {}), "activity-segments")).toBe("exclusive");
    expect(
      resolveDeviceMultiDeviceMode(
        device(3, { modes: { "android-activity-segments": "sideways" } }),
        "android-activity-segments",
      ),
    ).toBe("exclusive");
  });
});

describe("deviceSupportsMultiDeviceMode", () => {
  test("requires an exact collector announcement and leases for lease-backed modes", () => {
    const type = SourceType("notes");
    const announced = device(1, { modes: { notes: "replicated" } });
    expect(deviceSupportsMultiDeviceMode(announced, type, "replicated")).toBe(false);
    announced.capabilities.syncLease = true;
    expect(deviceSupportsMultiDeviceMode(announced, type, "replicated")).toBe(true);
    expect(deviceSupportsMultiDeviceMode(announced, type, "partitioned")).toBe(false);

    const partitioned = device(2, { modes: { notes: "partitioned" } });
    expect(deviceSupportsMultiDeviceMode(partitioned, type, "partitioned")).toBe(true);
  });

  test("keeps exclusive compatible but fails closed for legacy mobile clients", () => {
    const type = SourceType("photos");
    expect(deviceSupportsMultiDeviceMode(device(1, {}), type, "exclusive")).toBe(true);
    expect(deviceSupportsMultiDeviceMode(device(2, { kind: "ios" }), type, "replicated")).toBe(
      false,
    );

    const upgraded = device(3, { kind: "ios", modes: { photos: "replicated" } });
    expect(deviceSupportsMultiDeviceMode(upgraded, type, "replicated")).toBe(false);
    upgraded.capabilities.syncLease = true;
    expect(deviceSupportsMultiDeviceMode(upgraded, type, "replicated")).toBe(true);
    expect(
      deviceSupportsMultiDeviceMode(
        device(4, { kind: "android", modes: { photos: "partitioned" } }),
        type,
        "partitioned",
      ),
    ).toBe(true);
  });
});

describe("cursorDeviceFor", () => {
  const phone = DeviceId("00000000-0000-4000-8000-000000000042");
  test("the shared row for callers without a device and for shared-cursor modes", () => {
    expect(cursorDeviceFor("replicated", null)).toBe("");
    expect(cursorDeviceFor("exclusive", phone)).toBe("");
    expect(cursorDeviceFor("handoff", phone)).toBe("");
  });
  test("the device's own row for per-device-cursor modes", () => {
    expect(cursorDeviceFor("replicated", phone)).toBe(phone);
    expect(cursorDeviceFor("partitioned", phone)).toBe(phone);
  });
});
