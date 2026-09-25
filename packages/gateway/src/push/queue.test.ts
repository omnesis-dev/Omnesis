// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../db.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import {
  claimNotification,
  cleanupExpiredNotifications,
  CLAIM_CANDIDATE_SQL,
  confirmNotification,
  enqueueNotification,
  expireDeliveriesSql,
  expireNotifications,
  PENDING_COUNT_SQL,
  pendingNotificationCount,
  supersedeNotificationsByCollapseIdPrefix,
} from "./queue.js";
import type { Db } from "../data/types.js";
import type { NotificationMessage } from "@omnesis/core/push";
import type { DeviceId } from "@omnesis/types";

const BASE_TIME = 1_800_000_000_000;

let dbPath: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  dbPath = `/tmp/omnesis-notification-queue-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function message(
  suffix: string,
  overrides: Partial<Extract<NotificationMessage, { kind: "brief" }>> = {},
): Extract<NotificationMessage, { kind: "brief" }> {
  return {
    kind: "brief",
    title: `Fictional digest ${suffix}`,
    body: `Invented summary ${suffix}`,
    data: { briefId: `brf_${suffix}` },
    collapseId: `digest:${suffix}`,
    ...overrides,
  };
}

function state(deliveryId: string): string | undefined {
  return db
    .prepare<
      [string, string],
      { state: string }
    >("SELECT state FROM notification_deliveries WHERE id = ? OR lease_token = ?")
    .get(deliveryId, deliveryId)?.state;
}

describe("notification queue", () => {
  test("fresh schema includes durable wake columns and indexes", () => {
    const columns = db
      .prepare<[], { name: string }>(
        "SELECT name FROM pragma_table_info('notification_deliveries')",
      )
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "wake_state",
        "wake_attempt_count",
        "wake_lease_token",
        "wake_leased_until",
        "wake_next_attempt_at",
        "wake_last_attempt_at",
        "wake_last_success_at",
        "wake_last_error",
        "wake_last_transport",
      ]),
    );
    const indexes = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notification_deliveries'",
      )
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_notification_deliveries_wake_token",
        "idx_notification_deliveries_wake_due",
      ]),
    );
  });

  test("fans one rendered notification out once per distinct device", () => {
    const first = createDevice(db, { name: "phone-one", kind: "ios" });
    const second = createDevice(db, { name: "phone-two", kind: "android" });

    const result = enqueueNotification(db, {
      message: message("daily"),
      deviceIds: [first.id, second.id, first.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 60_000,
    });

    expect(result?.deliveryIds).toHaveLength(2);
    expect(result?.deviceIds).toEqual([first.id, second.id]);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM notifications").get()!.count,
    ).toBe(1);
    expect(
      db
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM notification_deliveries")
        .get()!.count,
    ).toBe(2);
  });

  test("preserves typed navigation data on the private claim path", () => {
    const device = createDevice(db, { name: "route-phone", kind: "ios" });
    enqueueNotification(db, {
      message: {
        kind: "watch",
        title: "Fictional watch fired",
        body: "Open the invented watch ledger.",
        data: { watchId: "watch-fictional", firingKey: "watch-fictional:17" },
        collapseId: "watch-fictional:17",
      },
      deviceIds: [device.id],
      createdAt: 1_000,
      expiresAt: 10_000,
    });

    expect(claimNotification(db, { deviceId: device.id, now: 1_001 })?.route).toEqual({
      kind: "watch",
      watchId: "watch-fictional",
      firingKey: "watch-fictional:17",
    });
  });

  test("claims FIFO, leases exactly one, and returns the remaining count", () => {
    const device = createDevice(db, { name: "fifo-phone", kind: "ios" });
    enqueueNotification(db, {
      message: message("first"),
      deviceIds: [device.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 60_000,
    });
    enqueueNotification(db, {
      message: message("second"),
      deviceIds: [device.id],
      createdAt: BASE_TIME + 1,
      expiresAt: BASE_TIME + 60_000,
    });

    const first = claimNotification(db, { deviceId: device.id, now: BASE_TIME + 2 });
    expect(first).toMatchObject({
      kind: "brief",
      targetId: "brf_first",
      collapseId: "digest:first",
      remaining: 1,
    });
    expect(first && state(first.id)).toBe("leased");

    const second = claimNotification(db, { deviceId: device.id, now: BASE_TIME + 3 });
    expect(second).toMatchObject({
      targetId: "brf_second",
      remaining: 0,
    });
    expect(claimNotification(db, { deviceId: device.id, now: BASE_TIME + 4 })).toBeNull();
  });

  test("preserves enqueue order when notifications share a timestamp", () => {
    const device = createDevice(db, { name: "same-timestamp-phone", kind: "ios" });
    enqueueNotification(db, {
      message: message("first-same-time"),
      deviceIds: [device.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 60_000,
    });
    enqueueNotification(db, {
      message: message("second-same-time"),
      deviceIds: [device.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 60_000,
    });

    expect(claimNotification(db, { deviceId: device.id, now: BASE_TIME + 1 })?.targetId).toBe(
      "brf_first-same-time",
    );
    expect(claimNotification(db, { deviceId: device.id, now: BASE_TIME + 1 })?.targetId).toBe(
      "brf_second-same-time",
    );
  });

  test("does not offer the same active lease through a second DB connection", () => {
    const device = createDevice(db, { name: "concurrent-phone", kind: "ios" });
    enqueueNotification(db, {
      message: message("concurrent"),
      deviceIds: [device.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 60_000,
    });
    const secondConnection = new Database(dbPath) as unknown as Db;
    try {
      expect(claimNotification(db, { deviceId: device.id, now: BASE_TIME + 1 })).not.toBeNull();
      expect(
        claimNotification(secondConnection, { deviceId: device.id, now: BASE_TIME + 1 }),
      ).toBeNull();
    } finally {
      secondConnection.close();
    }
  });

  test("reclaims an unconfirmed delivery only after its lease expires", () => {
    const device = createDevice(db, { name: "lease-phone", kind: "ios" });
    enqueueNotification(db, {
      message: message("lease"),
      deviceIds: [device.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 60_000,
    });
    const first = claimNotification(db, {
      deviceId: device.id,
      now: BASE_TIME + 1,
      leaseMs: 30,
    });
    expect(first).not.toBeNull();
    expect(claimNotification(db, { deviceId: device.id, now: BASE_TIME + 30 })).toBeNull();
    const reclaimed = claimNotification(db, { deviceId: device.id, now: BASE_TIME + 31 });
    expect(reclaimed?.id).not.toBe(first?.id);
  });

  test("rejects a stale claimant's confirm after the delivery is re-leased", () => {
    const device = createDevice(db, { name: "stale-confirm-phone", kind: "ios" });
    enqueueNotification(db, {
      message: message("stale-confirm"),
      deviceIds: [device.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 60_000,
    });
    const stale = claimNotification(db, { deviceId: device.id, now: BASE_TIME + 1, leaseMs: 10 })!;
    const current = claimNotification(db, { deviceId: device.id, now: BASE_TIME + 11 })!;

    expect(
      confirmNotification(db, {
        deviceId: device.id,
        deliveryId: stale.id,
        now: BASE_TIME + 12,
      }),
    ).toBe(false);
    expect(state(current.id)).toBe("leased");
    expect(
      confirmNotification(db, {
        deviceId: device.id,
        deliveryId: current.id,
        now: BASE_TIME + 12,
      }),
    ).toBe(true);
  });

  test("confirmation is device-bound, leased-only, and idempotent", () => {
    const owner = createDevice(db, { name: "owner-phone", kind: "ios" });
    const stranger = createDevice(db, { name: "stranger-phone", kind: "android" });
    enqueueNotification(db, {
      message: message("confirm"),
      deviceIds: [owner.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 60_000,
    });
    const claimed = claimNotification(db, { deviceId: owner.id, now: BASE_TIME + 1 })!;

    expect(
      confirmNotification(db, {
        deviceId: stranger.id,
        deliveryId: claimed.id,
        now: BASE_TIME + 2,
      }),
    ).toBe(false);
    expect(
      confirmNotification(db, {
        deviceId: owner.id,
        deliveryId: claimed.id,
        now: BASE_TIME + 2,
      }),
    ).toBe(true);
    expect(
      confirmNotification(db, {
        deviceId: owner.id,
        deliveryId: claimed.id,
        now: BASE_TIME + 3,
      }),
    ).toBe(false);
    expect(state(claimed.id)).toBe("delivered");
  });

  test("collapse supersession is per device and preserves active leases", () => {
    const first = createDevice(db, { name: "collapse-one", kind: "ios" });
    const second = createDevice(db, { name: "collapse-two", kind: "android" });
    const original = enqueueNotification(db, {
      message: message("old", { collapseId: "digest:shared" }),
      deviceIds: [first.id, second.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 60_000,
    })!;
    const active = claimNotification(db, { deviceId: first.id, now: BASE_TIME + 1 })!;

    enqueueNotification(db, {
      message: message("new", { collapseId: "digest:shared" }),
      deviceIds: [first.id],
      createdAt: BASE_TIME + 2,
      expiresAt: BASE_TIME + 60_000,
    });

    expect(state(active.id)).toBe("leased");
    expect(state(original.deliveryIds[1]!)).toBe("pending");
    expect(claimNotification(db, { deviceId: second.id, now: BASE_TIME + 3 })?.targetId).toBe(
      "brf_old",
    );
    expect(claimNotification(db, { deviceId: first.id, now: BASE_TIME + 3 })?.targetId).toBe(
      "brf_new",
    );
  });

  test("supersedes an expired lease before adding its replacement", () => {
    const device = createDevice(db, { name: "stale-lease-phone", kind: "ios" });
    const original = enqueueNotification(db, {
      message: message("stale", { collapseId: "digest:shared" }),
      deviceIds: [device.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 60_000,
    })!;
    claimNotification(db, { deviceId: device.id, now: BASE_TIME + 1, leaseMs: 10 });
    enqueueNotification(db, {
      message: message("replacement", { collapseId: "digest:shared" }),
      deviceIds: [device.id],
      createdAt: BASE_TIME + 11,
      expiresAt: BASE_TIME + 60_000,
    });

    expect(state(original.deliveryIds[0]!)).toBe("superseded");
    expect(claimNotification(db, { deviceId: device.id, now: BASE_TIME + 12 })?.targetId).toBe(
      "brf_replacement",
    );
  });

  test("recovery supersedes an active lease so it cannot reappear after expiry", () => {
    const device = createDevice(db, { name: "recovered-source-phone", kind: "ios" });
    const original = enqueueNotification(db, {
      message: message("permission", { collapseId: "source-permission:abcdef:episode" }),
      deviceIds: [device.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 60_000,
    })!;
    claimNotification(db, { deviceId: device.id, now: BASE_TIME + 1, leaseMs: 10 });

    expect(
      supersedeNotificationsByCollapseIdPrefix(db, "source-permission:abcdef:", BASE_TIME + 2),
    ).toBe(1);
    expect(state(original.deliveryIds[0]!)).toBe("superseded");
    expect(claimNotification(db, { deviceId: device.id, now: BASE_TIME + 12 })).toBeNull();
  });

  test("preserves the affected device through durable cross-device claims", () => {
    const affected = createDevice(db, { name: "affected-phone", kind: "ios" });
    const claimant = createDevice(db, { name: "claiming-phone", kind: "android" });
    enqueueNotification(db, {
      message: {
        kind: "source-permission",
        title: "Source access needs attention",
        body: "Open the affected phone to repair access.",
        data: { sourceId: "fictional-mobile:local", affectedDeviceId: affected.id },
        collapseId: "source-permission:abcdef:episode",
      },
      deviceIds: [claimant.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 60_000,
    });

    expect(claimNotification(db, { deviceId: claimant.id, now: BASE_TIME + 1 })).toMatchObject({
      kind: "source-permission",
      targetId: "fictional-mobile:local",
      affectedDeviceId: affected.id,
    });
  });

  test("expires pending work without consuming a live lease", () => {
    const pendingDevice = createDevice(db, { name: "expiry-pending", kind: "ios" });
    const leasedDevice = createDevice(db, { name: "expiry-leased", kind: "android" });
    const result = enqueueNotification(db, {
      message: message("short-lived"),
      deviceIds: [pendingDevice.id, leasedDevice.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 10,
    })!;
    claimNotification(db, {
      deviceId: leasedDevice.id,
      now: BASE_TIME + 1,
      leaseMs: 30,
    });

    expect(expireNotifications(db, BASE_TIME + 10)).toBe(1);
    expect(state(result.deliveryIds[0]!)).toBe("expired");
    expect(state(result.deliveryIds[1]!)).toBe("leased");
    expect(pendingNotificationCount(db, pendingDevice.id, BASE_TIME + 10)).toBe(0);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM notifications").get()!.count,
    ).toBe(1);

    expireNotifications(db, BASE_TIME + 31);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM notifications").get()!.count,
    ).toBe(0);
  });

  test("global cleanup bounds private content even when no device ever claims", () => {
    const device = createDevice(db, { name: "offline-expiry-phone", kind: "ios" });
    enqueueNotification(db, {
      message: message("offline-expiry"),
      deviceIds: [device.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 10,
    });

    expect(cleanupExpiredNotifications(db, BASE_TIME + 9)).toBe(0);
    expect(cleanupExpiredNotifications(db, BASE_TIME + 10)).toBe(1);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM notifications").get()!.count,
    ).toBe(0);
    expect(
      db
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM notification_deliveries")
        .get()!.count,
    ).toBe(0);
  });

  test("global cleanup preserves content for an active lease until that lease expires", () => {
    const device = createDevice(db, { name: "active-expiry-phone", kind: "android" });
    enqueueNotification(db, {
      message: message("active-expiry"),
      deviceIds: [device.id],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 10,
    });
    const lease = claimNotification(db, {
      deviceId: device.id,
      now: BASE_TIME + 1,
      leaseMs: 30,
    })!;

    expect(cleanupExpiredNotifications(db, BASE_TIME + 10)).toBe(0);
    expect(state(lease.id)).toBe("leased");
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM notifications").get()!.count,
    ).toBe(1);

    expect(cleanupExpiredNotifications(db, BASE_TIME + 31)).toBe(1);
    expect(state(lease.id)).toBeUndefined();
  });

  test("skips a device deleted after fan-out selection without aborting live devices", () => {
    const device = createDevice(db, { name: "valid-phone", kind: "ios" });
    const missing = "11111111-1111-4111-8111-111111111111" as typeof device.id;
    const result = enqueueNotification(db, {
      message: message("stale-device"),
      deviceIds: [device.id, missing],
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 60_000,
    });
    expect(result?.deliveryIds).toHaveLength(1);
    expect(result?.deviceIds).toEqual([device.id]);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM notifications").get()!.count,
    ).toBe(1);
  });

  test("does not retain content when every selected device has vanished", () => {
    const missing = "11111111-1111-4111-8111-111111111111" as never;
    expect(
      enqueueNotification(db, {
        message: message("all-stale"),
        deviceIds: [missing],
        createdAt: BASE_TIME,
        expiresAt: BASE_TIME + 60_000,
      }),
    ).toBeNull();
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM notifications").get()!.count,
    ).toBe(0);
  });

  test("does not create orphan content when there are no target devices", () => {
    expect(
      enqueueNotification(db, {
        message: message("nobody"),
        deviceIds: [],
        createdAt: BASE_TIME,
        expiresAt: BASE_TIME + 60_000,
      }),
    ).toBeNull();
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM notifications").get()!.count,
    ).toBe(0);
  });
});

/**
 * A phone drains its backlog with up to twenty sequential `/notifications/claim`
 * calls on every foreground, and each one runs three statements against
 * `notification_deliveries` inside a single `priority: "user"` writer
 * transaction. Deliveries are retained for the notification's whole TTL, so on
 * a device with any history the terminal `delivered` / `superseded` / `expired`
 * rows vastly outnumber the actionable ones. `idx_notification_deliveries_claim`
 * carries `state` right after `device_id` precisely so a claim costs what the
 * device still owes rather than everything it has ever been sent — and the
 * gateway never runs `ANALYZE`, so a predicate the planner can only exploit
 * with `sqlite_stat1` present does not reach that column at all.
 */
describe("notification claim query plans", () => {
  function explain(sql: string, params: Array<string | number>): string {
    return db
      .prepare<Array<string | number>, { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => row.detail)
      .join("\n");
  }

  /** One device holding a long terminal history plus a small live backlog. */
  function seedHistory(): DeviceId {
    const device = createDevice(db, { name: "fictional-backlog-phone", kind: "ios" });
    for (let i = 0; i < 40; i += 1) {
      const enqueued = enqueueNotification(db, {
        message: message(`history-${i}`),
        deviceIds: [device.id],
        createdAt: BASE_TIME + i,
        expiresAt: BASE_TIME + 600_000,
      });
      db.prepare("UPDATE notification_deliveries SET state = 'delivered' WHERE id = ?").run(
        enqueued!.deliveryIds[0]!,
      );
    }
    enqueueNotification(db, {
      message: message("live"),
      deviceIds: [device.id],
      createdAt: BASE_TIME + 100,
      expiresAt: BASE_TIME + 600_000,
    });
    return device.id;
  }

  test("all three statements constrain the claim index past device_id", () => {
    const deviceId = seedHistory();

    const plans = {
      candidate: explain(CLAIM_CANDIDATE_SQL, [deviceId, BASE_TIME + 200, BASE_TIME + 200]),
      remaining: explain(PENDING_COUNT_SQL, [deviceId, BASE_TIME + 200, BASE_TIME + 200]),
      expiry: explain(expireDeliveriesSql(true), [BASE_TIME + 200, BASE_TIME + 200, deviceId]),
    };

    for (const [name, plan] of Object.entries(plans)) {
      expect(plan, `${name} walks the device's whole delivery history:\n${plan}`).toContain(
        "idx_notification_deliveries_claim (device_id=? AND state=?",
      );
    }
  });

  test("the narrowed predicate still claims a lapsed lease ahead of a fresh one", () => {
    const deviceId = seedHistory();
    // The live row is claimed, then its lease lapses without a confirmation.
    const first = claimNotification(db, { deviceId, now: BASE_TIME + 200, leaseMs: 1_000 });
    expect(first?.targetId).toBe("brf_live");
    expect(claimNotification(db, { deviceId, now: BASE_TIME + 300 })).toBeNull();

    // Past the lease deadline the same delivery becomes claimable again — and
    // none of the forty terminal rows ever do.
    const again = claimNotification(db, { deviceId, now: BASE_TIME + 2_000 });
    expect(again?.targetId).toBe("brf_live");
    expect(pendingNotificationCount(db, deviceId, BASE_TIME + 2_000)).toBe(0);
  });
});
