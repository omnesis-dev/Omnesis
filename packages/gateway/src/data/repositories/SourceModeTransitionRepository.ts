// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { DeviceId, SourceId, type MultiDeviceMode } from "@omnesis/types";
import {
  advertisedMemberScopedParamNames,
  deviceMatchesMemberConfigContract,
  deviceSupportsMultiDeviceMode,
  splitMemberScopedParams,
} from "../../multi-device-mode.js";
import {
  getSourceMemberConfigContract,
  initializeOrAssertSourceMemberConfigContract,
} from "./SourceMemberConfigContractRepository.js";
import { getDevice } from "./DeviceRepository.js";
import {
  getSourceMemberConfigOverride,
  getSource,
  isSourceCleanupPending,
  listSourceMembers,
  setSourceMemberConfigOverride,
  type SourceRecord,
  updateSource,
} from "./SourceRepository.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export interface SourceModeTransition {
  sourceId: SourceId;
  fromMode: MultiDeviceMode;
  toMode: MultiDeviceMode;
  ownerDeviceId: DeviceId;
  preparedAt: number;
  lastError: string | null;
}

export interface SourceModeTransitionPublication {
  sourceId: SourceId;
  completedAt: number;
  lastError: string | null;
}

export type SourceModeTransitionPrepareRefusal =
  | "not-found"
  | "removal-pending"
  | "stream-cleanup-pending"
  | "owner-revoked"
  | "unsupported"
  | "membership-conflict"
  | "ambiguous-history"
  | "already-transitioning";

/** A domain refusal raised before the journal or either write fence is mutated. */
export class SourceModeTransitionPrepareError extends Error {
  override readonly name = "SourceModeTransitionPrepareError";
  readonly code: string;

  constructor(
    readonly reason: SourceModeTransitionPrepareRefusal,
    message: string,
  ) {
    super(message);
    this.code = `source-mode-transition-prepare:${reason}`;
  }
}

export function rehydrateSourceModeTransitionPrepareError(
  error: unknown,
): SourceModeTransitionPrepareError | null {
  if (!(error instanceof Error)) return null;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code !== "string" || !code.startsWith("source-mode-transition-prepare:")) {
    return null;
  }
  const reason = code.slice("source-mode-transition-prepare:".length);
  const reasons: readonly SourceModeTransitionPrepareRefusal[] = [
    "not-found",
    "removal-pending",
    "stream-cleanup-pending",
    "owner-revoked",
    "unsupported",
    "membership-conflict",
    "ambiguous-history",
    "already-transitioning",
  ];
  return reasons.includes(reason as SourceModeTransitionPrepareRefusal)
    ? new SourceModeTransitionPrepareError(
        reason as SourceModeTransitionPrepareRefusal,
        error.message,
      )
    : null;
}

export const SOURCE_MODE_ADOPTION_BATCH_SIZE = 100;

export interface SourceModeTransitionAdoptionBatch {
  moved: number;
  complete: boolean;
}

const SQLITE_STREAM_TABLES = [
  "documents",
  "removed_documents",
  "document_absences",
  "document_absence_scopes",
  "document_absence_observations",
  "snapshot_absence_deletions",
] as const;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Move legacy shared member params to the owner overlay without changing its effective config. */
function promoteLegacyMemberScopedParams(
  db: Db,
  source: SourceRecord,
  memberScopedParams: readonly string[],
): void {
  const { sharedConfig, memberParams } = splitMemberScopedParams(source.config, memberScopedParams);
  if (Object.keys(memberParams).length === 0) return;

  const override = getSourceMemberConfigOverride(db, source.id, source.deviceId);
  if (!override) throw new Error(`source ${source.id} owner is not a member`);
  const ownerParams = { ...(objectRecord(override.params) ?? {}) };
  for (const [name, value] of Object.entries(memberParams)) {
    if (!Object.hasOwn(ownerParams, name)) ownerParams[name] = value;
  }

  const ownerOverride = { ...override, params: ownerParams };
  if (!updateSource(db, source.id, { config: sharedConfig })) {
    throw new Error(`source ${source.id} changed while promoting member-local configuration`);
  }
  if (!setSourceMemberConfigOverride(db, source.id, source.deviceId, ownerOverride)) {
    throw new Error(`source ${source.id} owner changed while promoting member-local configuration`);
  }
}

