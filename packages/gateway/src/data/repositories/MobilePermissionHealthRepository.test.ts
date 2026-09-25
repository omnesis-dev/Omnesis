// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
import { AccountId, SourceType } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createDevice } from "./DeviceRepository.js";
import { addSourceMember, createSource } from "./SourceRepository.js";
import {
  commitMobilePermissionReminder,
  getMobilePermissionHealth,
  replaceMobilePermissionHealth,
  reserveMobilePermissionReminder,
} from "./MobilePermissionHealthRepository.js";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const device = createDevice(db, { name: "Fictional phone", kind: "ios" });
  const source = createSource(db, {
    type: SourceType("fictional-mobile"),
    accountId: AccountId("local"),
    deviceId: device.id,
  });
  return { db, device, source };
}

const capability = {
  id: "background-access",
  label: "Background access",
  state: "background-access-missing" as const,
  requirement: "required" as const,
  impact: "New records stop while the app is closed.",
  remediation: "Restore background access in system Settings.",
  repairAction: "open-system-settings" as const,
};

describe("mobile permission health persistence", () => {
  test("replaces a complete snapshot and derives overdue as unknown", () => {
    const { db, device, source } = fixture();
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: { checkedAt: 1_000, validForMs: 60_000, capabilities: [capability] },
      receivedAt: 2_000,
    });
    expect(getMobilePermissionHealth(db, source.id, 2_001)?.health.state).toBe(
      "background-access-missing",
    );
    const overdue = getMobilePermissionHealth(db, source.id, 62_001)!.health;
    expect(overdue).toMatchObject({ state: "unknown", reportStale: true });
  });

  test("anchors report expiry to the phone observation time", () => {
    const { db, device, source } = fixture();
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: { checkedAt: 1_000, validForMs: 60_000, capabilities: [] },
      receivedAt: 20_000,
    });

    expect(getMobilePermissionHealth(db, source.id, 60_999)?.health.reportStale).toBe(false);
    expect(getMobilePermissionHealth(db, source.id, 61_000)?.health.reportStale).toBe(true);
    expect(
      db
        .prepare<
          [string],
          { validity_anchored: number }
        >("SELECT validity_anchored FROM mobile_permission_health WHERE source_id = ?")
        .get(source.id),
    ).toEqual({ validity_anchored: 1 });

    db.prepare("UPDATE mobile_permission_health SET validity_anchored = 0 WHERE source_id = ?").run(
      source.id,
    );
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: { checkedAt: 2_000, validForMs: 60_000, capabilities: [] },
      receivedAt: 20_001,
    });
    expect(
      db
        .prepare<
          [string],
          { validity_anchored: number }
        >("SELECT validity_anchored FROM mobile_permission_health WHERE source_id = ?")
        .get(source.id),
    ).toEqual({ validity_anchored: 1 });
  });

  test("rejects older and equal observations deterministically", () => {
    const { db, device, source } = fixture();
    const first = replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: { checkedAt: 2_000, validForMs: 60_000, capabilities: [capability] },
      receivedAt: 2_000,
    });
    expect(first.accepted).toBe(true);
    for (const checkedAt of [1_999, 2_000]) {
      expect(
        replaceMobilePermissionHealth(db, {
          sourceId: source.id,
          deviceId: device.id,
          report: { checkedAt, validForMs: 60_000, capabilities: [] },
          receivedAt: 3_000,
        }).accepted,
      ).toBe(false);
    }
    expect(getMobilePermissionHealth(db, source.id, 3_000)?.health.reportedState).toBe(
      "background-access-missing",
    );
  });

  test("keeps independent snapshots and monotonic clocks for each member device", () => {
    const { db, device, source } = fixture();
    const other = createDevice(db, { name: "Fictional second phone", kind: "android" });
    expect(addSourceMember(db, source.id, other.id)).toBe(true);

    expect(
      replaceMobilePermissionHealth(db, {
        sourceId: source.id,
        deviceId: device.id,
        report: { checkedAt: 10_000, validForMs: 60_000, capabilities: [capability] },
        receivedAt: 10_000,
      }).accepted,
    ).toBe(true);
    expect(
      replaceMobilePermissionHealth(db, {
        sourceId: source.id,
        deviceId: other.id,
        report: { checkedAt: 1_000, validForMs: 60_000, capabilities: [] },
        receivedAt: 10_001,
      }).accepted,
    ).toBe(true);

    const rows = db
      .prepare<
        [string],
        { device_id: string; checked_at: number }
      >("SELECT device_id, checked_at FROM mobile_permission_health WHERE source_id = ? ORDER BY device_id")
      .all(source.id);
    expect(rows).toEqual(
      [
        { device_id: device.id, checked_at: 10_000 },
        { device_id: other.id, checked_at: 1_000 },
      ].sort((a, b) => a.device_id.localeCompare(b.device_id)),
    );
  });

  test("does not declare the source overdue while any member report is fresh", () => {
    const { db, device, source } = fixture();
    const other = createDevice(db, { name: "Fictional second phone", kind: "android" });
    expect(addSourceMember(db, source.id, other.id)).toBe(true);
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: { checkedAt: 1_000, validForMs: 100, capabilities: [] },
      receivedAt: 1_000,
    });
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: other.id,
      report: { checkedAt: 1_000, validForMs: 1_000, capabilities: [] },
      receivedAt: 1_000,
    });
    const cfg = {
      initialDelayMs: 10,
      multiplier: 1,
      maxDelayMs: 10,
      reservationTtlMs: 5,
    };
    expect(reserveMobilePermissionReminder(db, source.id, 1_101, cfg)).toBeNull();
    expect(reserveMobilePermissionReminder(db, source.id, 2_001, cfg)).toMatchObject({
      scope: "source-stale",
    });
  });

  test("reserves once, commits only after delivery, and recovery resets the episode", () => {
    const { db, device, source } = fixture();
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: { checkedAt: 1_000, validForMs: 60_000, capabilities: [capability] },
      receivedAt: 1_000,
    });
    const cfg = {
      initialDelayMs: 10_000,
      multiplier: 2,
      maxDelayMs: 100_000,
      reservationTtlMs: 5_000,
    };
    const reservation = reserveMobilePermissionReminder(db, source.id, 1_001, cfg)!;
    expect(reserveMobilePermissionReminder(db, source.id, 1_001, cfg)).toBeNull();
    expect(
      commitMobilePermissionReminder(db, reservation.token, reservation.episodeId, 1_002),
    ).toBe(true);
    expect(reserveMobilePermissionReminder(db, source.id, 2_000, cfg)).toBeNull();
    const recovery = replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: {
        checkedAt: 2_000,
        validForMs: 60_000,
        capabilities: [{ ...capability, state: "healthy" }],
      },
      receivedAt: 2_000,
    });
    expect(recovery.recovered).toBe(true);
    expect(recovery.health.state).toBe("healthy");
  });

  test("preserves an in-flight reservation across same-episode heartbeats", () => {
    const { db, device, source } = fixture();
    const cfg = {
      initialDelayMs: 10_000,
      multiplier: 2,
      maxDelayMs: 100_000,
      reservationTtlMs: 5_000,
    };
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: { checkedAt: 1_000, validForMs: 60_000, capabilities: [capability] },
      receivedAt: 1_000,
    });
    const reservation = reserveMobilePermissionReminder(db, source.id, 1_001, cfg)!;
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: { checkedAt: 1_100, validForMs: 60_000, capabilities: [capability] },
      receivedAt: 1_100,
    });

    expect(reserveMobilePermissionReminder(db, source.id, 1_101, cfg)).toBeNull();
    expect(
      commitMobilePermissionReminder(db, reservation.token, reservation.episodeId, 1_102),
    ).toBe(true);
  });

  test("unknown preserves an actionable episode until every capability is explicitly healthy", () => {
    const { db, device, source } = fixture();
    const cfg = {
      initialDelayMs: 10_000,
      multiplier: 2,
      maxDelayMs: 100_000,
      reservationTtlMs: 5_000,
    };
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: { checkedAt: 1_000, validForMs: 60_000, capabilities: [capability] },
      receivedAt: 1_000,
    });
    const reservation = reserveMobilePermissionReminder(db, source.id, 1_001, cfg)!;
    expect(
      commitMobilePermissionReminder(db, reservation.token, reservation.episodeId, 1_002),
    ).toBe(true);

    const unknown = replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: {
        checkedAt: 2_000,
        validForMs: 60_000,
        capabilities: [
          { ...capability, id: "opaque-read-access", state: "unknown", repairAction: "none" },
          { ...capability, id: "foreground-access", state: "healthy" },
        ],
      },
      receivedAt: 2_000,
    });
    expect(unknown).toMatchObject({ recovered: false, health: { state: "unknown" } });
    expect(reserveMobilePermissionReminder(db, source.id, 11_002, cfg)).toBeNull();

    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: { checkedAt: 2_500, validForMs: 60_000, capabilities: [capability] },
      receivedAt: 11_003,
    });
    expect(reserveMobilePermissionReminder(db, source.id, 11_003, cfg)?.episodeId).toBe(
      reservation.episodeId,
    );

    const healthy = replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: {
        checkedAt: 3_000,
        validForMs: 60_000,
        capabilities: [{ ...capability, state: "healthy" }],
      },
      receivedAt: 12_000,
    });
    expect(healthy).toMatchObject({ recovered: true, health: { state: "healthy" } });
  });

  test("a standalone unknown snapshot does not start a reminder episode", () => {
    const { db, device, source } = fixture();
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: {
        checkedAt: 1_000,
        validForMs: 60_000,
        capabilities: [{ ...capability, state: "unknown", repairAction: "none" }],
      },
      receivedAt: 1_000,
    });
    expect(
      reserveMobilePermissionReminder(db, source.id, 1_001, {
        initialDelayMs: 10_000,
        multiplier: 2,
        maxDelayMs: 100_000,
        reservationTtlMs: 5_000,
      }),
    ).toBeNull();
  });

  test("repairs the known driver even when an unrelated capability remains unknown", () => {
    const { db, device, source } = fixture();
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: { checkedAt: 1_000, validForMs: 60_000, capabilities: [capability] },
      receivedAt: 1_000,
    });
    const result = replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: {
        checkedAt: 2_000,
        validForMs: 60_000,
        capabilities: [
          { ...capability, state: "healthy" },
          { ...capability, id: "health-data", state: "unknown", repairAction: "none" },
        ],
      },
      receivedAt: 2_000,
    });
    expect(result).toMatchObject({ recovered: true, health: { state: "unknown" } });
  });

  test("a fresh snapshot resolves a stale-report episode regardless of its aggregate", () => {
    const { db, device, source } = fixture();
    const cfg = {
      initialDelayMs: 10_000,
      multiplier: 2,
      maxDelayMs: 100_000,
      reservationTtlMs: 5_000,
    };
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: { checkedAt: 1_000, validForMs: 100, capabilities: [] },
      receivedAt: 1_000,
    });
    const stale = reserveMobilePermissionReminder(db, source.id, 1_101, cfg)!;
    expect(stale).not.toBeNull();
    const fresh = replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: {
        checkedAt: 2_000,
        validForMs: 60_000,
        capabilities: [{ ...capability, state: "unknown", repairAction: "none" }],
      },
      receivedAt: 2_000,
    });
    expect(fresh).toMatchObject({ recovered: true, health: { state: "unknown" } });
    expect(reserveMobilePermissionReminder(db, source.id, 2_001, cfg)).toBeNull();
  });

  test("stops an overdue episode after its configured reminder budget", () => {
    const { db, device, source } = fixture();
    const cfg = {
      initialDelayMs: 10,
      multiplier: 1,
      maxDelayMs: 10,
      reservationTtlMs: 5,
      maxStaleNotifications: 2,
    };
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: { checkedAt: 1_000, validForMs: 100, capabilities: [] },
      receivedAt: 1_000,
    });

    const first = reserveMobilePermissionReminder(db, source.id, 1_101, cfg)!;
    expect(commitMobilePermissionReminder(db, first.token, first.episodeId, 1_102)).toBe(true);
    const second = reserveMobilePermissionReminder(db, source.id, 1_112, cfg)!;
    expect(commitMobilePermissionReminder(db, second.token, second.episodeId, 1_113)).toBe(true);
    expect(reserveMobilePermissionReminder(db, source.id, 100_000, cfg)).toBeNull();
  });

  test("does not apply the stale reminder budget to a known permission-loss episode", () => {
    const { db, device, source } = fixture();
    const cfg = {
      initialDelayMs: 10,
      multiplier: 1,
      maxDelayMs: 10,
      reservationTtlMs: 5,
      maxStaleNotifications: 1,
    };
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: {
        checkedAt: 1_000,
        validForMs: 100,
        capabilities: [{ ...capability, state: "permission-degraded" }],
      },
      receivedAt: 1_000,
    });

    const first = reserveMobilePermissionReminder(db, source.id, 1_001, cfg)!;
    expect(first.scope).toBe("member");
    expect(commitMobilePermissionReminder(db, first.token, first.episodeId, 1_002)).toBe(true);

    const afterExpiry = reserveMobilePermissionReminder(db, source.id, 1_111, cfg)!;
    expect(afterExpiry).toMatchObject({ scope: "member", episodeId: first.episodeId });
  });

  test("an overdue healthy member cannot starve a sibling's known permission loss", () => {
    const { db, device, source } = fixture();
    const sibling = createDevice(db, { name: "Second fictional phone", kind: "ios" });
    addSourceMember(db, source.id, sibling.id);
    const cfg = {
      initialDelayMs: 10,
      multiplier: 1,
      maxDelayMs: 10,
      reservationTtlMs: 5,
      maxStaleNotifications: 1,
    };
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: device.id,
      report: { checkedAt: 900, validForMs: 100, capabilities: [] },
      receivedAt: 900,
    });
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: sibling.id,
      report: {
        checkedAt: 1_000,
        validForMs: 100,
        capabilities: [{ ...capability, state: "permission-degraded" }],
      },
      receivedAt: 1_000,
    });

    const known = reserveMobilePermissionReminder(db, source.id, 1_101, cfg)!;
    expect(known).toMatchObject({ deviceId: sibling.id, scope: "member" });
    expect(commitMobilePermissionReminder(db, known.token, known.episodeId, 1_102)).toBe(true);
    const again = reserveMobilePermissionReminder(db, source.id, 1_112, cfg)!;
    expect(again).toMatchObject({ deviceId: sibling.id, scope: "member" });
  });
});
