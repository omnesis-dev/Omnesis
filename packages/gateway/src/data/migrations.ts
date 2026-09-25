// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Schema migration runner anchored on `PRAGMA user_version`.
 *
 * `runSchemaSetup` defines the live shape of the schema (idempotent
 * CREATE TABLE IF NOT EXISTS calls). Anything that needs to *transform*
 * existing rows or restructure existing tables — column renames,
 * back-fills, CHECK widenings, FK repairs — lives here as a numbered
 * migration step.
 *
 * Each step bumps `PRAGMA user_version` from N to N+1 inside one
 * transaction. The runner reads the live `user_version`, runs every
 * migration with `version > current` in order, and records each in
 * `schema_migrations` for descriptive history. Safe to call on every
 * boot — the runner is a no-op once the live version matches the head
 * of the list.
 *
 * Retention policy (per docs/conventions.md): the list is **append-only,
 * contiguous, and kept permanently**. With multiple live users on differing
 * schema versions, an install several versions behind must upgrade cleanly
 * by replaying the full sequence, so a migration's slot is never removed.
 * When a step's data transform later becomes obsolete (superseded by an
 * admin recompute endpoint, or a source stops emitting the data it fixed),
 * it is reduced to a **tombstone** — a no-op `up` with a description that
 * records why — rather than deleted. That keeps the `user_version` chain
 * gap-free (a property the contiguity test enforces) and the policy literal.
 *
 * The current head is `LATEST_SCHEMA_VERSION`. New migrations append an
 * entry with `version: LATEST_SCHEMA_VERSION + 1` and bump that constant.
 * A bump also obligates advancing the pinned migration-idempotency seed
 * (`migration-idempotency-seed.ts`) — see docs/conventions.md.
 */

import { createHash, randomUUID } from "node:crypto";
import { createLogger, type Logger } from "@omnesis/core";
import {
  createBriefsStorageTables,
  createBriefClaimsTables,
  createAnnotationStorageTables,
  createPersonAnnotationStorageTables,
  createConsumptionEdgesTables,
  createCognitionCoverageTable,
  createBootstrapMarkerIndexes,
  cascadeAnnotationPrivacyDelete,
  cascadePersonAnnotationPrivacyDelete,
  cascadeBriefClaimPrivacyDelete,
  cascadeOpenLoopPrivacyDelete,
  enqueueRechecksForMissingConsumptionPriors,
  OPEN_LOOP_PROVIDER_ID,
  OPEN_LOOP_SOURCE_ID,
} from "../brain/index.js";
import { createConversationReadStateTables } from "../agent/conversation-read-state.js";
import { createDevAnnotationsTables } from "../dev-annotations/store.js";
import { createSweepTallyTable } from "../brain/storage/sweep-tally.js";
import { queueTranscriptEviction } from "../brain/transcript-eviction.js";
import {
  createExtractedDatesTables,
  createDatesUnprocessedIndex,
} from "../enrichment/dates/storage.js";
import {
  cascadeTemporalAnnotationPrivacyDelete,
  createLegacyTimeIndexTables,
  createTemporalAnnotationTables,
} from "../enrichment/temporal-annotations/storage.js";
import { createDocumentTemporalProjectionTables } from "../enrichment/temporal-projections/document-storage.js";
import { supersedeNotificationsByCollapseIdPrefix } from "../push/queue.js";
import {
  advanceWorkflowDisclosure,
  createAnswerApprovalListIndexes,
  createAnswerPrivacyTables,
  createDirectAuditTables,
  parseReview,
} from "../privacy/store.js";
import {
  createSubscriptionApprovalListIndexes,
  createSubscriptionTables,
} from "../subscriptions/store-schema.js";
import { migrateV152AccessGrants } from "./migration-152-access-grants.js";
import { migrateV153AccessPolicyFamilies } from "./migration-153-access-policy-families.js";
import { markLinkStatsDirty } from "./DirtyMarks.js";
import { migrateV154ConfidentialOAuthClients } from "./migration-154-confidential-oauth-clients.js";
import { addOAuthRefreshRetryColumns } from "./migration-160-oauth-refresh-retry.js";
import { migrateAnswerOwnersToStableScope } from "./migration-161-answer-owner-scope.js";
import { indexPrincipalCredentialsByExecutionDevice } from "./migration-162-principal-credential-device-index.js";
import { renamePairingRedemptionReceipts } from "./migration-166-pairing-receipts.js";
import { indexPendingCredentials } from "./migration-167-pending-credential-index.js";
import { retireServiceCredentials } from "./migration-169-retire-service-credentials.js";
import { migrateV171AccessLevels } from "./migration-171-access-levels.js";
import { createDeviceDoctorRunsTable } from "./repositories/DeviceDoctorRunRepository.js";
import {
  addReauthReminderReservationColumns,
  createReauthRemindersTable,
  rekeyReauthRemindersByDevice,
} from "./repositories/ReauthRemindersRepository.js";
import {
  addMobilePermissionEpisodeIdColumn,
  addMobilePermissionEpisodeCauseColumns,
  createMobilePermissionHealthTable,
  rekeyMobilePermissionHealthByDevice,
} from "./repositories/MobilePermissionHealthRepository.js";
import { createSourceDocumentProfilesTable } from "./repositories/SourceDocumentProfileRepository.js";
import { createSourceStreamCleanupTable } from "./repositories/SourceStreamCleanupRepository.js";
import {
  createSourceModeTransitionIndexes,
  createSourceModeTransitionPublicationTable,
  createSourceModeTransitionTable,
} from "./repositories/SourceModeTransitionRepository.js";
import { createSourceMemberConfigContractTable } from "./repositories/SourceMemberConfigContractRepository.js";
import { createReplicaDeletionClaimsTable } from "./repositories/ReplicaDeletionClaimRepository.js";
import { foldWebPagesIntoWebSource } from "./fold-web-pages-migration.js";
import { installCollectorRosterRevision, installMutableListRevisions } from "./list-revisions.js";
import { pruneOrphanSourceStats } from "./prune-orphan-source-stats.js";
import { pruneInvalidEmailAliases } from "./prune-invalid-email-aliases.js";
import { runSchemaSetup } from "./schema.js";
import { addNotesAccessCapability } from "./migration-163-notes-access.js";
import { addSourceAccountDescriptor } from "./migration-172-source-account.js";
import { addPersonAliasAssertions } from "./migration-173-alias-assertions.js";
import { namespaceWhatsappLids } from "./migration-174-lid-namespace.js";
import { addSourceFamilyMeta } from "./migration-175-source-family-meta.js";
import { addDocumentPartitionKey } from "./migration-176-document-partition-key.js";
import { addSourceWireContracts } from "./migration-177-source-wire-contract.js";
import { addPendingSourcePages } from "./migration-178-pending-source-pages.js";
import { addSourceSyncIssues } from "./migration-179-source-sync-issues.js";
import { normalizeSourceTimestamps } from "./migration-180-source-timestamps.js";
import { LATEST_SCHEMA_VERSION } from "./schema-version.js";
import type { Db } from "./types.js";

export { LATEST_SCHEMA_VERSION } from "./schema-version.js";

const log = createLogger("gateway:migrations");

export interface Migration {
  /** 1-indexed strictly-increasing version number. */
  readonly version: number;
  /** One-line description, used in logs and `schema_migrations.description`. */
  readonly description: string;
  /**
   * Runs `up` outside the runner's transaction. Required for a migration
   * that must toggle `PRAGMA foreign_keys` (a no-op inside a transaction)
   * — i.e. SQLite's 12-step procedure for rebuilding a table other tables
   * reference. Such a migration owns its own BEGIN/COMMIT and must verify
   * itself with `PRAGMA foreign_key_check` before committing; the runner
   * stamps `user_version` only after `up` returns.
   */
  readonly ownTransaction?: boolean;
  /**
   * Imperative migration body. Runs inside a transaction unless
   * `ownTransaction` is set; the runner commits and bumps `user_version`
   * to `version` on success.
   */
  up(db: Db): void;
}

function ensurePortalSessionHashes(db: Db): void {
  const cols = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('sessions')")
    .all()
    .map((r) => r.name);
  if (!cols.includes("last_active_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_active_at INTEGER");
  }
  if (!cols.includes("session_hash")) {
    db.exec("ALTER TABLE sessions ADD COLUMN session_hash TEXT");
  }

  db.exec("UPDATE sessions SET last_active_at = created_at WHERE last_active_at IS NULL");

  const rows = db
    .prepare<
      [],
      { id: string; session_hash: string | null }
    >("SELECT id, session_hash FROM sessions")
    .all();
  const update = db.prepare<[string, string, string]>(
    "UPDATE sessions SET id = ?, session_hash = ? WHERE id = ?",
  );
  for (const row of rows) {
    if (row.session_hash) continue;
    const sessionHash = createHash("sha256").update(row.id).digest("hex");
    update.run(randomUUID(), sessionHash, row.id);
  }

  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_hash ON sessions(session_hash)");
}

function addNameFrequencyColumns(db: Db): void {
  const cols = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('person_aliases')")
    .all()
    .map((r) => r.name);
  if (!cols.includes("occurrence_count")) {
    db.exec("ALTER TABLE person_aliases ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1");
  }
  if (!cols.includes("is_primary")) {
    // Default 1: existing names are all born primary (pre-feature behavior — every
    // name participates), and recomputeNamePrimaries then demotes all but the
    // dominant one per person. NO document scan; counts refine organically as new
    // documents arrive (an operator who wants correct counts now runs a one-off
    // occurrence backfill).
    db.exec("ALTER TABLE person_aliases ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 1");
  }
}

/**
 * Ordered migration list. Future migrations append here.
 */
/**
 * The table a pre-rename migration must actually touch.
 *
 * Migration 72 renamed the steward's tables into the cognition vocabulary, and
 * the migrations before it were rewritten to the new names. That is only half
 * right: `runSchemaSetup` runs the current DDL on every boot BEFORE migrations,
 * so an install upgrading from before 72 reaches those earlier steps with the
 * new-named table freshly created and EMPTY, while its data still sits in the
 * old-named one. Operating on the new name there is a silent no-op — the
 * spend-history copy, the url-crawler run purge and the `cycle_anchor_at`
 * back-fill all quietly did nothing.
 *
 * So a migration that runs before 72 asks for the name that currently holds
 * the rows. After 72 the old table is gone and this returns the new name,
 * which is why it is safe to leave in place permanently.
 */
