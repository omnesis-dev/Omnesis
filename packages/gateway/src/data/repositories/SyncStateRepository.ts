// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { clearRestoredClaims } from "./ReplicaDeletionClaimRepository.js";
import { clearPendingSourcePages } from "./PendingSourcePageRepository.js";
import { setSourceAccount } from "./SourceAccountRepository.js";
import { getSourceFamilyMeta, setSourceFamilyMeta } from "./SourceFamilyMetaRepository.js";

import type Database from "better-sqlite3";
type Db = Database.Database;
import { retryOnBusy } from "../retry.js";
import {
  syncErrorRemediationCodec,
  syncStateCursorCodec,
  type SyncStateCursor,
} from "../json-columns.js";
import { LATEST_SCHEMA_VERSION } from "../migrations.js";
import type { StoredSyncState } from "../types.js";
import type { SourceMeta, SourceMetaEntry, SourceSyncMeta, SyncCursor } from "@omnesis/source-sdk";
import { sourceTypeOf } from "@omnesis/types";
import type { SyncRemediation } from "@omnesis/types";

/**
 * One source's sync-state row. `deviceId` selects the row: `""` is the shared
 * row every exclusive/handoff source syncs on; a device id is that member's
 * own row (replicated/partitioned sources).
 */
export function getSyncState(db: Db, sourceId: string, deviceId = ""): StoredSyncState | null {
  return (
    db
      .prepare<
        [string, string],
        StoredSyncState
      >("SELECT * FROM sync_state WHERE source_id = ? AND device_id = ?")
      .get(sourceId, deviceId) ?? null
  );
}

/**
 * Current write epoch of one cursor row (legacy wire name: wipeEpoch) —
 * `""` the shared row, a device id a member's own. It advances for every
 * sync attempt on that row and for every wipe of the source, so stale
 * writers lose authority.
 */
export function getWipeEpoch(db: Db, sourceId: string, deviceId = ""): number {
  const row = db
    .prepare<
      [string, string],
      { epoch: number }
    >("SELECT epoch FROM source_wipe_epoch WHERE source_id = ? AND device_id = ?")
    .get(sourceId, deviceId);
  return row?.epoch ?? 0;
}

/**
 * Wipe a source or one of its cursor rows. Without `deviceId` every row's
 * epoch advances, so a sync that began before the wipe is rejected when it
 * tries to advance its cursor, whichever row it holds; the shared row
 * is created if the source never claimed one. With `deviceId` only that
 * member's row advances — a stream wipe or a per-device resync must not
 * revoke the siblings' claims — and the row is created if absent, so a
 * writer that read epoch 0 before the wipe is refused as well.
 */
export function bumpWipeEpoch(db: Db, sourceId: string, deviceId?: string): void {
  clearPendingSourcePages(db, sourceId, deviceId);
  if (deviceId === undefined) {
    db.prepare(
      "INSERT OR IGNORE INTO source_wipe_epoch (source_id, device_id, epoch) VALUES (?, '', 0)",
    ).run(sourceId);
    db.prepare("UPDATE source_wipe_epoch SET epoch = epoch + 1 WHERE source_id = ?").run(sourceId);
    return;
  }
  db.prepare(
    "INSERT OR IGNORE INTO source_wipe_epoch (source_id, device_id, epoch) VALUES (?, ?, 0)",
  ).run(sourceId, deviceId);
  db.prepare(
    "UPDATE source_wipe_epoch SET epoch = epoch + 1 WHERE source_id = ? AND device_id = ?",
  ).run(sourceId, deviceId);
}

/**
 * Send one member back to a bootstrap: its cursor row is left in place with
 * no completed sync on it (`last_synced_at` NULL), which `GET /sync-state`
 * reports as no cursor, and the row's epoch advances so a sync that began
 * before the reset cannot write its stale cursor back. The row is kept rather
 * than deleted because a member whose row is missing adopts the shared row —
 * and the shared cursor is exactly what a resync must not resume from.
 * Display metadata on the row survives.
 */
