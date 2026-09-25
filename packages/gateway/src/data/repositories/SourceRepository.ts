// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import {
  AccountId,
  DeviceId,
  makeSourceId,
  SourceId,
  SourceType,
  hasPerDeviceCursor,
  type MultiDeviceMode,
} from "@omnesis/types";
import { sourceDeviceConfigOverrideCodec, sourcesConfigCodec } from "../json-columns.js";
import { pruneSourceFamilyMeta } from "./SourceFamilyMetaRepository.js";
import { setSourceAccount } from "./SourceAccountRepository.js";
import {
  deviceSupportsPersistedSourceContract,
  initializeOrAssertSourceMemberConfigContractForDevice,
} from "./SourceMemberConfigContractRepository.js";
import { getDevice } from "./DeviceRepository.js";
import { bumpWipeEpoch } from "./SyncStateRepository.js";
import { clearClaimsForDevice, clearClaimsForSource } from "./ReplicaDeletionClaimRepository.js";
import { forgetAbsenceObserver } from "./AbsenceRepository.js";
import {
  enqueueSourceStreamCleanup,
  hasSourceStreamCleanupHistory,
  isSourceStreamCleanupPending,
  type SourceStreamCleanupJob,
} from "./SourceStreamCleanupRepository.js";
import type { AccountDescriptor } from "@omnesis/source-sdk";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("gateway:sources");

export interface SourceRecord {
  id: SourceId;
  type: SourceType;
  accountId: AccountId;
  /**
   * What the source declares about this account: a readable label, the
   * subject the platform says it is, the tenant it is scoped to.
   *
   * Null for a source that has nothing to say beyond the id, which is most of
   * them and is not a gap — the id is what every consumer shows today. It is
   * deliberately not derived from `accountId`: inventing one would be the same
   * inference declaring it is meant to remove, and would be indistinguishable
   * afterwards from something a source actually said.
   */
  account: AccountDescriptor | null;
  deviceId: DeviceId;
  config: Record<string, unknown>;
  enabled: boolean;
  multiDeviceMode: MultiDeviceMode;
  replicaVersionPolicy: "source-updated-at" | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Read a stored descriptor, or nothing.
 *
 * Null and unreadable are the same answer here — no source has declared
 * anything for this account — because both leave every consumer where it
 * already is, falling back to the id.
 */
function parseAccountDescriptor(
  raw: string | null | undefined,
  rowId: string,
): AccountDescriptor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { id?: unknown }).id === "string"
    ) {
      return parsed as AccountDescriptor;
    }
  } catch {
    /* fall through */
  }
  log.warn(`Ignoring unreadable account descriptor on source ${rowId}`);
  return null;
}

function now(): number {
  return Date.now();
}