export function createSourceModeTransitionTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_mode_transitions (
      source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
      from_mode TEXT NOT NULL CHECK (from_mode IN ('exclusive', 'handoff', 'replicated', 'partitioned')),
      to_mode TEXT NOT NULL CHECK (to_mode IN ('exclusive', 'handoff', 'replicated', 'partitioned')),
      owner_device_id TEXT NOT NULL REFERENCES devices(id),
      prepared_at INTEGER NOT NULL,
      last_error TEXT
    )
  `);
}

/** Durable post-finalize work such as removing promoted member paths from the config file. */
export function createSourceModeTransitionPublicationTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_mode_transition_publications (
      source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
      completed_at INTEGER NOT NULL,
      last_error TEXT
    )
  `);
}

function rowToPublication(row: {
  source_id: string;
  completed_at: number;
  last_error: string | null;
}): SourceModeTransitionPublication {
  return {
    sourceId: SourceId(row.source_id),
    completedAt: row.completed_at,
    lastError: row.last_error,
  };
}

export function getSourceModeTransitionPublication(
  db: Db,
  sourceId: SourceId,
): SourceModeTransitionPublication | null {
  const row = db
    .prepare<[string], { source_id: string; completed_at: number; last_error: string | null }>(
      `SELECT source_id, completed_at, last_error
         FROM source_mode_transition_publications WHERE source_id = ?`,
    )
    .get(sourceId);
  return row ? rowToPublication(row) : null;
}

export function listSourceModeTransitionPublications(db: Db): SourceModeTransitionPublication[] {
  return db
    .prepare<[], { source_id: string; completed_at: number; last_error: string | null }>(
      `SELECT source_id, completed_at, last_error
         FROM source_mode_transition_publications ORDER BY completed_at, source_id`,
    )
    .all()
    .map(rowToPublication);
}

export function recordSourceModeTransitionPublicationFailure(
  db: Db,
  sourceId: SourceId,
  message: string,
): boolean {
  return (
    db
      .prepare("UPDATE source_mode_transition_publications SET last_error = ? WHERE source_id = ?")
      .run(message, sourceId).changes > 0
  );
}

export function completeSourceModeTransitionPublication(db: Db, sourceId: SourceId): boolean {
  return (
    db.prepare("DELETE FROM source_mode_transition_publications WHERE source_id = ?").run(sourceId)
      .changes > 0
  );
}

