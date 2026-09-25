// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createNotificationQueueTables } from "../push/queue.js";
import {
  createBriefsStorageTables,
  createBriefClaimsTables,
  createAnnotationStorageTables,
  createPersonAnnotationStorageTables,
  createConsumptionEdgesTables,
  createBootstrapMarkerIndexes,
} from "../brain/index.js";
import { createConversationReadStateTables } from "../agent/conversation-read-state.js";
import { createDevAnnotationsTables } from "../dev-annotations/store.js";
import { createExtractedDatesTables } from "../enrichment/dates/storage.js";
import { createTemporalAnnotationTables } from "../enrichment/temporal-annotations/storage.js";
import { createDocumentTemporalProjectionTables } from "../enrichment/temporal-projections/document-storage.js";
import { createNoteEntriesTables } from "../sources/omnesis-notes/storage.js";
import { createAgentMessagesTables } from "../sources/agent-conversations/storage.js";
import { createAccessTables } from "../access/store.js";
import { createAnswerPrivacyTables, createDirectAuditTables } from "../privacy/store.js";
import { createSubscriptionTables } from "../subscriptions/store-schema.js";
import { addSourceSyncIssues } from "./migration-179-source-sync-issues.js";
import { addPendingSourcePages } from "./migration-178-pending-source-pages.js";
import { addSourceWireContracts } from "./migration-177-source-wire-contract.js";
import { installCollectorRosterRevision, installMutableListRevisions } from "./list-revisions.js";
import { createCanonicalizationStateTable } from "./repositories/CanonicalizationStateRepository.js";
import { createReauthRemindersTable } from "./repositories/ReauthRemindersRepository.js";
import { createMobilePermissionHealthTable } from "./repositories/MobilePermissionHealthRepository.js";
import { createSourceDocumentProfilesTable } from "./repositories/SourceDocumentProfileRepository.js";
import { createSourceStreamCleanupTable } from "./repositories/SourceStreamCleanupRepository.js";
import {
  createSourceModeTransitionIndexes,
  createSourceModeTransitionPublicationTable,
  createSourceModeTransitionTable,
} from "./repositories/SourceModeTransitionRepository.js";
import { createSourceMemberConfigContractTable } from "./repositories/SourceMemberConfigContractRepository.js";
import { createReplicaDeletionClaimsTable } from "./repositories/ReplicaDeletionClaimRepository.js";
import { createDeviceDoctorRunsTable } from "./repositories/DeviceDoctorRunRepository.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/**
 * Idempotent schema setup for `omnesis.db`. Creates every table, index,
 * and singleton seed row used by the gateway. Safe to run on every
 * boot — `CREATE TABLE IF NOT EXISTS` and `INSERT OR IGNORE` make
 * each statement a no-op when the schema already matches.
 *
 * Connection-level PRAGMAs stay in `createDatabase` — they're per-handle
 * concerns, not schema.
 *
 * Wrapping the body in a single transaction means a power cut between
 * a `CREATE TABLE` and the matching singleton seed (`INSERT OR IGNORE
 * INTO link_stats VALUES (1)` etc.) cannot leave the table created
 * but the seed row missing. Without that, the first `markLinkStatsDirty
 * UPDATE … WHERE id = 1` would silently no-op and the dirty-version
 * mechanism would never fire until something repopulated the row.
 *
 * Multi-step shape changes that idempotent CREATEs cannot express
 * (column rename, CHECK widen, back-fill) live in `migrations.ts` and
 * run after this function via the `PRAGMA user_version` runner.
 */
export function runSchemaSetup(db: Db): void {
  db.transaction(() => runSchemaSetupInTxn(db))();
}