function rowToSource(row: {
  id: string;
  type: string;
  account_id: string;
  account: string | null;
  device_id: string;
  config: string;
  enabled: number;
  multi_device_mode: MultiDeviceMode;
  replica_version_policy: "source-updated-at" | null;
  created_at: number;
  updated_at: number;
}): SourceRecord {
  const config = sourcesConfigCodec.parseWithFallback(row.config, { rowId: row.id });
  return {
    id: SourceId(row.id),
    type: SourceType(row.type),
    accountId: AccountId(row.account_id),
    // Tolerant of a malformed value rather than refusing the row: this is
    // descriptive metadata, and a source that is otherwise fine must not
    // become unreadable because what it once said about its account did not
    // survive. The id, which is the addressable identity, is unaffected.
    account: parseAccountDescriptor(row.account, row.id),
    deviceId: DeviceId(row.device_id),
    config,
    enabled: row.enabled === 1,
    multiDeviceMode: row.multi_device_mode,
    replicaVersionPolicy: row.replica_version_policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Apply one member's overlay while retaining unrelated shared parameters. */
export function effectiveSourceConfig(
  config: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const effective = { ...config, ...override };
  const sharedParams = asRecord(config.params);
  const localParams = asRecord(override.params);
  if (sharedParams || localParams) {
    effective.params = { ...(sharedParams ?? {}), ...(localParams ?? {}) };
  }
  return effective;
}

function rowToMemberSource(
  row: Parameters<typeof rowToSource>[0] & { config_override: string },
): SourceRecord {
  const source = rowToSource(row);
  const override = sourceDeviceConfigOverrideCodec.parseWithFallback(row.config_override, {
    rowId: `${row.id}:${row.device_id}`,
  });
  return { ...source, config: effectiveSourceConfig(source.config, override) };
}

/**
 * Create a source. Idempotent on (type, accountId): if a source with the
 * same id already exists, returns the existing record unchanged — including
 * its `deviceId`. Ownership never moves implicitly: re-homing a source to
 * another device is an explicit act (`updateSource` with a `deviceId`,
 * driven by `PATCH /admin/sources/:id`), which notifies the losing device.
 * Callers that must not adopt a foreign-hosted source check first and
 * reject (see SourceService.createSource's 409). See #1513.
 */
export function createSource(
  db: Db,
  opts: {
    type: SourceType;
    accountId: AccountId;
    deviceId: DeviceId;
    config?: Record<string, unknown>;
    memberConfigOverride?: Record<string, unknown>;
    memberScopedParams?: readonly string[];
    account?: AccountDescriptor | null;
    enabled?: boolean;
    multiDeviceMode?: MultiDeviceMode;
    replicaVersionPolicy?: "source-updated-at";
  },
): SourceRecord {
  return db.transaction(() => {
    const id = makeSourceId(opts.type, opts.accountId);
    const existing = getSource(db, id);
    if (existing) {
      if (existing.deviceId === opts.deviceId && opts.memberScopedParams !== undefined) {
        initializeOrAssertSourceMemberConfigContractForDevice(
          db,
          id,
          opts.type,
          opts.deviceId,
          opts.memberScopedParams,
        );
      }
      if (existing.deviceId === opts.deviceId && opts.memberConfigOverride !== undefined) {
        setSourceMemberConfigOverride(db, id, opts.deviceId, opts.memberConfigOverride);
      }
      if (existing.deviceId === opts.deviceId && opts.account) {
        setSourceAccount(db, id, opts.account);
        return getSource(db, id)!;
      }
      return existing;
    }
    const ts = now();
    const config = opts.config ?? {};
    const multiDeviceMode = opts.multiDeviceMode ?? "exclusive";
    db.prepare(
      `INSERT INTO sources (
         id, type, account_id, account, device_id, config, enabled,
         multi_device_mode, replica_version_policy, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.type,
      opts.accountId,
      opts.account ? JSON.stringify(opts.account) : null,
      opts.deviceId,
      sourcesConfigCodec.serialize(config),
      opts.enabled === false ? 0 : 1,
      multiDeviceMode,
      opts.replicaVersionPolicy ?? null,
      ts,
      ts,
    );
    addSourceMember(db, id, opts.deviceId, ts, opts.memberConfigOverride, opts.memberScopedParams);
    return {
      id,
      type: opts.type,
      accountId: opts.accountId,
      account: opts.account ?? null,
      deviceId: opts.deviceId,
      config,
      enabled: opts.enabled !== false,
      multiDeviceMode,
      replicaVersionPolicy: opts.replicaVersionPolicy ?? null,
      createdAt: ts,
      updatedAt: ts,
    };
  })();
}

export function getSource(db: Db, id: SourceId): SourceRecord | null {
  const row = db
    .prepare<
      [string],
      {
        id: string;
        type: string;
        account_id: string;
        account: string | null;
        device_id: string;
        config: string;
        enabled: number;
        multi_device_mode: MultiDeviceMode;
        replica_version_policy: "source-updated-at" | null;
        created_at: number;
        updated_at: number;
      }
    >(
      "SELECT id, type, account_id, account, device_id, config, enabled, multi_device_mode, replica_version_policy, created_at, updated_at FROM sources WHERE id = ?",
    )
    .get(id);
  return row ? rowToSource(row) : null;
}

/** A durable mode transition owns source lifecycle changes until it finalizes. */
export function isSourceModeTransitionPending(db: Db, id: SourceId): boolean {
  return (
    db
      .prepare<
        [string],
        { found: number }
      >("SELECT 1 AS found FROM source_mode_transitions WHERE source_id = ? LIMIT 1")
      .get(id) !== undefined
  );
}

/**
 * Sources a device contributes to: the ones it owns plus the ones it has
 * joined as a member. This is a device's authoritative host list.
 */
export function listSourcesForMember(db: Db, deviceId: DeviceId): SourceRecord[] {
  return db
    .prepare<
      [string, string, string],
      {
        id: string;
        type: string;
        account_id: string;
        account: string | null;
        device_id: string;
        config: string;
        enabled: number;
        multi_device_mode: MultiDeviceMode;
        replica_version_policy: "source-updated-at" | null;
        created_at: number;
        updated_at: number;
        config_override: string;
      }
    >(
      `SELECT DISTINCT s.id, s.type, s.account_id, s.account, s.device_id, s.config, s.enabled,
                       s.multi_device_mode, s.replica_version_policy, s.created_at, s.updated_at,
                       COALESCE(m.config_override, '{}') AS config_override
         FROM sources s
         LEFT JOIN source_devices m ON m.source_id = s.id AND m.device_id = ?
        WHERE s.device_id = ? OR m.device_id = ?
        ORDER BY s.created_at ASC`,
    )
    .all(deviceId, deviceId, deviceId)
    .map(rowToMemberSource);
}

/** One member's effective view of one source, using the membership primary key. */
export function getSourceForMember(
  db: Db,
  sourceId: SourceId,
  deviceId: DeviceId,
): SourceRecord | null {
  const row = db
    .prepare<
      [string, string, string, string],
      {
        id: string;
        type: string;
        account_id: string;
        account: string | null;
        device_id: string;
        config: string;
        enabled: number;
        multi_device_mode: MultiDeviceMode;
        replica_version_policy: "source-updated-at" | null;
        created_at: number;
        updated_at: number;
        config_override: string;
      }
    >(
      `SELECT s.id, s.type, s.account_id, s.account, s.device_id, s.config, s.enabled,
              s.multi_device_mode, s.replica_version_policy, s.created_at, s.updated_at,
              COALESCE(m.config_override, '{}') AS config_override
         FROM sources s
         LEFT JOIN source_devices m ON m.source_id = s.id AND m.device_id = ?
        WHERE s.id = ? AND (s.device_id = ? OR m.device_id = ?)`,
    )
    .get(deviceId, sourceId, deviceId, deviceId);
  return row ? rowToMemberSource(row) : null;
}

export function listSources(db: Db): SourceRecord[] {
  return db
    .prepare<
      [],
      {
        id: string;
        type: string;
        account_id: string;
        account: string | null;
        device_id: string;
        config: string;
        enabled: number;
        multi_device_mode: MultiDeviceMode;
        replica_version_policy: "source-updated-at" | null;
        created_at: number;
        updated_at: number;
      }
    >(
      "SELECT id, type, account_id, account, device_id, config, enabled, multi_device_mode, replica_version_policy, created_at, updated_at FROM sources ORDER BY created_at ASC",
    )
    .all()
    .map(rowToSource);
}

/**
 * Every device that still holds durable source state — as the owning device
 * or as a member of a multi-device source. This is the same ownership test a
 * hard delete ("forget") applies before refusing, so a revoked device in this
 * set is a row that has to be repaired rather than forgotten.
 */
export function listDeviceIdsHostingSources(db: Db): DeviceId[] {
  return db
    .prepare<[], { device_id: string }>(
      `SELECT device_id FROM sources
       UNION
       SELECT device_id FROM source_devices`,
    )
    .all()
    .map((row) => DeviceId(row.device_id));
}

export function updateSource(
  db: Db,
  id: SourceId,
  patch: { config?: Record<string, unknown>; enabled?: boolean; deviceId?: DeviceId },
): SourceRecord | null {
  // The row update and the membership swap must land together; the
  // transaction nests as a savepoint under a caller's own.
  return db.transaction((): SourceRecord | null => {
    const existing = getSource(db, id);
    if (!existing) return null;
    if (isSourceModeTransitionPending(db, id)) return null;
    const config = patch.config ?? existing.config;
    const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled;
    const deviceId = patch.deviceId ?? existing.deviceId;
    const targetOverride =
      deviceId !== existing.deviceId ? getSourceMemberConfigOverride(db, id, deviceId) : null;
    const ts = now();
    db.prepare(
      "UPDATE sources SET config = ?, enabled = ?, device_id = ?, updated_at = ? WHERE id = ?",
    ).run(sourcesConfigCodec.serialize(config), enabled ? 1 : 0, deviceId, ts, id);
    if (deviceId !== existing.deviceId) {
      // Exclusive and handoff sources write through the shared cursor row.
      // Advancing it in the same transaction as the re-home makes the move a
      // hard write boundary: a page claimed by the former owner cannot land
      // after ownership has changed.
      if (!hasPerDeviceCursor(existing.multiDeviceMode)) {
        bumpWipeEpoch(db, id, "");
      }
      // A re-home replaces the membership: the losing devices stop
      // contributing, the gaining one becomes the (single) member and, when
      // it already was a member, keeps its cursor and its write authority.
      // Modes that keep several members join through membership APIs, not
      // through a deviceId change.
      retireMemberCursors(db, id, undefined, deviceId);
      db.prepare("DELETE FROM source_sync_issues WHERE source_id = ? AND device_id != ?").run(
        id,
        deviceId,
      );
      // With a single host left there is nobody to disagree with.
      clearClaimsForSource(db, id);
      forgetAbsenceObserver(db, id);
      db.prepare("DELETE FROM source_devices WHERE source_id = ?").run(id);
      if (!addSourceMember(db, id, deviceId, ts)) {
        throw new Error(`Cannot move ${id} to ${deviceId} while its stream cleanup is pending`);
      }
      if (targetOverride !== null) {
        setSourceMemberConfigOverride(db, id, deviceId, targetOverride);
      }
    }
    return { ...existing, config, enabled, deviceId, updatedAt: ts };
  })();
}

/**
 * Retire the cursor a device kept on a source — or every member's cursor
 * when no device is given, except `keep`'s. The `sync_state` row goes, so
 * the device no longer shows up in the source's status; the source's
 * documents and the shared row stay, and a device that joins again adopts
 * the shared row. The device's write-epoch row is kept and advanced instead
 * of deleted: it is the fence, not state. A sync of the device that began
 * before the retirement is refused on its next write, and a re-join claims
 * the next epoch from the same row — a deleted row would restart at the
 * epoch the in-flight sync still holds and let its page through.
 */
function retireMemberCursors(
  db: Db,
  sourceId: SourceId,
  deviceId?: DeviceId,
  keep?: DeviceId,
): void {
  if (deviceId) {
    db.prepare("DELETE FROM sync_state WHERE source_id = ? AND device_id = ?").run(
      sourceId,
      deviceId,
    );
    bumpWipeEpoch(db, sourceId, deviceId);
    return;
  }
  const kept = keep ?? "";
  db.prepare(
    "DELETE FROM pending_source_pages WHERE source_id = ? AND cursor_row != '' AND cursor_row != ?",
  ).run(sourceId, kept);
  db.prepare(
    "DELETE FROM sync_state WHERE source_id = ? AND device_id != '' AND device_id != ?",
  ).run(sourceId, kept);
  // A member that never claimed a row gets one at its first epoch, so a
  // writer that read no row (epoch 0) before the retirement is refused too.
  db.prepare(
    `INSERT OR IGNORE INTO source_wipe_epoch (source_id, device_id, epoch)
     SELECT source_id, device_id, 0 FROM source_devices WHERE source_id = ? AND device_id != ?`,
  ).run(sourceId, kept);
  db.prepare(
    "UPDATE source_wipe_epoch SET epoch = epoch + 1 WHERE source_id = ? AND device_id != '' AND device_id != ?",
  ).run(sourceId, kept);
}

/** Devices contributing to a source, oldest membership first. */
export function listSourceMembers(
  db: Db,
  sourceId: SourceId,
): Array<{ deviceId: DeviceId; addedAt: number }> {
  return db
    .prepare<[string], { device_id: string; added_at: number }>(
      "SELECT device_id, added_at FROM source_devices WHERE source_id = ? ORDER BY added_at, rowid",
    )
    .all(sourceId)
    .map((r) => ({ deviceId: DeviceId(r.device_id), addedAt: r.added_at }));
}

/** One member's local config overlay, or null when it is not a member. */
export function getSourceMemberConfigOverride(
  db: Db,
  sourceId: SourceId,
  deviceId: DeviceId,
): Record<string, unknown> | null {
  const row = db
    .prepare<
      [string, string],
      { config_override: string }
    >("SELECT config_override FROM source_devices WHERE source_id = ? AND device_id = ?")
    .get(sourceId, deviceId);
  return row
    ? sourceDeviceConfigOverrideCodec.parseWithFallback(row.config_override, {
        rowId: `${sourceId}:${deviceId}`,
      })
    : null;
}

/** Replace one existing member's local config overlay. */
export function setSourceMemberConfigOverride(
  db: Db,
  sourceId: SourceId,
  deviceId: DeviceId,
  override: Record<string, unknown>,
): boolean {
  const encoded = sourceDeviceConfigOverrideCodec.serialize(override);
  return (
    db
      .prepare(
        "UPDATE source_devices SET config_override = ? WHERE source_id = ? AND device_id = ?",
      )
      .run(encoded, sourceId, deviceId).changes > 0
  );
}

/** Update-only member overlay write; never inserts or crosses a pending mode transition. */
export function updateExistingSourceMemberConfigOverride(
  db: Db,
  sourceId: SourceId,
  deviceId: DeviceId,
  override: Record<string, unknown>,
  memberScopedParams: readonly string[],
): boolean {
  return db.transaction(() => {
    const source = getSource(db, sourceId);
    if (!source || !isSourceMember(db, sourceId, deviceId)) return false;
    initializeOrAssertSourceMemberConfigContractForDevice(
      db,
      sourceId,
      source.type,
      source.deviceId,
      memberScopedParams,
    );
    if (deviceId !== source.deviceId) {
      initializeOrAssertSourceMemberConfigContractForDevice(
        db,
        sourceId,
        source.type,
        deviceId,
        memberScopedParams,
      );
    }
    const encoded = sourceDeviceConfigOverrideCodec.serialize(override);
    return (
      db
        .prepare(
          `UPDATE source_devices SET config_override = ?
            WHERE source_id = ? AND device_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM source_mode_transitions WHERE source_id = source_devices.source_id
              )`,
        )
        .run(encoded, sourceId, deviceId).changes > 0
    );
  })();
}

/** Every source's members, keyed by source id — one query for list views. */
export function listAllSourceMembers(db: Db): Map<string, DeviceId[]> {
  const out = new Map<string, DeviceId[]>();
  for (const r of db
    .prepare<
      [],
      { source_id: string; device_id: string }
    >("SELECT source_id, device_id FROM source_devices ORDER BY added_at, rowid")
    .all()) {
    const list = out.get(r.source_id) ?? [];
    list.push(DeviceId(r.device_id));
    out.set(r.source_id, list);
  }
  return out;
}

export function isSourceMember(db: Db, sourceId: SourceId, deviceId: DeviceId): boolean {
  return (
    db
      .prepare<
        [string, string],
        { found: number }
      >("SELECT 1 AS found FROM source_devices WHERE source_id = ? AND device_id = ?")
      .get(sourceId, deviceId) !== undefined
  );
}

/**
 * Add a device to a source's membership; a no-op when it is already a
 * member. Returns false when the source no longer exists or that device's
 * retired stream is still being cleaned, so callers cannot reintroduce a
 * stream while an older generation may still delete it.
 */
export function addSourceMember(
  db: Db,
  sourceId: SourceId,
  deviceId: DeviceId,
  addedAt = now(),
  configOverride?: Record<string, unknown>,
  memberScopedParams?: readonly string[],
  allowDetachedRejoin = true,
): boolean {
  return db.transaction((): boolean => {
    const source = getSource(db, sourceId);
    if (!source) return false;
    if (isSourceModeTransitionPending(db, sourceId)) return false;
    if (isSourceStreamCleanupPending(db, sourceId, deviceId)) return false;
    // Check beside the insert, not on a reader: a queued implicit join may
    // reach the writer after detach and its cleanup have both completed.
    if (
      !allowDetachedRejoin &&
      source.multiDeviceMode === "partitioned" &&
      !isSourceMember(db, sourceId, deviceId) &&
      hasSourceStreamCleanupHistory(db, sourceId, deviceId)
    ) {
      return false;
    }
    const device = getDevice(db, deviceId);
    if (
      memberScopedParams !== undefined &&
      (!device || !deviceSupportsPersistedSourceContract(db, source, device))
    ) {
      throw new Error(
        `device ${deviceId} no longer advertises source ${sourceId}'s persisted multi-device contract`,
      );
    }
    if (memberScopedParams !== undefined) {
      initializeOrAssertSourceMemberConfigContractForDevice(
        db,
        sourceId,
        source.type,
        source.deviceId,
        memberScopedParams,
      );
      if (deviceId !== source.deviceId) {
        initializeOrAssertSourceMemberConfigContractForDevice(
          db,
          sourceId,
          source.type,
          deviceId,
          memberScopedParams,
        );
      }
    }
    if (configOverride === undefined) {
      db.prepare(
        "INSERT OR IGNORE INTO source_devices (source_id, device_id, added_at) VALUES (?, ?, ?)",
      ).run(sourceId, deviceId, addedAt);
    } else {
      db.prepare(
        `INSERT INTO source_devices (source_id, device_id, added_at, config_override)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_id, device_id) DO UPDATE SET config_override = excluded.config_override`,
      ).run(sourceId, deviceId, addedAt, sourceDeviceConfigOverrideCodec.serialize(configOverride));
    }
    return true;
  })();
}

