// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  SourceId,
  makeSourceId,
  type AccountId,
  type DeviceId,
  type SourceType,
} from "@omnesis/types";
import { getDevice, deleteDevice, revokeDevice } from "../data/repositories/DeviceRepository.js";
import {
  clearSourceRemoved,
  createSource,
  deleteSource,
  getSource,
  isSourceCleanupPending,
  isSourceMember,
  listSourceMembers,
  markSourceRemoved,
  removeSourceMember,
  updateSource,
  type RemoveSourceMemberResult,
  type SourceRecord,
} from "../data/repositories/SourceRepository.js";
import {
  deleteMobilePermissionHealth,
  deleteMobilePermissionHealthForDevice,
  replaceMobilePermissionHealth,
} from "../data/repositories/MobilePermissionHealthRepository.js";
import {
  enqueueSourceStreamCleanup,
  isSourceStreamCleanupPending,
  type SourceStreamCleanupJob,
} from "../data/repositories/SourceStreamCleanupRepository.js";
import { initializeOrAssertSourceMemberConfigContractForDevice } from "../data/repositories/SourceMemberConfigContractRepository.js";
import {
  agentDeviceRevocationImpact,
  STALE_DEVICE_REVOCATION_IMPACT_ERROR,
} from "../access/agent-device-authorization.js";
import { supersedeDeliveriesForDevice, supersedeNotificationsByCollapseIdPrefix } from "./queue.js";
import {
  collapsePrefix,
  memberCollapsePrefix,
  staleCollapsePrefix,
} from "./producers/source-permission.js";
import type {
  MobilePermissionHealth,
  MobilePermissionHealthReport,
} from "@omnesis/types/mobile-permission-health";
import type { Db } from "../data/types.js";

export type OwnedPermissionHealthResult =
  | {
      rejection:
        | "source-not-found"
        | "source-paused"
        | "wrong-device"
        | "not-phone"
        | "report-expired";
    }
  | {
      accepted: boolean;
      recovered: boolean;
      health: MobilePermissionHealth;
    };

export function replaceOwnedMobilePermissionHealth(
  db: Db,
  input: {
    sourceId: SourceId;
    deviceId: DeviceId;
    report: MobilePermissionHealthReport;
    receivedAt: number;
  },
): OwnedPermissionHealthResult {
  return db
    .transaction(() => {
      const source = getSource(db, input.sourceId);
      if (!source) return { rejection: "source-not-found" } as const;
      if (!source.enabled) return { rejection: "source-paused" } as const;
      const device = getDevice(db, input.deviceId);
      if (!isSourceMember(db, input.sourceId, input.deviceId) || device?.revokedAt != null)
        return { rejection: "wrong-device" } as const;
      if (!device || (device.kind !== "ios" && device.kind !== "android"))
        return { rejection: "not-phone" } as const;
      const validUntil = input.report.checkedAt + input.report.validForMs;
      if (!Number.isSafeInteger(validUntil) || validUntil <= input.receivedAt)
        return { rejection: "report-expired" } as const;
      const result = replaceMobilePermissionHealth(db, input);
      if (result.accepted && result.recoveredKnown) {
        supersedeNotificationsByCollapseIdPrefix(
          db,
          memberCollapsePrefix(input.sourceId, input.deviceId),
          input.receivedAt,
        );
      }
      if (result.accepted && result.recoveredStale) {
        supersedeNotificationsByCollapseIdPrefix(
          db,
          staleCollapsePrefix(input.sourceId),
          input.receivedAt,
        );
      }
      return result;
    })
    .immediate();
}

export function removeSourceMemberWithPermissionInvalidation(
  db: Db,
  sourceId: SourceId,
  deviceId: DeviceId,
  now = Date.now(),
): RemoveSourceMemberResult {
  return db
    .transaction(() => {
      const result = removeSourceMember(db, sourceId, deviceId);
      if (!result.removed) return result;
      deleteMobilePermissionHealth(db, sourceId, deviceId);
      supersedeNotificationsByCollapseIdPrefix(db, memberCollapsePrefix(sourceId, deviceId), now);
      supersedeNotificationsByCollapseIdPrefix(db, staleCollapsePrefix(sourceId), now);
      return result;
    })
    .immediate();
}

export function invalidateMobilePermissionHealth(db: Db, sourceId: SourceId, now: number): boolean {
  return db
    .transaction(() => {
      const deleted = deleteMobilePermissionHealth(db, sourceId);
      supersedeNotificationsByCollapseIdPrefix(db, collapsePrefix(sourceId), now);
      return deleted;
    })
    .immediate();
}

