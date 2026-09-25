// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import type { DocumentTemporalProjectionSpec } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";

export type { Db };

export interface StoredDocument {
  id: string;
  provider_id: string;
  source_id: string;
  external_id: string;
  title: string;
  content: string;
  content_hash: string;
  metadata: string; // JSON
  source_created_at: string;
  source_updated_at: string;
  ingested_at: string;
  updated_at: string;
  source_url: string | null;
}

export interface StoredSyncState {
  source_id: string;
  /** '' is the shared row; a device id scopes the cursor to one contributor. */
  device_id: string;
  cursor: string; // JSON
  /**
   * ISO timestamp of the last successful cursor save. NULL when the
   * source has never completed a sync but already has an error row
   * (only possible after `setSyncError` lands ahead of any successful
   * cycle).
   */
  last_synced_at: string | null;
  icon: string | null;
  label: string | null;
  url_patterns: string | null; // JSON array
  /** Last error message reported by the collector (cleared on next success). */
  last_error: string | null;
  /** ISO timestamp of the last error (cleared on next success). */
  errored_at: string | null;
  /**
   * JSON `SyncRemediation` — what the operator has to do before `last_error`
   * can clear, when the collector reported one. Set and cleared with the
   * message it explains; NULL for a failure that carried no remedy.
   */
  last_error_remediation: string | null;
  /** Content retention mode declared by the source. See SourceDescriptor.contentRetention. */
  content_retention: string | null;
  /**
   * Forward-looking consent / authorization deadline (ISO 8601) reported by the
   * source on its last successful sync, or NULL when it has no known deadline.
   *`deriveDisplayStatus` derives a non-terminal `auth-expiring` warning
   * when `now` is inside the lead window before this; a re-consent that no longer
   * expires reports a later value or NULL, clearing the warning.
   */
  consent_expires_at: string | null;
  /**
   * ISO timestamp of the last sync page that actually carried documents, or
   * NULL if this source has never produced one. Distinct from `last_synced_at`,
   * which advances on every successful cycle including the empty ones — a
   * source whose upstream feed has silently stalled keeps a fresh
   * `last_synced_at` forever, and only this column reveals it. Read by
   * `deriveDisplayStatus` to derive the non-terminal `stale` warning for
   * sources that declared a `SourceFreshness` expectation.
   *
   * Written and compared against the GATEWAY's clock at both ends, so a
   * collector on another machine with a skewed clock cannot shift the window.
   */
  last_document_at: string | null;
  /**
   * The schema version (PRAGMA user_version) at which this source's cursor was
   * last written. 0 means "written before version tracking was introduced"
   * (compatible with any binary). Used by `runDowngradeCompatCheck` on startup
   * to detect and reset sources whose data was written by a newer binary than
   * the one currently running.
   */
  minimum_gateway_version: number;
}

export interface ListDocumentsOptions {
  updatedSince?: string;
  excludeSourceIds?: string[];
  /**
   * Optional positive filter: only return documents whose `source_id`
   * is in this list. Combines with `excludeSourceIds` (intersection).
   * Lets callers walk selected sources instead of paging through every
   * document and filtering in memory.
   */
  includeSourceIds?: string[];
  limit?: number;
  afterId?: string;
}

export interface ListedDocumentRow {
  id: string;
  sourceId: string;
  title: string;
  content: string;
  contentHash: string;
  metadata: string; // JSON
  sourceCreatedAt: string;
  updatedAt: string;
}