/** Atomically update shared source settings and one existing member's local overlay. */
export function updateSourceForMember(
  db: Db,
  id: SourceId,
  deviceId: DeviceId,
  patch: { config?: Record<string, unknown>; enabled?: boolean },
  configOverride: Record<string, unknown>,
  memberScopedParams: readonly string[],
): SourceRecord | null {
  return db
    .transaction(() => {
      const existing = getSource(db, id);
      if (!existing || isSourceModeTransitionPending(db, id)) return null;
      if (existing.deviceId !== deviceId || !isSourceMember(db, id, deviceId)) return existing;
      initializeOrAssertSourceMemberConfigContractForDevice(
        db,
        id,
        existing.type,
        existing.deviceId,
        memberScopedParams,
      );
      const updated = updateSource(db, id, patch);
      if (!updated || !setSourceMemberConfigOverride(db, id, deviceId, configOverride)) return null;
      return updated;
    })
    .immediate();
}

/** Why a detach is refused: source/member state, the last host, or a pending transition. */
export interface SourceMemberDetachRefusal {
  removed: false;
  reason: "not-found" | "not-member" | "last-member" | "transition-pending";
}

/** Outcome of a detach, decided inside the write transaction. */
export type RemoveSourceMemberResult =
  | SourceMemberDetachRefusal
  | {
      removed: true;
      record: SourceRecord;
      /** The member that became the owner when the detached device was the owner; null otherwise. */
      ownerReassignedTo: DeviceId | null;
      /** Durable cleanup queued in the same transaction as the detach. */
      streamCleanup: SourceStreamCleanupJob | null;
    };

