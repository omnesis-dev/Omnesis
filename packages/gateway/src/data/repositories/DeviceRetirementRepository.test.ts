// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AccountId, SourceType } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { forgetDeviceWithPermissionInvalidation } from "../../push/mobile-permission-operations.js";
import { commitReauthReminderNotification } from "../../push/reminder-notification-operations.js";
import { enqueueNotification } from "../../push/queue.js";
import { needsAuthCollapseId } from "../../push/producers/needs-auth.js";
import { collapseId as permissionCollapseId } from "../../push/producers/source-permission.js";
import { createDevice, getDevice, findDeviceByName, listDevices } from "./DeviceRepository.js";
import { createSource, getSource, addSourceMember, listSourceMembers } from "./SourceRepository.js";
import { deviceForgetImpact, sourceArchivedDevices } from "./DeviceRetirementRepository.js";
import { getRecentDocuments } from "./DocumentRepository.js";
import { setSyncError } from "./SyncStateRepository.js";
import { listPendingSourceStreamCleanups } from "./SourceStreamCleanupRepository.js";
import { reserveActiveReauthReminder } from "./ReauthRemindersRepository.js";
import type { MultiDeviceMode } from "@omnesis/types";

let db: ReturnType<typeof createDatabase>;
beforeEach(() => {
  db = createDatabase(":memory:");
});
afterEach(() => db.close());

function fixture(mode: MultiDeviceMode, sibling: boolean) {
  const device = createDevice(db, {
    name: "Retired sample device",
    kind: "collector",
    capabilities: { installId: "fictional-old-install" },
  });
  const other = createDevice(db, { name: "Current sample device", kind: "collector" });
  const source = createSource(db, {
    type: SourceType("fictional-source"),
    accountId: AccountId("local"),
    deviceId: device.id,
    multiDeviceMode: mode,
  });
  if (sibling) expect(addSourceMember(db, source.id, other.id)).toBe(true);
  return { device, other, source };
}

function forget(id: ReturnType<typeof createDevice>["id"], data: "keep" | "delete") {
  const impact = deviceForgetImpact(db, id)!;
  return forgetDeviceWithPermissionInvalidation(db, id, {
    data,
    impactFingerprint: impact.fingerprint,
  });
}

