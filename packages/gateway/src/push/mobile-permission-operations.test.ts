// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
import { AccountId, SourceType } from "@omnesis/types";
import { createDatabase } from "../db.js";
import { directWriteGate } from "../write-gate.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import {
  agentDeviceRevocationImpacts,
  STALE_DEVICE_REVOCATION_IMPACT_ERROR,
} from "../access/agent-device-authorization.js";
import {
  addSourceMember,
  createSource,
  getSource,
  isSourceCleanupPending,
} from "../data/repositories/SourceRepository.js";
import {
  getMobilePermissionHealth,
  replaceMobilePermissionHealth,
  reserveMobilePermissionReminder,
} from "../data/repositories/MobilePermissionHealthRepository.js";
import { claimNotification, confirmNotification, enqueueNotification } from "./queue.js";
import { collapseId } from "./producers/source-permission.js";
import {
  deleteSourceWithPermissionInvalidation,
  forgetDeviceWithPermissionInvalidation,
  removeSourceWithPermissionInvalidation,
  replaceOwnedMobilePermissionHealth,
  revokeDeviceWithPermissionInvalidation,
  updateSourceWithPermissionInvalidation,
} from "./mobile-permission-operations.js";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const phone = createDevice(db, { name: "Fictional phone", kind: "ios" });
  const source = createSource(db, {
    type: SourceType("fictional-mobile"),
    accountId: AccountId("local"),
    deviceId: phone.id,
  });
  replaceMobilePermissionHealth(db, {
    sourceId: source.id,
    deviceId: phone.id,
    report: {
      checkedAt: 1_000,
      validForMs: 60_000,
      capabilities: [
        {
          id: "background-access",
          label: "Background access",
          state: "background-access-missing",
          requirement: "required",
          impact: "Collection stops.",
          remediation: "Enable background access.",
          repairAction: "open-system-settings",
        },
      ],
    },
    receivedAt: 1_000,
  });
  enqueueNotification(db, {
    message: {
      kind: "source-permission",
      title: "Permission needs attention",
      body: "Restore access.",
      data: { sourceId: source.id, affectedDeviceId: phone.id },
      collapseId: collapseId(source.id, "episode-one", phone.id),
    },
    deviceIds: [phone.id],
    createdAt: 1_000,
    expiresAt: 60_000,
  });
  return { db, phone, source };
}

