// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
type Db = Database.Database;
import { runSchemaSetup } from "./data/schema.js";
import { runDowngradeCompatCheck, runMigrations } from "./data/migrations.js";
import { openEncryptedSqlite } from "./sqlite-encryption.js";

// Re-export shared types so existing consumers keep working unchanged.
export type {
  StoredDocument,
  StoredSyncState,
  ListDocumentsOptions,
  ListedDocumentRow,
  UpsertDocumentsOptions,
  UpsertDocumentsResult,
  SourceStatsAggregation,
  LatestActivity,
  RecentDocument,
} from "./data/types.js";

// Re-export repository functions (the file used to inline these).
export {
  upsertDocuments,
  upsertWithCursor,
  upsertWithCursorYieldable,
  deleteDocuments,
  cascadeOpenLoopPrivacyDeleteWithMirrors,
  deleteDocumentsByIds,
  DELETE_IN_LIST_CHUNK,
  deleteDocumentForUser,
  deleteDocumentForRetention,
  completeDocumentRetention,
  tombstoneDocuments,
  deleteAllBySource,
  deleteAllByStream,
  deleteAllByProvider,
  getDocumentCount,
  getLatestActivityBySource,
  getRecentDocuments,
  listDocuments,
  listDocumentsLightweight,
  listDocumentIds,
  listDocumentsByIds,
  documentExistsForSource,
  getDocumentSourceIds,
  getDocumentTitlesAndSources,
  type DocumentTitleSource,
  lookupDocumentIdsByExternal,
  lookupDocumentIdsBySourceUrl,
  checkExistingExternalIds,
  fetchDocumentProjections,
  prepareDocumentsForWrite,
  type UpsertWithCursorArgs,
  type UpsertWithCursorResult,
  type SnapshotAbsenceOutcome,
  type DeleteAllByStreamResult,
  applyReplicaOmissions,
  type ReplicaOmissionArgs,
  type ReplicaVerdictOutcome,
} from "./data/repositories/DocumentRepository.js";

export {
  listClaimedExternalIds,
  listRestoredExternalIdsByDevice,
} from "./data/repositories/ReplicaDeletionClaimRepository.js";
export {
  judgeAnalyticsTombstones,
  listAnalyticsOmissionCandidates,
  recordAnalyticsPresence,
  recordAnalyticsRestorerOmissions,
  planAnalyticsSweep,
  recordAnalyticsSweepVerdict,
  analyticsSweepCandidateKey,
  listRestoredAnalyticsKeys,
  type AnalyticsTombstoneArgs,
  type AnalyticsTombstoneVerdict,
  type AnalyticsPresenceArgs,
  type AnalyticsRestorerSnapshotArgs,
  type AnalyticsSweepCandidate,
  type AnalyticsSweepPlan,
  type AnalyticsSweepVerdict,
} from "./data/repositories/AnalyticsReplicaClaimRepository.js";

export {
  applySnapshotAbsencePlan,
  computeSnapshotAbsencePlan,
  countPendingAbsences,
  listStaleAbsences,
  reclaimStaleAbsences,
  listPendingAbsenceCascades,
  acknowledgeAbsenceCascade,
  sweepDueAbsences,
  type AbsenceCascade,
  type AbsenceSweepBatch,
  type SnapshotAbsenceApplied,
  type SnapshotAbsencePlan,
  type SnapshotAbsencePolicy,
  type StaleAbsenceCandidate,
} from "./data/repositories/AbsenceRepository.js";

export {
  markSourceStatsDirty,
  listDirtyStatsSourceIds,
  computeSourceStatsRow,
  upsertSourceStatsRow,
  refreshSourceStatsRow,
  getSourceStats,
  getSourceStatsBulk,
} from "./data/repositories/SourceStatsRepository.js";