describe("device retirement", () => {
  test.each(["exclusive", "replicated", "handoff", "partitioned"] as const)(
    "keeps a last host's %s source historical and retires pairing identity",
    (mode) => {
      const { device, source } = fixture(mode, false);
      expect(forget(device.id, "keep")).toMatchObject({
        deleted: true,
        removedSourceIds: [],
        streamCleanups: [],
      });
      expect(getSource(db, source.id)).toMatchObject({ deviceId: device.id, enabled: false });
      expect(listSourceMembers(db, source.id)).toEqual([]);
      expect(getDevice(db, device.id)).toBeNull();
      expect(findDeviceByName(db, device.name)).toBeNull();
      expect(listDevices(db).some((row) => row.id === device.id)).toBe(false);
      expect(sourceArchivedDevices(db, source.id)).toEqual([
        {
          deviceId: device.id,
          name: device.name,
          kind: device.kind,
          forgottenAt: expect.any(Number),
        },
      ]);
      const fresh = createDevice(db, {
        name: device.name,
        kind: "collector",
        capabilities: { installId: "fictional-old-install" },
      });
      expect(fresh.id).not.toBe(device.id);
      expect(addSourceMember(db, source.id, device.id)).toBe(false);
      expect(addSourceMember(db, source.id, fresh.id)).toBe(true);
      expect(getSource(db, source.id)).toMatchObject({ deviceId: fresh.id, enabled: true });
      expect(sourceArchivedDevices(db, source.id)[0]?.deviceId).toBe(device.id);
    },
  );

  test.each(["replicated", "handoff", "partitioned"] as const)(
    "keeps historical %s contribution while handing ownership to the sibling",
    (mode) => {
      const { device, other, source } = fixture(mode, true);
      expect(forget(device.id, "keep")).toMatchObject({ deleted: true, streamCleanups: [] });
      expect(getSource(db, source.id)).toMatchObject({ deviceId: other.id, enabled: true });
      expect(listSourceMembers(db, source.id).map((member) => member.deviceId)).toEqual([other.id]);
      expect(listPendingSourceStreamCleanups(db)).toEqual([]);
    },
  );

  test("queues only the forgotten partition for deletion when a sibling remains", () => {
    const { device, other, source } = fixture("partitioned", true);
    expect(deviceForgetImpact(db, device.id)?.sources[0]).toMatchObject({
      otherDeviceCount: 1,
      deleteScope: "partition",
    });
    expect(forget(device.id, "delete")).toMatchObject({
      deleted: true,
      removedSourceIds: [],
      streamCleanups: [{ sourceId: source.id, deviceId: device.id }],
    });
    expect(getSource(db, source.id)?.deviceId).toBe(other.id);
    expect(sourceArchivedDevices(db, source.id)).toEqual([]);
  });

  test("a delete choice never erases shared data held by another device", () => {
    const { device, other, source } = fixture("replicated", true);
    expect(deviceForgetImpact(db, device.id)?.sources[0]?.deleteScope).toBe("none");
    expect(forget(device.id, "delete")).toMatchObject({
      deleted: true,
      removedSourceIds: [],
      streamCleanups: [],
    });
    expect(getSource(db, source.id)?.deviceId).toBe(other.id);
  });

  test("deleting the last host records a durable source cleanup instead of erasing data inline", () => {
    const { device, source } = fixture("exclusive", false);
    expect(forget(device.id, "delete")).toMatchObject({
      deleted: true,
      removedSourceIds: [source.id],
    });
    expect(getSource(db, source.id)).toBeNull();
    expect(
      db.prepare("SELECT cleanup_done_at FROM removed_sources WHERE id = ?").get(source.id),
    ).toEqual({ cleanup_done_at: null });
  });

  test("deleting the last active partition preserves earlier forgotten history", () => {
    const { device, other, source } = fixture("partitioned", true);
    expect(forget(device.id, "keep")).toMatchObject({ deleted: true });
    expect(deviceForgetImpact(db, other.id)?.sources[0]).toMatchObject({
      otherDeviceCount: 0,
      deleteScope: "partition",
    });
    expect(forget(other.id, "delete")).toMatchObject({
      deleted: true,
      removedSourceIds: [],
      streamCleanups: [{ deviceId: other.id }],
    });
    expect(getSource(db, source.id)?.enabled).toBe(false);
    expect(sourceArchivedDevices(db, source.id).map((entry) => entry.deviceId)).toEqual([
      device.id,
    ]);
  });

  test("ordinary source updates do not invalidate the reviewed retention impact", () => {
    const { device, source } = fixture("exclusive", false);
    const before = deviceForgetImpact(db, device.id)!;
    db.prepare("UPDATE sources SET updated_at = updated_at + 1000 WHERE id = ?").run(source.id);
    expect(deviceForgetImpact(db, device.id)?.fingerprint).toBe(before.fingerprint);
    expect(
      forgetDeviceWithPermissionInvalidation(db, device.id, {
        data: "keep",
        impactFingerprint: before.fingerprint,
      }),
    ).toMatchObject({ deleted: true });
  });

  test.each([false, true])(
    "forgetting an agent ends linked corpus credentials (source host: %s)",
    (hostsSource) => {
      const device = createDevice(db, { name: "Fictional research agent", kind: "agent" });
      db.prepare(
        "INSERT INTO access_principals (id, name, kind, created_at, updated_at) VALUES ('principal-example', 'Example assistant', 'interactive', 1, 1)",
      ).run();
      db.prepare(
        "INSERT INTO access_grants (id, principal_id, name, created_at, updated_at) VALUES ('grant-example', 'principal-example', 'Example research', 1, 1)",
      ).run();
      db.prepare(
        "INSERT INTO principal_credentials (id, grant_id, oauth_client_id, kind, status, label, execution_device_id, created_at) VALUES ('credential-example', 'grant-example', 'client-example', 'interactive', 'pending', 'Example runtime', ?, 1)",
      ).run(device.id);
      if (hostsSource)
        createSource(db, {
          type: SourceType("fictional-agent-source"),
          accountId: AccountId("local"),
          deviceId: device.id,
        });
      const impact = deviceForgetImpact(db, device.id)!;
      db.prepare(
        "UPDATE principal_credentials SET label = 'Changed runtime' WHERE id = 'credential-example'",
      ).run();
      expect(
        forgetDeviceWithPermissionInvalidation(db, device.id, {
          data: "keep",
          impactFingerprint: impact.fingerprint,
        }),
      ).toEqual({ deleted: false, reason: "impact-changed" });
      expect(getDevice(db, device.id)?.revokedAt).toBeNull();
      expect(forget(device.id, "keep")).toMatchObject({ deleted: true });
      const credential = db
        .prepare("SELECT revoked_at FROM principal_credentials WHERE id = 'credential-example'")
        .get();
      if (hostsSource) expect(credential).toEqual({ revoked_at: expect.any(Number) });
      else expect(credential).toBeUndefined();
    },
  );

  test.each(["retiring", "sibling", "legacy"] as const)(
    "retiring a non-owner handoff member handles %s shared errors and fences late reports",
    (reportedBy) => {
      const { device: sibling, other: retiring, source } = fixture("handoff", true);
      const reporter =
        reportedBy === "retiring" ? retiring.id : reportedBy === "sibling" ? sibling.id : undefined;
      setSyncError(db, source.id, "Source access failed", "", undefined, reporter);
      expect(forget(retiring.id, "keep")).toMatchObject({ deleted: true });
      const errorAfterRetirement = reportedBy === "sibling" ? "Source access failed" : null;
      expect(
        db
          .prepare("SELECT last_error FROM sync_state WHERE source_id = ? AND device_id = ''")
          .get(source.id),
      ).toEqual({ last_error: errorAfterRetirement });
      setSyncError(db, source.id, "A late retired report", "", undefined, retiring.id);
      expect(
        db
          .prepare("SELECT last_error FROM sync_state WHERE source_id = ? AND device_id = ''")
          .get(source.id),
      ).toEqual({ last_error: errorAfterRetirement });
      setSyncError(db, source.id, "Current sibling failure", "", undefined, sibling.id);
      expect(
        db
          .prepare("SELECT last_error FROM sync_state WHERE source_id = ? AND device_id = ''")
          .get(source.id),
      ).toEqual({ last_error: "Current sibling failure" });
    },
  );

  test("late re-auth reservations and retained auth/permission reminders cannot outlive their origin", () => {
    const { device, other, source } = fixture("replicated", true);
    const recipient = createDevice(db, { name: "Fictional notification phone", kind: "ios" });
    const principal = "fictional-provider:account@example.com";
    const reserve = (id: typeof device.id, now: number) =>
      reserveActiveReauthReminder(db, principal, id, now, 1000, () => true, source.id);
    const notify = (id: typeof device.id, token: string, now: number) =>
      commitReauthReminderNotification(db, token, now, {
        message: {
          kind: "needs-auth",
          title: "Sign in again",
          body: "Restore the fictional source sign-in.",
          data: { sourceId: source.id, providerId: principal },
          collapseId: needsAuthCollapseId(principal, id),
        },
        deviceIds: [recipient.id],
        createdAt: now,
        expiresAt: now + 10000,
      });
    const originReservation = reserve(device.id, 1)!;
    expect(notify(device.id, originReservation, 2)).not.toBeNull();
    const siblingReservation = reserve(other.id, 3)!;
    expect(notify(other.id, siblingReservation, 4)).not.toBeNull();
    enqueueNotification(db, {
      message: {
        kind: "source-permission",
        title: "Permission needs attention",
        body: "Restore fictional source access.",
        data: { sourceId: source.id, affectedDeviceId: device.id },
        collapseId: permissionCollapseId(source.id, "fictional-permission-episode", device.id),
      },
      deviceIds: [recipient.id],
      createdAt: 5,
      expiresAt: 10000,
    });
    // A second render may already hold a reservation when the owner forgets it.
    const delayed = reserve(device.id, 6)!;
    expect(delayed).not.toBeNull();
    expect(forget(device.id, "keep")).toMatchObject({ deleted: true });
    expect(reserve(device.id, 7)).toBeNull();
    expect(notify(device.id, delayed, 8)).toBeNull();
    const deliveries = db
      .prepare<[], { collapse_id: string; state: string }>(
        "SELECT n.collapse_id, d.state FROM notifications n JOIN notification_deliveries d ON d.notification_id = n.id ORDER BY n.created_at",
      )
      .all();
    expect(deliveries).toEqual([
      { collapse_id: needsAuthCollapseId(principal, device.id), state: "superseded" },
      { collapse_id: needsAuthCollapseId(principal, other.id), state: "pending" },
      {
        collapse_id: permissionCollapseId(source.id, "fictional-permission-episode", device.id),
        state: "superseded",
      },
    ]);
  });

  test("recent retained documents preserve their original device label", () => {
    const { device, source } = fixture("partitioned", false);
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, title, content, content_hash, source_created_at, source_updated_at, ingested_at, updated_at)
      VALUES ('fictional-document', 'fictional-provider', ?, 'fictional-item', ?, 'Example note', 'An invented note.', 'fictional-hash', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(source.id, device.id);
    expect(getRecentDocuments(db, source.id)[0]?.device_name).toBe(device.name);
    expect(forget(device.id, "keep")).toMatchObject({ deleted: true });
    expect(getRecentDocuments(db, source.id)[0]).toMatchObject({
      device_id: device.id,
      device_name: device.name,
      title: "Example note",
    });
    expect(getDevice(db, device.id)).toBeNull();
  });

  test("a changed impact refuses before revoking or detaching anything", () => {
    const { device, other, source } = fixture("partitioned", false);
    const impact = deviceForgetImpact(db, device.id)!;
    addSourceMember(db, source.id, other.id);
    expect(
      forgetDeviceWithPermissionInvalidation(db, device.id, {
        data: "delete",
        impactFingerprint: impact.fingerprint,
      }),
    ).toEqual({ deleted: false, reason: "impact-changed" });
    expect(getDevice(db, device.id)?.revokedAt).toBeNull();
    expect(listSourceMembers(db, source.id)).toHaveLength(2);
    expect(getSource(db, source.id)?.enabled).toBe(true);
  });
});