export function resetMemberCursor(db: Db, sourceId: string, deviceId: string): void {
  db.prepare(
    `INSERT INTO sync_state (source_id, device_id, cursor, last_synced_at)
     VALUES (?, ?, '{}', NULL)
     ON CONFLICT(source_id, device_id) DO UPDATE SET
       cursor = '{}',
       last_synced_at = NULL,
       last_error = NULL,
       errored_at = NULL,
       last_error_remediation = NULL`,
  ).run(sourceId, deviceId);
  bumpWipeEpoch(db, sourceId, deviceId);
  // A member sent back to bootstrap vouches for its replica from scratch.
  clearRestoredClaims(db, sourceId, { deviceId });
}

/**
 * Reset every member cursor except `deviceId` after one replica authoritatively
 * deletes shared data. Membership is resolved by these statements themselves,
 * so a concurrent join cannot fall between a reader-side member list and the
 * writer transaction. Both operations are set-based to keep writer work
 * bounded independently of the replica count.
 */
export function resetSiblingMemberCursors(db: Db, sourceId: string, deviceId: string): void {
  db.prepare(
    "DELETE FROM pending_source_pages WHERE source_id = ? AND cursor_row != ? AND cursor_row IN (SELECT device_id FROM source_devices WHERE source_id = ?)",
  ).run(sourceId, deviceId, sourceId);
  db.prepare(
    `INSERT INTO sync_state (source_id, device_id, cursor, last_synced_at)
     SELECT source_id, device_id, '{}', NULL
     FROM source_devices
     WHERE source_id = ? AND device_id != ?
     ON CONFLICT(source_id, device_id) DO UPDATE SET
       cursor = '{}',
       last_synced_at = NULL,
       last_error = NULL,
       errored_at = NULL,
       last_error_remediation = NULL`,
  ).run(sourceId, deviceId);
  db.prepare(
    `INSERT INTO source_wipe_epoch (source_id, device_id, epoch)
     SELECT source_id, device_id, 1
     FROM source_devices
     WHERE source_id = ? AND device_id != ?
     ON CONFLICT(source_id, device_id) DO UPDATE SET epoch = epoch + 1`,
  ).run(sourceId, deviceId);
  clearRestoredClaims(db, sourceId, { exceptDeviceId: deviceId });
}

/**
 * Reset every replica cursor after a snapshot-derived deletion. The absence
 * sweep acts on evidence several members may have contributed to, so every
 * member is sent back to bootstrap: the incomplete replica may vouch for the
 * absence again, while any healthy sibling gets the opportunity to restore
 * the shared row. Each member's restores are withdrawn until its bootstrap
 * re-states them.
 */
export function resetAllMemberCursors(db: Db, sourceId: string): void {
  clearPendingSourcePages(db, sourceId);
  db.prepare(
    `INSERT INTO sync_state (source_id, device_id, cursor, last_synced_at)
     SELECT source_id, device_id, '{}', NULL
     FROM source_devices
     WHERE source_id = ?
     ON CONFLICT(source_id, device_id) DO UPDATE SET
       cursor = '{}',
       last_synced_at = NULL,
       last_error = NULL,
       errored_at = NULL,
       last_error_remediation = NULL`,
  ).run(sourceId);
  db.prepare(
    `INSERT INTO source_wipe_epoch (source_id, device_id, epoch)
     SELECT source_id, device_id, 1
     FROM source_devices
     WHERE source_id = ?
     ON CONFLICT(source_id, device_id) DO UPDATE SET epoch = epoch + 1`,
  ).run(sourceId);
  clearRestoredClaims(db, sourceId, "all");
}

/**
 * Every cursor row a write on the source can be fenced on: the shared row
 * (`""`) and each device row known to the source — its current members,
 * plus any row that still carries an epoch or a cursor for a device that
 * has since detached. A source-wide purge serializes behind all of them
 * (see `SourceWriteEpochFence.runAll`), so no row's in-flight ingest can
 * land after it.
 */
export function listCursorRows(db: Db, sourceId: string): string[] {
  const rows = db
    .prepare<[string, string, string], { device_id: string }>(
      `SELECT device_id FROM source_devices WHERE source_id = ?
       UNION SELECT device_id FROM source_wipe_epoch WHERE source_id = ?
       UNION SELECT device_id FROM sync_state WHERE source_id = ?`,
    )
    .all(sourceId, sourceId, sourceId)
    .map((r) => r.device_id);
  return [...new Set(["", ...rows])].sort();
}