export {
  getSyncState,
  getWipeEpoch,
  bumpWipeEpoch,
  resetMemberCursor,
  resetSiblingMemberCursors,
  resetAllMemberCursors,
  beginSyncAttempt,
  revokeSyncAttempt,
  setSyncState,
  setSyncError,
  clearSyncError,
  listSyncStates,
  listSyncStatesForSource,
  getSourceMeta,
  setSourceMeta,
} from "./data/repositories/SyncStateRepository.js";

export {
  upsertSourceWatermark,
  listSourceWatermarks,
  getSourceWatermark,
  deleteSourceWatermark,
  type StoredSourceWatermark,
} from "./data/repositories/WatermarkRepository.js";

export {
  getCachedUrlIdPatterns,
  invalidateUrlIdPatternCache,
} from "./data/repositories/UrlPatternRepository.js";

export {
  getReauthReminder,
  clearReauthReminder,
  reserveReauthReminder,
  commitReauthReminder,
  releaseReauthReminder,
} from "./data/repositories/ReauthRemindersRepository.js";

export { retryOnBusy } from "./data/retry.js";

/**
 * Open omnesis.db **read-only** for main-thread use. The
 * main thread must not hold a writable handle; every mutation goes
 * through the writer worker (see write-gate.ts / writer-worker.ts).
 * `fileMustExist: true` ensures a typo'd path doesn't silently create
 * an empty DB — the writer worker's `createDatabase` is the only path
 * that ever creates + migrates.
 */
export interface GatewayDatabaseOptions {
  encryptionKey?: Buffer | null;
  /**
   * Page-cache budget in BYTES for this read handle. A larger cache keeps more
   * hot pages resident, which under storage encryption avoids re-DECRYPTING
   * those pages on every read — the dominant cost of a warm read on an encrypted
   * store. When omitted, SQLite's default (~2 MiB) applies.
   */
  cacheSizeBytes?: number;
}

export function openReadOnlyDatabase(path: string, opts: GatewayDatabaseOptions = {}): Db {
  const db = opts.encryptionKey
    ? (openEncryptedSqlite(path, {
        key: opts.encryptionKey,
        readonly: true,
        fileMustExist: true,
        migratePlaintext: false,
      }) as unknown as Db)
    : new Database(path, { readonly: true, fileMustExist: true });
  db.exec("PRAGMA busy_timeout = 5000");
  if (opts.cacheSizeBytes != null) {
    // Negative cache_size is a byte budget (KiB); mirror the indexer's clamp.
    const cacheKib = Math.max(2, Math.floor(opts.cacheSizeBytes / 1024));
    db.exec(`PRAGMA cache_size = -${cacheKib}`);
  }
  // Disable mmap-based reads — same rationale as the writer handle.
  db.exec("PRAGMA mmap_size = 0");
  return db;
}

export function createDatabase(path: string, opts: GatewayDatabaseOptions = {}): Db {
  const db = opts.encryptionKey
    ? (openEncryptedSqlite(path, { key: opts.encryptionKey }) as unknown as Db)
    : new Database(path);

  const isNewDatabase =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get() === undefined;
  // This has to precede journal_mode as well as schema creation. Once a new
  // file enters WAL mode SQLite no longer applies the auto-vacuum mode change
  // without a full VACUUM.
  if (isNewDatabase) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  // Disable mmap-based reads on the main DB file. Multiple connections
  // across main thread + backfill worker race against WAL checkpoints
  // that extend/relocate DB pages; the kernel then delivers SIGBUS when a
  // reader's mmap tries to page in a now-stale region. Forcing pread() is
  // a ~few-% read cost on our workload and removes `readDbPage →
  // getPageNormal` as a crash surface (see crashes node-2026-04-23-*.ips,
  // tracked separately).
  db.exec("PRAGMA mmap_size = 0");
  // Incremental auto-vacuum must be selected before the first table is
  // created. Existing installs are deliberately left unchanged: converting
  // mode NONE online requires a full, exclusive VACUUM and can need roughly
  // twice the database's size in free space.
  runSchemaSetup(db);
  runDowngradeCompatCheck(db); // Per-source cursor reset on downgrade
  runMigrations(db);

  return db;
}