describe("atomic mobile permission lifecycle invalidation", () => {
  test("fresh recovery clears the episode and revokes its live lease atomically", () => {
    const { db, phone, source } = fixture();
    const lease = claimNotification(db, { deviceId: phone.id, now: 1_001 })!;

    expect(
      replaceOwnedMobilePermissionHealth(db, {
        sourceId: source.id,
        deviceId: phone.id,
        report: {
          checkedAt: 2_000,
          validForMs: 60_000,
          capabilities: [
            {
              id: "background-access",
              label: "Background access",
              state: "healthy",
              requirement: "required",
              impact: "Collection stops.",
              remediation: "Enable background access.",
              repairAction: "none",
            },
          ],
        },
        receivedAt: 2_000,
      }),
    ).toMatchObject({ accepted: true, recovered: true });
    expect(confirmNotification(db, { deviceId: phone.id, deliveryId: lease.id, now: 2_001 })).toBe(
      false,
    );
  });

  test("one member's recovery preserves a sibling member's permission warning", () => {
    const { db, phone, source } = fixture();
    const sibling = createDevice(db, { name: "Fictional sibling phone", kind: "android" });
    expect(addSourceMember(db, source.id, sibling.id)).toBe(true);
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: sibling.id,
      report: {
        checkedAt: 1_000,
        validForMs: 60_000,
        capabilities: [
          {
            id: "background-access",
            label: "Background access",
            state: "background-access-missing",
            requirement: "required",
            impact: "Collection stops.",
            remediation: "Enable background access.",
            repairAction: "open-system-settings",
          },
        ],
      },
      receivedAt: 1_000,
    });
    enqueueNotification(db, {
      message: {
        kind: "source-permission",
        title: "Permission needs attention",
        body: "Restore access on the sibling.",
        data: { sourceId: source.id, affectedDeviceId: sibling.id },
        collapseId: collapseId(source.id, "episode-sibling", sibling.id),
      },
      deviceIds: [phone.id],
      createdAt: 1_001,
      expiresAt: 60_000,
    });

    expect(
      replaceOwnedMobilePermissionHealth(db, {
        sourceId: source.id,
        deviceId: phone.id,
        report: {
          checkedAt: 2_000,
          validForMs: 60_000,
          capabilities: [
            {
              id: "background-access",
              label: "Background access",
              state: "healthy",
              requirement: "required",
              impact: "Collection stops.",
              remediation: "Enable background access.",
              repairAction: "none",
            },
          ],
        },
        receivedAt: 2_000,
      }),
    ).toMatchObject({ accepted: true, recovered: true });

    expect(claimNotification(db, { deviceId: phone.id, now: 2_001 })?.body).toBe(
      "Restore access on the sibling.",
    );
  });

  test("any fresh report atomically supersedes an overdue-report reminder", () => {
    const { db, phone, source } = fixture();
    replaceOwnedMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: phone.id,
      report: {
        checkedAt: 2_000,
        validForMs: 100,
        capabilities: [
          {
            id: "background-access",
            label: "Background access",
            state: "healthy",
            requirement: "required",
            impact: "Collection stops.",
            remediation: "Enable background access.",
            repairAction: "none",
          },
        ],
      },
      receivedAt: 2_000,
    });
    const stale = reserveMobilePermissionReminder(db, source.id, 2_101, {
      initialDelayMs: 1_000,
      multiplier: 2,
      maxDelayMs: 10_000,
      reservationTtlMs: 1_000,
    })!;
    enqueueNotification(db, {
      message: {
        kind: "source-permission",
        title: "Source check overdue",
        body: "Open the app.",
        data: { sourceId: source.id, affectedDeviceId: phone.id },
        collapseId: collapseId(source.id, stale.episodeId),
      },
      deviceIds: [phone.id],
      createdAt: 2_101,
      expiresAt: 60_000,
    });
    const lease = claimNotification(db, { deviceId: phone.id, now: 2_102 })!;

    expect(
      replaceOwnedMobilePermissionHealth(db, {
        sourceId: source.id,
        deviceId: phone.id,
        report: {
          checkedAt: 3_000,
          validForMs: 60_000,
          capabilities: [
            {
              id: "health-data",
              label: "Health data",
              state: "unknown",
              requirement: "required",
              impact: "Some categories may not sync.",
              remediation: "Review access in Settings.",
              repairAction: "none",
            },
          ],
        },
        receivedAt: 3_000,
      }),
    ).toMatchObject({ accepted: true, recovered: true });
    expect(confirmNotification(db, { deviceId: phone.id, deliveryId: lease.id, now: 3_001 })).toBe(
      false,
    );
  });

  test("pause clears health and revokes an already leased delivery", () => {
    const { db, phone, source } = fixture();
    const lease = claimNotification(db, { deviceId: phone.id, now: 1_001 })!;

    updateSourceWithPermissionInvalidation(db, source.id, { enabled: false }, 1_002);

    expect(getMobilePermissionHealth(db, source.id)).toBeNull();
    expect(confirmNotification(db, { deviceId: phone.id, deliveryId: lease.id, now: 1_003 })).toBe(
      false,
    );
  });

  test("rehome and removal atomically supersede pending deliveries", () => {
    const rehome = fixture();
    const other = createDevice(rehome.db, { name: "Fictional other phone", kind: "android" });
    updateSourceWithPermissionInvalidation(
      rehome.db,
      rehome.source.id,
      { deviceId: other.id },
      1_002,
    );
    expect(claimNotification(rehome.db, { deviceId: rehome.phone.id, now: 1_003 })).toBeNull();

    const removal = fixture();
    deleteSourceWithPermissionInvalidation(removal.db, removal.source.id, 1_002);
    expect(claimNotification(removal.db, { deviceId: removal.phone.id, now: 1_003 })).toBeNull();
  });

  test("source removal establishes its tombstone in the row-deletion transaction", () => {
    const { db, source } = fixture();

    expect(removeSourceWithPermissionInvalidation(db, source.id, 1_002)).toEqual({
      source,
      memberDeviceIds: [source.deviceId],
    });

    expect(getSource(db, source.id)).toBeNull();
    expect(isSourceCleanupPending(db, source.id)).toBe(true);
    expect(getMobilePermissionHealth(db, source.id)).toBeNull();
  });

  test("device revocation supersedes deliveries and ends its permission episode", () => {
    const { db, phone, source } = fixture();
    expect(revokeDeviceWithPermissionInvalidation(db, phone.id, 1_002)).toBe(true);
    expect(getMobilePermissionHealth(db, source.id)).toBeNull();
    expect(
      db
        .prepare<
          [],
          { count: number }
        >("SELECT COUNT(*) AS count FROM notification_deliveries WHERE state IN ('pending','leased')")
        .get()!.count,
    ).toBe(0);
  });

  test("device revocation refuses a stale corpus-credential preview", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const agent = createDevice(db, { name: "Fictional lab agent", kind: "agent" });
    db.prepare(
      `INSERT INTO access_principals (id, name, kind, created_at, updated_at)
       VALUES ('principal-lab', 'Fictional assistant', 'interactive', 999, 999)`,
    ).run();
    db.prepare(
      `INSERT INTO access_grants (id, principal_id, name, created_at, updated_at)
       VALUES ('grant-lab', 'principal-lab', 'Reviewed research', 999, 999)`,
    ).run();
    db.prepare(
      `INSERT INTO principal_credentials
         (id, grant_id, oauth_client_id, kind, status, label, execution_device_id, created_at)
       VALUES
         ('credential-lab', 'grant-lab', 'client-lab', 'interactive', 'pending',
          'Lab runtime', ?, 999)`,
    ).run(agent.id);
    const preview = agentDeviceRevocationImpacts(db, 1_000).get(agent.id)!;

    db.prepare("DELETE FROM principal_credentials WHERE id = 'credential-lab'").run();
    db.prepare(
      `INSERT INTO principal_credentials
         (id, grant_id, oauth_client_id, kind, status, label, execution_device_id, created_at)
       VALUES
         ('credential-replacement', 'grant-lab', 'client-lab', 'interactive', 'pending',
          'Lab runtime', ?, 1001)`,
    ).run(agent.id);

    expect(() =>
      revokeDeviceWithPermissionInvalidation(db, agent.id, 1_002, preview.fingerprint),
    ).toThrow(STALE_DEVICE_REVOCATION_IMPACT_ERROR);
    expect(db.prepare("SELECT revoked_at FROM devices WHERE id = ?").get(agent.id)).toEqual({
      revoked_at: null,
    });

    const current = agentDeviceRevocationImpacts(db, 1_002).get(agent.id)!;
    expect(revokeDeviceWithPermissionInvalidation(db, agent.id, 1_003, current.fingerprint)).toBe(
      true,
    );
    expect(
      db
        .prepare("SELECT revoked_at FROM principal_credentials WHERE id = 'credential-replacement'")
        .get(),
    ).toEqual({ revoked_at: expect.any(Number) });
  });

  test("member detach deletes only that member's health and preserves its sibling", async () => {
    const { db, phone, source } = fixture();
    const sibling = createDevice(db, { name: "Fictional sibling phone", kind: "android" });
    expect(addSourceMember(db, source.id, sibling.id)).toBe(true);
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: sibling.id,
      report: { checkedAt: 2_000, validForMs: 60_000, capabilities: [] },
      receivedAt: 2_000,
    });

    await expect(
      directWriteGate(db).removeSourceMember(source.id, phone.id),
    ).resolves.toMatchObject({
      removed: true,
      ownerReassignedTo: sibling.id,
    });
    expect(getMobilePermissionHealth(db, source.id, 2_001, phone.id)).toBeNull();
    expect(getMobilePermissionHealth(db, source.id, 2_001, sibling.id)).not.toBeNull();
  });

  test("forgetting a device is refused while it hosts sources, then deletes once they're gone", () => {
    const { db, phone, source } = fixture();
    // The refusal is decided inside the write transaction, naming the
    // sources that stand in the way.
    expect(forgetDeviceWithPermissionInvalidation(db, phone.id)).toEqual({
      deleted: false,
      reason: "hosts-sources",
      sourceIds: [source.id],
    });
    expect(getMobilePermissionHealth(db, source.id)).not.toBeNull();

    deleteSourceWithPermissionInvalidation(db, source.id, 1_002);
    expect(forgetDeviceWithPermissionInvalidation(db, phone.id)).toEqual({ deleted: true });
    expect(getMobilePermissionHealth(db, source.id)).toBeNull();
    expect(forgetDeviceWithPermissionInvalidation(db, phone.id)).toEqual({
      deleted: false,
      reason: "not-found",
    });
  });
});