function runSchemaSetupInTxn(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      -- The contributing device's stream of a partitioned source; '' for a
      -- source with one stream. An external id is unique within a stream; the
      -- stream is the last key column so a lookup without it still seeks.
      stream_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      extracted_content_hash TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      source_created_at TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_url TEXT,
      people_resolved_at TEXT,
      links_extracted_at TEXT,
      dates_extracted_at TEXT,
      dates_truncated INTEGER,
      bootstrap_processed_at TEXT,
      bootstrap_failed_at TEXT,
      -- Which of the source's own partitions this document was read from — an
      -- address book, a notebook, a vault. Deliberately NOT part of the unique
      -- key: a note moved between notebooks is the same note. It exists so a
      -- per-partition snapshot claim can be acted on; the empty string (a
      -- source with one backing store) is the overwhelming majority.
      partition_key TEXT NOT NULL DEFAULT '',
      UNIQUE(provider_id, source_id, external_id, stream_id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_documents_source
      ON documents(provider_id, source_id)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_documents_updated_at
      ON documents(updated_at)
  `);
  // Compound index for the `listDocuments` watermark-paginated query:
  // `WHERE updated_at >= ? AND id > ? ORDER BY
  // id ASC LIMIT N`. Without this, SQLite's planner chose the PK scan
  // (id ASC) and walked all 264k rows checking updated_at for every
  // page — turning a watermark-is-now no-op read into a 20s full scan.
  // The covering index lets it range-scan updated_at and skip rows
  // outside the window entirely.
  db.exec("CREATE INDEX IF NOT EXISTS idx_documents_updated_at_id ON documents(updated_at, id)");

  // Indexes on the upstream timestamp columns so MIN/MAX and date-range
  // WHERE clauses don't fall back to a full-table scan. Used by
  // /sqlite/activity, /sqlite/catalog previews, and the sparkline query
  // on the Data view — without these, each one is a multi-second scan
  // of the 260k-row documents table.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_source_created_at ON documents(source_created_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_source_updated_at ON documents(source_updated_at)",
  );
  // Single-column source_id index so `WHERE source_id = ?` (without
  // provider_id) can use an index — the compound `(provider_id,
  // source_id)` index only covers queries constrained by the leading
  // column. Affects /documents/count, getSourceStats, and several other
  // per-source lookups that can show up as 5s stalls under load.
  db.exec("CREATE INDEX IF NOT EXISTS idx_documents_source_id ON documents(source_id)");
  // Compound index for getRecentDocuments: `WHERE source_id = ? ORDER BY
  // source_created_at DESC LIMIT N`. Without this, the single-column
  // source_id index loads every matching row and then a temp B-tree sorts
  // them — 146k rows for Gmail = 6-9s per call. With the compound index
  // SQLite walks it in reverse and stops at LIMIT — <1ms.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_source_id_created_at ON documents(source_id, source_created_at)",
  );
  // Sibling compound index keyed on gateway-side updated_at, used by the
  // "Last activity" popover on the Sources view to fetch the most recently
  // ingested-or-modified doc per source. Without it the lookup falls back
  // to idx_documents_source_id and a temp sort — fine for tiny sources but
  // 100ms+ for Gmail at 2s poll cadence × 23 sources.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_source_id_updated_at ON documents(source_id, updated_at)",
  );

  // Partial index supporting #264 / #271 / cross-source dedup — duplicate
  // -content detection between binary-extracted docs (attachments and
  // Drive files). Indexed on `extracted_content_hash` so a Drive PDF
  // (whose `content` is wrapped with a markdown header) and the same PDF
  // attached to an email (whose `content` is the raw extracted text) can
  // match — the wrapped/unwrapped split made `content_hash` diverge for
  // identical bytes. Keep the predicate in sync with the
  // `BINARY_EXTRACTED_DOC_TYPES` set in `domain/LinkGraphService.ts`.
  //
  // Idempotent migration: prior installs indexed `content_hash`. Drop and
  // recreate on the new column.
  db.exec("DROP INDEX IF EXISTS idx_documents_attachment_content_hash");
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_documents_attachment_content_hash
       ON documents(extracted_content_hash)
       WHERE json_extract(metadata, '$.documentType') IN ('attachment', 'file')
         AND extracted_content_hash IS NOT NULL`,
  );

  // Partial index supporting #266 — calendar-event link resolution by
  // RFC 5545 iCalUID. `resolveCalendarEventLink` queries by
  // `json_extract(metadata, '$.extra.iCalUID')`; without an expression
  // index it would scan every document on every link insert. Partial on
  // `IS NOT NULL` keeps the index tiny — only event docs land here.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_documents_ical_uid
       ON documents(json_extract(metadata, '$.extra.iCalUID'))
       WHERE json_extract(metadata, '$.extra.iCalUID') IS NOT NULL`,
  );

  // Expression index for contact-type documents. The boot-time
  // seedFromContacts scan queries
  // `WHERE json_extract(metadata, '$.documentType') = 'contact'`;
  // without an index it full-scans 260k+ documents.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_documents_contact_type
       ON documents(json_extract(metadata, '$.documentType'))
       WHERE json_extract(metadata, '$.documentType') = 'contact'`,
  );

  // Keyed per (source, device): the empty-string device_id is the shared
  // row — one cursor for the whole source, the shape `exclusive`/`handoff`
  // sources use. A real device_id scopes a cursor to
  // one contributor (`replicated`/`partitioned` sources, where each device
  // bookmarks its own replica or stream). Presentation metadata (icon,
  // label, url_patterns, colors) is source-level and lives on the shared
  // row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      source_id TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      cursor TEXT NOT NULL DEFAULT '{}',
      last_synced_at TEXT,
      icon TEXT,
      label TEXT,
      url_patterns TEXT,
      last_error TEXT,
      errored_at TEXT,
      last_error_remediation TEXT,
      bg_color TEXT,
      accent_color TEXT,
      content_retention TEXT,
      consent_expires_at TEXT,
      last_document_at TEXT,
      minimum_gateway_version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source_id, device_id)
    )
  `);

  // A source family's display identity, as its definition declares it —
  // separate from `sync_state` because that table's display columns belong to
  // one source, and for an accounted source they are whatever that account
  // chose. Clients that show a source by family read this. No foreign key to
  // `sources`: the declaration arrives with the collector's meta push and is
  // meaningful before any account of the type has synced.
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_family_meta (
      source_type TEXT PRIMARY KEY,
      icon TEXT,
      label TEXT,
      bg_color TEXT,
      accent_color TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  addSourceWireContracts(db);
  addPendingSourcePages(db);
  addSourceSyncIssues(db);

  // Monotonic write epoch per cursor row (legacy table/wire name: wipe
  // epoch), keyed like `sync_state`: `''` is the shared row, a device id a
  // member's own row. Every sync attempt claims a new epoch on the row it
  // advances, so members of a replicated source fence only themselves; every
  // delete-all / resync bumps every row of the source, so a wipe rejects each
  // in-flight attempt whatever row it holds. Kept outside sync_state so a
  // wipe cannot erase its own fence. The collector echoes its claimed epoch
  // on each write; stale overlapping runs and pre-wipe runs are rejected
  // before they can regress documents/cursors. See #551.
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_wipe_epoch (
      source_id TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      epoch INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source_id, device_id)
    )
  `);

  // V1 has one implicit stream ("default") per configured source. Keeping it
  // in the key makes a later source-partition refinement additive while the
  // current product and source contracts remain source-level.
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_watermarks (
      source_id TEXT NOT NULL,
      stream_id TEXT NOT NULL DEFAULT 'default',
      guarantee TEXT NOT NULL,
      semantic_time_through TEXT,
      observed_at TEXT NOT NULL,
      upstream_cut_digest TEXT,
      detail TEXT,
      generation INTEGER NOT NULL DEFAULT 1,
      committed_at TEXT NOT NULL,
      PRIMARY KEY (source_id, stream_id),
      CHECK (stream_id = 'default'),
      CHECK (guarantee IN ('change-cut', 'snapshot', 'best-effort-scan', 'observation'))
    )
  `);

  // Materialized per-source stats. The underlying aggregation
  // (`SUM(LENGTH(content+title+metadata))` over all rows for a source) is
  // a full-content scan that routinely takes tens of seconds on large
  // sources (146k Gmail docs → ~100s). Running it inline on the HTTP
  // path blocks the main event loop and makes `cli status` / `/portal/
  // sources` feel wedged. Instead we keep a pre-aggregated row per source
  // here, refresh it from the backfill worker (off the main thread), and
  // the HTTP endpoint becomes a single-row PK lookup.
  // Materialized "last new doc" per source. The `latest_*` columns are
  // maintained inline by upsertDocuments; readers (/status,
  // getLatestActivityBySource) do a single tiny SELECT on this table
  // instead of a per-source ORDER BY ... LIMIT 1 scan against
  // `documents`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_stats (
      source_id TEXT PRIMARY KEY,
      doc_count INTEGER NOT NULL DEFAULT 0,
      data_size_bytes INTEGER NOT NULL DEFAULT 0,
      total_units INTEGER,
      earliest_source_date TEXT,
      latest_source_date TEXT,
      needs_refresh INTEGER NOT NULL DEFAULT 1,
      last_computed_at TEXT,
      dirty_version INTEGER NOT NULL DEFAULT 0,
      latest_doc_id TEXT,
      latest_title TEXT,
      latest_source_created_at TEXT,
      latest_ingested_at TEXT,
      latest_updated_at TEXT,
      latest_source_updated_at TEXT
    )
  `);

  // Materialized row counts + MIN/MAX timestamps per catalog table. Same
  // motivation: `SELECT MIN(source_updated_at) FROM documents` takes ~10s
  // because source_updated_at isn't indexed; /sqlite/catalog iterates
  // every catalog table with that pattern, which is a 30-60s read for the
  // portal's table browser. Worker refresh + PK lookup collapses it to <1ms.
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_table_stats (
      table_name TEXT PRIMARY KEY,
      row_count INTEGER NOT NULL DEFAULT 0,
      earliest_date TEXT,
      latest_date TEXT,
      last_computed_at TEXT
    )
  `);

  // `revoked_at` marks a device as revoked rather than deleting its row:
  // the id is a durable identity (per-device cursors, and — for partitioned
  // sources — external-id stream keys hang off it), so unpairing keeps the
  // row with its tokens dead, and a later pair under the same name adopts
  // it, id intact. Hard delete is a separate explicit "forget forever" act.
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '{}',
      paired_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      revoked_at INTEGER,
      install_id TEXT,
      self_emails TEXT NOT NULL DEFAULT '[]',
      self_phones TEXT NOT NULL DEFAULT '[]',
      access_level_id TEXT,
      apns_device_token TEXT,
      apns_environment TEXT,
      apns_bundle_id TEXT,
      apns_token_updated_at INTEGER,
      fcm_registration_token TEXT,
      fcm_token_updated_at INTEGER,
      push_transport TEXT,
      relay_url TEXT,
      relay_credential TEXT,
      relay_consent_app_id TEXT,
      relay_consented_at INTEGER,
      notification_delivery_health TEXT,
      notification_delivery_health_updated_at INTEGER,
      version TEXT,
      version_seen_at INTEGER,
      protocol_version INTEGER,
      desired_version TEXT,
      update_state TEXT,
      update_detail TEXT,
      update_state_at INTEGER
    )
  `);

  // The column arrives via migration 132 on pre-existing installs, and
  // schema setup runs first — so only index it once it exists (a fresh DB
  // has it from the CREATE above; an old one gets index + column together
  // in the migration).
  const devicesHasInstallId = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
    .all()
    .some((r) => r.name === "install_id");
  if (devicesHasInstallId) {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_install ON devices(kind, install_id) WHERE install_id IS NOT NULL",
    );
  }

  createDeviceDoctorRunsTable(db);

  createNotificationQueueTables(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      scopes TEXT NOT NULL DEFAULT '[]',
      name TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      -- Optional expiry (unix ms). NULL = never expires (the default for
      -- pairing-minted device tokens). Short-lived callback credentials set
      -- this so an abandoned token cannot be replayed past its window.
      expires_at INTEGER
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_device ON tokens(device_id)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      session_hash TEXT UNIQUE NOT NULL,
      token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
      scopes TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      last_active_at INTEGER,
      expires_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS device_pairings (
      pairing_code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      -- Optional self annotation (#284) staged at pairing-code creation and
      -- applied to the new device row at redeem time, so the operator can
      -- pin the owner email/phone identifiers inline with pairing rather
      -- than via a separate devices set-self. JSON arrays; empty = none.
      self_emails TEXT NOT NULL DEFAULT '[]',
      self_phones TEXT NOT NULL DEFAULT '[]',
      -- A repair ceremony is bound to this exact device when the admin mints
      -- the code. A redeeming client can never select a repair target by
      -- merely claiming its name or its install identity.
      repair_device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
      -- The access level an integration paired with this code is put on,
      -- chosen from a portal session when the code was minted.
      access_level_id TEXT
    )
  `);

  // External MCP readers have a separate identity plane from operational
  // devices. These tables intentionally reference devices only for the
  // optional OpenClaw/Hermes execution context; their credentials and OAuth
  // tokens never live in the device-token table above.
  createAccessTables(db);

  // Star-topology Phase 2: source registry on the gateway. Collectors are
  // told what to host via WS events (sources.snapshot, source.added, etc.).
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      account_id TEXT NOT NULL,
      -- What the source declares about this account, as JSON: a readable
      -- label, the subject the platform says it is, the tenant it is scoped
      -- to. Null when the source has nothing to say beyond the id, which is
      -- most of them and is not a gap — the id is what consumers show today.
      -- Never a query predicate; the addressable identity stays account_id.
      account TEXT,
      device_id TEXT NOT NULL REFERENCES devices(id),
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      multi_device_mode TEXT NOT NULL DEFAULT 'exclusive'
        CHECK (multi_device_mode IN ('exclusive', 'handoff', 'replicated', 'partitioned')),
      replica_version_policy TEXT
        CHECK (replica_version_policy IS NULL OR replica_version_policy = 'source-updated-at'),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_sources_device ON sources(device_id)");

  // Which devices may contribute to a source. `sources.device_id` remains
  // the primary member (compatibility read); this table is the membership
  // set multi-device modes grow into. Deliberately no cascade from devices:
  // unpairing a device revokes it (see devices.revoked_at) and leaves its
  // memberships in place, dormant — device removal must never destroy a
  // source or its standing. Deleting a source removes its membership rows;
  // forgetting a device (hard delete) is refused while it hosts sources.
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_devices (
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES devices(id),
      added_at INTEGER NOT NULL,
      config_override TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (source_id, device_id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_source_devices_device ON source_devices(device_id)");
  createSourceMemberConfigContractTable(db);
  createSourceStreamCleanupTable(db);
  createSourceModeTransitionTable(db);
  createSourceModeTransitionPublicationTable(db);
  createReplicaDeletionClaimsTable(db);

  // Durable removal tombstones for push sources (browser, Apple Health,
  // Health Connect). A push source is operated by the device, not the
  // gateway, so deleting its `sources` row doesn't stop it — the next
  // ingest would auto-recreate it. A row here makes removal stick: ingest
  // rejects pushes for the id and auto-register refuses to resurrect it,
  // until an explicit re-enable (re-pair / re-opt-in / portal Add) clears
  // the tombstone. See `SourceRepository` removal-tombstone helpers.
  db.exec(`
    CREATE TABLE IF NOT EXISTS removed_sources (
      id TEXT PRIMARY KEY,
      removed_at INTEGER NOT NULL,
      -- NULL while the post-removal data sweep is still running. See the
      -- markSourceRemoved / markSourceCleanupDone helpers in SourceRepository.
      cleanup_done_at INTEGER
    )
  `);

  // Durable per-document tombstones for the single-document privacy delete
  // (`DELETE /documents/:id`). A document's natural dedup key is
  // `(provider_id, source_id, external_id, stream_id)`; the next sync or re-capture
  // would otherwise re-upsert a page the user explicitly removed. A row
  // here makes the delete stick — the upsert path drops any incoming doc
  // whose key is tombstoned — until the whole source is removed & re-added
  // (which clears the source's tombstones). See `DocumentRepository`
  // `deleteDocumentForUser` / `tombstoneDocuments`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS removed_documents (
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      stream_id TEXT NOT NULL DEFAULT '',
      removed_at INTEGER NOT NULL,
      original_document_id TEXT,
      PRIMARY KEY (provider_id, source_id, external_id, stream_id)
    )
  `);

  // Pending absences: a document a source's snapshot stopped naming.
  //
  // A snapshot ("here is everything that exists") that omits a stored document
  // is evidence of a deletion, not proof of one — an impoverished read of the
  // source's own store produces exactly the page a genuine mass deletion does.
  // The omission is recorded here instead of applied, and only becomes a
  // deletion once `gateway.snapshotAbsence.minObservations` separate snapshots
  // have corroborated it and `gateway.snapshotAbsence.minAge` has elapsed since
  // the first one. A snapshot that names the document again drops its row.
  //
  // Keyed by `document_id` with ON DELETE CASCADE so a document removed through
  // any other path — a user delete, a source tombstone, a source wipe — takes
  // its pending absence with it and can never leave an orphan behind.
  // `observations` counts snapshots, not sync attempts: the mark is only
  // corroborated again once `minAge / minObservations` has passed since
  // `last_absent_at`, so a source syncing every 30 seconds cannot spend the
  // window in an afternoon.
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_absences (
      document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      stream_id TEXT NOT NULL DEFAULT '',
      external_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      first_absent_at INTEGER NOT NULL,
      last_absent_at INTEGER NOT NULL,
      observations INTEGER NOT NULL,
      observed_by TEXT NOT NULL DEFAULT ''
    )
  `);
  // Reconcile and cleanup seek one scope generation at a time. The due sweep
  // drives from the scope table through the same index, so invalidated rows are
  // skipped rather than scanned before their bounded reclamation catches up.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_document_absences_scope
      ON document_absences(
        provider_id, source_id, stream_id, generation, observations, first_absent_at
      )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_absence_scopes (
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      stream_id TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider_id, source_id, stream_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_absence_observations (
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      stream_id TEXT NOT NULL DEFAULT '',
      observation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (provider_id, source_id, stream_id, observation_id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_document_absence_observations_created
      ON document_absence_observations(created_at)
  `);
  // The absence diff is scoped to one contributing stream. The existing
  // `(provider_id, source_id)` index still scans every sibling stream.
  // Schema setup precedes migrations on an upgrade, so a pre-134 documents
  // table does not carry stream_id yet. Migration 138 installs this index once
  // migration 134 has rebuilt the table; fresh and already-upgraded databases
  // can create it directly here.
  const documentsHaveStreamId = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
    .all()
    .some((row) => row.name === "stream_id");
  if (documentsHaveStreamId) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_provider_source_stream
        ON documents(provider_id, source_id, stream_id, id)
    `);
  }
  const documentsHavePartitionKey = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
    .all()
    .some((row) => row.name === "partition_key");
  if (documentsHavePartitionKey) {
    // The partition-scoped absence scan reads one partition of one stream. The
    // unscoped scan above stays: a source with one backing store never names a
    // partition, and making it pay for a column it does not use would be the
    // wrong trade for the common case.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_provider_source_stream_partition
        ON documents(provider_id, source_id, stream_id, partition_key, id)
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_absence_cascade_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      document_ids TEXT NOT NULL,
      index_done INTEGER NOT NULL DEFAULT 0,
      cognition_done INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Audit trail for documents the absence sweep deleted. A deletion driven by
  // omission is the one deletion nobody asked for out loud, so the ids go on
  // record before the rows go away: without this a loss is unreconstructable
  // after the fact. Bounded by `SNAPSHOT_ABSENCE_AUDIT_KEEP` batches — the
  // sweep prunes the oldest rows as it appends.
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_absence_deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deleted_at INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      stream_id TEXT NOT NULL DEFAULT '',
      external_ids TEXT NOT NULL,
      document_count INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_snapshot_absence_deletions_at
      ON snapshot_absence_deletions(deleted_at)
  `);
  createSourceModeTransitionIndexes(db);

  db.exec("CREATE INDEX IF NOT EXISTS idx_documents_source_url ON documents(source_url)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_external_id_source ON documents(LOWER(external_id), source_id)",
  );

  // Document links table for reference graph. `metadata_json` carries
  // per-edge details — citation payloads (quote/note) for `cited` edges,
  // `{"role":"attachment"}` for the attachment flavour of `contains`, and the
  // `EdgeDeclaration.metadata`/`ordering` of a source-declared edge. NULL for
  // the standard URL-derived edges that don't need it. Readers treat the
  // column as opaque metadata.
  //
  // Provenance (#430): every row records how the edge came to exist, so the
  // graph walker can filter by trust (`provenanceKinds`) and an upgraded
  // parser/annotator can invalidate only its own edges.
  //   - `provenance_kind`    — source-declared | content-derived |
  //                            cross-source-derived | llm-derived. NULL on a
  //                            legacy row falls back to the type-level default
  //                            in `@omnesis/core` `graphEdgeProvenance()`.
  //   - `provenance_origin`  — for source-declared: the declaring source id;
  //                            content-derived: the parser id; etc.
  //   - `provenance_version` — version string; a bump invalidates a parser's /
  //                            annotator's edges on the next derive.
  //   - `declared_at`        — epoch-ISO when the edge was first recorded.
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL,
      raw_target TEXT NOT NULL,
      normalized_target TEXT NOT NULL,
      target_doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      metadata_json TEXT,
      provenance_kind TEXT,
      provenance_origin TEXT,
      provenance_version TEXT,
      declared_at TEXT,
      UNIQUE(source_doc_id, link_type, normalized_target)
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_document_links_source ON document_links(source_doc_id)");
  // Typed lookups: a document's neighbourhood is read one link type at a time
  // on the reactive path, and its per-type totals are a GROUP BY over the same
  // rows. Without these both visit every edge the document has.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_document_links_source_type ON document_links(source_doc_id, link_type)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_document_links_target_type ON document_links(target_doc_id, link_type)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_document_links_target ON document_links(target_doc_id)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_document_links_normalized ON document_links(normalized_target)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_document_links_unresolved ON document_links(normalized_target) WHERE target_doc_id IS NULL",
  );
  // Accelerates `graph.walk` provenance filtering and the diff-and-delete of a
  // source's declared edges (scoped by source_doc_id + provenance_kind).
  // Guarded by column existence: on an existing install the provenance columns
  // are added by migration 19 (which runs AFTER this setup), so we create these
  // indexes here only once the column is present (fresh installs — the CREATE
  // TABLE above carries the columns — and post-migration boots). Migration 19
  // also creates them for the existing install in the same pass it adds the
  // column.
  const documentLinkCols = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('document_links')")
    .all()
    .map((r) => r.name);
  if (documentLinkCols.includes("provenance_kind")) {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_document_links_provenance ON document_links(provenance_kind) WHERE provenance_kind IS NOT NULL",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_document_links_source_prov ON document_links(source_doc_id, provenance_kind)",
    );
  }

  // Pending source-declared edges (#430): a declared edge whose target document
  // hasn't been ingested yet (a forward reference). Held here — not in
  // `document_links` — so the graph walker and link stats only ever see real,
  // resolved edges. A periodic drain (`scheduler/tasks` pendingEdges) retries
  // resolution by (target source_id, external id), promotes resolved edges into
  // `document_links` with source-declared provenance, and drops rows whose
  // `declared_at` is older than a TTL (a target that was deleted upstream or
  // never arrived). `source_doc_id` is FK-bound (the declaring doc always
  // exists — the source emits edges alongside its documents); the target is a
  // source-native ref, not yet an Omnesis id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL,
      target_source_id TEXT NOT NULL,
      target_external_id TEXT NOT NULL,
      provenance_origin TEXT NOT NULL,
      provenance_version TEXT,
      metadata_json TEXT,
      declared_at TEXT NOT NULL,
      last_attempt_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(source_doc_id, link_type, target_source_id, target_external_id)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pending_edges_target ON pending_edges(target_source_id, target_external_id)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_pending_edges_source ON pending_edges(source_doc_id)");

  // Cursor state for the periodic URL link reconciler. The reconciler
  // walks `document_links` by id in 500-row windows; without a cursor
  // every tick re-scans the oldest unresolved rows from id=0 (planner
  // uses `idx_document_links_target` and emits rowid-asc within the
  // `target_doc_id IS NULL` bucket). Permanently-unresolvable URLs at
  // the head of the rowid order then starve every newer link.
  //
  // Singleton row (`id = 1`). The writer advances `cursor` to the max
  // id seen in each batch; when a batch returns 0 rows the writer
  // resets `cursor` to 0, bumps `cycle_count`, and stamps
  // `last_wrapped_at`. Readers (compute side) use `cursor` as the
  // `WHERE id > ?` lower bound.
  // The two ownership cursors independently walk raw link/document row-id
  // windows. They keep the retroactive URL-owner pass bounded even when a
  // complete cycle finds nothing to repair. Each snapshots a cycle maximum,
  // so sustained ingestion cannot keep it chasing a moving tail forever.
  db.exec(`
    CREATE TABLE IF NOT EXISTS link_reconcile_state (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      cursor INTEGER NOT NULL DEFAULT 0,
      url_cycle_max_id INTEGER NOT NULL DEFAULT 0,
      cycle_count INTEGER NOT NULL DEFAULT 0,
      last_wrapped_at TEXT,
      ownership_link_cursor INTEGER NOT NULL DEFAULT 0,
      ownership_link_max_id INTEGER NOT NULL DEFAULT 0,
      ownership_document_cursor INTEGER NOT NULL DEFAULT 0,
      ownership_document_max_rowid INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec("INSERT OR IGNORE INTO link_reconcile_state (id) VALUES (1)");

  // Materialized link graph stats. The underlying aggregation —
  // 3 COUNT(*) scans over `document_links` (978k rows live) — takes
  // ~9.8s on the gateway's main read handle and blocks the HTTP event
  // loop on every poll of /links/stats. Mirrors `source_stats`:
  // writer-side `markLinkStatsDirty` + optimistic-concurrency token
  // (`dirty_version`); compute-side snapshot + pure-write upsert;
  // periodic refresh task in `scheduler/tasks/backfill.ts`.
  //
  // OCC plumbing (dirty_version, last_computed_version, last_computed_at,
  // needs_refresh) lives in the shared `refresh_meta` table keyed by
  // job — see `refresh_meta` setup below. `link_stats` is the data-
  // only sibling for the `link_graph` job. Before the collapse each job
  // had its own copy-pasted singleton OCC table; the migration in
  // `migrations.ts` collapses the three legacy tables (link_stats's
  // OCC columns, `interaction_scores_meta`, `merge_rules_meta`) into
  // `refresh_meta`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS link_stats (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      total_links INTEGER NOT NULL DEFAULT 0,
      resolved_links INTEGER NOT NULL DEFAULT 0,
      by_type_json TEXT NOT NULL DEFAULT '{}',
      last_computed_at INTEGER
    )
  `);
  // Singleton row. INSERT OR IGNORE so a fresh boot seeds it; reboots
  // see the existing row and the IGNORE no-ops. Idempotent.
  db.exec("INSERT OR IGNORE INTO link_stats (id) VALUES (1)");

  // Per-link-type counters maintained by SQLite triggers on
  // document_links. Provides O(1) reads of total/resolved counts
  // without scanning the full table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS link_stats_counters (
      link_type TEXT PRIMARY KEY,
      total INTEGER NOT NULL DEFAULT 0,
      resolved INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lsc_insert AFTER INSERT ON document_links BEGIN
      INSERT INTO link_stats_counters (link_type, total, resolved)
      VALUES (NEW.link_type, 1, CASE WHEN NEW.target_doc_id IS NOT NULL THEN 1 ELSE 0 END)
      ON CONFLICT(link_type) DO UPDATE SET
        total = total + 1,
        resolved = resolved + CASE WHEN NEW.target_doc_id IS NOT NULL THEN 1 ELSE 0 END;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lsc_resolve
    AFTER UPDATE OF target_doc_id ON document_links
    WHEN OLD.target_doc_id IS NULL AND NEW.target_doc_id IS NOT NULL BEGIN
      UPDATE link_stats_counters SET resolved = resolved + 1 WHERE link_type = NEW.link_type;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lsc_unresolve
    AFTER UPDATE OF target_doc_id ON document_links
    WHEN OLD.target_doc_id IS NOT NULL AND NEW.target_doc_id IS NULL BEGIN
      UPDATE link_stats_counters SET resolved = resolved - 1 WHERE link_type = OLD.link_type;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lsc_delete AFTER DELETE ON document_links BEGIN
      UPDATE link_stats_counters SET
        total = total - 1,
        resolved = resolved - CASE WHEN OLD.target_doc_id IS NOT NULL THEN 1 ELSE 0 END
      WHERE link_type = OLD.link_type;
    END
  `);

  // Shared OCC + refresh metadata table. Replaces the three legacy
  // copy-pasted singleton tables (`link_stats`'s OCC columns,
  // `interaction_scores_meta`, `merge_rules_meta`) with a single
  // row-per-job shape.
  //
  // `needs_refresh` is link_graph-specific (the other two jobs use the
  // `dirty_version > last_computed_version` predicate to decide
  // skip-vs-fire and don't need a separate flag). It defaults to 1
  // on every row so a job that doesn't care simply leaves it at 1
  // forever; the link_graph upsert clears it back to 0 atomically
  // with the data write.
  db.exec(`
    CREATE TABLE IF NOT EXISTS refresh_meta (
      job TEXT PRIMARY KEY CHECK (job IN ('link_graph', 'interaction_scores', 'merge_rules', 'near_dup_df', 'people_counts')),
      dirty_version INTEGER NOT NULL DEFAULT 0,
      last_computed_version INTEGER NOT NULL DEFAULT -1,
      last_computed_at INTEGER,
      needs_refresh INTEGER NOT NULL DEFAULT 1
    )
  `);
  // Seed one row per job. INSERT OR IGNORE so reboots see the
  // existing row and the seed no-ops.
  db.exec("INSERT OR IGNORE INTO refresh_meta (job) VALUES ('link_graph')");
  db.exec("INSERT OR IGNORE INTO refresh_meta (job) VALUES ('interaction_scores')");
  db.exec("INSERT OR IGNORE INTO refresh_meta (job) VALUES ('merge_rules')");
  db.exec("INSERT OR IGNORE INTO refresh_meta (job) VALUES ('near_dup_df')");
  db.exec("INSERT OR IGNORE INTO refresh_meta (job) VALUES ('people_counts')");

  // --- Near-duplicate graph ---
  // The seventh edge type in the document graph. Algorithm details +
  // configuration live in @omnesis/near-dupes (pure algo + filters +
  // gate) and packages/gateway/src/near-dupes/ (production glue).
  //
  // Five tables:
  //   - near_dup_signatures  : one MinHash signature per (doc, algo)
  //   - near_dup_lsh_buckets : LSH inverted index for candidate lookup
  //   - near_dup_edges       : the gate-passing edge rows surfaced in
  //                            /documents/:id/near-dupes
  //   - near_dup_df          : per-shingle document-frequency snapshot
  //                            used to drive IDF weighting at sketch
  //                            time. Rebuilt periodically by the
  //                            `near_dup_df` refresh_meta job rather
  //                            than maintained incrementally.
  //   - near_dup_df_meta     : singleton metadata for the active algo
  //                            and the resumable sweep watermark.
  //
  // Plus an inbox queue table (`near_dup_inbox`) — written inline by
  // the writer on ingest/update/delete via a cheap PK insert, drained
  // by the `backfill.nearDupCompute` task. The UNIQUE INDEX on
  // (doc_id, enqueued_reason) lets `INSERT OR IGNORE` coalesce
  // multiple enqueues of the same doc into a single row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS near_dup_signatures (
      doc_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      algo_version  TEXT NOT NULL,
      signature     BLOB NOT NULL,
      shingle_count INTEGER NOT NULL,
      computed_at   INTEGER NOT NULL,
      PRIMARY KEY (doc_id, algo_version)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_near_dup_sig_algo ON near_dup_signatures(algo_version)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS near_dup_lsh_buckets (
      algo_version TEXT NOT NULL,
      band_idx     INTEGER NOT NULL,
      bucket_hash  INTEGER NOT NULL,
      doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      PRIMARY KEY (algo_version, band_idx, bucket_hash, doc_id)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_near_dup_lsh_lookup ON near_dup_lsh_buckets(algo_version, band_idx, bucket_hash)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_near_dup_lsh_doc ON near_dup_lsh_buckets(doc_id)");

  // One row per canonical-ordered pair under one algo. The
  // CHECK(doc_a < doc_b) is enforced by the writer's canonical
  // ordering helper; consumers querying for "edges involving doc X"
  // OR over (doc_a = X) and (doc_b = X).
  db.exec(`
    CREATE TABLE IF NOT EXISTS near_dup_edges (
      doc_a            TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      doc_b            TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      algo_version     TEXT NOT NULL,
      jaccard          REAL NOT NULL,
      pair_unique_df2  INTEGER NOT NULL,
      pair_unique_df5  INTEGER NOT NULL,
      containment_min  REAL NOT NULL,
      gate_family      TEXT NOT NULL,
      computed_at      INTEGER NOT NULL,
      CHECK (doc_a < doc_b),
      PRIMARY KEY (doc_a, doc_b, algo_version)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_near_dup_edges_a ON near_dup_edges(doc_a, algo_version, jaccard DESC)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_near_dup_edges_b ON near_dup_edges(doc_b, algo_version, jaccard DESC)",
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS near_dup_df (
      algo_version TEXT NOT NULL,
      -- Which build of the table this row belongs to. A rebuild writes a
      -- new generation alongside the live one and flips
      -- near_dup_df_meta.live_generation when it is complete, so readers
      -- never see a half-built table and the writer never has to clear the
      -- old one on the critical path. Retiring a superseded generation is
      -- the near-dup algo sweep's job, in bounded chunks.
      generation   INTEGER NOT NULL DEFAULT 0,
      shingle      TEXT NOT NULL,
      df           INTEGER NOT NULL,
      PRIMARY KEY (algo_version, generation, shingle)
    ) WITHOUT ROWID
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS near_dup_df_meta (
      algo_version    TEXT PRIMARY KEY,
      total_docs      INTEGER NOT NULL DEFAULT 0,
      unique_shingles INTEGER NOT NULL DEFAULT 0,
      built_at        INTEGER,
      sweep_watermark TEXT,
      -- The generation of near_dup_df that readers must use. Flipping this is
      -- what publishes a rebuild, and it is a single-row update, so the
      -- swap costs the writer one short transaction however large the
      -- table is.
      live_generation INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Inbox queue. Survives docs deletion deliberately — the 'delete'
  // reason rows must outlive the documents row so the compute pass
  // knows to remove LSH-bucket entries the FK cascade doesn't cover.
  // The compute pass deletes inbox rows itself after applying.
  db.exec(`
    CREATE TABLE IF NOT EXISTS near_dup_inbox (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id          TEXT NOT NULL,
      enqueued_reason TEXT NOT NULL CHECK (enqueued_reason IN
        ('insert','update','delete','algo-bump')),
      enqueued_at     INTEGER NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_near_dup_inbox_doc ON near_dup_inbox(doc_id)");
  // Coalesce duplicate enqueues — `INSERT OR IGNORE` against this index
  // is the writer-side coalescing path that protects against reply-chain
  // re-enqueue storms.
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_near_dup_inbox_dedup ON near_dup_inbox(doc_id, enqueued_reason)",
  );

  // --- People tables ---
  // doc_count / alias_count are materialized per-person counts so
  // searchPeople doesn't run a correlated `COUNT(DISTINCT document_id)
  // FROM document_people GROUP BY person_id` per row. Maintained by the
  // backfill worker.
  //
  // The interaction-score columns are refreshed by
  // `interactionScoresRefreshTask` (compute on read handle, upsert on
  // writer). The lifetime / "_recent" pair lets consumers pick decayed
  // (default) or all-time. Each score lives in [0, 1]; the harmonic-mean
  // formulation makes a one-sided contact (e.g. a newsletter the user
  // never replies to) score near zero even at high inbound volume. See
  // `computeInteractionScores` in people.ts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      merged_into TEXT,
      source TEXT NOT NULL,
      is_self BOOLEAN DEFAULT FALSE,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      doc_count INTEGER NOT NULL DEFAULT 0,
      alias_count INTEGER NOT NULL DEFAULT 0,
      inbound_count INTEGER NOT NULL DEFAULT 0,
      outbound_count INTEGER NOT NULL DEFAULT 0,
      inbound_score REAL NOT NULL DEFAULT 0,
      outbound_score REAL NOT NULL DEFAULT 0,
      interaction_score REAL NOT NULL DEFAULT 0,
      inbound_score_recent REAL NOT NULL DEFAULT 0,
      outbound_score_recent REAL NOT NULL DEFAULT 0,
      interaction_score_recent REAL NOT NULL DEFAULT 0,
      interaction_scores_at TEXT
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_people_merged ON people(merged_into) WHERE merged_into IS NOT NULL",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_people_self ON people(is_self) WHERE is_self = TRUE");

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_people_doc_count ON people(doc_count DESC) WHERE merged_into IS NULL",
  );
  // Sort index for the portal / iOS /people default ordering. The browse
  // list orders by (is_self DESC, interaction_score_recent DESC, doc_count DESC);
  // the index columns match that tuple exactly so SQLite satisfies the ORDER BY
  // by walking the index and stops after LIMIT rows — no full-table TEMP B-TREE
  // sort of every person. Partial index skips merged people — never returned.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_people_interaction_recent
       ON people(is_self DESC, interaction_score_recent DESC, doc_count DESC)
       WHERE merged_into IS NULL`,
  );

  // Auto-detect rule scan (`computeAutoDetectedRules`) does a self-join
  // on `LOWER(canonical_name)` filtered to `source='contacts'` and
  // `merged_into IS NULL` and `canonical_name LIKE '% %'`. Without this
  // index the join is an O(N²) scan over the contacts subset — observed
  // as `backfill.autoDetect exec=13.5s` on the live 50k-people graph.
  // Partial index narrows it to the predicate the query actually uses.
  // Expression index uses `LOWER(canonical_name)` directly so SQLite's
  // planner can use it for both sides of the self-join.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_people_contacts_canonical_lower
       ON people(LOWER(canonical_name))
       WHERE merged_into IS NULL
         AND source = 'contacts'
         AND canonical_name LIKE '% %'`,
  );

  // (interaction-scores OCC plumbing lives in `refresh_meta` keyed by
  // `job='interaction_scores'` — see the `refresh_meta` block above.
  // Previously this was a dedicated `interaction_scores_meta`
  // singleton; the migration collapses it.)

  // ── Merge rules (logical merging) ────────────────────────────────────
  //
  // Both auto-detected (kind='system') and user-asserted (kind='user')
  // merges live here as cross-identifier alias bridges. The actual
  // `people.merged_into` pointer is *derived* from active rules by the
  // `mergeRulesEvalTask` periodic task and persisted via
  // `person_equivalences`. Wiping `person_equivalences` and re-running
  // the eval should reproduce the same `merged_into` state — that's the
  // "robust to data wipe / re-derivable" property.
  db.exec(`
    CREATE TABLE IF NOT EXISTS merge_rules (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('system', 'user')),
      side_a_alias_type TEXT NOT NULL,
      side_a_alias TEXT NOT NULL,
      side_b_alias_type TEXT NOT NULL,
      side_b_alias TEXT NOT NULL,
      winner_side TEXT NOT NULL CHECK (winner_side IN ('a', 'b')),
      reason TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      deactivated_at TEXT,
      -- Correlation id shared by every rule a single cluster-merge created.
      -- NULL for one-pair-at-a-time and auto-detected rules. Lets a whole
      -- cluster merge be audited and undone as one unit; equivalence is still
      -- derived from the individual edges, not this tag.
      group_id TEXT
    )
  `);
  // Active uniqueness on the (a, b) pair. Mirror collisions ((email=foo,
  // phone=bar) vs (phone=bar, email=foo)) are prevented by the
  // create-rule helper sorting sides into canonical (a < b) order before
  // insert — enforcing both at the SQL level would require two indexes
  // and the helper-side sort is robust enough.
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_rules_active_pair ON merge_rules(side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias) WHERE active = 1",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_merge_rules_side_a ON merge_rules(side_a_alias_type, side_a_alias) WHERE active = 1",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_merge_rules_side_b ON merge_rules(side_b_alias_type, side_b_alias) WHERE active = 1",
  );
  // Look up / delete every rule of one cluster-merge batch by its group id.
  // Guarded on the column existing: schema setup runs BEFORE migrations, so on
  // an existing DB upgrading to v16 the `group_id` column isn't present yet
  // (migration 16 adds it and the index). Fresh DBs have it via CREATE TABLE
  // above, so the index is created here on first boot.
  const mergeRuleCols = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('merge_rules')")
    .all()
    .map((r) => r.name);
  if (mergeRuleCols.includes("group_id")) {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_merge_rules_group ON merge_rules(group_id) WHERE group_id IS NOT NULL",
    );
  }

  // Materialized output of the rule evaluator. One row per non-canonical
  // person; `to_id` is the chosen root for the equivalence class. Wiped
  // and rebuilt on every eval pass that finds changes — never read by
  // user-facing queries directly (those go through `people.merged_into`,
  // which the eval pass keeps in sync).
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_equivalences (
      from_id TEXT PRIMARY KEY,
      to_id TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_person_equivalences_to ON person_equivalences(to_id)");

  // (merge-rules OCC plumbing lives in `refresh_meta` keyed by
  // `job='merge_rules'` — see the `refresh_meta` block above.
  // Previously this was a dedicated `merge_rules_meta` singleton;
  // the migration collapses it.)

  // Suggested merges surfaced to the operator via the portal. Distinct
  // from merge_rules: candidates are *proposals* generated by a fuzzy
  // name-token scorer (see `computeFuzzyMergeCandidates`). The user
  // accept/deny decision is durable — `denied` rows act as permanent
  // vetoes so the detector never re-proposes the same pair. Accepting
  // a candidate creates a `kind='user'` merge_rule and flips the
  // status to `accepted` with a back-reference (`rule_id`).
  //
  // Sides stored in canonical (alphabetical) order — same convention
  // as merge_rules — so a pair has at most one row regardless of
  // detection direction.
  db.exec(`
    CREATE TABLE IF NOT EXISTS merge_candidates (
      id TEXT PRIMARY KEY,
      side_a_alias_type TEXT NOT NULL,
      side_a_alias TEXT NOT NULL,
      side_b_alias_type TEXT NOT NULL,
      side_b_alias TEXT NOT NULL,
      score REAL NOT NULL,
      detection_kind TEXT NOT NULL,
      matched_tokens TEXT,
      -- Name-match strength multiplier for the portal queue rank: high when the
      -- match shares two name concepts (first + last) or a rare token, ~0.15 for
      -- a single shared common given name. Computed at detection (it needs the
      -- corpus token frequencies); NULL on rows from before this column existed.
      match_strength REAL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','accepted','denied')),
      detected_at TEXT NOT NULL,
      decided_at TEXT,
      rule_id TEXT,
      -- Background-agent adjudication (the merge_adjudication run kind): when
      -- the agent last judged this candidate, its verdict
      -- ('merge'|'distinct'|'unsure'), and its user-visible rationale. NULL on
      -- never-adjudicated rows. The verdict is advisory metadata — status stays
      -- the single source of truth for what actually happened.
      adjudicated_at TEXT,
      adjudication_verdict TEXT,
      adjudication_reason TEXT,
      -- Fingerprint of the evidence that verdict was passed on (matched tokens
      -- plus score/strength at display precision). The re-adjudication filter
      -- compares it with the row's live evidence, so a candidate is re-judged
      -- when what it rests on changed rather than whenever a detector pass
      -- moved a corpus-derived score in its far decimals. NULL on rows
      -- adjudicated before the column existed.
      adjudication_evidence_fingerprint TEXT,
      -- Verdicts passed on this candidate. Bounds spend on pairs an agent
      -- cannot settle: past the ceiling the candidate is the operator's.
      adjudication_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_merge_candidates_pending ON merge_candidates(score DESC) WHERE status = 'pending'",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_merge_candidates_status ON merge_candidates(status)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_merge_candidates_history ON merge_candidates(status, COALESCE(decided_at, detected_at) DESC, id DESC)",
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS person_aliases (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      alias_type TEXT NOT NULL,
      source_id TEXT,
      created_at TEXT NOT NULL,
      -- How many times this exact name was observed for this person (name
      -- aliases only; identifier rows stay at the default 1). Drives the
      -- dominant ("primary") name for display and for merge decisions. A name
      -- from a contact card is seeded to a large floor so a curated name
      -- outranks raw sender display-names. See migration 30 + recomputeNamePrimaries.
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      -- A name is born primary; recomputeNamePrimaries demotes all but the
      -- dominant one to 0. Defaulting to 1 means a freshly-resolved name
      -- participates in display/merge immediately (degrading to pre-feature
      -- behavior) until the next selector tick narrows it to the winner.
      is_primary INTEGER NOT NULL DEFAULT 1,
      UNIQUE(alias_type, alias, person_id)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_person_aliases_lookup ON person_aliases(alias_type, alias)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_person_aliases_person ON person_aliases(person_id)");

  // Every source that vouches for an alias, not only the first to see it.
  // `person_aliases.source_id` records the first asserter and cannot record a
  // second, so it cannot answer whether removing a source leaves an identifier
  // standing. Answering it from that column destroys identifiers other live
  // sources still assert — and, when one is a person's last alias, the person
  // and every attribution that hung off them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_alias_assertions (
      alias_id   TEXT NOT NULL REFERENCES person_aliases(id) ON DELETE CASCADE,
      source_id  TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL,
      PRIMARY KEY (alias_id, source_id)
    )
  `);
  // Removal keys on the source: the work has to be proportional to the source
  // being removed, not to the size of the person graph.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_person_alias_assertions_source
       ON person_alias_assertions(source_id)`,
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS document_people (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      source_id TEXT,
      PRIMARY KEY (document_id, person_id, role)
    )
  `);
  // Composite (person_id, source_id) so searchPeople's per-person `source_ids`
  // strip is an index-only scan (no random probes into `documents`, no decrypt
  // under storage encryption). The leftmost `person_id` prefix serves every
  // plain person_id equality/IN lookup identically to the old single-column index.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_document_people_person_source ON document_people(person_id, source_id)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_document_people_doc ON document_people(document_id)");

  // Learned non-identifying ("shared / firehose") email addresses. Mirrors
  // the static `isNonIdentifyingEmail` heuristic for senders that look like
  // ordinary personal addresses but are really a single mailbox fronting
  // many distinct authors (e.g. a shared ticket-queue mailbox that rewrites
  // every message's From to one inbox while keeping the sender's name in the
  // display field). Populated by the
  // `people.demoteSharedAddresses` sweep when a person bucket accretes too
  // many distinct name aliases under one email; consulted on the people-
  // resolution path so such addresses never re-form a bucket.
  db.exec(`
    CREATE TABLE IF NOT EXISTS non_identifying_emails (
      email TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      name_count INTEGER,
      detected_at TEXT NOT NULL
    )
  `);

  // Identity labels for the high-spread tokens that drive merge-candidate
  // suppression. A token appearing across many distinct email domains is a
  // *prior* for "generic / role mailbox word" (`reservations`, `enquiries`,
  // `ne-pas-repondre`) — but family surnames spread wide too (`bond` lives
  // on ~20 relatives' addresses), so spread alone cannot decide. This table
  // records a per-token verdict (`personal_name` | `role_generic` |
  // `ambiguous`) produced by the `tokenIdentityClassify` task, which classifies
  // only the high-spread tail via the configured generative model. The
  // merge-candidate detector reads it to veto suppression on any token that is
  // a confirmed personal name. Absence of a row means "not yet classified" —
  // the detector treats that as non-suppressing (a rare token already protects
  // its pair), so the feature degrades safely when no model is available.
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_identity_labels (
      token TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      domain_spread INTEGER NOT NULL,
      classified_at TEXT NOT NULL
    )
  `);

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_people_unprocessed ON documents(id) WHERE people_resolved_at IS NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_links_unprocessed ON documents(id) WHERE links_extracted_at IS NULL",
  );
  // Backlog AGE per derivation stage: `MIN(ingested_at) WHERE <col> IS NULL`
  // is what the derivation-SLA observers report, and carrying the column in
  // the index keeps that MIN index-only rather than a row lookup per entry.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_links_pending_age ON documents(ingested_at) WHERE links_extracted_at IS NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_people_pending_age ON documents(ingested_at) WHERE people_resolved_at IS NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_dates_pending_age ON documents(ingested_at) WHERE dates_extracted_at IS NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_dates_unprocessed ON documents(id) WHERE dates_extracted_at IS NULL",
  );

  // The retrospective lane's pair of marker indexes, over the unset and set
  // sides of bootstrap_processed_at. Owned by the Brain module, which guards
  // them on the column for the same upgrade-ordering reason as above.
  createBootstrapMarkerIndexes(db);

  // Expression indexes for the link-backfill hot path. Without these, every
  // document processed by `processDocumentLinks` fires full-table scans
  // against 200k+ rows for `resolveEmailThreadLink` (gmail / outlook) and
  // `resolveIntraSourceLink` (obsidian wikilinks), pinning the event loop
  // at 99% CPU and making the gateway unresponsive for seconds at a time.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_thread_id " +
      "ON documents(source_id, json_extract(metadata, '$.extra.threadId')) " +
      "WHERE json_extract(metadata, '$.extra.threadId') IS NOT NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_conversation_id " +
      "ON documents(source_id, json_extract(metadata, '$.extra.conversationId')) " +
      "WHERE json_extract(metadata, '$.extra.conversationId') IS NOT NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_title_source " +
      "ON documents(source_id, LOWER(title)) WHERE title IS NOT NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_external_source " +
      "ON documents(source_id, LOWER(external_id))",
  );

  createCanonicalizationStateTable(db);

  // Per-connection re-auth reminder backoff state (#683). One row per
  // re-auth principal (provider connection id) records when the last
  // needs-auth reminder push fired + how many have fired, so the built-in
  // notifier sends one reminder per connection on an exponential backoff
  // instead of one per source per sync tick. Survives gateway restart.
  createReauthRemindersTable(db);
  createMobilePermissionHealthTable(db);

  // Per-source-type document-event profiles published by the collector: what
  // each source's documents can be asked about. Persisted so a restart before
  // the collector reconnects doesn't read as "the source was removed".
  createSourceDocumentProfilesTable(db);

  // Briefs / Cognition Steward storage (experimental): open loops, briefs,
  // the agent run queue, spend tracking, agent notes.
  createBriefsStorageTables(db);
  // Brief-claims sidecar: per-brief atomic asserted claims, each bound to
  // its evidence document + quote. FK on briefs(id), so it follows the
  // briefs DDL above.
  createBriefClaimsTables(db);
  // Durable doc-annotation store — the abstract-graph substrate.
  createAnnotationStorageTables(db);
  // Durable person-annotation store — the person-keyed sibling.
  createPersonAnnotationStorageTables(db);
  // Consumption provenance: which briefs/loops were built on which
  // annotation priors, so invalidating a prior can re-examine its dependents.
  createConsumptionEdgesTables(db);
  // Developer-annotations store (OMNESIS_DEV_MODE): the operator → engineer
  // data-quality feedback channel.
  createDevAnnotationsTables(db);
  // Which agent conversations hold something the operator has not seen.
  createConversationReadStateTables(db);

  createAnswerPrivacyTables(db);
  createDirectAuditTables(db);
  createSubscriptionTables(db);
  // Omnesis-derived date-enrichment signal (experimental): dates extracted
  // from document text, resolved against each document's emission date.
  createExtractedDatesTables(db);
  // Temporal annotations (experimental): interval-addressed semantic time the
  // background agent adds to and queries.
  createTemporalAnnotationTables(db);
  // Deterministic, source-owned projections over typed document dates. Kept
  // separate from mutable LLM temporal annotations and from DuckDB's
  // analytics-row projection store.
  createDocumentTemporalProjectionTables(db);
  // omnesis-notes: the append-only quick-capture ledger
  // the per-day note documents are projected from.
  createNoteEntriesTables(db);
  // agent-conversations: the append-only ledger of turns a
  // harness plugin pushes, projected into per-day conversation documents.
  createAgentMessagesTables(db);
  installMutableListRevisions(db);
  installCollectorRosterRevision(db);

  // schema_migrations is the descriptive log of which migrations have
  // run, populated by `migrations.ts` after `runSchemaSetup`. Created
  // here so the runner can prepare against it on first boot.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      run_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    )
  `);
}