export interface UpsertDocumentsOptions {
  /**
   * Conflict policy for shared documents emitted by independent replicas.
   * `source-updated-at` makes the source's canonical update timestamp the
   * primary version and uses stable payload fields as a deterministic tie
   * break, so collector arrival order cannot regress or oscillate a row.
   */
  replicaVersionPolicies?: Readonly<Record<string, "source-updated-at">>;
  /**
   * The replicated member whose page this is. Each document it carries is
   * that member's word that its replica holds the item, recorded against any
   * deletion another member reported (see `ReplicaDeletionClaimRepository`).
   * Only a member's own sync page sets it; push ingest never does.
   */
  replicaClaimant?: { deviceId: string };
  /** The cursor row each source's `writeEpochs` entry was claimed on (`""` = shared). */
  cursorRows?: Readonly<Record<string, string>>;
  /** The stream each source's documents belong to (`""` = the source's one stream). */
  streams?: Readonly<Record<string, string>>;
  /**
   * Snapshot scope this upsert may rebase after its own arrival evidence.
   * If another writer changed the scope first, the caller discards that stale
   * snapshot plan while the arriving documents still revoke their deadlines.
   */
  absencePlanScope?: {
    providerId: string;
    sourceId: string;
    streamId: string;
    generation: number;
    revision: number;
  };
  /**
   * Optional cooperative-yield token. When the worker-side preempt
   * atomic flips between chunks, the function commits the chunk it
   * just finished and returns `{remaining}` so the Scheduler can
   * dispatch a higher-priority op before the rest of the docs land.
   *
   * Without a token, behavior is unchanged: all docs go in one
   * transaction (backward-compatible with `directWriteGate` callers
   * and the test path).
   */
  token?: { requested(): boolean };
  /**
   * Docs per chunk when a token is provided. Smaller = finer
   * preemption granularity, more fsyncs. Larger = fewer fsyncs but
   * higher latency between yield checks. Defaults to 5 — chosen so
   * a typical 20-document batch yields four times, keeping per-chunk latency
   * around a second even for medium-large documents.
   *
   * Heads up: when any single doc in the batch carries >1MB of
   * content, the runtime forces `chunkSize=1` for that batch (a 1MB
   * row alone is heavy enough that committing it next to peers
   * pushes the chunk past several seconds — see Issue A diagnosis).
   * That override happens AFTER `chunkSize` is applied, so an
   * explicit `chunkSize: 5` is the upper bound, not a guarantee.
   *
   * Ignored when `token` is omitted.
   */
  chunkSize?: number;
  /**
   * Authoritative source-owned temporal declaration for this sync page.
   * Internal to `upsertWithCursor`: each document's derived rows are replaced
   * inside the same transaction as that document.
   */
  /** Exact per-source epochs for legacy document-only writes. */
  writeEpochs?: Readonly<Record<string, number>>;
  documentTemporalProjection?: {
    sourceId: string;
    specs: readonly DocumentTemporalProjectionSpec[];
  };
}

export interface UpsertDocumentsResult {
  /** Docs not yet upserted at yield time. Empty when run completed. */
  remaining: DocumentInput[];
  /** Source ids rejected before any document in this call was written. */
  rejectedSourceIds: string[];
  /** Replicated rows ignored because the gateway already holds an equal-or-newer source version. */
  ignoredReplicaDocuments: Array<{ sourceId: string; externalId: string }>;
  /** Rows refused because the user deleted them for good (`removed_documents`). */
  suppressedDocuments: Array<{ sourceId: string; externalId: string }>;
  /** Rows accepted by the storage contract, including ordinary idempotent upserts. */
  acceptedDocumentCount: number;
  /** Same plan scope advanced only by this upsert's own arrival evidence. */
  absencePlanScope?: NonNullable<UpsertDocumentsOptions["absencePlanScope"]>;
  /** Another writer changed the scope, so the caller's pre-read plan is stale. */
  absencePlanInvalidated?: boolean;
}

/**
 * Aggregated stats for one source, produced by `computeSourceStatsRow`.
 * `capturedVersion` is the `dirty_version` value read from
 * `source_stats` at the moment the aggregation began — used by
 * `upsertSourceStatsRow` as an optimistic-concurrency token to detect
 * a `markSourceStatsDirty` that fired during the (potentially
 * multi-second) compute and would otherwise be silently dropped.
 */
export interface SourceStatsAggregation {
  count: number;
  earliest: string | null;
  latest: string | null;
  dataSize: number;
  totalUnits: number | null;
  capturedVersion: number;
}

export interface LatestActivity {
  /**
   * "document" → derived from the documents table (regular text-emitting
   * source). "analytics" → derived from a DuckDB analytics table for a
   * structured-only source (apple-health, screen-time, …).
   */
  kind: "document" | "analytics";
  /** Document ID — only set when kind === "document". */
  docId?: string;
  /** Document title — only set when kind === "document". May be empty. */
  title?: string;
  /**
   * For documents: gateway-side `updated_at` (bumps on first ingest AND on
   * every content rewrite). For analytics: max sample timestamp (e.g.
   * `start_time`) across the source's analytics tables.
   */
  latestActivityAt: string;
  /** Document only: origin-side timestamp (e.g. email date). */
  sourceCreatedAt?: string;
  /** Document only: gateway-side `ingested_at` — set once on creation. */
  ingestedAt?: string;
  /**
   * Document only: true iff `ingestedAt == latestActivityAt`. Distinguishes a
   * freshly-added doc from one that already existed and got rewritten.
   */
  isNew?: boolean;
  /** Analytics only: DuckDB table name the latest sample came from. */
  tableName?: string;
  /** Analytics only: human-readable table name for the popover. */
  tableDisplayName?: string;
}

export interface RecentDocument {
  id: string;
  source_id: string;
  external_id: string;
  device_id: string;
  device_name: string | null;
  title: string;
  content_preview: string;
  metadata: string;
  source_created_at: string;
  source_updated_at: string;
}