export function createSourceModeTransitionIndexes(db: Db): void {
  for (const table of SQLITE_STREAM_TABLES) {
    const columns = db
      .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map((row) => row.name);
    if (!columns.includes("source_id") || !columns.includes("stream_id")) continue;
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${table}_source_stream ON ${table}(source_id, stream_id)`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${table}_source_nonshared_stream
         ON ${table}(source_id) WHERE stream_id != ''`,
    );
  }
  const syncStateColumns = db
    .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
    .all("sync_state")
    .map((row) => row.name);
  if (syncStateColumns.includes("source_id") && syncStateColumns.includes("device_id")) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sync_state_source_nonshared_device
         ON sync_state(source_id) WHERE device_id != ''`,
    );
  }
}

function rowToTransition(row: {
  source_id: string;
  from_mode: MultiDeviceMode;
  to_mode: MultiDeviceMode;
  owner_device_id: string;
  prepared_at: number;
  last_error: string | null;
}): SourceModeTransition {
  return {
    sourceId: SourceId(row.source_id),
    fromMode: row.from_mode,
    toMode: row.to_mode,
    ownerDeviceId: DeviceId(row.owner_device_id),
    preparedAt: row.prepared_at,
    lastError: row.last_error,
  };
}

export function getSourceModeTransition(db: Db, sourceId: SourceId): SourceModeTransition | null {
  const row = db
    .prepare<
      [string],
      {
        source_id: string;
        from_mode: MultiDeviceMode;
        to_mode: MultiDeviceMode;
        owner_device_id: string;
        prepared_at: number;
        last_error: string | null;
      }
    >("SELECT * FROM source_mode_transitions WHERE source_id = ?")
    .get(sourceId);
  return row ? rowToTransition(row) : null;
}

export function listPendingSourceModeTransitions(db: Db): SourceModeTransition[] {
  return db
    .prepare<
      [],
      {
        source_id: string;
        from_mode: MultiDeviceMode;
        to_mode: MultiDeviceMode;
        owner_device_id: string;
        prepared_at: number;
        last_error: string | null;
      }
    >("SELECT * FROM source_mode_transitions ORDER BY prepared_at, source_id")
    .all()
    .map(rowToTransition);
}

function assertUnambiguousSharedHistory(db: Db, sourceId: SourceId): void {
  for (const table of SQLITE_STREAM_TABLES) {
    const row = db
      .prepare<[string], { stream_id: string }>(
        `SELECT stream_id FROM ${table} INDEXED BY idx_${table}_source_nonshared_stream
          WHERE source_id = ? AND stream_id != '' LIMIT 1`,
      )
      .get(sourceId);
    if (row) {
      throw new SourceModeTransitionPrepareError(
        "ambiguous-history",
        `source ${sourceId} already has partitioned stream data in ${table}; refusing ambiguous transition`,
      );
    }
  }
  const cursor = db
    .prepare<[string], { device_id: string }>(
      `SELECT device_id FROM sync_state INDEXED BY idx_sync_state_source_nonshared_device
        WHERE source_id = ? AND device_id != '' LIMIT 1`,
    )
    .get(sourceId);
  if (cursor) {
    throw new SourceModeTransitionPrepareError(
      "ambiguous-history",
      `source ${sourceId} already has a per-device cursor; refusing ambiguous transition`,
    );
  }
}

/**
 * Move at most one fixed batch from SQLite's shared stream to the owner.
 * Progress is durable in the rows themselves, so a restart can simply call
 * this again. Every candidate lookup is served by migration 141's
 * `(source_id, stream_id)` index and the outer update seeks by rowid.
 */
export function adoptSourceModeTransitionBatch(
  db: Db,
  sourceId: SourceId,
  limit = SOURCE_MODE_ADOPTION_BATCH_SIZE,
): SourceModeTransitionAdoptionBatch {
  if (!Number.isInteger(limit) || limit < 1 || limit > SOURCE_MODE_ADOPTION_BATCH_SIZE) {
    throw new Error(
      `source mode adoption batch limit must be between 1 and ${SOURCE_MODE_ADOPTION_BATCH_SIZE}`,
    );
  }
  const pending = getSourceModeTransition(db, sourceId);
  if (!pending) {
    const source = getSource(db, sourceId);
    if (
      source &&
      (source.multiDeviceMode === "partitioned" || source.multiDeviceMode === "replicated")
    ) {
      return { moved: 0, complete: true };
    }
    throw new Error(`source ${sourceId} has no pending mode transition`);
  }
  const source = getSource(db, sourceId);
  if (!source || source.multiDeviceMode !== pending.fromMode) {
    throw new Error(`source ${sourceId} changed while its mode transition was pending`);
  }

  // Replicas share one logical corpus, so their existing shared-stream rows
  // are already in the authoritative storage scope. Only partitioned sources
  // need their legacy rows re-keyed to the owner's device stream.
  if (pending.toMode === "replicated") return { moved: 0, complete: true };
  for (const table of SQLITE_STREAM_TABLES) {
    const result = db
      .prepare(
        `UPDATE ${table} SET stream_id = ?
          WHERE rowid IN (
            SELECT rowid FROM ${table} INDEXED BY idx_${table}_source_stream
             WHERE source_id = ? AND stream_id = '' LIMIT ?
          )`,
      )
      .run(pending.ownerDeviceId, sourceId, limit);
    if (result.changes > 0) {
      return { moved: result.changes, complete: false };
    }
  }
  return { moved: 0, complete: true };
}

/**
 * Validate the reader-observed owner and its persisted capability contract,
 * persist the exclusive→multi-device intent, and move both cursor scopes to
 * one generation above every prior claim in a single short transaction. The
 * source row deliberately remains exclusive until every required store has
 * adopted the target mode's storage scope.
 */
export function prepareSourceModeTransition(
  db: Db,
  sourceId: SourceId,
  toMode: MultiDeviceMode,
  expectedOwnerDeviceId: DeviceId,
  preparedAt = Date.now(),
  expectedMemberScopedParams?: readonly string[],
  expectedReplicaVersionPolicy?: "source-updated-at",
): SourceModeTransition | null {
  return db
    .transaction(() => {
      const existingPending = getSourceModeTransition(db, sourceId);
      if (existingPending) {
        if (existingPending.toMode !== toMode) {
          throw new SourceModeTransitionPrepareError(
            "already-transitioning",
            `source ${sourceId} already has a transition to ${existingPending.toMode}`,
          );
        }
      }
      const source = getSource(db, sourceId);
      if (!source) {
        throw new SourceModeTransitionPrepareError("not-found", `source ${sourceId} not found`);
      }
      if (source.deviceId !== expectedOwnerDeviceId) {
        throw new SourceModeTransitionPrepareError(
          "membership-conflict",
          `source ${sourceId} owner changed before mode transition: expected ${expectedOwnerDeviceId}, found ${source.deviceId}`,
        );
      }
      if (isSourceCleanupPending(db, sourceId)) {
        throw new SourceModeTransitionPrepareError(
          "removal-pending",
          `source ${sourceId} removal is still pending`,
        );
      }
      const streamCleanup = db
        .prepare<[string], { found: number }>(
          `SELECT 1 AS found FROM source_stream_cleanups
            WHERE source_id = ? AND completed_at IS NULL LIMIT 1`,
        )
        .get(sourceId);
      if (streamCleanup) {
        throw new SourceModeTransitionPrepareError(
          "stream-cleanup-pending",
          `source ${sourceId} stream cleanup is still pending`,
        );
      }
      if (toMode !== "partitioned" && toMode !== "replicated") {
        throw new SourceModeTransitionPrepareError(
          "unsupported",
          `unsupported source mode transition ${source.multiDeviceMode} → ${toMode}; only exclusive → partitioned or replicated is supported`,
        );
      }
      // A caller can read the old mode, queue behind the winning transition,
      // and reach the writer only after that transition has finalized. Treat
      // the same owner already being at the requested mode as the idempotent
      // result of that stale request. Returning null completes that request at
      // this atomic observation point instead of running an unfenced second
      // adoption/finalization pass.
      if (!existingPending && source.multiDeviceMode === toMode) {
        return null;
      }
      if (source.multiDeviceMode !== "exclusive") {
        throw new SourceModeTransitionPrepareError(
          "unsupported",
          `unsupported source mode transition ${source.multiDeviceMode} → ${toMode}; only exclusive → partitioned or replicated is supported`,
        );
      }
      const members = listSourceMembers(db, sourceId);
      if (members.length !== 1 || members[0]?.deviceId !== source.deviceId) {
        throw new SourceModeTransitionPrepareError(
          "membership-conflict",
          `source ${sourceId} must have exactly its owner as a member before transition`,
        );
      }
      const owner = getDevice(db, source.deviceId);
      if (!owner) {
        throw new Error(`source ${sourceId} owner is unavailable for mode transition`);
      }
      if (owner.revokedAt !== null) {
        throw new SourceModeTransitionPrepareError(
          "owner-revoked",
          `source ${sourceId} owner device ${owner.id} is revoked`,
        );
      }
      if (!deviceSupportsMultiDeviceMode(owner, source.type, toMode)) {
        throw new Error(
          `source ${sourceId} owner does not support the ${toMode} contract for source type ${source.type}`,
        );
      }
      const advertisedReplicaVersionPolicy =
        owner.capabilities.replicaVersionPolicies?.[source.type];
      if (
        (toMode === "replicated" ? advertisedReplicaVersionPolicy : undefined) !==
        expectedReplicaVersionPolicy
      ) {
        throw new SourceModeTransitionPrepareError(
          "unsupported",
          `source ${sourceId} owner replica version contract changed before mode transition`,
        );
      }
      const advertised = advertisedMemberScopedParamNames(owner, source.type);
      if (advertised === null) {
        throw new SourceModeTransitionPrepareError(
          "unsupported",
          `source ${sourceId} owner does not advertise its member-local configuration contract`,
        );
      }
      const expected = expectedMemberScopedParams ?? advertised;
      if (!deviceMatchesMemberConfigContract(owner, source.type, expected)) {
        throw new SourceModeTransitionPrepareError(
          "unsupported",
          `source ${sourceId} owner member-local configuration contract changed before mode transition`,
        );
      }
      initializeOrAssertSourceMemberConfigContract(db, sourceId, expected);
      promoteLegacyMemberScopedParams(db, source, expected);
      if (existingPending) {
        if ((source.replicaVersionPolicy ?? undefined) !== expectedReplicaVersionPolicy) {
          throw new SourceModeTransitionPrepareError(
            "unsupported",
            `source ${sourceId} replica version contract changed during mode transition`,
          );
        }
        return existingPending;
      }
      assertUnambiguousSharedHistory(db, sourceId);
      db.prepare("UPDATE sources SET replica_version_policy = ? WHERE id = ?").run(
        expectedReplicaVersionPolicy ?? null,
        sourceId,
      );
      db.prepare(
        `INSERT INTO source_mode_transitions
           (source_id, from_mode, to_mode, owner_device_id, prepared_at, last_error)
         VALUES (?, 'exclusive', ?, ?, ?, NULL)`,
      ).run(sourceId, toMode, source.deviceId, preparedAt);
      const generation = db
        .prepare<[string], { generation: number }>(
          `SELECT COALESCE(MAX(epoch), 0) + 1 AS generation
               FROM source_wipe_epoch WHERE source_id = ?`,
        )
        .get(sourceId)!.generation;
      const assignGeneration = db.prepare(
        `INSERT INTO source_wipe_epoch (source_id, device_id, epoch) VALUES (?, ?, ?)
         ON CONFLICT(source_id, device_id) DO UPDATE SET epoch = excluded.epoch`,
      );
      assignGeneration.run(sourceId, "", generation);
      assignGeneration.run(sourceId, source.deviceId, generation);
      return getSourceModeTransition(db, sourceId)!;
    })
    .immediate();
}

/** Record a cross-store adoption failure without surrendering the fence. */
export function recordSourceModeTransitionFailure(
  db: Db,
  sourceId: SourceId,
  message: string,
): boolean {
  return (
    db
      .prepare("UPDATE source_mode_transitions SET last_error = ? WHERE source_id = ?")
      .run(message, sourceId).changes > 0
  );
}

/**
 * Adopt SQLite's cursor, flip the authoritative mode, and clear the journal
 * atomically after every row store has completed its bounded adoption.
 */
export function finalizeSourceModeTransition(
  db: Db,
  sourceId: SourceId,
  completedAt = Date.now(),
): SourceRecord {
  return db
    .transaction(() => {
      const pending = getSourceModeTransition(db, sourceId);
      if (!pending) {
        const source = getSource(db, sourceId);
        if (
          source &&
          (source.multiDeviceMode === "partitioned" || source.multiDeviceMode === "replicated")
        ) {
          return source;
        }
        throw new Error(`source ${sourceId} has no pending mode transition`);
      }
      const source = getSource(db, sourceId);
      if (!source || source.multiDeviceMode !== pending.fromMode) {
        throw new Error(`source ${sourceId} changed while its mode transition was pending`);
      }
      const members = listSourceMembers(db, sourceId);
      if (
        source.deviceId !== pending.ownerDeviceId ||
        members.length !== 1 ||
        members[0]?.deviceId !== pending.ownerDeviceId
      ) {
        throw new Error(`source ${sourceId} owner or membership changed during mode transition`);
      }
      const ownerDevice = getDevice(db, pending.ownerDeviceId);
      const memberConfigContract = getSourceMemberConfigContract(db, sourceId);
      if (
        !ownerDevice ||
        ownerDevice.revokedAt !== null ||
        !deviceSupportsMultiDeviceMode(ownerDevice, source.type, pending.toMode) ||
        (pending.toMode === "replicated" &&
          ownerDevice.capabilities.replicaVersionPolicies?.[source.type] !==
            (source.replicaVersionPolicy ?? undefined)) ||
        memberConfigContract === null ||
        !deviceMatchesMemberConfigContract(ownerDevice, source.type, memberConfigContract)
      ) {
        throw new Error(
          `source ${sourceId} owner no longer supports ${pending.toMode} or its prepared member-local configuration contract for source type ${source.type}`,
        );
      }
      const owner = pending.ownerDeviceId;
      if (pending.toMode === "partitioned") {
        for (const table of SQLITE_STREAM_TABLES) {
          const remaining = db
            .prepare(
              `SELECT 1 FROM ${table} INDEXED BY idx_${table}_source_stream
                WHERE source_id = ? AND stream_id = '' LIMIT 1`,
            )
            .get(sourceId);
          if (remaining) {
            throw new Error(`source ${sourceId} still has shared stream rows in ${table}`);
          }
        }
      }
      db.prepare(
        `INSERT INTO sync_state (
           source_id, device_id, cursor, last_synced_at, icon, label, url_patterns,
           last_error, errored_at, bg_color, accent_color, content_retention,
           consent_expires_at, last_document_at, minimum_gateway_version
         )
         SELECT source_id, ?, cursor, last_synced_at, icon, label, url_patterns,
                last_error, errored_at, bg_color, accent_color, content_retention,
                consent_expires_at, last_document_at, minimum_gateway_version
           FROM sync_state WHERE source_id = ? AND device_id = ''
         ON CONFLICT(source_id, device_id) DO UPDATE SET
           cursor = excluded.cursor,
           last_synced_at = excluded.last_synced_at,
           icon = excluded.icon,
           label = excluded.label,
           url_patterns = excluded.url_patterns,
           last_error = excluded.last_error,
           errored_at = excluded.errored_at,
           bg_color = excluded.bg_color,
           accent_color = excluded.accent_color,
           content_retention = excluded.content_retention,
           consent_expires_at = excluded.consent_expires_at,
           last_document_at = excluded.last_document_at,
           minimum_gateway_version = excluded.minimum_gateway_version`,
      ).run(owner, sourceId);
      // The shared row is also the source's presentation-metadata home. Keep
      // it, but clear the cursor/sync authority that moved to the owner row.
      db.prepare(
        `UPDATE sync_state
            SET cursor = '{}',
                last_synced_at = NULL,
                last_error = NULL,
                errored_at = NULL,
                consent_expires_at = NULL,
                last_document_at = NULL,
                minimum_gateway_version = 0
          WHERE source_id = ? AND device_id = ''`,
      ).run(sourceId);
      db.prepare("UPDATE sources SET multi_device_mode = ?, updated_at = ? WHERE id = ?").run(
        pending.toMode,
        completedAt,
        sourceId,
      );
      db.prepare(
        `INSERT INTO source_mode_transition_publications (source_id, completed_at, last_error)
         VALUES (?, ?, NULL)
         ON CONFLICT(source_id) DO UPDATE SET
           completed_at = excluded.completed_at,
           last_error = NULL`,
      ).run(sourceId, completedAt);
      db.prepare("DELETE FROM source_mode_transitions WHERE source_id = ?").run(sourceId);
      return getSource(db, sourceId)!;
    })
    .immediate();
}