function liveTableName(db: Db, legacy: string, current: string): string {
  const exists = (name: string): boolean =>
    db
      .prepare<
        [string],
        { present: number }
      >("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined;
  return exists(legacy) ? legacy : current;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    description: "collapse three singleton OCC tables into refresh_meta",
    up(db) {
      // `runSchemaSetup` runs ahead of this migration and has already
      // CREATEd `refresh_meta` with three seed rows (job='link_graph',
      // 'interaction_scores', 'merge_rules'). Populate the per-job
      // state from the legacy tables where they still exist, then
      // drop the legacy structures.

      const tableExists = (name: string): boolean => {
        const row = db
          .prepare<
            [string],
            { name: string }
          >("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
          .get(name);
        return row !== undefined;
      };

      // link_graph — historically lived on the data row of `link_stats`
      // (Shape A: data + OCC in the same row). Pre-migration the OCC
      // columns are `dirty_version`, `needs_refresh`, `last_computed_at`.
      // There was no `last_computed_version` field; the inline-skip
      // pattern (`UPDATE link_stats SET ... WHERE dirty_version = ?`)
      // didn't need one. Map last_computed_version to dirty_version on
      // migration so the first post-migration refresh tick doesn't
      // immediately re-fire on a healthy row.
      const linkStatsCols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('link_stats')")
        .all()
        .map((r) => r.name);
      const linkStatsHasOcc =
        linkStatsCols.includes("dirty_version") && linkStatsCols.includes("needs_refresh");
      if (linkStatsHasOcc) {
        db.prepare(
          `UPDATE refresh_meta
             SET dirty_version = COALESCE((SELECT dirty_version FROM link_stats WHERE id = 1), 0),
                 last_computed_version = COALESCE((SELECT dirty_version FROM link_stats WHERE id = 1), 0),
                 last_computed_at = (SELECT last_computed_at FROM link_stats WHERE id = 1),
                 needs_refresh = COALESCE((SELECT needs_refresh FROM link_stats WHERE id = 1), 1)
           WHERE job = 'link_graph'`,
        ).run();
        db.exec("ALTER TABLE link_stats DROP COLUMN dirty_version");
        db.exec("ALTER TABLE link_stats DROP COLUMN needs_refresh");
      }

      if (tableExists("interaction_scores_meta")) {
        db.prepare(
          `UPDATE refresh_meta
             SET dirty_version = COALESCE((SELECT dirty_version FROM interaction_scores_meta WHERE id = 1), 0),
                 last_computed_version = COALESCE((SELECT last_computed_version FROM interaction_scores_meta WHERE id = 1), -1),
                 last_computed_at = (SELECT last_computed_at FROM interaction_scores_meta WHERE id = 1)
           WHERE job = 'interaction_scores'`,
        ).run();
        db.exec("DROP TABLE interaction_scores_meta");
      }

      if (tableExists("merge_rules_meta")) {
        // merge_rules_meta carried `last_evaluated_*` columns instead
        // of `last_computed_*`. The semantics are identical (watermark
        // of the last successful pass); the rename is for consistency.
        db.prepare(
          `UPDATE refresh_meta
             SET dirty_version = COALESCE((SELECT dirty_version FROM merge_rules_meta WHERE id = 1), 0),
                 last_computed_version = COALESCE((SELECT last_evaluated_version FROM merge_rules_meta WHERE id = 1), -1),
                 last_computed_at = (SELECT last_evaluated_at FROM merge_rules_meta WHERE id = 1)
           WHERE job = 'merge_rules'`,
        ).run();
        db.exec("DROP TABLE merge_rules_meta");
      }
    },
  },
  {
    version: 3,
    description: "tombstone — re-derive documents.source_url (obsolete)",
    up() {
      // Tombstone. The original transform re-derived `documents.source_url`
      // after a `normalizeUrl` heuristic change. It ran on every install
      // that crossed it and is now obsolete: re-canonicalization on future
      // spec changes goes through
      // `POST /admin/url-canonicalizers/recompute-source-urls`, not a
      // migration. Kept as a no-op so the user_version chain stays
      // contiguous and the append-only policy holds — never removed.
    },
  },
  {
    version: 4,
    description: "tombstone — apply source-package URL-canonicalizer contract (obsolete)",
    up() {
      // Tombstone. Paired with migration 3: re-applied `documents.source_url`
      // under the source-package URL-canonicalizer contract. Superseded by
      // the same admin recompute endpoint; kept as a no-op for chain
      // contiguity.
    },
  },
  {
    version: 5,
    description: "add APNs registration columns to devices",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("apns_device_token")) {
        db.exec("ALTER TABLE devices ADD COLUMN apns_device_token TEXT");
      }
      if (!cols.includes("apns_environment")) {
        db.exec("ALTER TABLE devices ADD COLUMN apns_environment TEXT");
      }
      if (!cols.includes("apns_bundle_id")) {
        db.exec("ALTER TABLE devices ADD COLUMN apns_bundle_id TEXT");
      }
      if (!cols.includes("apns_token_updated_at")) {
        db.exec("ALTER TABLE devices ADD COLUMN apns_token_updated_at INTEGER");
      }
    },
  },
  {
    version: 6,
    description: "retired: added a column to a table the triggers feature owned",
    up() {
      // Tombstone. This step shaped a table the triggers feature owned, and
      // migration 102 drops that table on every install that still has one, so
      // there is nothing left for it to shape. The slot stays because the
      // version chain has to stay contiguous.
    },
  },
  {
    version: 7,
    description: "widen refresh_meta CHECK to include near_dup_df",
    up(db) {
      // Existing installs have refresh_meta with the old 3-job CHECK
      // constraint. SQLite can't ALTER CHECK constraints in place — the
      // canonical pattern is to recreate the table.
      //
      // `runSchemaSetup` has already (re-)issued the CREATE IF NOT
      // EXISTS for the new shape; on an existing install the new CHECK
      // is silently ignored by `IF NOT EXISTS`. We rebuild explicitly.
      //
      // If the live table already includes 'near_dup_df' in its CHECK
      // (idempotent re-application), skip.
      const ddl = db
        .prepare<
          [string],
          { sql: string | null }
        >("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("refresh_meta");
      if (ddl?.sql && ddl.sql.includes("'near_dup_df'")) return;

      // Re-create the table with the widened CHECK and copy rows over.
      db.exec(`
        CREATE TABLE refresh_meta_new (
          job TEXT PRIMARY KEY CHECK (job IN ('link_graph', 'interaction_scores', 'merge_rules', 'near_dup_df')),
          dirty_version INTEGER NOT NULL DEFAULT 0,
          last_computed_version INTEGER NOT NULL DEFAULT -1,
          last_computed_at INTEGER,
          needs_refresh INTEGER NOT NULL DEFAULT 1
        )
      `);
      db.exec(`
        INSERT INTO refresh_meta_new (job, dirty_version, last_computed_version, last_computed_at, needs_refresh)
          SELECT job, dirty_version, last_computed_version, last_computed_at, needs_refresh FROM refresh_meta
      `);
      db.exec("DROP TABLE refresh_meta");
      db.exec("ALTER TABLE refresh_meta_new RENAME TO refresh_meta");
      // Seed the new job row idempotently (no-op if already present
      // because another path raced).
      db.exec("INSERT OR IGNORE INTO refresh_meta (job) VALUES ('near_dup_df')");
    },
  },
  {
    version: 8,
    description: "tombstone — rewrite Gmail metadata.sourceUrl to openable form (obsolete)",
    up() {
      // Tombstone. The original transform rewrote Gmail `metadata.sourceUrl`
      // from the synthetic `#message/<id>` dedup key to the openable
      // `u/0/#all/<id>` form. It ran on every install that crossed it; the
      // Gmail source now emits the openable form directly at ingest, so the
      // back-fill is obsolete. Kept as a no-op for chain contiguity.
    },
  },
  {
    version: 9,
    description: "add bg_color + accent_color columns to sync_state",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('sync_state')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("bg_color")) {
        db.exec("ALTER TABLE sync_state ADD COLUMN bg_color TEXT");
      }
      if (!cols.includes("accent_color")) {
        db.exec("ALTER TABLE sync_state ADD COLUMN accent_color TEXT");
      }
    },
  },
  {
    version: 10,
    description: "add content_retention column to sync_state",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('sync_state')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("content_retention")) {
        db.exec("ALTER TABLE sync_state ADD COLUMN content_retention TEXT");
      }
    },
  },
  {
    // Conversations as first-class documents. The omnesis-chat source
    // attaches per-citation quote / quoteAuthor / note to each annotation
    // edge; the column is NULL for every pre-existing URL-derived edge.
    version: 11,
    description: "add metadata_json column to document_links for citation payloads",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('document_links')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("metadata_json")) {
        db.exec("ALTER TABLE document_links ADD COLUMN metadata_json TEXT");
      }
    },
  },
  {
    version: 12,
    description: "add link_stats_counters table and triggers for O(1) link stats reads",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS link_stats_counters (
          link_type TEXT PRIMARY KEY,
          total INTEGER NOT NULL DEFAULT 0,
          resolved INTEGER NOT NULL DEFAULT 0
        )
      `);
      // Seed counters from current document_links data.
      db.exec(`
        INSERT OR REPLACE INTO link_stats_counters (link_type, total, resolved)
        SELECT link_type, COUNT(*) AS total,
          SUM(CASE WHEN target_doc_id IS NOT NULL THEN 1 ELSE 0 END) AS resolved
        FROM document_links GROUP BY link_type
      `);
      // Triggers maintain counters atomically with every mutation.
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
    },
  },
  {
    version: 13,
    description: "add expression index on documentType='contact' for boot-time seedFromContacts",
    up(db) {
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_documents_contact_type
           ON documents(json_extract(metadata, '$.documentType'))
           WHERE json_extract(metadata, '$.documentType') = 'contact'`,
      );
    },
  },
  {
    version: 14,
    description: "tombstone — strip non-functional googlegmail:///co compose appUrl (obsolete)",
    up() {
      // Tombstone. The original transform stripped the non-functional
      // `googlegmail:///co` compose appUrl from Gmail document metadata once
      // the Gmail source stopped emitting an appUrl. With no new rows ever
      // carrying that appUrl, the back-fill is obsolete. Kept as a no-op for
      // chain contiguity.
    },
  },
  {
    version: 15,
    description: "add match_strength column to merge_candidates for name-match ranking",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('merge_candidates')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("match_strength")) {
        db.exec("ALTER TABLE merge_candidates ADD COLUMN match_strength REAL");
      }
    },
  },
  {
    version: 16,
    description: "add group_id correlation column + index to merge_rules for cluster-merge batches",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('merge_rules')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("group_id")) {
        db.exec("ALTER TABLE merge_rules ADD COLUMN group_id TEXT");
      }
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_merge_rules_group ON merge_rules(group_id) WHERE group_id IS NOT NULL",
      );
    },
  },
  {
    // See #568 — runner callback tokens are short-lived and read-only; the
    // expiry column lets `lookupToken` reject a replayed credential past its
    // window and a periodic sweep prune the rows. NULL for every existing
    // (never-expiring) device token.
    version: 17,
    description: "add expires_at column to tokens for short-lived callback tokens",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('tokens')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("expires_at")) {
        db.exec("ALTER TABLE tokens ADD COLUMN expires_at INTEGER");
      }
    },
  },
  {
    // See #284 — pairing flows (CLI + portal) can now stage the device
    // owner's self email/phone identifiers at code-creation time; they're
    // applied to the new device row at redeem. The pending pairing carries
    // them in these JSON-array columns. '[]' for every pre-existing row.
    version: 18,
    description: "add self_emails / self_phones columns to device_pairings",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('device_pairings')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("self_emails")) {
        db.exec("ALTER TABLE device_pairings ADD COLUMN self_emails TEXT NOT NULL DEFAULT '[]'");
      }
      if (!cols.includes("self_phones")) {
        db.exec("ALTER TABLE device_pairings ADD COLUMN self_phones TEXT NOT NULL DEFAULT '[]'");
      }
    },
  },
  {
    // See #430 — source-declared edges + link provenance. Adds the four
    // provenance columns to document_links, migrates the structural edge
    // vocabulary on existing rows (attachment→contains, email-thread→
    // part-of-thread, intra-source→references), backfills provenance from the
    // (now-migrated) link_type, and re-seeds link_stats_counters since its
    // primary key is the renamed link_type. The pending_edges table + the
    // provenance indexes are created idempotently by runSchemaSetup (which
    // runs ahead of this migration); this step owns only the column ALTERs and
    // the data transformation.
    version: 19,
    description: "add provenance columns to document_links + migrate edge vocabulary (#430)",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('document_links')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("provenance_kind")) {
        db.exec("ALTER TABLE document_links ADD COLUMN provenance_kind TEXT");
      }
      if (!cols.includes("provenance_origin")) {
        db.exec("ALTER TABLE document_links ADD COLUMN provenance_origin TEXT");
      }
      if (!cols.includes("provenance_version")) {
        db.exec("ALTER TABLE document_links ADD COLUMN provenance_version TEXT");
      }
      if (!cols.includes("declared_at")) {
        db.exec("ALTER TABLE document_links ADD COLUMN declared_at TEXT");
      }

      // Vocabulary migration. The attachment flavour of `contains` carries
      // `{"role":"attachment"}` so the edge is self-describing; COALESCE keeps
      // any pre-existing metadata_json (there is none on attachment rows today).
      db.exec(
        `UPDATE document_links
            SET link_type = 'contains',
                metadata_json = COALESCE(metadata_json, '{"role":"attachment"}')
          WHERE link_type = 'attachment'`,
      );
      db.exec(
        "UPDATE document_links SET link_type = 'part-of-thread' WHERE link_type = 'email-thread'",
      );
      db.exec(
        "UPDATE document_links SET link_type = 'references' WHERE link_type = 'intra-source'",
      );

      // Backfill provenance from the (now-migrated) link_type. Mirrors the
      // type-level defaults in `@omnesis/core` LINK_EDGE_PROVENANCE so a
      // legacy row reads identically whether it consults the column or the
      // type-level fallback. declared_at <- created_at; origin <- the row's
      // source document's source_id (the declaring source for structural
      // edges; the parser/extractor scope otherwise).
      db.exec(
        `UPDATE document_links
            SET provenance_kind = CASE link_type
                  WHEN 'url' THEN 'content-derived'
                  WHEN 'duplicate-content' THEN 'cross-source-derived'
                  WHEN 'cited' THEN 'llm-derived'
                  ELSE 'source-declared'
                END,
                declared_at = COALESCE(declared_at, created_at)
          WHERE provenance_kind IS NULL`,
      );
      db.exec(
        `UPDATE document_links
            SET provenance_origin = (
              SELECT source_id FROM documents WHERE documents.id = document_links.source_doc_id)
          WHERE provenance_origin IS NULL`,
      );

      // Re-seed link_stats_counters: its primary key is link_type, which we
      // just renamed for the structural edges, so the legacy 'attachment' /
      // 'email-thread' / 'intra-source' counter rows are now orphaned. Rebuild
      // from the live data (same pattern as migration 12's seed).
      db.exec("DELETE FROM link_stats_counters");
      db.exec(
        `INSERT OR REPLACE INTO link_stats_counters (link_type, total, resolved)
           SELECT link_type, COUNT(*) AS total,
                  SUM(CASE WHEN target_doc_id IS NOT NULL THEN 1 ELSE 0 END) AS resolved
             FROM document_links GROUP BY link_type`,
      );

      // Ensure the provenance indexes exist for this (existing) install now
      // that the column is present — runSchemaSetup guards them on the column,
      // and on this boot it ran before the ALTER above.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_document_links_provenance ON document_links(provenance_kind) WHERE provenance_kind IS NOT NULL",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_document_links_source_prov ON document_links(source_doc_id, provenance_kind)",
      );
    },
  },
  {
    // Durable removal tombstones for push sources. The table is created
    // idempotently by runSchemaSetup (which runs ahead of this migration),
    // so for an existing install this step only needs to ensure it exists —
    // there is no data to transform. A push source removed before this
    // migration shipped was a self-healing no-op (it auto-recreated on the
    // next ingest); from here on, removal sticks until an explicit re-enable.
    version: 20,
    description: "add removed_sources tombstone table for durable push-source removal",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS removed_sources (
          id TEXT PRIMARY KEY,
          removed_at INTEGER NOT NULL
        )
      `);
    },
  },
  {
    // Collapse accumulated ghost portal devices onto a single canonical row.
    // Blank-named portal (browser) logins used to mint a fresh random-named
    // `portal-<8hex>` device on every redeem, so the by-name reuse never
    // matched and the devices list grew an orphan row per login that nothing
    // pruned. The companion code fix (resolveDeviceName → stable "portal")
    // stops new ones; this collapses the ones already on existing installs.
    //
    // Scope is the auto-generated names only — `portal` or `portal-<8 hex>` —
    // so an explicitly-named portal device is never touched. The survivor is
    // the one whose token was used most recently (then most recently paired),
    // the others' tokens are re-pointed onto it, the extra rows are deleted,
    // and the survivor is renamed to the canonical "portal" so future nameless
    // logins reuse it. Idempotent: once one target row remains it is a no-op.
    version: 21,
    description: "collapse duplicate auto-named portal devices onto one canonical row",
    up(db) {
      // GLOB (not LIKE) so each `[0-9a-f]` is an actual character class; the
      // hex slug from randomBytes(4).toString("hex") is 8 lowercase hex chars.
      const HEX = "[0-9a-f]";
      const portalGlob = `portal-${HEX}${HEX}${HEX}${HEX}${HEX}${HEX}${HEX}${HEX}`;
      const targets = db
        .prepare<[string], { id: string; pairedAt: number; lastTokenUse: number | null }>(
          `SELECT d.id AS id,
                  d.paired_at AS pairedAt,
                  (SELECT MAX(t.last_used_at) FROM tokens t WHERE t.device_id = d.id) AS lastTokenUse
             FROM devices d
            WHERE d.kind = 'portal'
              AND (d.name = 'portal' OR d.name GLOB ?)`,
        )
        .all(portalGlob);
      if (targets.length <= 1) return;

      const survivor = targets.slice().sort((a, b) => {
        const byUse = (b.lastTokenUse ?? -1) - (a.lastTokenUse ?? -1);
        if (byUse !== 0) return byUse;
        const byPaired = (b.pairedAt ?? -1) - (a.pairedAt ?? -1);
        if (byPaired !== 0) return byPaired;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })[0];

      const repoint = db.prepare("UPDATE tokens SET device_id = ? WHERE device_id = ?");
      const dropDevice = db.prepare("DELETE FROM devices WHERE id = ?");
      let merged = 0;
      for (const t of targets) {
        if (t.id === survivor.id) continue;
        // Re-point first so the token rows survive the cascade on delete.
        repoint.run(survivor.id, t.id);
        dropDevice.run(t.id);
        merged += 1;
      }

      const survName = db
        .prepare<[string], { name: string }>("SELECT name FROM devices WHERE id = ?")
        .get(survivor.id);
      if (survName && survName.name !== "portal") {
        db.prepare("UPDATE devices SET name = 'portal' WHERE id = ?").run(survivor.id);
      }
      log.info(`migration 21: collapsed ${merged} ghost portal device(s) onto ${survivor.id}`);
    },
  },
  {
    // Re-home pages written by early browser-extension builds onto `web`,
    // preserving links and coalescing duplicate normalized URLs.
    version: 22,
    description: "fold legacy browser-extension pages into the `web` source",
    up(db) {
      const result = foldWebPagesIntoWebSource(db);
      if (result.scanned > 0) {
        log.info(
          `web-pages fold: ${result.folded} folded into 'web', ${result.deduped} deduped, ${result.linksRemapped} links + ${result.pendingRemapped} pending edges remapped`,
        );
      }
    },
  },
  {
    version: 23,
    description: "tombstone — retired queue provenance column",
    up() {},
  },
  {
    // Forward-looking consent-expiry (#927). Open-banking aggregators (Plaid
    // `item.consent_expiration_time`, PSD2/CDR windows) require periodic
    // re-consent on a *known* schedule. The source reports its deadline on each
    // successful page; the gateway persists it here so `deriveDisplayStatus` can
    // raise a non-terminal `auth-expiring` warning ahead of the deadline,
    // distinct from the reactive terminal `needs-auth`. No data to transform —
    // an existing install just gains the column (NULL = no known deadline).
    version: 24,
    description:
      "add consent_expires_at column to sync_state for forward-looking re-consent (#927)",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('sync_state')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("consent_expires_at")) {
        db.exec("ALTER TABLE sync_state ADD COLUMN consent_expires_at TEXT");
      }
    },
  },
  {
    // Prune orphaned `source_stats` rows left by source re-homes.
    // `source_stats` is recomputed only for dirty sources and never deleted, so
    // a source whose documents were all re-homed keeps a stale `doc_count` that
    // inflates `totalGatewayDocs` on `/index/stats` — a phantom backlog with a
    // bogus ETA, plus a ghost row in the status views. General + conservative:
    // deletes a row only when it claims documents the `documents` table no
    // longer has. The whole rule lives in `prune-orphan-source-stats.ts` so it
    // is testable in isolation; idempotent (a replay finds no orphans).
    version: 25,
    description: "prune orphaned source_stats rows for re-homed/removed sources (#895)",
    up(db) {
      const removed = pruneOrphanSourceStats(db);
      if (removed > 0) {
        log.info(`pruned ${removed} orphaned source_stats row(s)`);
      }
    },
  },
  {
    // Prior versions stored the literal portal cookie value in `sessions.id`.
    // `/sql` and backups could therefore expose a reusable browser session.
    // Add a hash column for lookups and rotate the primary key to a fresh,
    // non-secret row id while preserving existing browser sessions: the old
    // cookie value is hashed into `session_hash`, then removed from `id`.
    //
    // The same migration also adds the durable `last_active_at` gate for the
    // throttled sliding expiry window (#65), so background refresh attempts can
    // be safely fire-and-forget without writing on every authenticated request.
    version: 26,
    description: "hash portal session secrets at rest and add throttled activity refresh gate",
    up(db) {
      ensurePortalSessionHashes(db);
    },
  },
  {
    // Repair live installs that recorded an earlier migration 26 from #65
    // before #1039's session_hash hardening merged under the same version.
    // Those databases have `last_active_at` but not `session_hash`, so the
    // migration runner skips v26 and portal cookie lookup fails at runtime.
    version: 27,
    description: "repair portal session hash column after migration 26 collision",
    up(db) {
      ensurePortalSessionHashes(db);
    },
  },
  {
    // Remove email aliases whose domain ends in a non-existent TLD — parser
    // artifacts (a real local glued onto a domain extended past its true TLD).
    // Alias creation now rejects these at the source; this clears the ones
    // recorded before that gate. Idempotent — a replay finds none.
    version: 28,
    description: "prune invalid-TLD email aliases (parser artifacts)",
    up(db) {
      const removed = pruneInvalidEmailAliases(db);
      if (removed > 0) log.info(`migration 28: pruned ${removed} invalid-TLD email aliases`);
    },
  },
  {
    // Downgrade compatibility: each source now records the schema version
    // that wrote its cursor. On boot the gateway checks whether the running
    // binary is older than any source's recorded version; if so it resets
    // only those sources (cursor cleared, wipe epoch bumped) so they resync
    // cleanly. Upgrade path is unchanged — forward migrations always run and
    // sources always keep their data. See #1078 and runDowngradeCompatCheck.
    version: 29,
    description:
      "add minimum_gateway_version to sync_state for downgrade-safe per-source cursor reset (#1078)",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('sync_state')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("minimum_gateway_version")) {
        db.exec(
          "ALTER TABLE sync_state ADD COLUMN minimum_gateway_version INTEGER NOT NULL DEFAULT 0",
        );
      }
    },
  },
  {
    // Per-name occurrence frequency: adds occurrence_count + is_primary to
    // person_aliases so the dominant ("most common") name drives display and
    // merge decisions, and a curated contact-card name outranks raw sender
    // display-names. Adds columns with cheap defaults and seeds is_primary on
    // the earliest name per person — NO document-history scan (counts refine
    // organically as new documents arrive).
    version: 30,
    description: "add per-name occurrence_count + is_primary to person_aliases",
    up(db) {
      addNameFrequencyColumns(db);
    },
  },
  {
    // Per-document privacy-delete tombstones (#1065). `runSchemaSetup`
    // already creates the table idempotently ahead of this migration, so
    // for an existing install this only needs to ensure it exists — there
    // is no data to transform. Before this shipped a single-document delete
    // had no durable record, so the next sync / re-capture re-upserted the
    // page; from here on the removal sticks until the source is re-added.
    version: 31,
    description: "add removed_documents tombstone table for durable single-document privacy delete",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS removed_documents (
          provider_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          external_id TEXT NOT NULL,
          removed_at INTEGER NOT NULL,
          PRIMARY KEY (provider_id, source_id, external_id)
        )
      `);
    },
  },
  {
    // The `devices.self_emails` / `self_phones` columns — the device owner's
    // self email/phone identifiers (#282) — were only ever declared inline in
    // `runSchemaSetup`'s `CREATE TABLE IF NOT EXISTS devices`, which is a no-op
    // on an already-existing `devices` table. The sibling `device_pairings`
    // columns got their own ALTER migration (v18); the `devices` table never
    // did. So an install whose `devices` table was created before #282 and then
    // upgraded across it is left without these columns — and `DEVICE_SELECT_COLS`
    // selects them on every getDevice/listDevices, throwing `no such column:
    // self_emails` on a core, always-hit path. This back-fills them. Idempotent
    // via the pragma_table_info guard, so it's a no-op on a fresh DB whose
    // `devices` table already carries the columns.
    version: 32,
    description: "back-fill self_emails / self_phones columns on devices (#282)",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("self_emails")) {
        db.exec("ALTER TABLE devices ADD COLUMN self_emails TEXT NOT NULL DEFAULT '[]'");
      }
      if (!cols.includes("self_phones")) {
        db.exec("ALTER TABLE devices ADD COLUMN self_phones TEXT NOT NULL DEFAULT '[]'");
      }
    },
  },
  {
    // Briefs / Cognition Steward storage (experimental): open loops + ledger +
    // doc edges, briefs + citation/loop edges, the agent run queue, daily
    // spend totals, the agent-notes blob. Same idempotent DDL function
    // `runSchemaSetup` calls, so fresh and upgrading installs converge on
    // one source of truth.
    version: 33,
    description:
      "add Briefs / Cognition Steward storage tables (open loops, briefs, run queue, spend, notes)",
    up(db) {
      createBriefsStorageTables(db);
    },
  },
  {
    // Decay engine (Briefs / Cognition Steward): the per-loop back-off counter
    // on open_loops. The engine-state table it pairs with is covered by
    // the idempotent createBriefsStorageTables call. The ALTER is
    // pragma-guarded because installs whose open_loops was created by
    // the current DDL already have the column.
    version: 34,
    description: "add open_loops.decay_check_count for the decay engine back-off",
    up(db) {
      createBriefsStorageTables(db);
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('open_loops')")
        .all()
        .map((c) => c.name);
      if (!cols.includes("decay_check_count")) {
        db.exec("ALTER TABLE open_loops ADD COLUMN decay_check_count INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    // Debounce-ceiling engine (Briefs / Cognition Steward): the mutable per-cycle
    // anchor `cognition_runs.cycle_anchor_at`. It anchors the max-defer
    // ceiling that keeps a continuously-folded `data` run claimable within a
    // bounded time — see storage/run-queue.ts. Existing rows back-fill to
    // their `enqueued_at` (their real cycle start); new rows set it on INSERT.
    // The ALTER is pragma-guarded because installs whose cognition_runs was
    // created by the current DDL already carry the column; the back-fill
    // therefore runs only when the column was just added (never re-stomping a
    // live anchor a resurrect has since moved).
    version: 35,
    description: "add cognition_runs.cycle_anchor_at for the debounce-ceiling engine",
    up(db) {
      createBriefsStorageTables(db);
      const runs = liveTableName(db, "loop_agent_runs", "cognition_runs");
      const cols = db
        .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${runs}')`)
        .all()
        .map((c) => c.name);
      if (!cols.includes("cycle_anchor_at")) {
        db.exec(`ALTER TABLE ${runs} ADD COLUMN cycle_anchor_at INTEGER NOT NULL DEFAULT 0`);
        db.exec(`UPDATE ${runs} SET cycle_anchor_at = enqueued_at`);
      }
    },
  },
  {
    // Graph-based reconcile candidates (Briefs / Cognition Steward): the
    // `open_loop_people` join table lets the identity-based reconcile scan
    // find loops sharing a datum's actors/involved people. The idempotent
    // createBriefsStorageTables call creates the table (and index) on both
    // fresh and upgrading installs; the backfill then projects existing
    // loops' `actors_json`/`involved_json` into join rows. INSERT OR IGNORE
    // makes the backfill safe to replay (the PK dedupes), so a re-run — or a
    // fresh install whose CREATE already exists — never double-inserts.
    version: 36,
    description: "add open_loop_people join table + backfill for identity-based reconcile",
    up(db) {
      createBriefsStorageTables(db);
      db.exec(`
        INSERT OR IGNORE INTO open_loop_people (loop_id, person_id, role)
        SELECT ol.id, a.value, 'actor'
        FROM open_loops ol, json_each(ol.actors_json) a
      `);
      db.exec(`
        INSERT OR IGNORE INTO open_loop_people (loop_id, person_id, role)
        SELECT ol.id, i.value, 'involved'
        FROM open_loops ol, json_each(ol.involved_json) i
      `);
    },
  },
  {
    // Consolidation store (Briefs / Cognition Steward): the append-only
    // `retired_loops` table records a compact trace of every loop resolved or
    // removed, so reconcile can recognise a recurring commitment as a known
    // recurrence rather than a fresh loop. A brand-new IF NOT EXISTS table via
    // the idempotent createBriefsStorageTables — no ALTER, no backfill (a fresh
    // table has nothing to migrate). Both this and v36's `up` call the same
    // idempotent DDL, so replaying either order converges on one shape.
    version: 37,
    description: "add retired_loops consolidation store",
    up(db) {
      createBriefsStorageTables(db);
    },
  },
  {
    // Durable doc-annotation store — the evidence-firewalled base of the
    // abstract graph over the physical corpus. A brand-new IF NOT EXISTS table
    // via the idempotent createAnnotationStorageTables (also called from
    // runSchemaSetup for fresh installs) — no ALTER, no backfill.
    version: 38,
    description: "add doc_annotations store for the Cognition Steward",
    up(db) {
      createAnnotationStorageTables(db);
    },
  },
  {
    // Omnesis-derived date-enrichment signal (experimental): a
    // `dates_extracted_at` dirty-flag column on documents (mirrors
    // links_extracted_at) plus the `document_extracted_dates` sidecar table.
    // The ALTER adds the column on existing installs; createExtractedDatesTables
    // (also called from runSchemaSetup for fresh installs) is idempotent and
    // creates the sidecar table + indexes + the partial work-discovery index,
    // which needs the column, so it runs after the ALTER.
    version: 39,
    description: "add date-enrichment signal (dates_extracted_at + document_extracted_dates)",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("dates_extracted_at")) {
        db.exec("ALTER TABLE documents ADD COLUMN dates_extracted_at TEXT");
      }
      createExtractedDatesTables(db);
      // The partial "find work" index references dates_extracted_at, so it is
      // created here — after the ALTER — rather than in runSchemaSetup, which
      // runs before this migration on an upgrade.
      createDatesUnprocessedIndex(db);
    },
  },
  {
    // The time index (experimental): interval-addressed semantic time the
    // background agent adds to and queries. Brand-new IF NOT EXISTS tables via
    // the idempotent createTimeIndexTables (also called from runSchemaSetup for
    // fresh installs) — the doc_annotations shape, no ALTER, no backfill.
    version: 40,
    description: "add time-index store (time_index_entries + time_index_entry_docs)",
    up(db) {
      createLegacyTimeIndexTables(db);
    },
  },
  {
    // Per-document marker for the retrospective bootstrap sweep (experimental).
    // Unlike the dates/links/people dirty flags, this is set ONCE and NEVER
    // cleared by the document upsert — a bootstrap is a one-time historical
    // catch-up; live edits are the waker's job, not the bootstrap's. Guarded
    // ALTER (runSchemaSetup adds the column on fresh installs, ahead of this
    // migration), then the partial "find work" index carrying the sort key.
    version: 41,
    description: "add bootstrap_processed_at marker + pending index",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("bootstrap_processed_at")) {
        db.exec("ALTER TABLE documents ADD COLUMN bootstrap_processed_at TEXT");
      }
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_documents_bootstrap_pending ON documents(source_created_at) WHERE bootstrap_processed_at IS NULL",
      );
    },
  },
  {
    // Split prompt-cache usage out of the steward spend totals so the
    // cache-hit rate is observable per day. prompt_tokens stays the
    // input-side TOTAL; the new columns are subsets of it. Guarded ALTERs
    // (runSchemaSetup creates the full shape on fresh installs, ahead of
    // this migration); existing rows read 0 — the split simply wasn't
    // recorded before it existed.
    version: 42,
    description: "add cognition_spend_daily cache_read_tokens + cache_creation_tokens",
    up(db) {
      const spend = liveTableName(db, "loop_agent_spend", "cognition_spend_daily");
      const cols = db
        .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${spend}')`)
        .all()
        .map((r) => r.name);
      if (!cols.includes("cache_read_tokens")) {
        db.exec(`ALTER TABLE ${spend} ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0`);
      }
      if (!cols.includes("cache_creation_tokens")) {
        db.exec(`ALTER TABLE ${spend} ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    // The brief's follow-up thread ("talk back to the brief"): a nullable
    // pointer to the conversation seeded from the brief's creating-run
    // transcript, stamped once when the user first opens the thread.
    // Guarded ALTER (runSchemaSetup creates the full shape on fresh
    // installs, ahead of this migration); existing rows read NULL — no
    // brief has a thread until one is opened.
    version: 43,
    description: "add briefs.thread_conversation_id for talk-back threads",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('briefs')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("thread_conversation_id")) {
        db.exec("ALTER TABLE briefs ADD COLUMN thread_conversation_id TEXT");
      }
    },
  },
  {
    // Date extraction became language-routed: each document is parsed with
    // the recognizers-text culture of its detected language instead of
    // English for everything, which changes the expected output for every
    // document. Clearing the dirty flag re-enqueues the whole corpus for
    // the background drip; extraction is deterministic and LLM-free, so
    // the re-run costs only background CPU. Existing date rows are
    // replaced per document as the pass reprocesses it
    // (applyExtractedDates deletes-then-inserts). Guarded on the column
    // existing (migration 39 adds it ahead of this one on an upgrading
    // install; runSchemaSetup carries it on a fresh one).
    version: 44,
    description: "reset dates_extracted_at so date extraction reruns with language routing",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
        .all()
        .map((r) => r.name);
      if (cols.includes("dates_extracted_at")) {
        db.exec("UPDATE documents SET dates_extracted_at = NULL");
      }
    },
  },
  {
    version: 45,
    description:
      "add time_index_entries.thread_conversation_id (per-entry follow-up thread pointer)",
    up(db) {
      // Historical upgrades have this retired table. Modern fresh installs do
      // not create it, so replaying this migration must safely no-op.
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('time_index_entries')")
        .all()
        .map((r) => r.name);
      if (cols.length === 0) return;
      if (!cols.includes("thread_conversation_id")) {
        db.exec("ALTER TABLE time_index_entries ADD COLUMN thread_conversation_id TEXT");
      }
    },
  },
  {
    // Replace the /people browse sort index. The old index was on
    // `interaction_score` (the non-decayed variant), but the default browse
    // ORDER BY is `is_self DESC, interaction_score_recent DESC, doc_count DESC`
    // — a different column set — so it could not satisfy the sort and every
    // /people call did a full-table TEMP B-TREE sort (~3.4s on a 50k-people
    // encrypted corpus). Drop it and add one matching the sort tuple exactly;
    // the old index was used by no query. `runSchemaSetup` creates the new
    // index on fresh installs ahead of this migration.
    version: 46,
    description: "replace idx_people_interaction_score with browse-sort-tuple index",
    up(db) {
      db.exec("DROP INDEX IF EXISTS idx_people_interaction_score");
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_people_interaction_recent
           ON people(is_self DESC, interaction_score_recent DESC, doc_count DESC)
           WHERE merged_into IS NULL`,
      );
    },
  },
  {
    // Introduce the developer-annotations store — the operator → engineer
    // data-quality feedback channel, gated behind OMNESIS_DEV_MODE. New,
    // additive table; `runSchemaSetup` creates it on fresh installs and this
    // migration creates it on upgrades. The DDL is idempotent, so no backfill.
    version: 47,
    description: "add dev_annotations store for developer annotations",
    up(db) {
      createDevAnnotationsTables(db);
    },
  },
  {
    // Add doc_annotations.updated_at — the last-revise timestamp the
    // annotation_revise tool stamps. Fresh installs get the column from the
    // idempotent createAnnotationStorageTables DDL; this ALTER adds it on
    // upgrades. Guarded on column absence (like migration 45); no backfill
    // (NULL = never revised).
    version: 48,
    description: "add doc_annotations.updated_at (annotation revise timestamp)",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('doc_annotations')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("updated_at")) {
        db.exec("ALTER TABLE doc_annotations ADD COLUMN updated_at INTEGER");
      }
    },
  },
  {
    // Time-index backlinks: the entry↔loop and entry↔person join tables.
    // Brand-new IF NOT EXISTS tables via the idempotent createTimeIndexTables
    // (also called from runSchemaSetup for fresh installs) — no ALTER. open_loops
    // (migration 33) exists by this point, so the entry↔loop FK resolves. The
    // deterministic seed of these edges from existing links is a separate
    // step (v51), so this slot ships only the empty schema.
    version: 49,
    description: "add time_index_entry_loops + time_index_entry_people backlink join tables",
    up(db) {
      createLegacyTimeIndexTables(db);
    },
  },
  {
    // Person-annotation store — the abstract graph over people, the person-keyed
    // sibling of doc_annotations (migration 38). Brand-new IF NOT EXISTS table via
    // the idempotent createPersonAnnotationStorageTables (also called from
    // runSchemaSetup for fresh installs) — no ALTER, no backfill (person
    // annotations are LLM-derived; there is nothing deterministic to seed).
    version: 50,
    description: "add person_annotations store",
    up(db) {
      createPersonAnnotationStorageTables(db);
    },
  },
  {
    // Deterministic seed of the v49 backlinks from already-present links:
    //   time_index_entry_people <- each entry's linked docs' document_people;
    //   time_index_entry_loops  <- where a loop and an entry share >=1 document
    //   (open_loop_docs INTERSECT time_index_entry_docs).
    // Pure set-based joins over existing tables — no LLM/network — idempotent via
    // INSERT OR IGNORE on the composite PKs, the same shape as migration 36's
    // open_loop_people back-fill. createTimeIndexTables ran in v49, so the target
    // tables exist. New entries created after upgrade carry their own edges via
    // the time_index_add/update tool params; this seeds the pre-existing corpus.
    version: 51,
    description: "backfill time-index entry↔people and entry↔loop backlinks from shared docs",
    up(db) {
      db.exec(`
        INSERT OR IGNORE INTO time_index_entry_people (entry_id, person_id)
        SELECT DISTINCT ted.entry_id, dp.person_id
          FROM time_index_entry_docs ted
          JOIN document_people dp ON dp.document_id = ted.document_id
      `);
      db.exec(`
        INSERT OR IGNORE INTO time_index_entry_loops (entry_id, loop_id)
        SELECT DISTINCT ted.entry_id, old.loop_id
          FROM time_index_entry_docs ted
          JOIN open_loop_docs old ON old.doc_id = ted.document_id
      `);
    },
  },
  {
    // Protocol-neutral state for the external /answer privacy boundary.
    // Candidate answers stay isolated in answer_tasks until a release or
    // approval decision; only released text is copied into answer_messages.
    version: 52,
    description: "add external-answer privacy workflows, approvals, and release ledger",
    up(db) {
      createAnswerPrivacyTables(db);
    },
  },
  {
    version: 53,
    description: "add FCM registration columns to devices",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
        .all()
        .map((row) => row.name);
      if (!cols.includes("fcm_registration_token")) {
        db.exec("ALTER TABLE devices ADD COLUMN fcm_registration_token TEXT");
      }
      if (!cols.includes("fcm_token_updated_at")) {
        db.exec("ALTER TABLE devices ADD COLUMN fcm_token_updated_at INTEGER");
      }
    },
  },
  {
    // Per-mechanism spend accounting: `cognition_spend`, keyed
    // (day, mechanism, model_id), succeeds the day-only `cognition_spend_daily`.
    // The idempotent createBriefsStorageTables call creates the table on both
    // fresh and upgrading installs; the copy then folds the pre-split day
    // totals in as mechanism 'unattributed' / model_id '' so history stays
    // visible in the per-day aggregates. INSERT OR IGNORE makes the copy safe
    // to replay (the composite PK dedupes). `cognition_spend_daily` is deliberately
    // NOT dropped — it is no longer written, but a downgraded binary that
    // still reads it finds its history intact.
    version: 54,
    description:
      "add cognition_spend (per-mechanism token spend) + copy cognition_spend_daily history",
    up(db) {
      createBriefsStorageTables(db);
      const spend = liveTableName(db, "loop_agent_spend", "cognition_spend_daily");
      db.exec(`
        INSERT OR IGNORE INTO cognition_spend
          (day, mechanism, model_id, runs, prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens)
        SELECT day, 'unattributed', '', runs, prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens
          FROM ${spend}
      `);
    },
  },
  {
    // Entailment-firewall verification stamps on both annotation stores:
    // `verification_state` ('verified' | 'unverified' | 'failed', NULL = written
    // with no verifier configured) and `last_verified_at` (unix ms of the last
    // check). Fresh installs get the columns from the idempotent
    // create*StorageTables DDLs; this ALTER adds them on upgrades, guarded on
    // column absence (like migration 48) — no backfill (NULL = pre-gate rows).
    // The partial indexes back the future re-verification sweep's "live rows,
    // oldest-verified first" scan.
    version: 55,
    description:
      "add verification_state + last_verified_at to doc_annotations and person_annotations",
    up(db) {
      for (const table of ["doc_annotations", "person_annotations"]) {
        const cols = db
          .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
          .all()
          .map((r) => r.name);
        if (!cols.includes("verification_state")) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN verification_state TEXT`);
        }
        if (!cols.includes("last_verified_at")) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN last_verified_at INTEGER`);
        }
      }
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_doc_annotations_verified ON doc_annotations(last_verified_at) WHERE invalidated_at IS NULL",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_person_annotations_verified ON person_annotations(last_verified_at) WHERE invalidated_at IS NULL",
      );
    },
  },
  {
    // claim_basis on both annotation stores: how far a claim reasons from its
    // evidence ('quoted' | 'inferred' | 'synthesized'). Fresh installs get the
    // column from the idempotent create*StorageTables DDLs; this ALTER adds it
    // on upgrades, guarded on column absence (like migration 48). The DEFAULT
    // doubles as the legacy backfill: every pre-existing row passed the
    // verbatim-quote firewall, so 'quoted' is the honest-enough label — the
    // re-verification sweep (the verification lane's pull half) corrects it per row.
    version: 56,
    description: "add claim_basis to doc_annotations and person_annotations",
    up(db) {
      for (const table of ["doc_annotations", "person_annotations"]) {
        const cols = db
          .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
          .all()
          .map((r) => r.name);
        if (!cols.includes("claim_basis")) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN claim_basis TEXT NOT NULL DEFAULT 'quoted'`);
        }
      }
    },
  },
  {
    // superseded_by on both annotation stores: a superseded prior is stamped
    // with BOTH invalidated_at (so every liveness predicate and partial index
    // keeps working untouched) and the id of the annotation that replaced it
    // (so audit distinguishes belief revision from content-drift
    // invalidation). Fresh installs get the column from the idempotent
    // create*StorageTables DDLs; this ALTER adds it on upgrades, guarded on
    // column absence (like migration 48) — no backfill (NULL = never
    // superseded).
    version: 57,
    description: "add superseded_by to doc_annotations and person_annotations",
    up(db) {
      for (const table of ["doc_annotations", "person_annotations"]) {
        const cols = db
          .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
          .all()
          .map((r) => r.name);
        if (!cols.includes("superseded_by")) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN superseded_by TEXT`);
        }
      }
    },
  },
  {
    // The brief-claims sidecar: per-brief atomic asserted claims — each
    // factual, document-derived assertion a brief makes, bound to its own
    // evidence document + verbatim quote and stamped by the write-time
    // entailment gate. Fresh installs get the table from the idempotent
    // createBriefClaimsTables DDL in runSchemaSetup; this migration creates
    // it on upgrades (the annotation stores' dual-DDL convention).
    version: 58,
    description: "add the brief_claims sidecar table",
    up(db) {
      createBriefClaimsTables(db);
    },
  },
  {
    // Multi-evidence grounding + consumption provenance. The annotation
    // stores gain per-atom child tables (doc_annotation_evidence /
    // person_annotation_evidence) whose row 0 mirrors the parent's scalar
    // evidence columns; each existing annotation's scalar pair is backfilled
    // as its evidence[0] row (INSERT OR IGNORE on the composite PK keeps the
    // backfill replayable). cognition_consumption_edges records which
    // briefs/loops were built on which annotation priors — brand-new and
    // empty (provenance is recorded mechanically from this version on).
    version: 59,
    description:
      "add annotation evidence child tables (backfilled from the scalar columns) + cognition_consumption_edges",
    up(db) {
      createAnnotationStorageTables(db);
      createPersonAnnotationStorageTables(db);
      createConsumptionEdgesTables(db);
      db.exec(`
        INSERT OR IGNORE INTO doc_annotation_evidence (annotation_id, position, evidence_doc_id, evidence_quote)
        SELECT id, 0, evidence_doc_id, evidence_quote FROM doc_annotations
      `);
      db.exec(`
        INSERT OR IGNORE INTO person_annotation_evidence (annotation_id, position, evidence_doc_id, evidence_quote)
        SELECT id, 0, evidence_doc_id, evidence_quote FROM person_annotations
      `);
    },
  },
  {
    // Trusted /answer audit history is deliberately separate from both the
    // searchable Agent conversation store and answer_messages (released-only
    // model context). Existing pending approvals are snapshotted before later
    // resolution clears the held candidate from answer_tasks.
    version: 60,
    description: "add trusted answer audit history, exact egress ledger, and approval snapshots",
    up(db) {
      createAnswerPrivacyTables(db);
      const columns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('answer_approvals')")
        .all()
        .map((row) => row.name);
      if (!columns.includes("candidate_answer")) {
        db.exec("ALTER TABLE answer_approvals ADD COLUMN candidate_answer TEXT");
      }
      if (!columns.includes("release_status")) {
        db.exec(
          "ALTER TABLE answer_approvals ADD COLUMN release_status TEXT NOT NULL DEFAULT 'released'",
        );
      }
      if (!columns.includes("reductions_json")) {
        db.exec(
          "ALTER TABLE answer_approvals ADD COLUMN reductions_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
      db.exec(`
        UPDATE answer_approvals
           SET candidate_answer = (
                 SELECT t.candidate_answer FROM answer_tasks t
                  WHERE t.id = answer_approvals.task_id
               ),
               release_status = COALESCE((
                 SELECT CASE
                   WHEN t.reductions_json IS NOT NULL AND t.reductions_json <> '[]'
                     THEN 'released_with_reductions'
                   ELSE 'released'
                 END
                   FROM answer_tasks t WHERE t.id = answer_approvals.task_id
               ), 'released'),
               reductions_json = COALESCE((
                 SELECT t.reductions_json FROM answer_tasks t
                  WHERE t.id = answer_approvals.task_id
               ), '[]')
         WHERE status = 'pending'
      `);
      const releases = db
        .prepare<
          [],
          {
            workflow_id: string;
            review_json: string | null;
            policy_revision: string | null;
            answer: string;
            created_at: number;
          }
        >(
          `SELECT t.workflow_id, t.review_json, t.policy_revision, r.answer, r.created_at
             FROM answer_releases r
             JOIN answer_tasks t ON t.id = r.task_id
            WHERE NOT EXISTS (
              SELECT 1 FROM answer_workflow_disclosure d
               WHERE d.workflow_id = t.workflow_id AND d.revision > 0
            )
            ORDER BY t.workflow_id ASC, r.created_at ASC, r.id ASC`,
        )
        .all();
      for (const release of releases) {
        advanceWorkflowDisclosure(db, {
          workflowId: release.workflow_id,
          review: parseReview(release.review_json, release.policy_revision),
          answerCharacters: release.answer.length,
          now: release.created_at,
        });
      }
    },
  },
  {
    version: 61,
    description: "index external-answer review time for bounded privacy health checks",
    up(db) {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_answer_tasks_created_at ON answer_tasks(created_at DESC)",
      );
    },
  },
  {
    version: 62,
    description: "add workflow-scoped answer grants (standing allowances)",
    up(db) {
      // Idempotent: installs answer_workflow_grants via the shared installer.
      createAnswerPrivacyTables(db);
    },
  },
  {
    version: 63,
    description: "add background-agent adjudication columns to merge_candidates",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("PRAGMA table_info(merge_candidates)")
        .all()
        .map((c) => c.name);
      if (!cols.includes("adjudicated_at")) {
        db.exec("ALTER TABLE merge_candidates ADD COLUMN adjudicated_at TEXT");
      }
      if (!cols.includes("adjudication_verdict")) {
        db.exec("ALTER TABLE merge_candidates ADD COLUMN adjudication_verdict TEXT");
      }
      if (!cols.includes("adjudication_reason")) {
        db.exec("ALTER TABLE merge_candidates ADD COLUMN adjudication_reason TEXT");
      }
    },
  },
  {
    version: 64,
    description:
      "swap document_people(person_id) index for a covering (person_id, source_id) index so searchPeople's source_ids strip is index-only",
    up(db) {
      // 1. Create the composite covering index. Its leftmost `person_id` prefix
      //    serves every existing person_id equality/IN lookup identically.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_document_people_person_source ON document_people(person_id, source_id)",
      );
      // 2. Defensive backfill: the read path now reads dp.source_id directly
      //    instead of joining to documents, so any legacy row with a NULL
      //    source_id (older inserts / partial writes) must be reconciled to the
      //    document's own source_id or it would silently drop from the strip.
      //    No-op on a healthy corpus where every insert already set source_id.
      db.exec(
        `UPDATE document_people SET source_id = (
           SELECT source_id FROM documents WHERE documents.id = document_people.document_id
         ) WHERE source_id IS NULL`,
      );
      // 3. Drop the now-redundant single-column index.
      db.exec("DROP INDEX IF EXISTS idx_document_people_person");
    },
  },
  {
    version: 65,
    description:
      "rename the LLM-owned time index to temporal annotations while preserving existing ids",
    up(db) {
      // `runSchemaSetup` executes before migrations, so the destination tables
      // already exist on an upgrade. Calling the installer here keeps direct
      // migration tests and manual idempotency probes honest.
      createTemporalAnnotationTables(db);

      const hasLegacy = db
        .prepare<
          [],
          { one: number }
        >("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'time_index_entries'")
        .get();
      if (hasLegacy) {
        // Live schema setup reflects the current head and therefore omits the
        // retired pointer. Recreate it only for this historical copy step so
        // installs replaying v65 preserve their old row shape until v96 drops
        // the column deliberately.
        const destinationColumns = db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('temporal_annotations')",
          )
          .all()
          .map((row) => row.name);
        if (!destinationColumns.includes("thread_conversation_id")) {
          db.exec("ALTER TABLE temporal_annotations ADD COLUMN thread_conversation_id TEXT");
        }
        // The destination is the live table `createTemporalAnnotationTables`
        // just installed, so the interval's precision lands in `precision`;
        // the legacy source table spells the same value `granularity`.
        db.exec(`
          INSERT OR IGNORE INTO temporal_annotations (
            id, interval_start_ms, interval_end_ms, precision, canonical,
            sentence, kind, created_by_run, created_at, updated_at,
            invalidated_at, thread_conversation_id
          )
          SELECT
            id, interval_start_ms, interval_end_ms, granularity, canonical,
            sentence, kind, created_by_run, created_at, updated_at,
            invalidated_at, thread_conversation_id
          FROM time_index_entries
        `);
        db.exec(`
          INSERT OR IGNORE INTO temporal_annotation_documents (annotation_id, document_id)
          SELECT entry_id, document_id FROM time_index_entry_docs
        `);
        db.exec(`
          INSERT OR IGNORE INTO temporal_annotation_loops (annotation_id, loop_id)
          SELECT entry_id, loop_id FROM time_index_entry_loops
        `);
        db.exec(`
          INSERT OR IGNORE INTO temporal_annotation_people (annotation_id, person_id)
          SELECT entry_id, person_id FROM time_index_entry_people
        `);

        db.exec("DROP TABLE time_index_entry_people");
        db.exec("DROP TABLE time_index_entry_loops");
        db.exec("DROP TABLE time_index_entry_docs");
        db.exec("DROP TABLE time_index_entries");
      }

      // Developer notes are operator-owned state and must continue to point at
      // the same preserved annotation ids after the vocabulary change.
      db.prepare(
        "UPDATE dev_annotations SET target_type = 'temporal_annotation' WHERE target_type = 'time_index_entry'",
      ).run();
    },
  },
  {
    version: 66,
    description: "add source-owned document temporal projections and coverage",
    up(db) {
      // Deliberately schema-only: existing documents are not backfilled.
      // Projection rows appear when their source next emits each document;
      // even an empty page can register the source's declared coverage.
      createDocumentTemporalProjectionTables(db);
    },
  },
  {
    version: 67,
    description: "replace runner actions with subscriptions and firing-bound delivery authority",
    up(db) {
      // The generic off-host runner product has been removed. Its dedicated
      // outbox goes, and so do the device rows it was reached through; the
      // token rows cascade from those.
      //
      // This step also deleted the trigger rows that named a runner action.
      // That part is gone: migration 102 drops the table those rows lived in,
      // and this runs on installs that no longer have it.
      db.exec(`
        DELETE FROM devices WHERE kind = 'runner';
        DROP TABLE IF EXISTS action_deliveries;
        DROP TABLE IF EXISTS action_delivery_circuit;
      `);
      createSubscriptionTables(db);
    },
  },
  {
    version: 68,
    description: "normalize firing evidence and bind Answer egress to its firing",
    up(db) {
      const columns = (table: string): Set<string> =>
        new Set(
          db
            .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
            .all()
            .map((row) => row.name),
        );
      if (!columns("answer_tasks").has("subscription_firing_id")) {
        db.exec("ALTER TABLE answer_tasks ADD COLUMN subscription_firing_id TEXT");
      }
      if (!columns("answer_egress_events").has("subscription_firing_id")) {
        db.exec("ALTER TABLE answer_egress_events ADD COLUMN subscription_firing_id TEXT");
      }
      if (!columns("subscription_firings").has("evidence_count")) {
        db.exec(
          "ALTER TABLE subscription_firings ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 0",
        );
      }
      createSubscriptionTables(db);
      db.exec(`
        INSERT OR IGNORE INTO subscription_firing_evidence (firing_id, document_id)
        SELECT f.id, CAST(value.value AS TEXT)
          FROM subscription_firings f, json_each(f.evidence_json) value
         JOIN documents d ON d.id = CAST(value.value AS TEXT)
         WHERE json_valid(f.evidence_json)
           AND value.type = 'text';

        UPDATE subscription_firings
           SET evidence_count = CASE
                 WHEN json_valid(evidence_json) AND json_type(evidence_json) = 'array'
                   THEN json_array_length(evidence_json)
                 ELSE evidence_count
               END,
               evidence_json = '[]'
         WHERE evidence_json <> '[]';
      `);
    },
  },
  {
    version: 69,
    description: "bind agent repair pairing codes to an exact device",
    up(db) {
      const columns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('device_pairings')")
        .all()
        .map((row) => row.name);
      if (!columns.includes("repair_device_id")) {
        db.exec(
          "ALTER TABLE device_pairings ADD COLUMN repair_device_id TEXT REFERENCES devices(id) ON DELETE CASCADE",
        );
      }
    },
  },
  {
    version: 70,
    description: "remove retired source state and output",
    up(db) {
      const runs = liveTableName(db, "loop_agent_runs", "cognition_runs");
      const tableExists = (name: string): boolean =>
        db
          .prepare<
            [string],
            { present: number }
          >("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(name) !== undefined;

      // Preserve generic source-URL maintenance state that used to share the
      // retired feature's key/value table.
      if (tableExists("crawl_state")) {
        db.exec(`
          INSERT INTO canonicalization_state (key, value, updated_at)
          SELECT key, value, updated_at
            FROM crawl_state
           WHERE key = 'recanonicalize_source_url_fingerprint'
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `);
      }

      db.exec(`
        CREATE TEMP TABLE retired_web_documents (
          id TEXT PRIMARY KEY
        ) WITHOUT ROWID;

        CREATE TEMP TABLE retired_cleanup_sources (
          source_id TEXT PRIMARY KEY
        ) WITHOUT ROWID;

        INSERT INTO retired_web_documents (id)
        SELECT id
          FROM documents
         WHERE source_id = 'url-crawler'
            OR (
              source_id = 'web'
              AND CASE
                    WHEN json_valid(metadata)
                      THEN json_extract(metadata, '$.captureMethod') = 'server-crawl'
                    ELSE 0
                  END
            );

        INSERT OR IGNORE INTO retired_cleanup_sources (source_id)
        SELECT DISTINCT source_id
          FROM documents
         WHERE id IN (SELECT id FROM retired_web_documents);

        INSERT OR IGNORE INTO retired_cleanup_sources (source_id)
        SELECT DISTINCT source_id
          FROM documents
         WHERE CASE
                 WHEN json_valid(metadata)
                 THEN json_type(metadata, '$.captureMethod') IS NOT NULL
                 ELSE 0
               END;

        CREATE TEMP TABLE retired_cleanup_state (
          changed INTEGER NOT NULL
        );

        INSERT INTO retired_cleanup_state (changed)
        SELECT CASE
                 WHEN EXISTS (SELECT 1 FROM retired_web_documents)
                   OR EXISTS (SELECT 1 FROM retired_cleanup_sources)
                   OR EXISTS (
                     SELECT 1 FROM document_links WHERE link_type = 'crawl-seed'
                   )
                   OR EXISTS (
                     SELECT 1 FROM pending_edges
                      WHERE link_type = 'crawl-seed'
                         OR target_source_id = 'url-crawler'
                         OR (link_type = 'url' AND target_source_id = 'web')
                   )
                   THEN 1
                 ELSE 0
               END;
      `);

      // Derived loops and briefs may embed source text even though their
      // citation tables deliberately have no document FK. Expand the deletion
      // closure through loop mirrors before removing any corpus row.
      let frontier = db
        .prepare<[], { id: string }>("SELECT id FROM retired_web_documents")
        .all()
        .map((row) => row.id);
      const deletedLoopIds = new Set<string>();
      const deletedBriefIds = new Set<string>();
      const CASCADE_CHUNK = 400;
      while (frontier.length > 0) {
        const nextFrontier: string[] = [];
        for (let i = 0; i < frontier.length; i += CASCADE_CHUNK) {
          const result = cascadeOpenLoopPrivacyDelete(db, frontier.slice(i, i + CASCADE_CHUNK));
          result.deletedLoopIds.forEach((id) => deletedLoopIds.add(id));
          result.deletedBriefIds.forEach((id) => deletedBriefIds.add(id));
          for (let j = 0; j < result.deletedLoopIds.length; j += CASCADE_CHUNK) {
            const loopIds = result.deletedLoopIds.slice(j, j + CASCADE_CHUNK);
            if (loopIds.length === 0) continue;
            const placeholders = loopIds.map(() => "?").join(", ");
            const mirrors = db
              .prepare<string[], { id: string; source_id: string }>(
                `SELECT id, source_id
                   FROM documents
                  WHERE provider_id = ?
                    AND source_id = ?
                    AND external_id IN (${placeholders})`,
              )
              .all(OPEN_LOOP_PROVIDER_ID, OPEN_LOOP_SOURCE_ID, ...loopIds);
            for (const mirror of mirrors) {
              const inserted = db
                .prepare<[string]>("INSERT OR IGNORE INTO retired_web_documents (id) VALUES (?)")
                .run(mirror.id);
              db.prepare<[string]>(
                "INSERT OR IGNORE INTO retired_cleanup_sources (source_id) VALUES (?)",
              ).run(mirror.source_id);
              if (inserted.changes > 0) nextFrontier.push(mirror.id);
            }
          }
        }
        frontier = nextFrontier;
      }

      const retiredIds = db
        .prepare<[], { id: string }>("SELECT id FROM retired_web_documents")
        .all()
        .map((row) => row.id);
      const deletedDocAnnotationIds = cascadeAnnotationPrivacyDelete(db, retiredIds);
      const deletedPersonAnnotationIds = cascadePersonAnnotationPrivacyDelete(db, retiredIds);
      cascadeTemporalAnnotationPrivacyDelete(db, retiredIds);
      cascadeBriefClaimPrivacyDelete(db, retiredIds);

      const deleteConsumptionIds = (
        column: "prior_annotation_id" | "dependent_id",
        discriminatorColumn: "prior_store" | "dependent_kind",
        discriminator: "doc" | "person" | "loop" | "brief",
        ids: readonly string[],
      ): void => {
        for (let i = 0; i < ids.length; i += CASCADE_CHUNK) {
          const batch = ids.slice(i, i + CASCADE_CHUNK);
          if (batch.length === 0) continue;
          const placeholders = batch.map(() => "?").join(", ");
          db.prepare(
            `DELETE FROM cognition_consumption_edges
              WHERE ${discriminatorColumn} = ? AND ${column} IN (${placeholders})`,
          ).run(discriminator, ...batch);
        }
      };
      deleteConsumptionIds("prior_annotation_id", "prior_store", "doc", deletedDocAnnotationIds);
      deleteConsumptionIds(
        "prior_annotation_id",
        "prior_store",
        "person",
        deletedPersonAnnotationIds,
      );
      deleteConsumptionIds("dependent_id", "dependent_kind", "loop", [...deletedLoopIds]);
      deleteConsumptionIds("dependent_id", "dependent_kind", "brief", [...deletedBriefIds]);

      db.exec(`
        DELETE FROM ${runs}
         WHERE kind IN ('data', 'bootstrap')
           AND CASE
                 WHEN json_valid(payload_json)
                   THEN json_extract(payload_json, '$.docId')
                        IN (SELECT id FROM retired_web_documents)
                 ELSE 0
               END;

        DELETE FROM near_dup_inbox
         WHERE doc_id IN (SELECT id FROM retired_web_documents);

        DELETE FROM document_links WHERE link_type = 'crawl-seed';
        DELETE FROM pending_edges
         WHERE link_type = 'crawl-seed'
            OR target_source_id = 'url-crawler'
            OR (link_type = 'url' AND target_source_id = 'web');
        DELETE FROM documents
         WHERE id IN (SELECT id FROM retired_web_documents);

        UPDATE documents
           SET metadata = json_remove(metadata, '$.captureMethod')
         WHERE CASE
                 WHEN json_valid(metadata)
                   THEN json_type(metadata, '$.captureMethod') IS NOT NULL
                 ELSE 0
               END;

        DELETE FROM sync_state WHERE source_id = 'url-crawler';
        DELETE FROM source_stats WHERE source_id = 'url-crawler';
        DELETE FROM sources WHERE id = 'url-crawler' OR type = 'url-crawler';
        DELETE FROM removed_sources WHERE id = 'url-crawler';
        DELETE FROM source_wipe_epoch WHERE source_id = 'url-crawler';
        DELETE FROM removed_documents WHERE source_id = 'url-crawler';
        DELETE FROM person_aliases WHERE source_id = 'url-crawler';

        UPDATE source_stats
           SET needs_refresh = 1,
               dirty_version = dirty_version + 1,
               latest_doc_id = (
                 SELECT id FROM documents
                  WHERE source_id = source_stats.source_id
                  ORDER BY updated_at DESC, source_updated_at DESC, id DESC
                  LIMIT 1
               ),
               latest_title = (
                 SELECT title FROM documents
                  WHERE source_id = source_stats.source_id
                  ORDER BY updated_at DESC, source_updated_at DESC, id DESC
                  LIMIT 1
               ),
               latest_source_created_at = (
                 SELECT source_created_at FROM documents
                  WHERE source_id = source_stats.source_id
                  ORDER BY updated_at DESC, source_updated_at DESC, id DESC
                  LIMIT 1
               ),
               latest_source_updated_at = (
                 SELECT source_updated_at FROM documents
                  WHERE source_id = source_stats.source_id
                  ORDER BY updated_at DESC, source_updated_at DESC, id DESC
                  LIMIT 1
               ),
               latest_ingested_at = (
                 SELECT ingested_at FROM documents
                  WHERE source_id = source_stats.source_id
                  ORDER BY updated_at DESC, source_updated_at DESC, id DESC
                  LIMIT 1
               ),
               latest_updated_at = (
                 SELECT updated_at FROM documents
                  WHERE source_id = source_stats.source_id
                  ORDER BY updated_at DESC, source_updated_at DESC, id DESC
                  LIMIT 1
               ),
               doc_count = (
                 SELECT COUNT(*) FROM documents
                  WHERE source_id = source_stats.source_id
               )
         WHERE source_id IN (SELECT source_id FROM retired_cleanup_sources);

        UPDATE refresh_meta
           SET dirty_version = dirty_version + 1,
               needs_refresh = CASE
                 WHEN job = 'link_graph' THEN 1
                 ELSE needs_refresh
               END
         WHERE job IN ('link_graph', 'interaction_scores', 'merge_rules', 'near_dup_df')
           AND (SELECT changed FROM retired_cleanup_state) = 1;

        DROP TABLE retired_web_documents;
        DROP TABLE retired_cleanup_sources;
        DROP TABLE retired_cleanup_state;
        DROP TABLE IF EXISTS crawl_queue;
        DROP TABLE IF EXISTS crawl_domain_stats;
        DROP TABLE IF EXISTS crawl_state;
      `);
    },
  },
  {
    version: 71,
    description: "durable per-run cognitive attribution",
    up(db) {
      // Artifacts carry `created_by_run`, but settled run rows are pruned past
      // the retention window — so the workflow, its contract version, and the
      // model behind a durable loop/brief/annotation became unknowable exactly
      // when someone wanted to ask. One never-pruned row per run keeps the
      // answer reachable through the id artifacts already store.
      db.exec(`
        CREATE TABLE IF NOT EXISTS cognition_run_attribution (
          run_id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          workflow_version INTEGER NOT NULL,
          model_id TEXT NOT NULL DEFAULT '',
          settled_at INTEGER NOT NULL
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_run_attribution_workflow ON cognition_run_attribution(workflow_id, workflow_version)",
      );
      // Runs that settled before this migration keep no attribution row. That
      // is deliberate: "we cannot tell what produced this" is a different
      // claim from "this is stale", and back-filling a guess would make the
      // first version bump reprocess a corpus.
    },
  },
  {
    version: 72,
    description: "rename the steward tables to the cognition vocabulary",
    up(db) {
      // The tables were named after the Loop Agent, itself named after the
      // loops it first maintained. The actor now has a name covering what it
      // does — the Cognition Steward — and `cognition` is the code vocabulary.
      //
      // The awkward part is ordering: `runSchemaSetup` runs its DDL on every
      // boot BEFORE migrations, so by the time this runs an upgrading install
      // already has the new-named tables, freshly created and empty, sitting
      // beside the old ones that hold the data. A plain RENAME would fail, and
      // skipping on "target exists" would strand every row. So: move the rows
      // across whatever columns the two share, then drop the old table.
      const renames: Array<[string, string]> = [
        ["loop_agent_runs", "cognition_runs"],
        ["loop_agent_engine_state", "cognition_engine_state"],
        ["loop_agent_notes", "cognition_notes"],
        ["loop_agent_spend", "cognition_spend_daily"],
      ];
      const exists = (name: string): boolean =>
        db
          .prepare<
            [string],
            { present: number }
          >("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(name) !== undefined;
      const columns = (name: string): string[] =>
        db
          .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${name}')`)
          .all()
          .map((r) => r.name);

      for (const [from, to] of renames) {
        if (!exists(from)) continue; // fresh install — the DDL made the new one
        if (!exists(to)) {
          db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
          continue;
        }
        // Both present: carry the rows over on the shared columns. An install
        // several versions behind may lack columns the current DDL creates;
        // those keep their defaults and the later migrations still apply.
        const shared = columns(from).filter((c) => columns(to).includes(c));
        if (shared.length > 0) {
          const cols = shared.join(", ");
          db.exec(`INSERT OR IGNORE INTO ${to} (${cols}) SELECT ${cols} FROM ${from}`);
        }
        db.exec(`DROP TABLE ${from}`);
      }

      // SQLite carries indexes across a RENAME but keeps their old names.
      // Drop them and let the DDL's own definitions stand, so a fresh install
      // and an upgraded one converge on one set.
      db.exec("DROP INDEX IF EXISTS idx_loop_agent_runs_due");
      db.exec("DROP INDEX IF EXISTS idx_loop_agent_runs_pending_dedupe");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_cognition_runs_due ON cognition_runs(status, next_attempt_at)",
      );
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_cognition_runs_pending_dedupe ON cognition_runs(dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL",
      );
    },
  },
  {
    // Staleness detection for sources reading a local file some other program
    // keeps current. Such a source syncs successfully every tick while its data
    // is frozen, so `last_synced_at` says "healthy" right up until the operator
    // notices weeks-old data by hand. What distinguishes a stalled feed from a
    // quiet one is when the source last produced anything, which nothing
    // recorded — hence this column, stamped only when a page carries documents.
    // NULL means "has never produced a document"; a source is never called
    // stale on that basis alone, since it's also what a brand-new source looks
    // like before its first sync lands.
    version: 73,
    description: "add last_document_at column to sync_state for source staleness detection",
    up(db) {
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('sync_state')")
        .all()
        .map((r) => r.name);
      if (!cols.includes("last_document_at")) {
        db.exec("ALTER TABLE sync_state ADD COLUMN last_document_at TEXT");
      }
    },
  },
  {
    version: 74,
    description: "canonicalize stored temporal kinds and allow zero-width projections",
    up(db) {
      // Two shape changes land together because both are constraints on the
      // same rows.
      //
      // A kind names what a fact is, never where it came from, so the spellings
      // that named a producer resolve onto the nature they described. The map
      // is the one in `@omnesis/types/temporal-vocabulary`; it is applied here
      // rather than read from the module so this migration keeps meaning even
      // if the vocabulary moves on.
      //
      // A fact with no duration is now stored as an empty interval instead of
      // being padded to one millisecond, so `end - start` is honestly zero.
      // Analytics-plane projections need neither fix: changing a source's spec
      // changes its contract hash, which retires and re-derives those rows.
      const retired: Array<[string, string]> = [
        ["calendar_event", "appointment"],
        ["episodic", "episode"],
      ];
      const tableExists = (name: string): boolean =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
        undefined;

      // `temporal_annotations.kind` carries no constraint, so it is rewritten
      // in place. `document_temporal_projections` cannot be: its existing CHECK
      // still names the retired spellings and not the canonical ones, so an
      // UPDATE to the new value fails the old constraint. That table is rebuilt
      // below and rewrites its kinds on the way across instead.
      if (tableExists("temporal_annotations")) {
        for (const [from, to] of retired) {
          db.prepare("UPDATE temporal_annotations SET kind = ? WHERE kind = ?").run(to, from);
        }
      }

      if (!tableExists("document_temporal_projections")) return;

      const retiredKindCase = `CASE kind ${retired
        .map(([from, to]) => `WHEN '${from}' THEN '${to}'`)
        .join(" ")} ELSE kind END`;

      // SQLite cannot alter a CHECK in place, so the table is rebuilt. The
      // copy collapses the one-millisecond padding on the way across; a row
      // whose end was exactly one millisecond after its start was, by
      // construction, a fact with no declared end.
      db.exec(
        "ALTER TABLE document_temporal_projections RENAME TO document_temporal_projections_old",
      );
      // Renaming a table carries its indexes along under their original names,
      // so the `CREATE INDEX IF NOT EXISTS` below would see those names taken
      // and do nothing — and the rename's indexes then vanish with the old
      // table, leaving every window query on a full scan. Dropping them here
      // frees the names for the rebuilt table.
      db.exec("DROP INDEX IF EXISTS idx_document_temporal_projections_window");
      db.exec("DROP INDEX IF EXISTS idx_document_temporal_projections_source");
      createDocumentTemporalProjectionTables(db);
      db.exec(`
        INSERT INTO document_temporal_projections (
          id, source_id, document_id, document_external_id, slot,
          start_ms, end_exclusive_ms, start_canonical, end_canonical,
          precision, all_day, time_zone, label, kind, modality, status,
          source_updated_at, projected_at
        )
        SELECT
          id, source_id, document_id, document_external_id, slot,
          start_ms,
          CASE
            WHEN precision = 'instant' AND end_exclusive_ms = start_ms + 1 THEN start_ms
            ELSE end_exclusive_ms
          END,
          start_canonical,
          CASE
            WHEN precision = 'instant' AND end_exclusive_ms = start_ms + 1 THEN start_canonical
            ELSE end_canonical
          END,
          precision, all_day, time_zone, label, ${retiredKindCase}, modality, status,
          source_updated_at, projected_at
        FROM document_temporal_projections_old
      `);
      db.exec("DROP TABLE document_temporal_projections_old");
    },
  },
  {
    version: 75,
    description: "rename temporal_annotations.granularity to precision",
    up(db) {
      // How precisely an interval is known is one concept, spelled once —
      // `TemporalPrecision` in `@omnesis/types/temporal-vocabulary`, the same
      // five values `document_temporal_projections.precision` already carries.
      //
      // Two shapes reach this step. `runSchemaSetup` runs ahead of migrations,
      // so a fresh install arrives with the column already under its current
      // name and nothing to rename; a database created by an older binary
      // still spells it `granularity`. Testing for the column rather than the
      // schema version is what makes a re-run a no-op in both cases.
      const cols = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('temporal_annotations')")
        .all()
        .map((row) => row.name);
      if (cols.includes("granularity") && !cols.includes("precision")) {
        db.exec("ALTER TABLE temporal_annotations RENAME COLUMN granularity TO precision");
      }
    },
  },
  {
    version: 76,
    description: "track whether a removed source's data sweep has finished",
    up(db) {
      // Removing a source deletes its row immediately and then sweeps its
      // documents, analytics, cognitive state and index entries — work that is
      // serialized behind the indexer and can run for minutes on a large
      // corpus. `cleanup_done_at` is what makes that sweep observable: NULL
      // means it is still running, so clients can show the source as removing
      // and the gateway can resume it after a restart.
      //
      // Every tombstone that predates this column was swept synchronously
      // before its request returned, so backfilling them as done is a
      // statement of fact — not a default. Leaving them NULL would present
      // long-finished removals as permanently in progress.
      const hasColumn = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('removed_sources')")
        .all()
        .some((r) => r.name === "cleanup_done_at");
      // The backfill belongs inside the branch: NULL means "legacy tombstone"
      // only at the instant the column appears. Once the feature is live it
      // means "sweep in flight", and stamping those as done would orphan a
      // half-deleted source that nothing else ever revisits.
      if (!hasColumn) {
        db.exec("ALTER TABLE removed_sources ADD COLUMN cleanup_done_at INTEGER");
        db.exec("UPDATE removed_sources SET cleanup_done_at = removed_at");
      }
    },
  },
  {
    version: 77,
    description: "rekey document temporal projections on the document they describe",
    up(db) {
      // A projection's primary key was derived from (sourceId, externalId,
      // slot), but a document is identified by (providerId, sourceId,
      // externalId). Two documents differing only in provider therefore
      // produced one id, and the second to be written collided with the first —
      // failing the page, freezing the sync cursor, and stalling the account.
      //
      // The key is now derived from the resolved document id and the slot,
      // which is exactly what `UNIQUE(document_id, slot)` already constrains,
      // so the two agree by construction. Every stored id changes, and the
      // rows are rewritten in one pass: cleared first so a recomputed id can
      // never collide with an as-yet-unrewritten row.
      const table = "document_temporal_projections";
      const exists =
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
        undefined;
      if (!exists) return;

      const rekey = (documentId: string, slot: string): string =>
        `tp_${createHash("sha256").update(`${documentId}\0${slot}`).digest("hex").slice(0, 32)}`;

      const update = db.prepare(`UPDATE ${table} SET id = ? WHERE rowid = ?`);
      const withRowid = db
        .prepare<
          [],
          { rowid: number; id: string; document_id: string; slot: string }
        >(`SELECT rowid, id, document_id, slot FROM ${table}`)
        .all();
      if (withRowid.length === 0) return;

      // A temporary key keeps the rewrite free of transient collisions while
      // still satisfying the table's `id LIKE 'tp_%'` constraint.
      for (const row of withRowid) update.run(`tp_rekey_${row.rowid}`, row.rowid);
      for (const row of withRowid) update.run(rekey(row.document_id, row.slot), row.rowid);

      // An annotation may cite a projection it was grounded in. That link is
      // stored as bare text with no foreign key, so it has to be carried across
      // by hand — otherwise the annotation goes on claiming an id that no
      // longer resolves, and the entity-id lookup that reads it silently stops
      // matching. Analytics-row projections keep their keys, so only the
      // document ones named here move.
      const linkTable = "temporal_annotation_projections";
      const linksExist =
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(linkTable) !== undefined;
      if (!linksExist) return;
      const relink = db.prepare(
        `UPDATE ${linkTable} SET projection_id = ? WHERE projection_id = ?`,
      );
      for (const row of withRowid) relink.run(rekey(row.document_id, row.slot), row.id);
    },
  },
  {
    version: 78,
    description: "bind merge adjudication verdicts to the evidence they judged",
    up(db) {
      // A verdict recorded only WHEN it happened. Whether to re-judge was then
      // decided by comparing that timestamp with the detector's `detected_at`
      // — and `detected_at` moved whenever the pair's score changed at all.
      // The score is IDF over the whole alias corpus, so ingesting an
      // unrelated person moves it in the far decimals, and one candidate the
      // agent could only ever answer `unsure` was re-judged 26 times in a
      // week. Recording WHAT was judged makes "the evidence changed" testable.
      const columns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('merge_candidates')")
        .all()
        .map((r) => r.name);
      if (!columns.includes("adjudication_evidence_fingerprint")) {
        db.exec("ALTER TABLE merge_candidates ADD COLUMN adjudication_evidence_fingerprint TEXT");
      }
      if (!columns.includes("adjudication_count")) {
        db.exec(
          "ALTER TABLE merge_candidates ADD COLUMN adjudication_count INTEGER NOT NULL DEFAULT 0",
        );
      }

      // Back-fill from each row's current evidence rather than leaving it
      // NULL. The alternative re-opens every already-judged candidate exactly
      // once — the whole population this migration exists to stop paying for.
      // The fingerprint is inlined rather than imported: a migration whose
      // meaning shifts when a shared helper is edited is not a fixed point in
      // the chain.
      const quantize = (value: number, decimals: number): string =>
        Number.isFinite(value) ? value.toFixed(decimals) : "nan";
      const fingerprint = (
        matchedTokensJson: string | null,
        score: number,
        matchStrength: number | null,
      ): string => {
        let tokens: string[] = [];
        if (matchedTokensJson) {
          try {
            const parsed: unknown = JSON.parse(matchedTokensJson);
            if (Array.isArray(parsed))
              tokens = parsed.filter((t): t is string => typeof t === "string");
          } catch {
            tokens = [];
          }
        }
        return createHash("sha256")
          .update(
            JSON.stringify({
              t: [...tokens].sort(),
              s: quantize(score, 3),
              m: matchStrength === null ? null : quantize(matchStrength, 2),
            }),
          )
          .digest("hex");
      };

      const judged = db
        .prepare<
          [],
          {
            id: string;
            matched_tokens: string | null;
            score: number;
            match_strength: number | null;
          }
        >(
          `SELECT id, matched_tokens, score, match_strength FROM merge_candidates
            WHERE adjudicated_at IS NOT NULL AND adjudication_evidence_fingerprint IS NULL`,
        )
        .all();
      const stamp = db.prepare(
        `UPDATE merge_candidates
            SET adjudication_evidence_fingerprint = ?,
                adjudication_count = MAX(COALESCE(adjudication_count, 0), 1)
          WHERE id = ?`,
      );
      for (const row of judged) {
        stamp.run(fingerprint(row.matched_tokens, row.score, row.match_strength), row.id);
      }
    },
  },
  {
    version: 79,
    description: "retired: recorded why a scheduled trigger evaluation failed",
    up() {
      // Tombstone. This step shaped a table the triggers feature owned, and
      // migration 102 drops that table on every install that still has one, so
      // there is nothing left for it to shape. The slot stays because the
      // version chain has to stay contiguous.
    },
  },
  {
    version: 80,
    description: "add the durable per-source-type document-event profile store",
    up(db) {
      // Schema-only. The table is empty until the collector publishes, and an
      // empty table is the honest state: the gateway has not been told what
      // any source's documents can be asked about yet. The collector pushes
      // the full set on its next connect.
      createSourceDocumentProfilesTable(db);
    },
  },
  {
    version: 81,
    description: "tombstone: the document-event profile store already exists at 80",
    up() {
      // Two independently-developed lines of work both created the
      // `source_document_profiles` table, and both slots reached the chain.
      // Version 80 does the work; this step would repeat idempotent DDL and
      // read as a distinct schema change that never happened. The slot stays
      // so the `user_version` sequence has no hole — an install several
      // versions behind has to replay the chain contiguously to arrive at a
      // schema this binary understands.
    },
  },
  {
    version: 82,
    description: "per-source cognitive coverage; the bootstrap lane stops being terminal",
    up(db) {
      // The coverage tallies. The idempotent DDL helper creates the table on
      // both paths — a fresh install through `runSchemaSetup`, an upgrading
      // one here — so there is one source of DDL truth.
      createCognitionCoverageTable(db);

      // The coverage read counts the documents carrying the bootstrap marker,
      // which migration 41's partial index cannot serve — it covers only the
      // rows where the marker is unset. Same helper as schema setup calls, so
      // the two paths cannot drift; it no-ops when the column is absent.
      createBootstrapMarkerIndexes(db);

      // The retrospective lane used to record `done` when it ran out of
      // candidates, and `done` short-circuited every later pass before the
      // candidate count was re-read. An install that reached it — commonly a
      // young one that had nothing to review on its first pass — could then
      // connect a large source and have its entire history covered by neither
      // lane. Rewrite the marker to the quiet-but-reopenable state, and
      // deliberately write no drained-day / source-watermark alongside it:
      // their absence is what makes the next pass re-probe the corpus instead
      // of trusting a verdict this schema no longer stands behind.
      const engineState = db
        .prepare<
          [],
          { present: number }
        >("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'cognition_engine_state'")
        .get();
      if (engineState) {
        db.exec(
          "UPDATE cognition_engine_state SET value = 'drained' WHERE key = 'bootstrap_state' AND value = 'done'",
        );
      }
    },
  },
  {
    version: 83,
    description: "record compile-time watch grounding on subscription revisions",
    up(db) {
      // Revisions written before the compiler measured its watch keep a NULL
      // here; the approval surface omits the block rather than inventing a
      // zero, which would read as "nothing matches" instead of "not measured".
      const columns = db
        .prepare<[], { name: string }>(
          "SELECT name FROM pragma_table_info('subscription_revisions')",
        )
        .all()
        .map((row) => row.name);
      if (!columns.includes("grounding_json")) {
        db.exec("ALTER TABLE subscription_revisions ADD COLUMN grounding_json TEXT");
      }
    },
  },
  {
    version: 84,
    description: "record which part of a document a semantic watch candidate matched on",
    up() {
      // Tombstone. This step added `matched_document_id` to
      // `subscription_evaluations` — the first watch engine's work queue,
      // which no longer exists in the schema and is dropped outright by a
      // later step. Its slot stays so the version chain has no gap, and its
      // transform is a no-op so replaying the full sequence on a fresh
      // database does not fail on a table nothing creates.
    },
  },
  {
    version: 85,
    description: "retired: renamed a trigger kind",
    up() {
      // Tombstone. This step shaped a table the triggers feature owned, and
      // migration 102 drops that table on every install that still has one, so
      // there is nothing left for it to shape. The slot stays because the
      // version chain has to stay contiguous.
    },
  },
  {
    version: 86,
    description: "link subscription revisions to their compile run",
    up(db) {
      // Every compilation now records a `subscription_compile` run in the
      // cognition ledger (its transcript is the compile's inspection
      // surface); the revision keeps the run id so "plan → what the compiler
      // saw and said" is one lookup. Revisions written before recording
      // existed stay NULL — there is no run to point at.
      //
      // `runSchemaSetup` runs ahead of migrations, so a fresh install already
      // has the column from the CREATE TABLE; testing for the column keeps
      // this step correct on both shapes and a no-op on a re-run.
      const columns = db
        .prepare<[], { name: string }>(
          "SELECT name FROM pragma_table_info('subscription_revisions')",
        )
        .all()
        .map((row) => row.name);
      if (!columns.includes("compile_run_id")) {
        db.exec("ALTER TABLE subscription_revisions ADD COLUMN compile_run_id TEXT");
      }
    },
  },
  {
    version: 87,
    description: "bounded activity-retention scans",
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_cognition_runs_retention
          ON cognition_runs(completed_at, id)
          WHERE status IN ('completed', 'failed') AND completed_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_subscription_firings_retention
          ON subscription_firings(fired_at, id)
          WHERE status IN ('delivered', 'blocked', 'failed');
        CREATE INDEX IF NOT EXISTS idx_subscription_audit_retention
          ON subscription_audit_events(created_at, sequence);
        CREATE INDEX IF NOT EXISTS idx_dev_annotations_retention
          ON dev_annotations(resolved_at, id)
          WHERE status = 'resolved' AND resolved_at IS NOT NULL;
      `);
    },
  },
  {
    version: 88,
    description: "keyset index for settled merge-candidate history",
    up: (db) => {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_merge_candidates_history ON merge_candidates(status, COALESCE(decided_at, detected_at) DESC, id DESC)",
      );
    },
  },
  {
    version: 89,
    description: "snapshot brief reads and index growing-list keysets",
    up(db) {
      const briefColumns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('briefs')")
        .all()
        .map((row) => row.name);
      if (!briefColumns.includes("read_at")) {
        db.exec("ALTER TABLE briefs ADD COLUMN read_at INTEGER");
      }
      db.exec(`
        DROP INDEX IF EXISTS idx_cognition_runs_due;
        DROP INDEX IF EXISTS idx_open_loops_state_update;
        CREATE INDEX IF NOT EXISTS idx_briefs_read_snapshot
          ON briefs(read_at DESC);
        CREATE INDEX IF NOT EXISTS idx_briefs_created_page
          ON briefs(created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_briefs_state_created_page
          ON briefs(state, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_briefs_active_created_page
          ON briefs(created_at DESC, id DESC)
          WHERE state IN ('unread', 'read');
        CREATE INDEX IF NOT EXISTS idx_briefs_dismissed_created_page
          ON briefs(created_at DESC, id DESC)
          WHERE state IN (
            'dismissed_already_handled',
            'dismissed_acknowledged',
            'dismissed_not_relevant',
            'dismissed_wrong'
          );
        CREATE INDEX IF NOT EXISTS idx_cognition_runs_enqueued_page
          ON cognition_runs(enqueued_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_cognition_runs_scheduled_page
          ON cognition_runs(next_attempt_at ASC, id ASC);
        CREATE INDEX IF NOT EXISTS idx_cognition_runs_due
          ON cognition_runs(status, next_attempt_at ASC, id ASC);
        CREATE INDEX IF NOT EXISTS idx_cognition_runs_status_enqueued_page
          ON cognition_runs(status, enqueued_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_cognition_runs_kind_enqueued_page
          ON cognition_runs(kind, enqueued_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_cognition_runs_status_kind_enqueued_page
          ON cognition_runs(status, kind, enqueued_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_cognition_runs_kind_scheduled_page
          ON cognition_runs(kind, next_attempt_at ASC, id ASC);
        CREATE INDEX IF NOT EXISTS idx_cognition_runs_status_kind_scheduled_page
          ON cognition_runs(status, kind, next_attempt_at ASC, id ASC);
        CREATE INDEX IF NOT EXISTS idx_open_loops_state_update
          ON open_loops(state, last_update DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_open_loops_update_page
          ON open_loops(last_update DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_open_loops_importance_page
          ON open_loops(importance DESC, last_update DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_open_loops_state_importance_page
          ON open_loops(state, importance DESC, last_update DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_open_loops_active_importance_page
          ON open_loops(importance DESC, last_update DESC, id DESC)
          WHERE state IN ('open', 'snoozed');
        CREATE INDEX IF NOT EXISTS idx_open_loops_resolved_importance_page
          ON open_loops(importance DESC, last_update DESC, id DESC)
          WHERE state IN ('done', 'dismissed');
        CREATE INDEX IF NOT EXISTS idx_open_loops_active_update_page
          ON open_loops(last_update DESC, id DESC)
          WHERE state IN ('open', 'snoozed');
        CREATE INDEX IF NOT EXISTS idx_open_loops_resolved_update_page
          ON open_loops(last_update DESC, id DESC)
          WHERE state IN ('done', 'dismissed');
        CREATE INDEX IF NOT EXISTS idx_retired_loops_page
          ON retired_loops(retired_at DESC, id DESC);
      `);
    },
  },
  {
    version: 90,
    description: "retain original document ids on privacy tombstones",
    up(db) {
      const columns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('removed_documents')")
        .all()
        .map((row) => row.name);
      if (!columns.includes("original_document_id")) {
        db.exec("ALTER TABLE removed_documents ADD COLUMN original_document_id TEXT");
      }
    },
  },
  {
    version: 91,
    description: "track mutable list revisions and index approval history pages",
    up(db) {
      installMutableListRevisions(db);
      createAnswerApprovalListIndexes(db);
      createSubscriptionApprovalListIndexes(db);
    },
  },
  {
    version: 92,
    description: "record structured cognition run failure codes",
    up(db) {
      const columns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('cognition_runs')")
        .all()
        .map((row) => row.name);
      if (!columns.includes("failure_code")) {
        db.exec("ALTER TABLE cognition_runs ADD COLUMN failure_code TEXT");
      }
    },
  },
  {
    version: 93,
    description: "add durable external answer completion deliveries",
    up(db) {
      createAnswerPrivacyTables(db);
      const columns = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('answer_tasks')")
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("completion_device_id")) {
        db.exec(
          "ALTER TABLE answer_tasks ADD COLUMN completion_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL",
        );
      }
      if (!columns.has("completion_native_conversation_id")) {
        db.exec("ALTER TABLE answer_tasks ADD COLUMN completion_native_conversation_id TEXT");
      }
    },
  },
  {
    version: 94,
    description: "add scoped answer completion authorities",
    up: createAnswerPrivacyTables,
  },
  {
    version: 95,
    description: "add source-level coverage watermarks",
    up(db) {
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
    },
  },
  {
    version: 96,
    description: "remove retired temporal-annotation conversation pointer",
    up(db) {
      const columns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('temporal_annotations')")
        .all()
        .map((row) => row.name);
      if (columns.includes("thread_conversation_id")) {
        db.exec("ALTER TABLE temporal_annotations DROP COLUMN thread_conversation_id");
      }
    },
  },
  {
    version: 97,
    description: "persist semantic watch privacy review disclosures",
    up(db) {
      const approvalColumns = new Set(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('subscription_approvals')",
          )
          .all()
          .map((row) => row.name),
      );
      if (!approvalColumns.has("privacy_review_json")) {
        db.exec("ALTER TABLE subscription_approvals ADD COLUMN privacy_review_json TEXT");
      }
      if (!approvalColumns.has("disclosure_categories_json")) {
        db.exec(
          "ALTER TABLE subscription_approvals ADD COLUMN disclosure_categories_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
      const grantColumns = new Set(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('subscription_grants')",
          )
          .all()
          .map((row) => row.name),
      );
      if (!grantColumns.has("disclosure_categories_json")) {
        db.exec(
          "ALTER TABLE subscription_grants ADD COLUMN disclosure_categories_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
    },
  },
  {
    version: 98,
    description: "add temporal-annotation evidence atoms and invalidation cause",
    up(db) {
      // runSchemaSetup executes before migrations, so the destination table
      // already exists on an upgrade. Calling the installer here keeps direct
      // migration tests and manual idempotency probes honest.
      createTemporalAnnotationTables(db);
      // CREATE TABLE IF NOT EXISTS leaves a standing pre-98 table without the
      // cause column, so it is added here; guarded because fresh installs
      // (and replays through v65) already carry it via the live DDL.
      const columns = new Set(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('temporal_annotations')",
          )
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("invalidation_cause")) {
        db.exec("ALTER TABLE temporal_annotations ADD COLUMN invalidation_cause TEXT");
      }
    },
  },
  {
    version: 99,
    description: "discard coarse run-wide annotation dependency edges",
    up(db) {
      // Pre-v99 edges mean only that a prior was visible somewhere in the
      // run. They cannot be distinguished from genuine output dependencies,
      // so precise provenance must restart prospectively.
      db.exec("DELETE FROM cognition_consumption_edges");
    },
  },
  {
    version: 100,
    description: "index derivation backlog age and typed link lookups",
    up(db) {
      // The derivation-SLA scan asks each stage for the age of the oldest
      // document it has not processed. Without `ingested_at` in the partial
      // index that is a row lookup per backlog entry — on a large corpus, a
      // full scan on the main thread every few minutes. Carrying the column in
      // the index makes the MIN index-only.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_documents_links_pending_age ON documents(ingested_at) WHERE links_extracted_at IS NULL",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_documents_people_pending_age ON documents(ingested_at) WHERE people_resolved_at IS NULL",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_documents_dates_pending_age ON documents(ingested_at) WHERE dates_extracted_at IS NULL",
      );
      // A document's neighbourhood is read per link type, on the reactive
      // path. Without these the per-type lookups and the GROUP BY totals visit
      // every edge a document has — unbounded for a hub document that shares
      // its content with thousands of others.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_document_links_source_type ON document_links(source_doc_id, link_type)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_document_links_target_type ON document_links(target_doc_id, link_type)",
      );
    },
  },
  {
    version: 101,
    description: "drop the retired evaluator's queue",
    up(db) {
      // `subscription_evaluations` was the first watch engine's work queue: a
      // row per candidate document awaiting a precision decision. That engine
      // is gone, and this is the one table in the subscription family with no
      // surviving reader — the records, approvals, grants, firing ledger,
      // answer authorities and delivery queue all stay, because the watch
      // engine fires through them.
      //
      // A queue is not history. An unsettled row describes work that will
      // never be done, so there is nothing here worth keeping for an operator
      // to read later.
      db.exec("DROP TABLE IF EXISTS subscription_evaluations");
    },
  },
  {
    version: 102,
    description: "drop the retired triggers storage and the column that pointed at it",
    up(db) {
      // The last of the triggers feature. Its CRUD surface, evaluators,
      // orchestrator and every client screen went with the engine; what
      // stayed was storage — the four tables, and a `subscriptions` column
      // holding a foreign key into them.
      //
      // Nothing has written that column since a record's condition became a
      // watch the watch runtime owns, so on any install it is either NULL or
      // pointing at a trigger no code can evaluate. Five queries on live
      // paths still joined through it and read columns nobody used, which is
      // how a dead subsystem keeps a place in the plan of a query that wakes
      // an agent.
      //
      // The column goes before the tables so the foreign key does not outlive
      // its parent. `DROP COLUMN` is refused for a column an index or view
      // depends on; nothing indexes this one, and a rebuild would mean
      // reciting the table's full shape here, where it would drift.
      //
      // This is the one step here a downgrade cannot survive. An older binary
      // re-creates the four tables on boot, because they are `CREATE TABLE IF
      // NOT EXISTS` — but nothing re-adds a column, and that binary's delivery
      // queries still select it. The main database's policy is numbered,
      // forward-only migrations and three earlier steps already drop columns;
      // going back past this one means restoring the backup taken before the
      // upgrade, which is what that backup is for.
      const columns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('subscriptions')")
        .all()
        .map((row) => row.name);
      if (columns.includes("managed_trigger_id")) {
        db.exec("ALTER TABLE subscriptions DROP COLUMN managed_trigger_id");
      }

      // Counted before the drop, and only for what an operator might miss: a
      // deletion this size should be able to say what it deleted, and the
      // upgrade log is the only place they will ever be able to read it.
      const dropped = (table: string): number => {
        const present = db
          .prepare<
            [string],
            { name: string }
          >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table);
        if (!present) return 0;
        return db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
      };
      const rules = dropped("triggers");
      const firings = dropped("trigger_firings");
      const hadStorage = ["triggers", "trigger_firings", "trigger_state", "trigger_meta"].some(
        (table) =>
          db
            .prepare<
              [string],
              { name: string }
            >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table) !== undefined,
      );

      // Dropped rather than kept as history. A trigger row is a rule, not a
      // record of anything that happened — and `trigger_firings`, which is a
      // record, is the log of a dispatch mechanism the operator has been told
      // is gone: no surface reads it, nothing can replay it, and its rows
      // carry captured stdout and stderr from processes this build cannot
      // run. Children first, so the parent's cascade never has to fire.
      db.exec(`
        DROP TABLE IF EXISTS trigger_firings;
        DROP TABLE IF EXISTS trigger_state;
        DROP TABLE IF EXISTS trigger_meta;
        DROP TABLE IF EXISTS triggers;
      `);
      // Logged whenever there was storage to drop, not only when it held
      // rows: an operator upgrading past this deserves to see it happen, and
      // the empty case is the one they would otherwise never learn about.
      if (hadStorage) {
        log.info(
          `migration 102: dropped the retired triggers storage (four tables) — ${rules} rule(s) and ${firings} recorded firing(s)`,
        );
      }
    },
  },
  {
    version: 103,
    description: "drop the pre-V2 watch compile runs",
    up(db) {
      // The ledger's record of watch compilation restarts here.
      //
      // Every `subscription_compile` row on an existing install was written
      // by the first compiler, which no longer exists: a two-stage pipeline
      // over a bounded prompt, whose payload said which of those stages a
      // refusal came from and which of two authoring paths asked. The V2
      // compile is one agent session with the corpus in front of it and a
      // repair loop, and none of those fields describe it. Rather than
      // teaching every reader a shape nothing will ever write again, the rows
      // go — the alternative is a decoder whose only purpose is rendering
      // recordings of a compiler that was deleted.
      //
      // What is NOT deleted, and why:
      //   - `cognition_run_attribution` rows. That table is designed to
      //     outlive run rows — it is how an artifact's `created_by_run` stays
      //     answerable after retention prunes the run — so orphans are its
      //     normal state and removing these would be the deviation.
      //   - `cognition_spend`. Its rows are running per-(day, mechanism,
      //     model) totals carrying no run id, so a compile's tokens cannot be
      //     unwound from them. They are the durable accounting record and
      //     stay accurate about what was actually spent.
      //   - `subscription_revisions.compile_run_id`. The read projects it
      //     through a LEFT JOIN onto `cognition_runs`, so a pointer at a
      //     deleted run already reads back as null and the portal hides the
      //     link. Blanking the column would destroy the only remaining
      //     evidence that a revision was compiled at all.
      const doomed = db
        .prepare<[], { id: string }>(
          "SELECT id FROM cognition_runs WHERE kind = 'subscription_compile'",
        )
        .all()
        .map((row) => row.id);
      if (doomed.length === 0) return;
      db.exec("DELETE FROM cognition_runs WHERE kind = 'subscription_compile'");
      // The transcripts are files, and a migration cannot reach the
      // filesystem. The ids are handed to the drain that runs at start, when
      // the transcripts directory is in scope. See `brain/transcript-eviction.ts`.
      queueTranscriptEviction(db, doomed);
      log.info(
        `migration 103: dropped ${doomed.length} pre-V2 watch compile run(s); their transcripts are queued for deletion at the next start`,
      );
    },
  },
  {
    version: 104,
    description: "add append-only privacy policy version history",
    up: createAnswerPrivacyTables,
  },
  {
    version: 105,
    description: "track which agent conversations the operator has not seen",
    up(db) {
      // The table holds one row per unread conversation, so there is nothing
      // to backfill and no default to choose: an install upgrading into this
      // migration starts empty, which reads as "every existing conversation is
      // read". That is the right answer — these transcripts predate the
      // feature, and marking a history of them unread would greet the operator
      // with a wall of dots for conversations they have already had.
      createConversationReadStateTables(db);
    },
  },
  {
    version: 106,
    description: "preserve note capture timezone and gateway receipt time",
    up(db) {
      const columns = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('note_entries')")
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("captured_time_zone_id"))
        db.exec("ALTER TABLE note_entries ADD COLUMN captured_time_zone_id TEXT");
      if (!columns.has("captured_utc_offset_seconds"))
        db.exec("ALTER TABLE note_entries ADD COLUMN captured_utc_offset_seconds INTEGER");
      if (!columns.has("received_at"))
        db.exec("ALTER TABLE note_entries ADD COLUMN received_at TEXT");
    },
  },
  {
    version: 107,
    description: "tell a machine's revocation of a subscription from a person's",
    up(db) {
      const columns = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('subscriptions')")
          .all()
          .map((row) => row.name),
      );
      // Nothing to backfill: every row already revoked was revoked before
      // anything could stamp a reason, and NULL is exactly the reading those
      // rows need — a person's decision, which no repair may overturn. The
      // conservative direction is the one an upgrade lands on for free.
      if (!columns.has("revoked_reason"))
        db.exec("ALTER TABLE subscriptions ADD COLUMN revoked_reason TEXT");
    },
  },
  {
    version: 108,
    description: "recheck live cognition outputs whose annotation prior was hard-retracted",
    up(db) {
      const marker = "migration:108:missing-prior-rechecks";
      if (
        db
          .prepare<
            [string],
            { value: string }
          >("SELECT value FROM cognition_engine_state WHERE key = ?")
          .get(marker)
      )
        return;
      enqueueRechecksForMissingConsumptionPriors(db, Date.now());
      db.prepare<[string, string]>(
        "INSERT OR REPLACE INTO cognition_engine_state (key, value) VALUES (?, ?)",
      ).run(marker, "complete");
    },
  },
  {
    version: 109,
    description: "store each device's selected push transport",
    up(db) {
      const columns = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("push_transport"))
        db.exec("ALTER TABLE devices ADD COLUMN push_transport TEXT");
      if (!columns.has("relay_url")) db.exec("ALTER TABLE devices ADD COLUMN relay_url TEXT");
      if (!columns.has("relay_credential"))
        db.exec("ALTER TABLE devices ADD COLUMN relay_credential TEXT");

      const phoneTokens = db
        .prepare<[], { id: string; scopes: string }>(
          `SELECT t.id, t.scopes
             FROM tokens t
             JOIN devices d ON d.id = t.device_id
            WHERE d.kind IN ('ios', 'android')`,
        )
        .all();
      const updateScopes = db.prepare("UPDATE tokens SET scopes = ? WHERE id = ?");
      for (const token of phoneTokens) {
        let scopes: unknown;
        try {
          scopes = JSON.parse(token.scopes);
        } catch {
          continue;
        }
        if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) continue;
        if (!scopes.includes("push:claim")) {
          updateScopes.run(JSON.stringify([...scopes, "push:claim"]), token.id);
        }
      }
    },
  },
  {
    version: 110,
    description: "add the per-device notification delivery queue",
    up(db) {
      // Frozen v110 shape. New queue columns belong in later migrations even
      // though the fresh-schema helper creates the current head directly.
      db.exec(`
        CREATE TABLE IF NOT EXISTS notifications (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          target_id TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          collapse_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_collapse
          ON notifications(collapse_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_notifications_expiry
          ON notifications(expires_at);
        CREATE TABLE IF NOT EXISTS notification_deliveries (
          id TEXT PRIMARY KEY,
          notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
          device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'delivered', 'superseded', 'expired')),
          lease_token TEXT UNIQUE,
          leased_until INTEGER,
          claimed_at INTEGER,
          delivered_at INTEGER,
          UNIQUE(notification_id, device_id)
        );
        CREATE INDEX IF NOT EXISTS idx_notification_deliveries_claim
          ON notification_deliveries(device_id, state, leased_until, notification_id);
      `);
    },
  },
  {
    version: 111,
    description: "store phone-reported notification delivery health",
    up(db) {
      const columns = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("notification_delivery_health"))
        db.exec("ALTER TABLE devices ADD COLUMN notification_delivery_health TEXT");
      if (!columns.has("notification_delivery_health_updated_at"))
        db.exec("ALTER TABLE devices ADD COLUMN notification_delivery_health_updated_at INTEGER");
    },
  },
  {
    version: 112,
    description: "preserve typed notification navigation data",
    up(db) {
      const columns = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('notifications')")
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("route_data"))
        db.exec("ALTER TABLE notifications ADD COLUMN route_data TEXT");
    },
  },
  {
    version: 113,
    description: "persist mobile source permission health and reminder episodes",
    up(db) {
      createMobilePermissionHealthTable(db);
      addMobilePermissionEpisodeIdColumn(db);
      createReauthRemindersTable(db);
      addReauthReminderReservationColumns(db);
    },
  },
  {
    version: 114,
    description: "record why a mobile permission reminder episode is active",
    up(db) {
      createMobilePermissionHealthTable(db);
      addMobilePermissionEpisodeCauseColumns(db);
    },
  },
  {
    version: 115,
    description: "anchor mobile permission report validity to observation time",
    up(db) {
      const columns = new Set(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('mobile_permission_health')",
          )
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("validity_anchored"))
        db.exec(
          "ALTER TABLE mobile_permission_health ADD COLUMN validity_anchored INTEGER NOT NULL DEFAULT 0",
        );
      db.exec(`
        UPDATE mobile_permission_health
           SET valid_until = checked_at + (valid_until - received_at),
               validity_anchored = 1
         WHERE validity_anchored = 0
      `);
    },
  },
  {
    version: 116,
    description: "persist leased notification wake retries",
    up(db) {
      const columns = new Set(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('notification_deliveries')",
          )
          .all()
          .map((row) => row.name),
      );
      const addedWakeState = !columns.has("wake_state");
      const additions = [
        ["wake_state", "TEXT NOT NULL DEFAULT 'pending'"],
        ["wake_attempt_count", "INTEGER NOT NULL DEFAULT 0"],
        ["wake_lease_token", "TEXT"],
        ["wake_leased_until", "INTEGER"],
        ["wake_next_attempt_at", "INTEGER"],
        ["wake_last_attempt_at", "INTEGER"],
        ["wake_last_success_at", "INTEGER"],
        ["wake_last_error", "TEXT"],
        ["wake_last_transport", "TEXT"],
      ] as const;
      for (const [name, definition] of additions) {
        if (!columns.has(name)) {
          db.exec(`ALTER TABLE notification_deliveries ADD COLUMN ${name} ${definition}`);
        }
      }
      if (addedWakeState) {
        db.exec(`UPDATE notification_deliveries
           SET wake_state = CASE
                 WHEN state IN ('pending', 'leased') THEN 'pending'
                 ELSE 'sent'
               END,
               wake_next_attempt_at = CASE
                 WHEN state IN ('pending', 'leased') THEN 0
                 ELSE NULL
               END
         WHERE wake_attempt_count = 0`);
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_wake_token
          ON notification_deliveries(wake_lease_token)
          WHERE wake_lease_token IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_notification_deliveries_wake_due
          ON notification_deliveries(wake_state, wake_next_attempt_at, wake_leased_until,
                                     wake_attempt_count, device_id);
      `);
    },
  },
  {
    version: 117,
    description: "per-sweep production tallies",
    up(db) {
      createSweepTallyTable(db);
    },
  },
  {
    version: 118,
    description: "temporal annotation doc links survive document deletion",
    up(db) {
      // The privacy cascade selects the annotations to purge FROM
      // `temporal_annotation_documents` — but that table's `document_id`
      // carried `REFERENCES documents(id) ON DELETE CASCADE`, so by the time
      // the purge ran, the FK had already erased the rows it keys on, and an
      // annotation about a deleted document stayed live and queryable. The
      // rebuild drops the document-side FK (the doc-link convention:
      // `open_loop_docs`, `time_index_entry_people`); the annotation-side FK
      // stays, so links still die with their annotation.
      //
      // SQLite cannot drop an FK in place, so the table is rebuilt.
      const tableExists = (name: string): boolean =>
        db
          .prepare<
            [string],
            { name: string }
          >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(name) !== undefined;
      if (!tableExists("temporal_annotation_documents")) return;

      db.exec(
        "ALTER TABLE temporal_annotation_documents RENAME TO temporal_annotation_documents_old",
      );
      // The rename carries the index along under its original name; free the
      // name so the recreate below really recreates it on the new table.
      db.exec("DROP INDEX IF EXISTS idx_temporal_annotation_documents_doc");
      createTemporalAnnotationTables(db);
      db.exec(`
        INSERT INTO temporal_annotation_documents (annotation_id, document_id)
        SELECT annotation_id, document_id FROM temporal_annotation_documents_old
      `);
      db.exec("DROP TABLE temporal_annotation_documents_old");
    },
  },
  {
    version: 119,
    description: "record what a condition-only firing observed",
    up(db) {
      const columns = new Set(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('subscription_firings')",
          )
          .all()
          .map((row) => row.name),
      );
      // An empty column list means the table is not there yet — a database
      // migrating past this point before the subscriptions constellation was
      // ever created. The boot-time schema setup will create it already
      // carrying the column, so there is nothing to alter.
      if (columns.size > 0 && !columns.has("observation_json")) {
        db.exec("ALTER TABLE subscription_firings ADD COLUMN observation_json TEXT");
      }
      // Firings recorded before this column keep a NULL observation: the row
      // that satisfied them was never captured, and inventing one now by
      // re-running the condition would attach a different occurrence to an
      // answer about this one.

      // The evidence-deletion guard also withdraws the authority to report on
      // a firing whose evidence was privacy-deleted. Its CREATE is guarded by
      // IF NOT EXISTS, so an install that already has the trigger would keep
      // the older body forever; dropping it lets the schema setup below put
      // the current one back.
      db.exec("DROP TRIGGER IF EXISTS subscription_firing_evidence_delete_guard");
      createSubscriptionTables(db);
    },
  },
  {
    version: 120,
    description: "temporal annotation re-file presentation marker",
    up(db) {
      // `refile_presented_run` records which data run's prompt listed a
      // churn-invalidated annotation for re-filing; the re-file lookup skips
      // entries whose presented run completed and re-presents on failure.
      // The lookup is a state predicate rather than a time window — the
      // invalidation is stamped at document-event time, before the run it
      // wakes even exists, so no bound derived from run timestamps can
      // contain it.
      const columns = new Set(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('temporal_annotations')",
          )
          .all()
          .map((c) => c.name),
      );
      if (columns.size > 0 && !columns.has("refile_presented_run")) {
        db.exec("ALTER TABLE temporal_annotations ADD COLUMN refile_presented_run TEXT");
      }
    },
  },
  {
    version: 121,
    description: "year-aware date extraction: truncation marker + corpus rescan",
    up(db) {
      // `dates_truncated` records that the extraction pass scanned only a
      // truncated prefix of the document, so "no dates found" can be told
      // apart from "no dates found in the part that was read" — the backlog
      // lane admits documents by their extracted dates, so the difference
      // decides whether the background agent ever reads them.
      const columns = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
          .all()
          .map((c) => c.name),
      );
      if (columns.size > 0 && !columns.has("dates_truncated")) {
        db.exec("ALTER TABLE documents ADD COLUMN dates_truncated INTEGER");
      }
      // Re-extract the whole corpus under the year-aware rules: the
      // recognizer now resolves year-less human dates ("August 16",
      // "16 au 23 août") against each document's anchor instead of dropping
      // them, and anchors on last edit rather than creation. Clearing the
      // stamp re-queues every document for the background extraction drip;
      // the pass rewrites each document's rows wholesale, so no stale rows
      // survive. Guarded like the ALTER above: pruned test fixtures replay
      // the chain over documents tables without the extraction column.
      if (columns.has("dates_extracted_at")) {
        db.exec("UPDATE documents SET dates_extracted_at = NULL");
      }
    },
  },
  {
    version: 122,
    description: "re-scan truncated documents under the budgeted date scan",
    up(db) {
      // Documents stamped `dates_truncated` were scanned under a small
      // character cap that doubled as the recognizer's only cost bound.
      // With dense-span neutralization and the per-document scan budget in
      // place, the cap is generous again — clearing these documents' stamps
      // re-queues exactly the partially-scanned set for the background drip.
      const columns = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
          .all()
          .map((c) => c.name),
      );
      if (columns.has("dates_truncated") && columns.has("dates_extracted_at")) {
        db.exec("UPDATE documents SET dates_extracted_at = NULL WHERE dates_truncated = 1");
      }
    },
  },
  {
    version: 123,
    description: "re-scan documents stamped truncated by the wall-clock budget",
    up(db) {
      // The scan budget originally read wall clock: a corpus-wide rescan at
      // full pool parallelism charged ordinary documents for time they spent
      // queued and stamped tens of thousands of them truncated. The budget
      // now reads the scanning thread's own cpu time, so clearing the
      // stamps re-queues that set for a scan whose verdict reflects each
      // document's real cost.
      const columns = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
          .all()
          .map((c) => c.name),
      );
      if (columns.has("dates_truncated") && columns.has("dates_extracted_at")) {
        db.exec("UPDATE documents SET dates_extracted_at = NULL WHERE dates_truncated = 1");
      }
    },
  },
  {
    version: 124,
    description: "re-queue truncated documents under the currently configured scan bounds",
    up(db) {
      // A dates_truncated stamp records the scan bounds in force when the
      // document was scanned — a smaller live cap override, an exhausted
      // budget under a different metric. Installs whose bounds have since
      // widened would otherwise keep the old partial coverage forever
      // (re-extraction only triggers on content change). Clearing the
      // stamped set re-queues it for the background drip under whatever
      // bounds are configured now; documents that still exceed them are
      // simply re-stamped.
      const columns = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
          .all()
          .map((c) => c.name),
      );
      if (columns.has("dates_truncated") && columns.has("dates_extracted_at")) {
        db.exec("UPDATE documents SET dates_extracted_at = NULL WHERE dates_truncated = 1");
      }
    },
  },
  {
    version: 125,
    description: "re-queue truncated documents for the smaller-chunk date scan",
    up(db) {
      // The scan chunk shrank from 5k to 2k chars. The recognizer's cost is
      // superlinear in call length, so date-dense documents that exhausted
      // the scan budget on a single 5k chunk (stamping only a partial
      // prefix's dates) now scan fully. Clearing the stamped set re-queues
      // it for the background drip; documents still too hostile even at the
      // smaller chunk size are simply re-stamped.
      const columns = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
          .all()
          .map((c) => c.name),
      );
      if (columns.has("dates_truncated") && columns.has("dates_extracted_at")) {
        db.exec("UPDATE documents SET dates_extracted_at = NULL WHERE dates_truncated = 1");
      }
    },
  },
  {
    version: 126,
    description: "re-admit documents whose only bootstrap runs failed terminally",
    up(db) {
      // The bootstrap enqueuer marks a document processed AT ENQUEUE so the
      // next pass never re-selects it; the marker is never cleared. When a
      // run then fails terminally (e.g. the model provider rejecting every
      // attempt during an outage), the document keeps its marker without
      // ever having been reasoned over — a permanent hole in the backfill.
      // Clear the marker for documents that have at least one failed
      // bootstrap run and no completed one; the enqueuer re-admits them
      // (fold-on-update only matches pending rows, so the failed run does
      // not block a fresh enqueue).
      const columns = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
          .all()
          .map((c) => c.name),
      );
      const tables = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((t) => t.name),
      );
      if (columns.has("bootstrap_processed_at") && tables.has("cognition_runs")) {
        db.exec(`
          UPDATE documents SET bootstrap_processed_at = NULL
          WHERE bootstrap_processed_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM cognition_runs f
              WHERE f.kind = 'bootstrap' AND f.status = 'failed'
                AND json_extract(f.payload_json, '$.docId') = documents.id)
            AND NOT EXISTS (
              SELECT 1 FROM cognition_runs c
              WHERE c.kind = 'bootstrap' AND c.status = 'completed'
                AND json_extract(c.payload_json, '$.docId') = documents.id)
        `);
      }
    },
  },
  {
    version: 127,
    description: "rename cognition coverage status 'covered' to 'settled'",
    up(db) {
      // `covered` read as a claim about the SOURCE — that its corpus has been
      // reasoned over — when it only ever meant that every document the lane
      // had SELECTED so far had settled. A source with a large unselected
      // backlog therefore reported as covered. The counters were always
      // right; the word was not. `settled` says what is actually true, and
      // matches the vocabulary the run queue already uses.
      //
      // The status is derived from the counters on every write, so new rows
      // would correct themselves — but only when something touches them, and
      // a fully-settled source is exactly the row nothing touches again.
      const tables = db
        .prepare<
          [],
          { name: string }
        >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cognition_coverage'")
        .all();
      if (tables.length === 0) return;
      db.prepare("UPDATE cognition_coverage SET status = 'settled' WHERE status = 'covered'").run();
    },
  },
  {
    version: 128,
    description: "mark already-running bootstrap lanes as started",
    up(db) {
      // The lane now waits for the operator to start it, because assigning a
      // background-agent model is a capability choice rather than consent to
      // spend for days working through history. An install that has already
      // enqueued bootstrap runs made that decision under the old rule, and
      // must not be stopped by the new one — so it is recorded as started,
      // dated to its first run rather than to now, which is when the operator
      // actually began.
      const tables = db
        .prepare<
          [string],
          { name: string }
        >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .all("cognition_engine_state");
      if (tables.length === 0) return;
      const total = Number(
        db
          .prepare<
            [string],
            { value: string }
          >("SELECT value FROM cognition_engine_state WHERE key = ?")
          .get("bootstrap_total_enqueued")?.value ?? "0",
      );
      if (!Number.isFinite(total) || total <= 0) return;
      // Same caution as 129: a partial fixture may carry the engine-state table
      // without the run ledger, and dating the start from `now` is a better
      // answer than failing the upgrade.
      const hasRuns =
        db
          .prepare<
            [string],
            { name: string }
          >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .all("cognition_runs").length > 0;
      const firstRun = hasRuns
        ? db
            .prepare<
              [],
              { at: number | null }
            >("SELECT MIN(enqueued_at) AS at FROM cognition_runs WHERE kind = 'bootstrap'")
            .get()?.at
        : null;
      db.prepare(
        "INSERT INTO cognition_engine_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
      ).run("bootstrap_started_at", String(firstRun ?? Date.now()));
    },
  },
  {
    version: 129,
    description: "record when the bootstrap lane gives up on a document",
    up(db) {
      // A document whose bootstrap runs failed terminally is re-admitted a
      // bounded number of times; past that the lane gives up and its marker
      // stands. Until now that give-up was recoverable only by joining the run
      // ledger — which is pruned — so an abandoned document eventually became
      // indistinguishable from a reviewed one, and the corpus reported more
      // coverage than it had.
      //
      // A column on the document itself outlives the runs that produced it,
      // which is the same reason `run_attribution` exists.
      // Not every database this runs against has the whole schema: partial
      // fixtures exist that carry only one subsystem's tables. Check for the
      // table rather than assuming the column list of a table that may not be
      // there — `pragma_table_info` on a missing table returns nothing, which
      // reads exactly like a table missing the column.
      const has = (table: string): boolean =>
        db
          .prepare<
            [string],
            { name: string }
          >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .all(table).length > 0;
      if (!has("documents")) return;
      const columns = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
          .all()
          .map((c) => c.name),
      );
      if (!columns.has("bootstrap_failed_at")) {
        db.exec("ALTER TABLE documents ADD COLUMN bootstrap_failed_at TEXT");
      }
      if (!has("cognition_runs")) return;
      // Backfill what the ledger still remembers: marked, no completed
      // bootstrap run, at least one failed. Older give-ups whose runs are
      // already pruned cannot be recovered and stay counted as reviewed —
      // stated here rather than papered over.
      // Set-based on purpose. The obvious shape — two correlated EXISTS
      // subqueries per document — cannot use the only index on `dedupe_key`,
      // which is partial (`WHERE status = 'pending'`) and so covers neither
      // `failed` nor `completed`. That makes it one full scan of the run
      // ledger per marked document: on a corpus of a few hundred thousand
      // documents it turns a migration into a startup the operator watches.
      //
      // Instead: one grouped pass over the bootstrap runs to decide which
      // documents were abandoned, then an update keyed on the primary key.
      db.exec(`
        UPDATE documents SET bootstrap_failed_at = bootstrap_processed_at
         WHERE bootstrap_processed_at IS NOT NULL
           AND bootstrap_failed_at IS NULL
           AND id IN (
             SELECT substr(dedupe_key, length('bootstrap:doc:') + 1)
               FROM cognition_runs
              WHERE dedupe_key LIKE 'bootstrap:doc:%'
              GROUP BY dedupe_key
             HAVING SUM(status = 'failed') > 0 AND SUM(status = 'completed') = 0
           )`);
    },
  },
  {
    version: 130,
    description: "raise the bootstrap lifetime counter to at least what the ledger shows",
    up(db) {
      // The counter was advanced by writing back an absolute total computed
      // from a value read several awaits earlier, so a lost write dropped an
      // increment for good. On a live install it had fallen 226 below the
      // bootstrap runs still on the ledger.
      //
      // The ledger is pruned, so its count is itself only a floor — but a
      // floor is strictly better than a number known to be short, and the
      // counter is the lane's lifetime backstop. Raising it can only make the
      // backstop fire nearer to when the operator asked; it is never lowered,
      // because the pruned history it already counts is real.
      const has = (table: string): boolean =>
        db
          .prepare<
            [string],
            { name: string }
          >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .all(table).length > 0;
      if (!has("cognition_engine_state") || !has("cognition_runs")) return;
      const onLedger = db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM cognition_runs WHERE kind = 'bootstrap'")
        .get()!.n;
      if (onLedger <= 0) return;
      db.prepare(
        `INSERT INTO cognition_engine_state (key, value) VALUES ('bootstrap_total_enqueued', ?)
         ON CONFLICT(key) DO UPDATE
           SET value = CAST(MAX(CAST(cognition_engine_state.value AS INTEGER), ?) AS TEXT)`,
      ).run(String(onLedger), onLedger);
    },
  },
  {
    version: 131,
    description: "source membership: source_devices, per-device sync_state, revocable devices",
    // Rebuilds `sources` — a table other tables reference — so FK
    // enforcement must be off for the rebuild (SQLite's 12-step ALTER):
    // with it on, RENAME rewrites every child FK to point at the old name.
    // `PRAGMA foreign_keys` is inert inside a transaction, hence
    // ownTransaction; the body BEGINs/COMMITs itself and verifies the
    // rebuilt tables with foreign_key_check before committing.
    ownTransaction: true,
    up(db) {
      const fkWasOn =
        (db.prepare<[], { foreign_keys: number }>("PRAGMA foreign_keys").get()?.foreign_keys ??
          0) === 1;
      db.exec("PRAGMA foreign_keys = OFF");
      // RENAME rewrites other tables' REFERENCES clauses to the new name
      // even with FKs off; legacy mode disables that, so the child FKs
      // keep pointing at `sources` and are satisfied again by the
      // recreated table. Restored in the finally below.
      db.exec("PRAGMA legacy_alter_table = ON");
      db.exec("BEGIN");
      try {
        rebuildForSourceMembership(db);
        // Scoped to the tables the rebuild touches or that reference them:
        // a DB-wide check would fail this upgrade on any unrelated,
        // pre-existing orphan row anywhere in the database.
        for (const table of [
          "sources",
          "source_devices",
          "mobile_permission_health",
          "document_temporal_projection_sources",
        ]) {
          // Partial fixture databases carry only some of these tables.
          const present =
            db
              .prepare<
                [string],
                { name: string }
              >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(table) !== undefined;
          if (!present) continue;
          const violations = db
            .prepare<[], { table: string }>(`PRAGMA foreign_key_check(${table})`)
            .all();
          if (violations.length > 0) {
            throw new Error(
              `foreign_key_check(${table}) found ${violations.length} violation(s) after the rebuild`,
            );
          }
        }
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch (rollbackErr) {
          log.warn(
            `migration 131: rollback skipped (${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)})`,
          );
        }
        throw err;
      } finally {
        db.exec("PRAGMA legacy_alter_table = OFF");
        if (fkWasOn) db.exec("PRAGMA foreign_keys = ON");
      }
    },
  },
  {
    version: 132,
    description:
      "devices.install_id: the client's per-install identity, the pair-time adoption key",
    up(db) {
      // The name is display only: re-pairing adopts the row carrying the
      // same (kind, install_id), so a rename can't sever the identity that
      // per-device cursors and stream keys hang off. NULL for rows paired by
      // clients without an install identity; those are adopted by name, or
      // by the device id the client remembers.
      const columns = new Set(
        db
          .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
          .all("devices")
          .map((r) => r.name),
      );
      if (columns.size > 0 && !columns.has("install_id")) {
        db.exec("ALTER TABLE devices ADD COLUMN install_id TEXT");
      }
      if (columns.size > 0) {
        db.exec(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_install ON devices(kind, install_id) WHERE install_id IS NOT NULL",
        );
      }
    },
  },
  {
    version: 133,
    description:
      "source_wipe_epoch keyed by (source_id, device_id): one write-epoch fence per cursor row",
    up(db) {
      // Nothing references this table, so it is rebuilt in place: every
      // existing epoch becomes the shared row's (`device_id = ''`), which is
      // the row every source syncs on until its type declares a mode.
      const columns = new Set(
        db
          .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
          .all("source_wipe_epoch")
          .map((r) => r.name),
      );
      if (columns.size === 0 || columns.has("device_id")) return;
      db.exec(`
        CREATE TABLE source_wipe_epoch_next (
          source_id TEXT NOT NULL,
          device_id TEXT NOT NULL DEFAULT '',
          epoch INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (source_id, device_id)
        );
        INSERT INTO source_wipe_epoch_next (source_id, device_id, epoch)
          SELECT source_id, '', epoch FROM source_wipe_epoch;
        DROP TABLE source_wipe_epoch;
        ALTER TABLE source_wipe_epoch_next RENAME TO source_wipe_epoch;
      `);
    },
  },
  {
    version: 134,
    description:
      "documents.stream_id: the contributing device's stream of a partitioned source; uniqueness and tombstones keyed per stream",
    // Rebuilds `documents` and `removed_documents` — tables other tables
    // reference — so FK enforcement must be off for the rebuild (SQLite's
    // 12-step ALTER), exactly as migration 131 rebuilt `sources`. The
    // documents indexes go with the old table; schema setup recreates them
    // once the rebuild has committed.
    ownTransaction: true,
    up(db) {
      const fkWasOn =
        (db.prepare<[], { foreign_keys: number }>("PRAGMA foreign_keys").get()?.foreign_keys ??
          0) === 1;
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("PRAGMA legacy_alter_table = ON");
      db.exec("BEGIN");
      try {
        rebuildForDocumentStreams(db);
        // The tables that reference the rebuilt `documents` are the ones
        // whose foreign keys could dangle.
        const referencing = db
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%REFERENCES documents%'",
          )
          .all()
          .map((r) => r.name);
        for (const table of referencing) {
          const violations = db
            .prepare<[], { table: string }>(`PRAGMA foreign_key_check(${table})`)
            .all();
          if (violations.length > 0) {
            throw new Error(
              `foreign_key_check(${table}) found ${violations.length} violation(s) after the rebuild`,
            );
          }
        }
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch (rollbackErr) {
          log.warn(
            `migration 134: rollback skipped (${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)})`,
          );
        }
        throw err;
      } finally {
        db.exec("PRAGMA legacy_alter_table = OFF");
        if (fkWasOn) db.exec("PRAGMA foreign_keys = ON");
      }
      runSchemaSetup(db);
      // The rebuild wrote a copy of the table into the WAL; hand the space back.
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
  },
  {
    version: 135,
    description:
      "reauth_reminders keyed by (principal, device_id): each member device's grant lapses and recovers on its own",
    up(db) {
      // Nothing references this table, so it is rebuilt in place inside
      // the runner's transaction. Every existing row becomes a device-less
      // row carrying a principal-wide episode; the next device that lapses
      // adopts it.
      rekeyReauthRemindersByDevice(db);
      // A reminder queued under the previous collapse-id shape can never be
      // superseded by a per-device recovery, so every pending needs-auth
      // reminder is retired here; the next lapse re-issues it under the
      // per-device shape. Schema setup creates the queue tables before any
      // migration runs, so they exist here on every install.
      supersedeNotificationsByCollapseIdPrefix(db, "needs-auth:", Date.now());
    },
  },
  {
    version: 136,
    description: "refresh_meta: add the people_counts job",
    up(db) {
      // Partial fixture databases (and any install that predates the table)
      // carry no `refresh_meta`; schema setup creates it with the current
      // shape, so there is nothing here to rebuild.
      const present =
        db
          .prepare<
            [],
            { name: string }
          >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'refresh_meta'")
          .get() !== undefined;
      if (!present) return;
      // `refresh_meta.job` carries a CHECK listing the jobs that may use it,
      // so admitting a new one means rebuilding the table. Nothing
      // references `refresh_meta`, so this is a plain copy — no foreign-key
      // dance, and it runs inside the runner's transaction.
      //
      // Existing rows carry their dirty/computed watermarks across
      // unchanged; the new job starts undirty with no computed version, so
      // the first sweep after the upgrade runs and stamps it.
      db.exec(`
        CREATE TABLE refresh_meta_new (
          job TEXT PRIMARY KEY CHECK (job IN ('link_graph', 'interaction_scores', 'merge_rules', 'near_dup_df', 'people_counts')),
          dirty_version INTEGER NOT NULL DEFAULT 0,
          last_computed_version INTEGER NOT NULL DEFAULT -1,
          last_computed_at INTEGER,
          needs_refresh INTEGER NOT NULL DEFAULT 1
        )
      `);
      db.exec(`
        INSERT INTO refresh_meta_new (job, dirty_version, last_computed_version, last_computed_at, needs_refresh)
        SELECT job, dirty_version, last_computed_version, last_computed_at, needs_refresh FROM refresh_meta
      `);
      db.exec("DROP TABLE refresh_meta");
      db.exec("ALTER TABLE refresh_meta_new RENAME TO refresh_meta");
      db.exec("INSERT OR IGNORE INTO refresh_meta (job) VALUES ('people_counts')");
    },
  },
  {
    version: 137,
    description: "near_dup_df: rows carry a generation, and the meta row names the live one",
    up(db) {
      // Rows are keyed by the build they belong to, and the meta row names
      // the build readers use. That is what lets a rebuild write alongside
      // the live rows and publish itself by moving one pointer, rather than
      // clearing the table and refilling it.
      //
      // `near_dup_df` is WITHOUT ROWID and nothing references it, so the
      // primary-key change is a plain rebuild inside the runner's
      // transaction. Existing rows become generation 0, which is what the
      // meta row points at, so the table stays live throughout.
      const dfPresent =
        db
          .prepare<
            [],
            { name: string }
          >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'near_dup_df'")
          .get() !== undefined;
      // Guarded on the column, not the table: re-running the rebuild on a
      // table that already has generations would copy every one of them to
      // 0 while the meta pointer still names a later one, leaving readers
      // on an empty generation.
      const dfNeedsGeneration =
        dfPresent &&
        !db
          .prepare<[], { name: string }>("PRAGMA table_info(near_dup_df)")
          .all()
          .some((c) => c.name === "generation");
      if (dfNeedsGeneration) {
        db.exec(`
          CREATE TABLE near_dup_df_new (
            algo_version TEXT NOT NULL,
            generation   INTEGER NOT NULL DEFAULT 0,
            shingle      TEXT NOT NULL,
            df           INTEGER NOT NULL,
            PRIMARY KEY (algo_version, generation, shingle)
          ) WITHOUT ROWID
        `);
        db.exec(`
          INSERT INTO near_dup_df_new (algo_version, generation, shingle, df)
          SELECT algo_version, 0, shingle, df FROM near_dup_df
        `);
        db.exec("DROP TABLE near_dup_df");
        db.exec("ALTER TABLE near_dup_df_new RENAME TO near_dup_df");
      }

      const metaPresent =
        db
          .prepare<
            [],
            { name: string }
          >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'near_dup_df_meta'")
          .get() !== undefined;
      if (metaPresent) {
        const hasColumn = db
          .prepare<[], { name: string }>("PRAGMA table_info(near_dup_df_meta)")
          .all()
          .some((c) => c.name === "live_generation");
        if (!hasColumn) {
          db.exec(
            "ALTER TABLE near_dup_df_meta ADD COLUMN live_generation INTEGER NOT NULL DEFAULT 0",
          );
        }
      }
    },
  },
  {
    version: 138,
    description:
      "document_absences + snapshot_absence_deletions: a snapshot's omission is marked with a deadline instead of deleting",
    up(db) {
      // Schema setup creates both tables with the head shape before any
      // migration runs, so on a fresh install these CREATEs are no-ops. On an
      // existing install they are what introduces the tables — no data to
      // carry over: an install upgrading here has no recorded absences, and
      // the first snapshot each source sends after the upgrade starts them.
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
          observations INTEGER NOT NULL
        )
      `);
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
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_documents_provider_source_stream
          ON documents(provider_id, source_id, stream_id, id)
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS snapshot_absence_cascade_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER NOT NULL,
          document_ids TEXT NOT NULL,
          index_done INTEGER NOT NULL DEFAULT 0,
          cognition_done INTEGER NOT NULL DEFAULT 0
        )
      `);
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
    },
  },
  {
    version: 139,
    description: "persist each source's authoritative multi-device mode",
    up(db) {
      const sourceColumns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('sources')")
        .all();
      if (sourceColumns.some((column) => column.name === "multi_device_mode")) return;

      db.exec(`
        ALTER TABLE sources ADD COLUMN multi_device_mode TEXT NOT NULL DEFAULT 'exclusive'
          CHECK (multi_device_mode IN ('exclusive', 'handoff', 'replicated', 'partitioned'))
      `);

      // Freeze the mode the old gateway would have resolved at upgrade
      // time. Invalid/malformed announcements are ignored, revoked devices
      // do not vote, and equal activity timestamps retain pairing order —
      // the historical resolver's stable listDevices ordering.
      const devices = db
        .prepare<[], { capabilities: string; last_seen_at: number | null; paired_at: number }>(
          `SELECT capabilities, last_seen_at, paired_at
             FROM devices
            WHERE revoked_at IS NULL
            ORDER BY COALESCE(last_seen_at, 0) DESC, paired_at ASC`,
        )
        .all();
      const announcements: Array<Record<string, unknown>> = [];
      for (const device of devices) {
        try {
          const parsed: unknown = JSON.parse(device.capabilities);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          const modes = (parsed as { multiDeviceModes?: unknown }).multiDeviceModes;
          if (!modes || typeof modes !== "object" || Array.isArray(modes)) continue;
          announcements.push(modes as Record<string, unknown>);
        } catch {
          // A malformed legacy capability row never supplied a valid mode.
        }
      }

      const validModes = new Set(["exclusive", "handoff", "replicated", "partitioned"]);
      const sourceTypes = db
        .prepare<[], { type: string }>("SELECT DISTINCT type FROM sources")
        .all();
      const persist = db.prepare("UPDATE sources SET multi_device_mode = ? WHERE type = ?");
      for (const { type } of sourceTypes) {
        let mode = "exclusive";
        for (const announced of announcements) {
          const candidate = announced[type];
          if (typeof candidate === "string" && validModes.has(candidate)) {
            mode = candidate;
            break;
          }
        }
        persist.run(mode, type);
      }
    },
  },
  {
    version: 140,
    description: "journal partitioned member stream cleanup",
    up: createSourceStreamCleanupTable,
  },
  {
    version: 141,
    description: "journal authoritative source mode transitions",
    up: (db) => {
      createSourceModeTransitionTable(db);
      createSourceModeTransitionIndexes(db);
    },
  },
  {
    version: 142,
    description: "link reconciliation: add bounded URL-ownership cursors",
    up(db) {
      const columns = new Set(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('link_reconcile_state')",
          )
          .all()
          .map((row) => row.name),
      );
      if (columns.size === 0) return;
      if (!columns.has("ownership_link_cursor")) {
        db.exec(
          "ALTER TABLE link_reconcile_state ADD COLUMN ownership_link_cursor INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!columns.has("ownership_link_max_id")) {
        db.exec(
          "ALTER TABLE link_reconcile_state ADD COLUMN ownership_link_max_id INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!columns.has("ownership_document_cursor")) {
        db.exec(
          "ALTER TABLE link_reconcile_state ADD COLUMN ownership_document_cursor INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!columns.has("ownership_document_max_rowid")) {
        db.exec(
          "ALTER TABLE link_reconcile_state ADD COLUMN ownership_document_max_rowid INTEGER NOT NULL DEFAULT 0",
        );
      }
    },
  },
  {
    version: 143,
    description: "index URL ownership lookup by normalized external id and source",
    up(db) {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_documents_external_id_source ON documents(LOWER(external_id), source_id)",
      );
    },
  },
  {
    version: 144,
    description: "add an O(1) URL-declaration revision fence",
    up(db) {
      installCollectorRosterRevision(db);
    },
  },
  {
    version: 145,
    description: "bound the unresolved URL reconciliation cycle with a high-water mark",
    up(db) {
      const columns = new Set(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('link_reconcile_state')",
          )
          .all()
          .map((row) => row.name),
      );
      if (columns.size > 0 && !columns.has("url_cycle_max_id")) {
        db.exec(
          "ALTER TABLE link_reconcile_state ADD COLUMN url_cycle_max_id INTEGER NOT NULL DEFAULT 0",
        );
        // A legacy nonzero cursor may already sit beyond the quiet unresolved
        // tail. Seed the first finite cycle at that cursor so its first empty
        // scan wraps instead of leaving the historical prefix stranded.
        db.exec("UPDATE link_reconcile_state SET url_cycle_max_id = cursor WHERE cursor > 0");
      }
    },
  },
  {
    version: 146,
    description: "store member-local source configuration overrides",
    up: (db) => {
      const columns = db
        .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
        .all("source_devices")
        .map((row) => row.name);
      if (!columns.includes("config_override")) {
        db.exec("ALTER TABLE source_devices ADD COLUMN config_override TEXT NOT NULL DEFAULT '{}'");
      }
    },
  },
  {
    version: 147,
    description: "pin each source's member-local configuration contract",
    up: createSourceMemberConfigContractTable,
  },
  {
    version: 148,
    description: "journal post-transition source config publication",
    up: createSourceModeTransitionPublicationTable,
  },
  {
    version: 149,
    description: "pin replicated row version policy on each source",
    up: (db) => {
      const columns = db
        .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
        .all("sources")
        .map((row) => row.name);
      if (!columns.includes("replica_version_policy")) {
        db.exec(`
          ALTER TABLE sources ADD COLUMN replica_version_policy TEXT
            CHECK (
              replica_version_policy IS NULL
              OR replica_version_policy = 'source-updated-at'
            )
        `);
      }
    },
  },
  {
    version: 150,
    description: "record each replica member's deletion verdicts so disputed items converge",
    up: createReplicaDeletionClaimsTable,
  },
  {
    version: 151,
    description: "remember which device's snapshot observed each pending absence",
    up: (db) => {
      const columns = db
        .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
        .all("document_absences")
        .map((row) => row.name);
      if (columns.length > 0 && !columns.includes("observed_by")) {
        db.exec("ALTER TABLE document_absences ADD COLUMN observed_by TEXT NOT NULL DEFAULT ''");
      }
    },
  },
  {
    version: 152,
    description: "add external MCP principals, grants, credentials, and OAuth state",
    up: migrateV152AccessGrants,
  },
  {
    version: 153,
    description: "add named privacy policies and granular access rules",
    up: migrateV153AccessPolicyFamilies,
  },
  {
    version: 154,
    description: "support confidential dynamically registered OAuth clients",
    ownTransaction: true,
    up(db) {
      const fkWasOn =
        (db.prepare<[], { foreign_keys: number }>("PRAGMA foreign_keys").get()?.foreign_keys ??
          0) === 1;
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("PRAGMA legacy_alter_table = ON");
      db.exec("BEGIN");
      try {
        migrateV154ConfidentialOAuthClients(db);
        for (const table of ["oauth_execution_bindings", "oauth_authorization_requests"]) {
          const present =
            db
              .prepare<
                [string],
                { name: string }
              >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(table) !== undefined;
          if (!present) continue;
          const violations = db
            .prepare<[], { table: string }>(`PRAGMA foreign_key_check(${table})`)
            .all();
          if (violations.length > 0) {
            throw new Error(
              `foreign_key_check(${table}) found ${violations.length} violation(s) after the rebuild`,
            );
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The original migration failure is the actionable error.
        }
        throw error;
      } finally {
        db.exec("PRAGMA legacy_alter_table = OFF");
        if (fkWasOn) db.exec("PRAGMA foreign_keys = ON");
      }
    },
  },
  {
    version: 155,
    description: "keep a sync error's structured remediation beside its message",
    up: (db) => {
      const columns = db
        .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
        .all("sync_state")
        .map((row) => row.name);
      if (columns.length > 0 && !columns.includes("last_error_remediation")) {
        db.exec("ALTER TABLE sync_state ADD COLUMN last_error_remediation TEXT");
      }
    },
  },
  {
    version: 156,
    description: "track mobile permission health independently for every source member",
    up(db) {
      rekeyMobilePermissionHealthByDevice(db);
      const tables = new Set(
        db
          .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name),
      );
      if (tables.has("notifications") && tables.has("notification_deliveries")) {
        // The collapse-key namespace gained member and source-stale scopes.
        // Retire only the old raw-source-id shape. Active episodes are
        // persisted above and the notifier will publish them in the new
        // bounded opaque shape. Keeping the shape test here makes a crash
        // replay idempotent: it cannot retire notifications already emitted
        // by the new binary.
        db.prepare(
          `UPDATE notification_deliveries
              SET state = 'superseded', lease_token = NULL, leased_until = NULL,
                  wake_state = 'terminal', wake_lease_token = NULL,
                  wake_leased_until = NULL, wake_next_attempt_at = NULL
            WHERE state IN ('pending', 'leased')
              AND notification_id IN (
                SELECT id FROM notifications
                 WHERE kind = 'source-permission'
                   AND collapse_id LIKE 'source-permission:%'
                   AND collapse_id NOT GLOB 'source-permission:????????????????????:m:????????:????????????'
                   AND collapse_id NOT GLOB 'source-permission:????????????????????:stale:????????????'
              )`,
        ).run();
      }
    },
  },
  {
    version: 157,
    description: "remove internal identity URIs from document source links",
    up(db) {
      const detachedLinks = db
        .prepare(
          `UPDATE document_links
              SET target_doc_id = NULL, resolved_at = NULL
            WHERE link_type = 'url'
              AND target_doc_id IN (
                SELECT id FROM documents WHERE source_url GLOB 'omnesis://*'
              )`,
        )
        .run().changes;
      db.exec(`
        UPDATE documents
           SET metadata = CASE
                 WHEN json_valid(metadata) THEN json_remove(metadata, '$.sourceUrl')
                 ELSE metadata
               END,
               source_url = NULL,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE source_url GLOB 'omnesis://*'
      `);
      if (detachedLinks > 0) markLinkStatsDirty(db);
    },
  },
  {
    version: 158,
    description: "record the product version and wire protocol each device reports",
    up(db) {
      const columns = new Set(
        db
          .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
          .all("devices")
          .map((row) => row.name),
      );
      if (columns.size === 0) return;
      // Existing rows stay NULL on all three: a device that paired before the
      // ledger has told the gateway nothing about its build, and inventing a
      // version for it would be a worse answer than "unknown". Each column is
      // filled by that device's next hello.
      if (!columns.has("version")) {
        db.exec("ALTER TABLE devices ADD COLUMN version TEXT");
      }
      if (!columns.has("version_seen_at")) {
        db.exec("ALTER TABLE devices ADD COLUMN version_seen_at INTEGER");
      }
      if (!columns.has("protocol_version")) {
        db.exec("ALTER TABLE devices ADD COLUMN protocol_version INTEGER");
      }
    },
  },
  {
    version: 159,
    description: "hold the version an operator asked each device to update itself to",
    up(db) {
      const columns = new Set(
        db
          .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
          .all("devices")
          .map((row) => row.name),
      );
      if (columns.size === 0) return;
      // All NULL on existing rows, which is the correct reading: nothing has
      // been asked of any of them. `desired_version` is cleared once the
      // device reports back on that version, so a non-null value always means
      // an update is still owed.
      if (!columns.has("desired_version")) {
        db.exec("ALTER TABLE devices ADD COLUMN desired_version TEXT");
      }
      if (!columns.has("update_state")) {
        db.exec("ALTER TABLE devices ADD COLUMN update_state TEXT");
      }
      if (!columns.has("update_detail")) {
        db.exec("ALTER TABLE devices ADD COLUMN update_detail TEXT");
      }
      if (!columns.has("update_state_at")) {
        db.exec("ALTER TABLE devices ADD COLUMN update_state_at INTEGER");
      }
    },
  },
  {
    version: 160,
    description: "make OAuth refresh-token rotation safe to retry",
    up: addOAuthRefreshRetryColumns,
  },
  {
    version: 161,
    description: "stabilize external Answer ownership across policy revisions",
    up: migrateAnswerOwnersToStableScope,
  },
  {
    version: 162,
    description: "index principal credentials by execution device",
    up: indexPrincipalCredentialsByExecutionDevice,
  },
  {
    version: 163,
    description: "allow independent notes access grants",
    up: addNotesAccessCapability,
  },
  {
    version: 164,
    description: "retain authenticated principal provenance for note captures",
    up: (db) => {
      const columns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('note_entries')")
        .all();
      if (!columns.some((column) => column.name === "capture_context")) {
        db.exec("ALTER TABLE note_entries ADD COLUMN capture_context TEXT");
      }
    },
  },
  {
    version: 165,
    description: "record per-device relay notification consent",
    up(db) {
      const columns = new Set(
        db
          .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
          .all("devices")
          .map((row) => row.name),
      );
      if (columns.size === 0) return;
      if (!columns.has("relay_consent_app_id")) {
        db.exec("ALTER TABLE devices ADD COLUMN relay_consent_app_id TEXT");
      }
      if (!columns.has("relay_consented_at")) {
        db.exec("ALTER TABLE devices ADD COLUMN relay_consented_at INTEGER");
      }
      // A legacy relay registration proves only that the old global switch
      // was enabled. It is not a device-owner authorization, so discard it
      // while the new consent fields are empty.
      if (columns.has("push_transport")) {
        const assignments = ["push_transport = NULL"];
        if (columns.has("relay_url")) assignments.push("relay_url = NULL");
        if (columns.has("relay_credential")) assignments.push("relay_credential = NULL");
        db.exec(`
          UPDATE devices
             SET ${assignments.join(", ")}
           WHERE push_transport = 'relay'
             AND (relay_consent_app_id IS NULL OR relay_consented_at IS NULL)
        `);
      }
    },
  },
  {
    version: 166,
    description: "pairing redemption receipts serve every device kind",
    up: renamePairingRedemptionReceipts,
  },
  {
    version: 167,
    description: "Index pending principal credentials by age for the orphan sweep",
    up: indexPendingCredentials,
  },
  {
    version: 168,
    description: "persist the current doctor run for each device",
    up: createDeviceDoctorRunsTable,
  },
  {
    version: 169,
    description: "revoke service principals, their grants and credentials",
    up: retireServiceCredentials,
  },
  {
    version: 170,
    description: "direct MCP audit transcript tables",
    up: createDirectAuditTables,
  },
  {
    version: 171,
    description: "split shared access into one connection per sign-in and add access levels",
    up: (db) => migrateV171AccessLevels(db),
  },
  {
    version: 172,
    description: "A source row carries what its source declares about the account",
    up: addSourceAccountDescriptor,
  },
  {
    version: 173,
    description: "An alias records every source that vouches for it, not only the first",
    up: addPersonAliasAssertions,
  },
  {
    version: 174,
    description: "A platform identifier says which platform issued it",
    up: namespaceWhatsappLids,
  },
  {
    version: 175,
    description: "A source family declares its own display identity",
    up: addSourceFamilyMeta,
  },
  {
    version: 176,
    description: "A document records which of its source's partitions it came from",
    up: addDocumentPartitionKey,
  },
  {
    version: 177,
    description: "Sources retain their adopted sync wire contract across mixed collector upgrades",
    up: addSourceWireContracts,
  },
  {
    version: 178,
    description: "Retain structured source pages across partial writes",
    up: addPendingSourcePages,
  },
  {
    version: 179,
    description: "Persist nonfatal sync issues per reporting member",
    up: addSourceSyncIssues,
  },
  {
    version: 180,
    description: "A source's timestamps are milliseconds, as every reader of them assumes",
    up: normalizeSourceTimestamps,
  },
  {
    // The access level an integration's `/answer` requests use, and the one a
    // pairing code puts a new integration on. Null means none, so existing
    // rows need no back-fill. Idempotent via the pragma_table_info guards, and
    // a no-op on a fresh DB whose tables already carry the columns.
    version: 181,
    description: "add access_level_id to devices and device_pairings",
    up(db) {
      for (const table of ["devices", "device_pairings"]) {
        const cols = db
          .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
          .all()
          .map((r) => r.name);
        if (!cols.includes("access_level_id")) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN access_level_id TEXT`);
        }
      }
    },
  },
];