export function updateSourceWithPermissionInvalidation(
  db: Db,
  id: SourceId,
  patch: { config?: Record<string, unknown>; enabled?: boolean; deviceId?: DeviceId },
  now = Date.now(),
): SourceRecord | null {
  return moveSourceWithPermissionInvalidation(db, id, patch, now)?.record ?? null;
}

/**
 * Same write as `updateSourceWithPermissionInvalidation`, additionally
 * returning the owner and displaced membership read inside the transaction.
 * A deviceId patch is a re-home, and its caller must notify every device that
 * actually lost the source — a pre-write read can go stale under concurrent
 * membership changes, so the displaced set has to come out of the same
 * transaction as the update.
 *
 * `expectDeviceId` makes the write conditional on ownership: when set and
 * the row belongs to a different device at write time, nothing is written
 * and the untouched record comes back with its actual owner — the caller
 * detects the mismatch via `previousDeviceId` and rejects. This is how a
 * collector's own-source update stays atomic against a concurrent re-home.
 */
export function moveSourceWithPermissionInvalidation(
  db: Db,
  id: SourceId,
  patch: {
    config?: Record<string, unknown>;
    memberConfigOverride?: Record<string, unknown>;
    enabled?: boolean;
    deviceId?: DeviceId;
    expectDeviceId?: DeviceId;
    memberScopedParams?: readonly string[];
  },
  now = Date.now(),
): {
  record: SourceRecord;
  previousDeviceId: DeviceId;
  displacedDeviceIds: DeviceId[];
  streamCleanups: SourceStreamCleanupJob[];
} | null {
  const { expectDeviceId, memberScopedParams, ...fields } = patch;
  return db
    .transaction(() => {
      const before = getSource(db, id);
      if (!before) return null;
      if (expectDeviceId !== undefined && before.deviceId !== expectDeviceId) {
        return {
          record: before,
          previousDeviceId: before.deviceId,
          displacedDeviceIds: [],
          streamCleanups: [],
        };
      }
      if (memberScopedParams !== undefined) {
        const targetDeviceId = fields.deviceId ?? before.deviceId;
        initializeOrAssertSourceMemberConfigContractForDevice(
          db,
          id,
          before.type,
          before.deviceId,
          memberScopedParams,
        );
        initializeOrAssertSourceMemberConfigContractForDevice(
          db,
          id,
          before.type,
          targetDeviceId,
          memberScopedParams,
        );
      }
      if (
        fields.deviceId !== undefined &&
        fields.deviceId !== before.deviceId &&
        isSourceStreamCleanupPending(db, id, fields.deviceId)
      ) {
        return null;
      }
      const displacedDeviceIds =
        fields.deviceId !== undefined && fields.deviceId !== before.deviceId
          ? listSourceMembers(db, id)
              .map((member) => member.deviceId)
              .filter((deviceId) => deviceId !== fields.deviceId)
          : [];
      const updated = updateSource(db, id, fields);
      if (!updated) return null;
      if (updated.enabled === false || updated.deviceId !== before.deviceId)
        invalidateMobilePermissionHealth(db, id, now);
      const streamCleanups =
        before.multiDeviceMode === "partitioned"
          ? displacedDeviceIds.map((deviceId) => enqueueSourceStreamCleanup(db, id, deviceId, now))
          : [];
      return {
        record: updated,
        previousDeviceId: before.deviceId,
        displacedDeviceIds,
        streamCleanups,
      };
    })
    .immediate();
}

export function createSourceWithPermissionInvalidation(
  db: Db,
  opts: {
    type: SourceType;
    accountId: AccountId;
    deviceId: DeviceId;
    config?: Record<string, unknown>;
    memberConfigOverride?: Record<string, unknown>;
    memberScopedParams?: readonly string[];
    enabled?: boolean;
    multiDeviceMode?: import("@omnesis/types").MultiDeviceMode;
  },
  now = Date.now(),
): SourceRecord | null {
  return db
    .transaction(() => {
      const id = makeSourceId(opts.type, opts.accountId);
      if (isSourceCleanupPending(db, id)) return null;
      if (isSourceStreamCleanupPending(db, id, opts.deviceId)) return null;
      const before = getSource(db, id);
      // createSource is create-or-get: an existing row comes back unchanged
      // (ownership never moves on create), so only its disabled state can
      // make the current permission health invalid here.
      const source = createSource(db, opts);
      clearSourceRemoved(db, id);
      if (source && before && source.enabled === false)
        invalidateMobilePermissionHealth(db, source.id, now);
      return source;
    })
    .immediate();
}

export interface RemovedSource {
  source: SourceRecord;
  memberDeviceIds: DeviceId[];
}