/** Claim exclusive write authority for one new sync attempt on a cursor row. */
export function beginSyncAttempt(db: Db, sourceId: string, deviceId = ""): number {
  db.prepare(
    `INSERT INTO source_wipe_epoch (source_id, device_id, epoch) VALUES (?, ?, 1)
     ON CONFLICT(source_id, device_id) DO UPDATE SET epoch = epoch + 1`,
  ).run(sourceId, deviceId);
  return getWipeEpoch(db, sourceId, deviceId);
}

/** Revoke one timed-out attempt on a cursor row without superseding a newer claim. */
export function revokeSyncAttempt(
  db: Db,
  sourceId: string,
  expectedEpoch: number,
  deviceId = "",
): boolean {
  return (
    db
      .prepare(
        "UPDATE source_wipe_epoch SET epoch = epoch + 1 WHERE source_id = ? AND device_id = ? AND epoch = ?",
      )
      .run(sourceId, deviceId, expectedEpoch).changes > 0
  );
}

export function setSyncState(
  db: Db,
  sourceId: string,
  cursor: SyncCursor,
  meta?: SourceSyncMeta,
  /**
   * Forward-looking consent deadline (ISO 8601) the source reported this page.
   *`undefined` leaves the stored value unchanged (the common case —
   * a source with no known deadline); an explicit string SETS it; an explicit
   * `null` CLEARS it (re-consent that no longer expires). The undefined-vs-null
   * distinction is preserved by writing the prior value back on `undefined`
   * rather than COALESCE-ing — COALESCE could not express an explicit clear.
   */
  consentExpiresAt?: string | null,
  /**
   * Whether the page being committed actually carried documents. Only `true`
   * advances `last_document_at`; the empty-page case must leave it alone, since
   * the whole point is to remember when this source last produced something.
   * Cursor-only callers (metadata refresh, hand-written cursor writes) leave it
   * unset and so never disturb the stamp.
   */
  hadDocuments = false,
  writeEpoch?: number,
  /** The row to write: `""` (shared) or a member device's own row. */
  deviceId = "",
): boolean {
  if (
    db
      .prepare<[string], { found: number }>("SELECT 1 AS found FROM removed_sources WHERE id = ?")
      .get(sourceId)
  ) {
    return false;
  }
  const currentWriteEpoch = getWipeEpoch(db, sourceId, deviceId);
  if ((writeEpoch !== undefined || currentWriteEpoch > 0) && writeEpoch !== currentWriteEpoch) {
    return false;
  }
  // The family declaration rides with the source's own, so it lands on the
  // first sync of the first account rather than waiting for the collector's
  // next boot pass — which is the difference between a source added mid-session
  // showing its family icon now and showing it after a restart.
  if (meta?.family) setSourceFamilyMeta(db, sourceTypeOf(sourceId), meta.family);
  if (meta?.account) setSourceAccount(db, sourceId, meta.account);
  const now = new Date().toISOString();
  // `undefined` means "leave unchanged" — read the current value so the upsert
  // writes it back verbatim; an explicit value (string or null) overrides it.
  const nextConsent =
    consentExpiresAt === undefined
      ? (getSyncState(db, sourceId, deviceId)?.consent_expires_at ?? null)
      : consentExpiresAt;
  // A successful cursor save also clears any previously persisted error —
  // the source has reached a known-good state. Any incoming error event
  // for a future failed cycle will repopulate last_error/errored_at.
  retryOnBusy(
    () =>
      db
        .prepare(
          `INSERT INTO sync_state (source_id, device_id, cursor, last_synced_at, icon, label, url_patterns, bg_color, accent_color, content_retention, consent_expires_at, last_document_at, last_error, errored_at, last_error_remediation, minimum_gateway_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
       ON CONFLICT(source_id, device_id) DO UPDATE SET
         cursor = excluded.cursor,
         last_synced_at = excluded.last_synced_at,
         last_document_at = COALESCE(excluded.last_document_at, sync_state.last_document_at),
         icon = COALESCE(excluded.icon, sync_state.icon),
         label = COALESCE(excluded.label, sync_state.label),
         url_patterns = COALESCE(excluded.url_patterns, sync_state.url_patterns),
         bg_color = COALESCE(excluded.bg_color, sync_state.bg_color),
         accent_color = COALESCE(excluded.accent_color, sync_state.accent_color),
         content_retention = COALESCE(excluded.content_retention, sync_state.content_retention),
         consent_expires_at = excluded.consent_expires_at,
         last_error = NULL,
         errored_at = NULL,
         last_error_remediation = NULL,
         minimum_gateway_version = excluded.minimum_gateway_version`,
        )
        .run(
          sourceId,
          deviceId,
          syncStateCursorCodec.serialize(cursor as SyncStateCursor),
          now,
          meta?.icon ?? null,
          meta?.label ?? null,
          meta?.urlPatterns ? JSON.stringify(meta.urlPatterns) : null,
          meta?.bgColor ?? null,
          meta?.accentColor ?? null,
          meta?.contentRetention ?? null,
          nextConsent,
          hadDocuments ? now : null,
          LATEST_SCHEMA_VERSION,
        ),
    { op: "setSyncState" },
  );
  return true;
}

