// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { DeviceId } from "@omnesis/types";
import { createNotificationQueueTables, enqueueNotification } from "./queue.js";
import { suppressUnsupportedPairingReminders } from "./pairing-delivery.js";

const deviceId = DeviceId("00000000-0000-4000-8000-000000000051");
test("queues without pairing reminders need no new device capability columns", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE devices(id TEXT PRIMARY KEY)");
    createNotificationQueueTables(db);
    expect(() => suppressUnsupportedPairingReminders(db, deviceId, 1_000, true)).not.toThrow();
  } finally {
    db.close();
  }
});
for (const capabilities of [
  null,
  "not-json",
  "null",
  "42",
  "[]",
  "{}",
  '{"pairingNotifications":false}',
  '{"pairingNotifications":"true"}',
  '{"pairingNotifications":true}',
]) {
  test(`only an explicit current pairing-reminder capability retains a queued delivery: ${capabilities}`, () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE devices(id TEXT PRIMARY KEY,capabilities TEXT)");
      db.prepare("INSERT INTO devices(id,capabilities) VALUES (?,?)").run(deviceId, capabilities);
      createNotificationQueueTables(db);
      enqueueNotification(db, {
        message: {
          kind: "device-pairing",
          title: "Pairing request",
          body: "Review the request.",
          data: {},
          collapseId: "pairing:fixture",
        },
        deviceIds: [deviceId],
        createdAt: 1_000,
        expiresAt: 601_000,
      });
      suppressUnsupportedPairingReminders(db, deviceId, 1_001, true);
      expect(db.prepare("SELECT state FROM notification_deliveries").get()).toEqual({
        state: capabilities === '{"pairingNotifications":true}' ? "pending" : "superseded",
      });
    } finally {
      db.close();
    }
  });
}

test("missing recipient metadata fails closed without stealing an active notification lease", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE devices(id TEXT PRIMARY KEY,capabilities TEXT)");
    db.prepare("INSERT INTO devices VALUES (?,?)").run(deviceId, "{}");
    createNotificationQueueTables(db);
    enqueueNotification(db, {
      message: {
        kind: "device-pairing",
        title: "Pairing request",
        body: "Review the request.",
        data: {},
        collapseId: "pairing:fixture",
      },
      deviceIds: [deviceId],
      createdAt: 1_000,
      expiresAt: 601_000,
    });
    db.prepare("UPDATE notification_deliveries SET state='leased',leased_until=2000").run();
    suppressUnsupportedPairingReminders(db, deviceId, 1_001, true);
    expect(db.prepare("SELECT state FROM notification_deliveries").get()).toEqual({
      state: "leased",
    });
    // An incomplete restore may leave a delivery without its recipient metadata.
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM devices WHERE id=?").run(deviceId);
    suppressUnsupportedPairingReminders(db, deviceId, 2_000, true);
    expect(db.prepare("SELECT state,wake_state FROM notification_deliveries").get()).toEqual({
      state: "superseded",
      wake_state: "terminal",
    });
  } finally {
    db.close();
  }
});

test("an older claimant without negotiation cannot receive a queued new kind even when its hello is stale", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE devices(id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO devices VALUES (?)").run(deviceId);
    createNotificationQueueTables(db);
    enqueueNotification(db, {
      message: {
        kind: "device-pairing",
        title: "Pairing request",
        body: "Review the request.",
        data: {},
        collapseId: "pairing:fixture",
      },
      deviceIds: [deviceId],
      createdAt: 1_000,
      expiresAt: 601_000,
    });
    suppressUnsupportedPairingReminders(db, deviceId, 1_001, false);
    expect(db.prepare("SELECT state FROM notification_deliveries").get()).toEqual({
      state: "superseded",
    });
  } finally {
    db.close();
  }
});