export function removeSourceWithPermissionInvalidation(
  db: Db,
  id: SourceId,
  now = Date.now(),
): RemovedSource | null {
  return db
    .transaction(() => {
      const source = getSource(db, id);
      if (!source) return null;
      // Membership capture and cascade share the writer transaction: a join
      // either belongs to this cohort or encounters the removal tombstone.
      const memberDeviceIds = [
        ...new Set([source.deviceId, ...listSourceMembers(db, id).map((m) => m.deviceId)]),
      ];
      const deleted = deleteSource(db, id);
      if (deleted) {
        markSourceRemoved(db, id, { cleanupPending: true });
        invalidateMobilePermissionHealth(db, id, now);
      }
      return deleted ? { source, memberDeviceIds } : null;
    })
    .immediate();
}

export function deleteSourceWithPermissionInvalidation(
  db: Db,
  id: SourceId,
  now = Date.now(),
): boolean {
  return db
    .transaction(() => {
      const deleted = deleteSource(db, id);
      if (deleted) invalidateMobilePermissionHealth(db, id, now);
      return deleted;
    })
    .immediate();
}

/**
 * Revoke a device (the default unpair): its tokens and push registrations
 * are invalidated; the row and every source stay. Its sources go dormant
 * until the same device pairs again (adopting the row) or the operator
 * moves them. Every delivery still owed to the device is
 * superseded — nothing can reach it anymore — and the standing permission
 * notifications for its sources are cancelled for every device, since a
 * revoked device can't repair anything they ask for.
 * Its member-local permission snapshots are deleted as well, ending stale
 * episodes instead of resurrecting reminders about an intentionally unpaired
 * phone. A later re-pair starts from a fresh report.
 */
export function revokeDeviceWithPermissionInvalidation(
  db: Db,
  id: DeviceId,
  now = Date.now(),
  expectedImpactFingerprint?: string,
): boolean {
  return db
    .transaction(() => {
      if (expectedImpactFingerprint !== undefined) {
        const currentImpact = agentDeviceRevocationImpact(db, id, now);
        if (!currentImpact || currentImpact.fingerprint !== expectedImpactFingerprint) {
          throw new Error(STALE_DEVICE_REVOCATION_IMPACT_ERROR);
        }
      }
      // Owned and joined alike: a revoked member can't repair anything a
      // permission notification for those sources would ask of it.
      const sourceIds = db
        .prepare<[string, string], { id: string }>(
          `SELECT id FROM sources WHERE device_id = ?
           UNION
           SELECT source_id AS id FROM source_devices WHERE device_id = ?`,
        )
        .all(id, id)
        .map((row) => SourceId(row.id));
      const revoked = revokeDevice(db, id);
      if (!revoked) return false;
      supersedeDeliveriesForDevice(db, id);
      const healthSourceIds = deleteMobilePermissionHealthForDevice(db, id);
      for (const sourceId of new Set([...sourceIds, ...healthSourceIds])) {
        supersedeNotificationsByCollapseIdPrefix(db, memberCollapsePrefix(sourceId, id), now);
        supersedeNotificationsByCollapseIdPrefix(db, staleCollapsePrefix(sourceId), now);
      }
      return true;
    })
    .immediate();
}

/** Outcome of a hard device delete, decided inside the write transaction. */
export type DeleteDeviceResult =
  | { deleted: true }
  | { deleted: false; reason: "not-found" }
  | { deleted: false; reason: "hosts-sources"; sourceIds: SourceId[] };

/**
 * Hard-delete a device ("forget"). Refuses — atomically with the check —
 * while any source still points at the device, so removing a device can
 * never take a corpus with it; the caller surfaces the hosted ids. A
 * device with no sources has no live memberships either (membership
 * mirrors the owning device), but stale rows are swept regardless so the
 * FK on source_devices can't block the delete.
 */
export function forgetDeviceWithPermissionInvalidation(db: Db, id: DeviceId): DeleteDeviceResult {
  return db
    .transaction((): DeleteDeviceResult => {
      // Ownership and membership both count: a device that is a member of
      // a source it doesn't own (multi-member modes) blocks the delete too.
      const hosted = db
        .prepare<[string, string], { id: string }>(
          `SELECT id FROM sources WHERE device_id = ?
           UNION
           SELECT source_id AS id FROM source_devices WHERE device_id = ?`,
        )
        .all(id, id)
        .map((row) => SourceId(row.id));
      if (hosted.length > 0) return { deleted: false, reason: "hosts-sources", sourceIds: hosted };
      supersedeDeliveriesForDevice(db, id);
      const deleted = deleteDevice(db, id);
      if (!deleted) return { deleted: false, reason: "not-found" };
      return { deleted: true };
    })
    .immediate();
}