/**
 * Why detaching `deviceId` from `sourceId` would be refused, or null when it
 * would go through. `removeSourceMember` decides on this inside its write
 * transaction; a caller with work to do before that write (a stream wipe)
 * asks first, so a refused detach does no work at all.
 */
export function sourceMemberDetachRefusal(
  db: Db,
  sourceId: SourceId,
  deviceId: DeviceId,
): SourceMemberDetachRefusal | null {
  const existing = getSource(db, sourceId);
  if (!existing) return { removed: false, reason: "not-found" };
  if (isSourceModeTransitionPending(db, sourceId)) {
    return { removed: false, reason: "transition-pending" };
  }
  if (existing.deviceId !== deviceId && !isSourceMember(db, sourceId, deviceId)) {
    return { removed: false, reason: "not-member" };
  }
  const remaining = listSourceMembers(db, sourceId).filter((m) => m.deviceId !== deviceId);
  if (remaining.length === 0 && existing.deviceId === deviceId) {
    return { removed: false, reason: "last-member" };
  }
  return null;
}

/**
 * Detach a device from a source. The source keeps its documents and every
 * other member. When the detached device owned the row, ownership passes to
 * the oldest remaining member. The last member cannot detach: a source
 * always has a host, and taking the last one away is removing the source.
 */
