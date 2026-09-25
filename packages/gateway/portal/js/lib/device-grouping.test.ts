// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// The portal ships plain browser JS; importing the .js module directly keeps
// this test exercising the exact code the portal loads.
import {
  currentDeviceIdForKind,
  groupDevices,
  liveConnectionCount,
  needsPairingCount,
  relativeTime,
  revokedCount,
  statusLine,
} from "./device-grouping.js";

const NOW = Date.UTC(2026, 5, 23, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const ago = (ms: number) => NOW - ms;

describe("relativeTime", () => {
  test("buckets recent timestamps into human strings", () => {
    expect(relativeTime(ago(10_000))).toBe("just now");
    expect(relativeTime(ago(5 * 60_000))).toBe("5m ago");
    expect(relativeTime(ago(3 * 3_600_000))).toBe("3h ago");
    expect(relativeTime(ago(2 * 86_400_000))).toBe("2d ago");
  });

  test("falls back to an ISO date past a week, and 'never' when missing", () => {
    expect(relativeTime(ago(30 * 86_400_000))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(relativeTime(null)).toBe("never");
    expect(relativeTime(0)).toBe("never");
  });
});

describe("statusLine", () => {
  test("the current authenticated device is active without a WebSocket", () => {
    expect(statusLine({ online: false, lastSeenAt: null }, true)).toBe("Active now");
  });
  test("online means a live device-WebSocket connection", () => {
    expect(statusLine({ online: true, lastSeenAt: ago(60_000) })).toBe("Live connection");
  });
  test("non-live devices surface recorded activity without calling them offline", () => {
    expect(statusLine({ online: false, lastSeenAt: ago(2 * 3_600_000) })).toBe(
      "Last active 2h ago",
    );
    expect(statusLine({ online: false, lastSeenAt: null })).toBe("No activity recorded");
  });
  test("a revoked device reads as revoked, whatever its socket or activity say", () => {
    expect(
      statusLine({ online: true, lastSeenAt: ago(60_000), revokedAt: ago(5 * 60_000) }),
    ).toBe("Revoked 5m ago");
  });
  // The needs-pairing distinction is carried by the card's badge, so the
  // status line stays the timestamp and does not repeat the phrase.
  test("still reads as revoked when the device is waiting on a repair", () => {
    expect(
      statusLine({
        online: false,
        lastSeenAt: ago(60_000),
        revokedAt: ago(5 * 60_000),
        needsPairing: true,
      }),
    ).toBe("Revoked 5m ago");
  });
});

describe("revoked devices", () => {
  const devices = [
    { id: "live", online: true, lastSeenAt: ago(60_000), revokedAt: null },
    { id: "revoked-recent", online: false, lastSeenAt: ago(60_000), revokedAt: ago(30_000) },
    { id: "paired-old", online: false, lastSeenAt: ago(86_400_000), revokedAt: null },
    // A socket still draining after revocation is not a live connection.
    { id: "revoked-draining", online: true, lastSeenAt: ago(10_000), revokedAt: ago(5_000) },
  ];
  test("never count as live and sort after paired devices", () => {
    const { live, other } = groupDevices(devices, null);
    expect(live.map((d) => d.id)).toEqual(["live"]);
    expect(other.map((d) => d.id)).toEqual(["paired-old", "revoked-draining", "revoked-recent"]);
    expect(liveConnectionCount(devices)).toBe(1);
    expect(revokedCount(devices)).toBe(2);
  });

  test("only the revoked devices still hosting sources count as needing re-pairing", () => {
    expect(needsPairingCount(devices)).toBe(0);
    expect(
      needsPairingCount([
        ...devices,
        { id: "dormant", online: false, lastSeenAt: null, revokedAt: ago(1_000), needsPairing: true },
        // A flag on a paired row is meaningless; it must not be counted.
        { id: "paired-flagged", online: true, lastSeenAt: null, revokedAt: null, needsPairing: true },
      ]),
    ).toBe(1);
  });
});

describe("groupDevices", () => {
  const devices = [
    { id: "cli", online: false, lastSeenAt: ago(5 * 86_400_000) },
    { id: "collector", online: true, lastSeenAt: ago(60_000) },
    { id: "phone", online: false, lastSeenAt: ago(2 * 3_600_000) },
    { id: "portal", online: false, lastSeenAt: ago(30_000) },
  ];

  test("pins this device and splits the rest into live / other", () => {
    const { thisDevice, live, other } = groupDevices(devices, "portal");
    expect(thisDevice?.id).toBe("portal");
    expect(live.map((d) => d.id)).toEqual(["collector"]);
    // other is sorted most-recently-active first
    expect(other.map((d) => d.id)).toEqual(["phone", "cli"]);
  });

  test("pins the current device even without a live socket", () => {
    const { thisDevice, live, other } = groupDevices(devices, "cli");
    expect(thisDevice?.id).toBe("cli");
    expect(live.map((d) => d.id)).toEqual(["collector"]);
    expect(other.map((d) => d.id)).toEqual(["portal", "phone"]);
  });

  test("no this-device match leaves thisDevice null", () => {
    const { thisDevice, live, other } = groupDevices(devices, null);
    expect(thisDevice).toBeNull();
    expect(live).toHaveLength(1);
    expect(other).toHaveLength(3);
  });

  test("live connection count uses only WebSocket presence", () => {
    expect(liveConnectionCount(devices)).toBe(1);
  });

  test("current-device identity must belong to the client kind rendering the page", () => {
    const typedDevices = [
      { id: "portal", kind: "portal" },
      { id: "bootstrap", kind: "cli" },
    ];
    expect(currentDeviceIdForKind(typedDevices, "portal", "portal")).toBe("portal");
    expect(currentDeviceIdForKind(typedDevices, "bootstrap", "portal")).toBeNull();
    expect(currentDeviceIdForKind(typedDevices, null, "portal")).toBeNull();
  });
});