/**
 * Body of migration 131. Devices become members of sources rather than
 * owners, in four schema moves that change no behavior on their own
 * (everything keeps reading/writing the shapes it did — the single shared
 * cursor row, the primary device on `sources.device_id`):
 *
 *   1. `devices.revoked_at` — unpairing marks a device revoked instead of
 *      deleting the row, so the id survives as a durable identity
 *      (per-device cursors, partitioned stream keys).
 *   2. `sources` drops ON DELETE CASCADE from its device FK — removing a
 *      device must never destroy a source or its data.
 *   3. `source_devices(source_id, device_id, added_at)` — the membership
 *      set, backfilled with each source's current device.
 *   4. `sync_state` is re-keyed to (source_id, device_id) with '' as the
 *      shared sentinel; every existing row becomes the shared row.
 *
 * Every step is guarded by a shape probe, so a re-run after a crash between
 * the body's COMMIT and the version stamp is a no-op. Runs with foreign
 * keys OFF and legacy_alter_table ON (see the migration entry).
 */
function rebuildForSourceMembership(db: Db): void {
  const has = (table: string): boolean =>
    db
      .prepare<
        [string],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .all(table).length > 0;
  const columns = (table: string): Set<string> =>
    new Set(
      db
        .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
        .all(table)
        .map((r) => r.name),
    );

  if (has("devices") && !columns("devices").has("revoked_at")) {
    db.exec("ALTER TABLE devices ADD COLUMN revoked_at INTEGER");
  }

  // Rebuild `sources` without the cascade. Only when the old FK is
  // present: a fresh DB (or one already migrated) has the new shape.
  if (has("sources")) {
    const fkCascades = db
      .prepare<[], { on_delete: string }>(
        `SELECT "on_delete" FROM pragma_foreign_key_list('sources')`,
      )
      .all()
      .some((r) => r.on_delete === "CASCADE");
    if (fkCascades) {
      db.exec("ALTER TABLE sources RENAME TO sources_old");
      db.exec(`
        CREATE TABLE sources (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          account_id TEXT NOT NULL,
          device_id TEXT NOT NULL REFERENCES devices(id),
          config TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.exec(`
        INSERT INTO sources (id, type, account_id, device_id, config, enabled, created_at, updated_at)
        SELECT id, type, account_id, device_id, config, enabled, created_at, updated_at
          FROM sources_old
      `);
      // The index rides along with the renamed table and dies with it.
      db.exec("DROP TABLE sources_old");
      db.exec("CREATE INDEX IF NOT EXISTS idx_sources_device ON sources(device_id)");
    }
  }

  if (!has("source_devices") && has("sources")) {
    db.exec(`
      CREATE TABLE source_devices (
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES devices(id),
        added_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, device_id)
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_source_devices_device ON source_devices(device_id)");
  }
  if (has("source_devices") && has("sources")) {
    // Backfill (idempotent): every source's current device becomes its
    // first member. `created_at` is the closest honest stamp for when
    // that device started serving the source.
    db.exec(`
      INSERT OR IGNORE INTO source_devices (source_id, device_id, added_at)
      SELECT id, device_id, created_at FROM sources
    `);
  }

  // `document_temporal_projection_sources` carried an FK to
  // sync_state(source_id); with the composite key below that column is
  // no longer a unique parent key, so the FK is dropped (cleanup is
  // explicit at the source-wipe sites). Must happen before the re-key,
  // or every statement touching the child table fails FK resolution.
  if (has("document_temporal_projection_sources")) {
    const hasFk =
      db
        .prepare<
          [],
          { table: string }
        >(`SELECT "table" FROM pragma_foreign_key_list('document_temporal_projection_sources')`)
        .all().length > 0;
    if (hasFk) {
      db.exec("ALTER TABLE document_temporal_projection_sources RENAME TO dtps_old");
      db.exec(`
        CREATE TABLE document_temporal_projection_sources (
          source_id TEXT PRIMARY KEY,
          slots_json TEXT NOT NULL,
          last_materialized_at TEXT,
          last_sync_at TEXT NOT NULL
        )
      `);
      db.exec(`
        INSERT INTO document_temporal_projection_sources (source_id, slots_json, last_materialized_at, last_sync_at)
        SELECT source_id, slots_json, last_materialized_at, last_sync_at FROM dtps_old
      `);
      db.exec("DROP TABLE dtps_old");
    }
  }

  // Re-key sync_state to (source_id, device_id). Existing rows become
  // the shared row ('' device) — exactly what they were.
  if (has("sync_state") && !columns("sync_state").has("device_id")) {
    db.exec("ALTER TABLE sync_state RENAME TO sync_state_old");
    db.exec(`
      CREATE TABLE sync_state (
        source_id TEXT NOT NULL,
        device_id TEXT NOT NULL DEFAULT '',
        cursor TEXT NOT NULL DEFAULT '{}',
        last_synced_at TEXT,
        icon TEXT,
        label TEXT,
        url_patterns TEXT,
        last_error TEXT,
        errored_at TEXT,
        bg_color TEXT,
        accent_color TEXT,
        content_retention TEXT,
        consent_expires_at TEXT,
        last_document_at TEXT,
        minimum_gateway_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_id, device_id)
      )
    `);
    // Every prior column is added by an earlier migration, so on a real
    // install the old table carries the full set. Copy by name and refuse
    // to drop a column silently — that would be data loss.
    const oldCols = [...columns("sync_state_old")];
    const newCols = columns("sync_state");
    const dropped = oldCols.filter((c) => !newCols.has(c));
    if (dropped.length > 0) {
      throw new Error(`sync_state re-key would drop column(s): ${dropped.join(", ")}`);
    }
    db.exec(`
      INSERT INTO sync_state (${oldCols.join(", ")}, device_id)
      SELECT ${oldCols.join(", ")}, '' FROM sync_state_old
    `);
    db.exec("DROP TABLE sync_state_old");
  }
}

/**
 * Detect and repair sources that are incompatible with a downgraded gateway
 * binary. Called by `createDatabase` between `runSchemaSetup` and
 * `runMigrations` — before any migrations run — so it sees the raw DB state
 * left by the previously-running (newer) binary.
 *
 * When `PRAGMA user_version` (the DB's schema version) is greater than
 * `LATEST_SCHEMA_VERSION` (this binary's highest known migration), the binary
 * is older than the DB. Any source whose cursor was written at a version
 * higher than this binary's is considered incompatible: its cursor is cleared
 * and its wipe epoch bumped so in-flight syncs from the previous binary are
 * rejected (#551). Documents already in the index are NOT bulk-deleted; they
 * are tombstoned as the fresh resync comes in.
 *
 * Sources written at or below `LATEST_SCHEMA_VERSION` are untouched — their
 * data is still interpretable by the running binary.
 *
 * Protection scope: activates for binaries at schema v29+ (the #1078 release
 * that added both this check and the `minimum_gateway_version` column). A
 * downgrade to a pre-v29 binary has no detection code on the old side and is
 * unprotected.
 *
 * See #1078.
 */
export function runDowngradeCompatCheck(db: Db, opts?: { log?: Logger }): void {
  const logger = opts?.log ?? log;

  const row = db.prepare<unknown[], { user_version: number }>("PRAGMA user_version").get();
  const dbVersion = row?.user_version ?? 0;

  if (dbVersion <= LATEST_SCHEMA_VERSION) return;

  // Binary is older than the DB — downgrade detected.
  // Check whether the minimum_gateway_version column exists. It was added in
  // migration 29 (the same #1078 release that introduced this check), so any
  // binary carrying this code also carries the column migration. If somehow
  // we're downgrading past a DB that pre-dates migration 29 (impossible in
  // practice since this code only ships at v29+), log a warning and skip.
  const cols = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('sync_state')")
    .all()
    .map((r) => r.name);
  if (!cols.includes("minimum_gateway_version")) {
    logger.warn(
      `downgrade detected (DB schema v${dbVersion}, binary v${LATEST_SCHEMA_VERSION}) but ` +
        `sync_state.minimum_gateway_version column is absent — per-source compatibility check ` +
        `skipped; consider resyncing sources manually if you encounter issues`,
    );
    return;
  }

  const incompatible = db
    .prepare<[number], { source_id: string; minimum_gateway_version: number }>(
      `SELECT source_id, MAX(minimum_gateway_version) AS minimum_gateway_version
       FROM sync_state WHERE minimum_gateway_version > ? GROUP BY source_id`,
    )
    .all(LATEST_SCHEMA_VERSION);

  if (incompatible.length === 0) {
    logger.info(
      `downgrade detected (DB schema v${dbVersion}, binary v${LATEST_SCHEMA_VERSION}); ` +
        `all sources are compatible with this binary — no resets needed`,
    );
    return;
  }

  const clearCursor = db.prepare<[string]>(
    "UPDATE sync_state SET cursor = '{}', minimum_gateway_version = 0 WHERE source_id = ?",
  );
  // Every cursor row's epoch advances, so any in-flight sync of the source
  // loses its write authority whichever row it claimed.
  const seedEpoch = db.prepare<[string]>(
    "INSERT OR IGNORE INTO source_wipe_epoch (source_id, device_id, epoch) VALUES (?, '', 0)",
  );
  const bumpEpoch = db.prepare<[string]>(
    "UPDATE source_wipe_epoch SET epoch = epoch + 1 WHERE source_id = ?",
  );

  db.transaction(() => {
    for (const { source_id, minimum_gateway_version } of incompatible) {
      clearCursor.run(source_id);
      seedEpoch.run(source_id);
      bumpEpoch.run(source_id);
      logger.warn(
        `downgrade: reset source ${source_id} (cursor written at schema v${minimum_gateway_version}, ` +
          `binary supports up to v${LATEST_SCHEMA_VERSION}) — it will resync automatically`,
      );
    }
  })();

  logger.warn(
    `downgrade (DB schema v${dbVersion} → binary v${LATEST_SCHEMA_VERSION}): ` +
      `reset ${incompatible.length} source(s); they will resync automatically`,
  );
}

/**
 * Run any unapplied migrations. Idempotent: repeated calls after the
 * head version is reached are no-ops.
 *
 * Caller is `db.ts`'s `createDatabase`, after `runSchemaSetup` has
 * created the live shape. The order matters: `schema_migrations`
 * itself lives in the schema, so `runSchemaSetup` must run first.
 */
export function runMigrations(
  db: Db,
  opts?: { log?: Logger; migrations?: readonly Migration[] },
): void {
  const logger = opts?.log ?? log;
  const list = opts?.migrations ?? MIGRATIONS;

  const row = db.prepare<unknown[], { user_version: number }>("PRAGMA user_version").get();
  const current = row?.user_version ?? 0;

  // Sort by version so an out-of-order MIGRATIONS list still applies
  // sensibly (defensive: the constant is supposed to be ordered).
  const eligible = list.filter((m) => m.version > current).sort((a, b) => a.version - b.version);

  if (eligible.length === 0) {
    if (current < LATEST_SCHEMA_VERSION) {
      // No migration definitions but the head says we should be at a
      // higher version. Set the version forward — typical when the
      // framework lands on a DB that was created by a previous schema
      // generation but whose shape now matches the head schema after
      // `runSchemaSetup`'s idempotent CREATEs ran.
      db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
      logger.info(`schema baseline set: user_version 0 -> ${LATEST_SCHEMA_VERSION}`);
    }
    return;
  }

  for (const m of eligible) {
    if (m.version <= current) continue;
    logger.info(`running migration ${m.version}: ${m.description}`);
    const startMs = Date.now();
    if (m.ownTransaction) {
      // The migration owns its atomicity (it must toggle a pragma that is
      // inert inside a transaction). The version stamp still happens in a
      // small transaction of its own AFTER the body returns, so a crash
      // between the two re-runs the (idempotent) body rather than skipping
      // it.
      try {
        m.up(db);
        db.exec("BEGIN");
        db.exec(`PRAGMA user_version = ${m.version}`);
        db.prepare(
          "INSERT INTO schema_migrations (version, description, run_at, duration_ms) VALUES (?, ?, ?, ?)",
        ).run(m.version, m.description, Date.now(), Date.now() - startMs);
        db.exec("COMMIT");
        logger.info(`migration ${m.version} applied in ${Date.now() - startMs}ms`);
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* no transaction active — the body already rolled back */
        }
        throw new Error(
          `migration ${m.version} (${m.description}) failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
          { cause: err },
        );
      }
      continue;
    }
    db.exec("BEGIN");
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.prepare(
        "INSERT INTO schema_migrations (version, description, run_at, duration_ms) VALUES (?, ?, ?, ?)",
      ).run(m.version, m.description, Date.now(), Date.now() - startMs);
      db.exec("COMMIT");
      logger.info(`migration ${m.version} applied in ${Date.now() - startMs}ms`);
    } catch (err) {
      // Try to roll back if a transaction is still active; if SQLite
      // already cleared it (some errors auto-rollback), swallow the
      // "no transaction is active" error so the *original* migration
      // failure is what surfaces to the caller.
      try {
        db.exec("ROLLBACK");
      } catch (rollbackErr) {
        logger.warn(
          `migration ${m.version}: rollback skipped (${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)})`,
        );
      }
      throw new Error(
        `migration ${m.version} (${m.description}) failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        { cause: err },
      );
    }
  }
}

/**
 * Body of migration 134. Every document and tombstone gains a `stream_id`:
 * the contributing device's stream of a partitioned source, `''` for a
 * source with one stream. Uniqueness becomes per stream, so two devices'
 * streams may carry the same external id. Existing rows join the shared
 * stream — a historical row came from the only device that existed. Both
 * tables are rebuilt through SQLite's 12-step ALTER; the caller has foreign
 * keys off and `legacy_alter_table` on, so the tables that reference
 * `documents(id)` keep pointing at the rebuilt table by name. Columns are
 * copied by name; a column the new DDL does not declare stops the rebuild
 * rather than being dropped, so no install ever loses data it wrote.
 */
function rebuildForDocumentStreams(db: Db): void {
  const columns = (table: string): string[] =>
    db
      .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map((r) => r.name);
  const rebuild = (table: string, create: string): void => {
    const before = columns(table);
    if (before.length === 0 || before.includes("stream_id")) return;
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
    db.exec(create);
    const after = new Set(columns(table));
    const lost = before.filter((c) => !after.has(c));
    if (lost.length > 0) {
      throw new Error(
        `${table}: the rebuild would drop column(s) ${lost.join(", ")} — declare them in the setup DDL first`,
      );
    }
    db.exec(
      `INSERT INTO ${table} (${before.join(", ")}, stream_id)
         SELECT ${before.join(", ")}, '' FROM ${table}_old`,
    );
    db.exec(`DROP TABLE ${table}_old`);
  };
  rebuild(
    "documents",
    `CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
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
      UNIQUE(provider_id, source_id, external_id, stream_id)
    )`,
  );
  rebuild(
    "removed_documents",
    `CREATE TABLE removed_documents (
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      stream_id TEXT NOT NULL DEFAULT '',
      removed_at INTEGER NOT NULL,
      original_document_id TEXT,
      PRIMARY KEY (provider_id, source_id, external_id, stream_id)
    )`,
  );
}