export function removeSourceMember(
  db: Db,
  sourceId: SourceId,
  deviceId: DeviceId,
): RemoveSourceMemberResult {
  return db.transaction((): RemoveSourceMemberResult => {
    const refusal = sourceMemberDetachRefusal(db, sourceId, deviceId);
    if (refusal) return refusal;
    const existing = getSource(db, sourceId)!;
    const remaining = listSourceMembers(db, sourceId).filter((m) => m.deviceId !== deviceId);
    db.prepare("DELETE FROM source_devices WHERE source_id = ? AND device_id = ?").run(
      sourceId,
      deviceId,
    );
    retireMemberCursors(db, sourceId, deviceId);
    db.prepare("DELETE FROM source_sync_issues WHERE source_id = ? AND device_id = ?").run(
      sourceId,
      deviceId,
    );
    db.prepare("DELETE FROM pending_source_pages WHERE source_id = ? AND prepared_by = ?").run(
      sourceId,
      deviceId,
    );
    // A device that no longer hosts the source has no say in which of its
    // items exist; nothing is deleted by this, a dispute it alone kept open
    // simply closes.
    clearClaimsForDevice(db, sourceId, deviceId);
    forgetAbsenceObserver(db, sourceId, deviceId);
    let ownerReassignedTo: DeviceId | null = null;
    let record = existing;
    if (existing.deviceId === deviceId) {
      const next = remaining[0]!;
      const ts = now();
      db.prepare("UPDATE sources SET device_id = ?, updated_at = ? WHERE id = ?").run(
        next.deviceId,
        ts,
        sourceId,
      );
      ownerReassignedTo = next.deviceId;
      record = { ...existing, deviceId: next.deviceId, updatedAt: ts };
    }
    const streamCleanup =
      existing.multiDeviceMode === "partitioned"
        ? enqueueSourceStreamCleanup(db, sourceId, deviceId)
        : null;
    return { removed: true, record, ownerReassignedTo, streamCleanup };
  })();
}