/**
 * Persist a sync error for a source. Writes `last_error` + `errored_at`
 * without touching `cursor` or `last_synced_at`, so the next read can
 * tell "errored after a previously-good sync" from "errored before any
 * sync ever succeeded". The remediation is written with the message and
 * cleared with it: an error reported without one replaces whatever the
 * previous error carried.
 */
export function setSyncError(
  db: Db,
  sourceId: string,
  errorMessage: string,
  /** The row to stamp: `""` (shared) or a member device's own row. */
  deviceId = "",
  remediation?: SyncRemediation,
): void {
  const now = new Date().toISOString();
  // Cap the message at a sane size — the column is unbounded TEXT but
  // there's no point persisting a 50KB stack trace.
  const truncated = errorMessage.length > 2000 ? `${errorMessage.slice(0, 2000)}…` : errorMessage;
  const remediationJson = remediation ? syncErrorRemediationCodec.serialize(remediation) : null;
  retryOnBusy(
    () =>
      db
        .prepare(
          `INSERT INTO sync_state (source_id, device_id, cursor, last_synced_at, last_error, errored_at, last_error_remediation)
       VALUES (?, ?, '{}', NULL, ?, ?, ?)
       ON CONFLICT(source_id, device_id) DO UPDATE SET
         last_error = excluded.last_error,
         errored_at = excluded.errored_at,
         last_error_remediation = excluded.last_error_remediation`,
        )
        .run(sourceId, deviceId, truncated, now, remediationJson),
    { op: "setSyncError" },
  );
}

/**
 * Clear the persisted error fields for a source — one member's row when
 * `deviceId` is given, every row of the source otherwise. No-op if nothing
 * matches.
 */
export function clearSyncError(db: Db, sourceId: string, deviceId?: string): void {
  retryOnBusy(
    () =>
      deviceId === undefined
        ? db
            .prepare(
              `UPDATE sync_state SET last_error = NULL, errored_at = NULL, last_error_remediation = NULL WHERE source_id = ?`,
            )
            .run(sourceId)
        : db
            .prepare(
              `UPDATE sync_state SET last_error = NULL, errored_at = NULL, last_error_remediation = NULL WHERE source_id = ? AND device_id = ?`,
            )
            .run(sourceId, deviceId),
    { op: "clearSyncError" },
  );
}

/** List every persisted sync_state row. Used to derive display state across restarts. */
export function listSyncStates(db: Db): StoredSyncState[] {
  return db.prepare<[], StoredSyncState>("SELECT * FROM sync_state").all();
}

/** Every cursor row of one source: the shared row and each member's own. */
export function listSyncStatesForSource(db: Db, sourceId: string): StoredSyncState[] {
  return db
    .prepare<[string], StoredSyncState>("SELECT * FROM sync_state WHERE source_id = ?")
    .all(sourceId);
}

/**
 * UPSERT only per-source display/query metadata into `sync_state`. Leaves
 * `cursor`, `last_synced_at`, and error fields
 * untouched on conflict. On insert, `cursor` is seeded to `'{}'` and
 * `last_synced_at` to NULL so the row is well-formed without claiming a sync
 * ever ran.
 *
 * Consumers (`getSourceMeta`, `/portal/source-meta.json`, iOS
 * `SourceIconView`) read display columns; this helper is how a
 * gateway-hosted source registers its display identity once at boot.
 */
