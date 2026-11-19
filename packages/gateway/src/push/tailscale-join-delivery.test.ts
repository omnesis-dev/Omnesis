// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { DeviceId } from "@omnesis/types";
import { createNotificationQueueTables, enqueueNotification } from "./queue.js";
import { suppressUnsupportedPairingReminders } from "./pairing-delivery.js";
import { suppressUnsupportedTailscaleJoinReminders } from "./tailscale-join-delivery.js";

const deviceId = DeviceId("00000000-0000-4000-8000-000000000052");

function queueTwoKinds(capabilities: string) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE devices(id TEXT PRIMARY KEY,capabilities TEXT)");
  db.prepare("INSERT INTO devices(id,capabilities) VALUES (?,?)").run(deviceId, capabilities);
  createNotificationQueueTables(db);
  for (const kind of ["device-pairing", "tailscale-join"] as const) {
    enqueueNotification(db, {
      message: { kind, title: "Waiting", body: "Review it.", data: {}, collapseId: kind },
      deviceIds: [deviceId],
      createdAt: 1_000,
      expiresAt: 601_000,
    });
  }
  const states = () =>
    Object.fromEntries(
      db
        .prepare<[], { kind: string; state: string }>(
          "SELECT n.kind AS kind, d.state AS state FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id",
        )
        .all()
        .map((row) => [row.kind, row.state]),
    );
  return { db, states };
}

for (const [capabilities, claimSupports, kept] of [
  ['{"tailscaleJoinNotifications":true}', true, true],
  ['{"tailscaleJoinNotifications":true}', false, false],
  ['{"tailscaleJoinNotifications":"true"}', true, false],
  ['{"pairingNotifications":true}', true, false],
  ["{}", true, false],
] as const) {
  test(`a Tailscale join reminder is kept only for a client that negotiated it and says so: ${capabilities} claim=${claimSupports}`, () => {
    const { db, states } = queueTwoKinds(capabilities);
    try {
      suppressUnsupportedTailscaleJoinReminders(db, deviceId, 1_001, claimSupports);
      // Each kind is judged by its own capability only.
      expect(states()).toEqual({
        "device-pairing": "pending",
        "tailscale-join": kept ? "pending" : "superseded",
      });
    } finally {
      db.close();
    }
  });
}

test("suppressing pairing reminders leaves Tailscale join reminders alone", () => {
  const { db, states } = queueTwoKinds('{"tailscaleJoinNotifications":true}');
  try {
    suppressUnsupportedPairingReminders(db, deviceId, 1_001, false);
    expect(states()).toEqual({ "device-pairing": "superseded", "tailscale-join": "pending" });
  } finally {
    db.close();
  }
});

test("a Tailscale joined notice follows the same capability as a waiting request", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE devices(id TEXT PRIMARY KEY,capabilities TEXT)");
    db.prepare("INSERT INTO devices(id,capabilities) VALUES (?,?)").run(deviceId, "{}");
    createNotificationQueueTables(db);
    for (const kind of ["tailscale-joined", "device-joined"] as const) {
      enqueueNotification(db, {
        message: { kind, title: "Joined", body: "A device joined.", data: {}, collapseId: kind },
        deviceIds: [deviceId],
        createdAt: 1_000,
        expiresAt: 601_000,
      });
    }
    suppressUnsupportedTailscaleJoinReminders(db, deviceId, 1_001, false);
    const states = Object.fromEntries(
      db
        .prepare<[], { kind: string; state: string }>(
          "SELECT n.kind AS kind, d.state AS state FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id",
        )
        .all()
        .map((row) => [row.kind, row.state]),
    );
    // The cloud relay's device-joined is not this check's to judge.
    expect(states).toEqual({ "tailscale-joined": "superseded", "device-joined": "pending" });
  } finally {
    db.close();
  }
});