/**
 * Create a source row with an explicit id (no derivation from
 * `${type}:${accountId}`). Used for singleton sources whose canonical id has
 * no colon, where the collector's engine emits sync.status with the bare id
 * and we need the registry row to match.
 * Returns the created record, or null if the insert conflicted or cleanup
 * still owns the requested device stream.
 */
export function createSourceWithId(
  db: Db,
  id: SourceId,
  opts: {
    type: SourceType;
    accountId: AccountId;
    deviceId: DeviceId;
    config?: Record<string, unknown>;
    memberConfigOverride?: Record<string, unknown>;
    memberScopedParams?: readonly string[];
    account?: AccountDescriptor | null;
    enabled?: boolean;
    multiDeviceMode?: MultiDeviceMode;
    replicaVersionPolicy?: "source-updated-at";
  },
): SourceRecord | null {
  return db
    .transaction(() => {
      if (isSourceCleanupPending(db, id)) return null;
      if (isSourceStreamCleanupPending(db, id, opts.deviceId)) return null;
      const ts = now();
      const config = opts.config ?? {};
      const multiDeviceMode = opts.multiDeviceMode ?? "exclusive";
      db.prepare(
        `INSERT INTO sources (
           id, type, account_id, account, device_id, config, enabled, multi_device_mode,
           replica_version_policy, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(
        id,
        opts.type,
        opts.accountId,
        opts.account ? JSON.stringify(opts.account) : null,
        opts.deviceId,
        sourcesConfigCodec.serialize(config),
        opts.enabled === false ? 0 : 1,
        multiDeviceMode,
        opts.replicaVersionPolicy ?? null,
        ts,
        ts,
      );
      clearSourceRemoved(db, id);
      const rec = getSource(db, id);
      // Membership mirrors the owning device. Only stamp it when this call
      // actually owns the row (a conflicting concurrent create returns the
      // winner's record; the loser must not join).
      if (rec && rec.deviceId === opts.deviceId) {
        addSourceMember(
          db,
          id,
          rec.deviceId,
          ts,
          opts.memberConfigOverride,
          opts.memberScopedParams,
        );
      }
      return rec;
    })
    .immediate();
}

export function deleteSource(db: Db, id: SourceId): boolean {
  if (isSourceModeTransitionPending(db, id)) return false;
  const result = db.prepare("DELETE FROM sources WHERE id = ?").run(id);
  return result.changes > 0;
}

// ── removal tombstones ──────────────────────────────────────────────
//
// A push source (browser extension, Apple Health, Health Connect) is
// operated by the *device*, not the gateway, so deleting its `sources`
// row is not enough to stop it: the device keeps POSTing and the next
// ingest would auto-recreate the row (see `ensurePushSourcesRegistered`).
// `removed_sources` is the durable marker that a source was explicitly
// removed: ingest rejects pushes for a tombstoned id and auto-register
// refuses to resurrect it, until an explicit re-enable (re-pair, health
// re-opt-in, or portal "Add") clears the tombstone.

/**
 * Record that `id` was explicitly removed. Idempotent.
 *
 * `cleanupPending` leaves `cleanup_done_at` NULL, which is what marks the
 * removal as still in progress: the source's documents, analytics, cognitive
 * state and index entries are swept after the request returns, and a NULL here
 * is what lets clients show the removal as unfinished and lets the gateway
 * resume it after a restart. Callers that have nothing left to sweep pass
 * nothing and get a tombstone that is complete on arrival.
 */
export function markSourceRemoved(db: Db, id: SourceId, opts?: { cleanupPending?: boolean }): void {
  const at = now();
  const doneAt = opts?.cleanupPending ? null : at;
  db.prepare(
    "INSERT INTO removed_sources (id, removed_at, cleanup_done_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET removed_at = excluded.removed_at, cleanup_done_at = excluded.cleanup_done_at",
  ).run(id, at, doneAt);
}

/** Record that the post-removal sweep for `id` has finished. Idempotent. */
export function markSourceCleanupDone(db: Db, id: SourceId): void {
  db.prepare("UPDATE removed_sources SET cleanup_done_at = ? WHERE id = ?").run(now(), id);
  // The family declaration outlives any one account of its type, so it is
  // dropped here — at the end of a removal — rather than with the source's
  // rows: a resync deletes those and re-creates them, and a family dropped
  // there would disappear for as long as the re-sync takes.
  pruneSourceFamilyMeta(db, id);
}

/** A removal whose post-removal sweep has not finished. */
export interface PendingSourceRemoval {
  id: SourceId;
  removedAt: number;
}

/** True if `id` carries a tombstone whose post-removal sweep is unfinished. */
export function isSourceCleanupPending(db: Db, id: SourceId): boolean {
  return (
    db
      .prepare<
        [string],
        { one: number }
      >("SELECT 1 AS one FROM removed_sources WHERE id = ? AND cleanup_done_at IS NULL")
      .get(id) !== undefined
  );
}

/**
 * Removals whose sweep is still outstanding, oldest first. Non-empty either
 * because a sweep is running right now or because the gateway stopped partway
 * through one — the two are indistinguishable from the row alone, which is why
 * resuming a sweep has to be safe to do while one is already in flight.
 */
export function listPendingSourceRemovals(db: Db): PendingSourceRemoval[] {
  return db
    .prepare<[], { id: string; removed_at: number }>(
      "SELECT id, removed_at FROM removed_sources WHERE cleanup_done_at IS NULL ORDER BY removed_at ASC",
    )
    .all()
    .map((r) => ({ id: SourceId(r.id), removedAt: r.removed_at }));
}

/** Clear the removal tombstone for `id` (explicit re-enable). Idempotent. */
export function clearSourceRemoved(db: Db, id: SourceId): void {
  db.prepare("DELETE FROM removed_sources WHERE id = ?").run(id);
}

/** Clear only a completed tombstone; a concurrent pending removal wins. */
export function clearSourceRemovedIfCleanupDone(db: Db, id: SourceId): boolean {
  return (
    db.prepare("DELETE FROM removed_sources WHERE id = ? AND cleanup_done_at IS NOT NULL").run(id)
      .changes > 0
  );
}

/** True if `id` carries a durable removal tombstone. */
export function isSourceRemoved(db: Db, id: SourceId): boolean {
  const row = db
    .prepare<[string], { one: number }>("SELECT 1 AS one FROM removed_sources WHERE id = ?")
    .get(id);
  return row !== undefined;
}

/** Return the requested source ids that carry durable removal tombstones. */
export function findRemovedSourceIds(db: Db, sourceIds: readonly string[]): Set<string> {
  const removed = new Set<string>();
  for (let offset = 0; offset < sourceIds.length; offset += 500) {
    const chunk = sourceIds.slice(offset, offset + 500);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<
        unknown[],
        { id: string }
      >(`SELECT id FROM removed_sources WHERE id IN (${placeholders})`)
      .all(...chunk);
    for (const row of rows) removed.add(row.id);
  }
  return removed;
}

/** All currently-tombstoned source ids. */
export function listRemovedSources(db: Db): SourceId[] {
  return db
    .prepare<[], { id: string }>("SELECT id FROM removed_sources ORDER BY removed_at ASC")
    .all()
    .map((r) => SourceId(r.id));
}