export function setSourceMeta(db: Db, sourceId: string, meta: SourceSyncMeta): void {
  db.transaction(() => setSourceMetaInTransaction(db, sourceId, meta))();
}

function setSourceMetaInTransaction(db: Db, sourceId: string, meta: SourceSyncMeta): void {
  if (meta.account) setSourceAccount(db, sourceId, meta.account);
  if (meta.family) setSourceFamilyMeta(db, sourceTypeOf(sourceId), meta.family);
  retryOnBusy(
    () =>
      db
        .prepare(
          `INSERT INTO sync_state
             (source_id, cursor, last_synced_at, icon, label, url_patterns, bg_color, accent_color, content_retention)
           SELECT ?, '{}', NULL, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM removed_sources WHERE id = ?)
           ON CONFLICT(source_id, device_id) DO UPDATE SET
             icon = COALESCE(excluded.icon, sync_state.icon),
             label = COALESCE(excluded.label, sync_state.label),
             url_patterns = COALESCE(excluded.url_patterns, sync_state.url_patterns),
             bg_color = COALESCE(excluded.bg_color, sync_state.bg_color),
             accent_color = COALESCE(excluded.accent_color, sync_state.accent_color),
             content_retention = COALESCE(excluded.content_retention, sync_state.content_retention)`,
        )
        .run(
          sourceId,
          meta.icon ?? null,
          meta.label ?? null,
          meta.urlPatterns ? JSON.stringify(meta.urlPatterns) : null,
          meta.bgColor ?? null,
          meta.accentColor ?? null,
          meta.contentRetention ?? null,
          sourceId,
        ),
    { op: "setSourceMeta" },
  );
}

/**
 * Get source metadata from sync_state.
 *
 * Returns a map keyed by BOTH full sourceId (e.g. `browser-history:chrome`)
 * AND source type (e.g. `browser-history`). Consumers look up the full
 * sourceId first and fall back to the type-level entry, so a client that
 * displays a source by family still has an icon and a label.
 *
 * Explicit family declarations win. A legacy peer cannot declare a family;
 * its sole source may supply the fallback until it upgrades. Once a family
 * has multiple sources there is no safe account to choose, including when
 * only one has pushed metadata yet.
 */
export function getSourceMeta(db: Db): SourceMeta {
  const rows = db
    .prepare<
      [],
      {
        source_id: string;
        icon: string | null;
        label: string | null;
        bg_color: string | null;
        accent_color: string | null;
      }
    >(
      `SELECT source_id, icon, label, bg_color, accent_color
       FROM sync_state
       WHERE icon IS NOT NULL OR label IS NOT NULL OR bg_color IS NOT NULL OR accent_color IS NOT NULL`,
    )
    .all();
  // Family declarations first: a source whose id IS its type (one that names
  // no account) then overwrites its own key with its own row, which is the
  // same declaration read at the level that owns it.
  const meta: SourceMeta = { ...getSourceFamilyMeta(db) };
  for (const row of rows) {
    const entry: SourceMetaEntry = {};
    if (row.icon) entry.icon = row.icon;
    if (row.label) entry.label = row.label;
    if (row.bg_color) entry.bgColor = row.bg_color;
    if (row.accent_color) entry.accentColor = row.accent_color;
    if (entry.icon || entry.label || entry.bgColor || entry.accentColor)
      meta[row.source_id] = entry;
  }
  const singleton = new Map<string, string | null>();
  const identities = db
    .prepare<
      [],
      { source_id: string }
    >("SELECT source_id FROM sync_state UNION SELECT id AS source_id FROM sources")
    .all();
  for (const { source_id: id } of identities) {
    const type = sourceTypeOf(id);
    if (!singleton.has(type)) singleton.set(type, id);
    else if (singleton.get(type) !== id) singleton.set(type, null);
  }
  for (const [type, id] of singleton) {
    if (id && !meta[type] && meta[id]) meta[type] = { ...meta[id] };
  }
  return meta;
}
