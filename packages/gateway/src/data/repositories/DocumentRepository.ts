// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { randomUUID } from "node:crypto";
import { createLogger, normalizeUrl } from "@omnesis/core";
import {
  registerDocumentTemporalProjectionCoverage,
  replaceDocumentTemporalProjections,
} from "../../enrichment/temporal-projections/document-storage.js";
import { markLinkStatsDirty, markPeopleGraphDirty, markMergeRulesDirty } from "../DirtyMarks.js";
import { extractPeopleFromMetadata, type DocumentProjection } from "../document-projection.js";
import { documentsMetadataCodec, type DocumentsMetadata } from "../json-columns.js";
import { applyDeclaredEdges } from "../../domain/EdgeDeclarationWriter.js";
import {
  cascadeAnnotationPrivacyDelete,
  cascadeOpenLoopPrivacyDelete,
  listLoopIdsCitingDocs,
  cascadePersonAnnotationPrivacyDelete,
  OPEN_LOOP_PROVIDER_ID,
  OPEN_LOOP_SOURCE_ID,
} from "../../brain/index.js";
import { sourcePrefixPredicate } from "../source-addressing.js";
import { getPendingSourcePage } from "./PendingSourcePageRepository.js";
import {
  clearClaimsForExternalIds,
  clearClaimsForSource,
  judgeTombstones,
  listClaimedExternalIds,
  pruneUncontestedClaims,
  recordDeletionClaims,
  recordPresenceClaims,
  recordRestorerOmissions,
  type RestorerSnapshot,
} from "./ReplicaDeletionClaimRepository.js";
import {
  setSyncState,
  getWipeEpoch,
  bumpWipeEpoch,
  resetSiblingMemberCursors,
} from "./SyncStateRepository.js";
import { markSourceStatsDirty } from "./SourceStatsRepository.js";
import {
  applySnapshotAbsencePlan,
  clearDocumentAbsencesForArrivals,
  enqueueDocumentCascade,
  type AbsenceCascade,
  type SnapshotAbsencePlan,
  observationSpacingMs,
  type SnapshotAbsencePolicy,
} from "./AbsenceRepository.js";
import { findRemovedSourceIds } from "./SourceRepository.js";
import { retractAliasAssertions } from "./PersonAliasRepository.js";
import { deleteSourceWatermark, upsertSourceWatermark } from "./WatermarkRepository.js";
import type { UrlCanonicalizerSpec, EdgeDeclaration } from "@omnesis/core";

const log = createLogger("gateway:documents");
import type {
  DocumentTemporalProjectionSpec,
  SourceWatermark,
  SyncCursor,
} from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";
import type {
  ListDocumentsOptions,
  ListedDocumentRow,
  UpsertDocumentsOptions,
  UpsertDocumentsResult,
  LatestActivity,
  RecentDocument,
} from "../types.js";

/**
 * Threshold above which a single doc is "huge" enough to deserve its own
 * chunk — measured in bytes of `content`. Full-page captures hit this
 * routinely. At 1MB+
 * the per-row write cost (17 indexes + multi-page TEXT blob) dwarfs
 * the per-fsync cost, so isolating the heavy row keeps siblings'
 * chunks fast.
 */
const HUGE_DOC_CONTENT_BYTES = 1_000_000;

/**
 * Writer-ready document. URL canonicalization is deliberately completed
 * before the document crosses into the single writer worker: source rules use
 * RE2 and neither regex compilation nor matching belongs on that thread.
 */
export type PreparedDocumentInput = DocumentInput & { preparedSourceUrl?: string | null };

export function prepareDocumentsForWrite(
  documents: readonly PreparedDocumentInput[],
  canonicalizers?: ReadonlyMap<string, UrlCanonicalizerSpec>,
): PreparedDocumentInput[] {
  return documents.map((document) => ({
    ...document,
    // Always overwrite a same-named wire field. Document schemas deliberately
    // preserve unknown fields, so trusting an existing value would let an
    // ingest caller choose the materialized URL independently of metadata.
    preparedSourceUrl: document.metadata.sourceUrl
      ? normalizeUrl(document.metadata.sourceUrl, canonicalizers)
      : null,
  }));
}

/**
 * Recompute the materialized `latest_*` columns on `source_stats` for one
 * source from the rows that currently survive in `documents`, then write
 * them back. Picks the freshest doc by `updated_at DESC, source_updated_at
 * DESC, id DESC` — the same ordering both ingest and the Sources-view
 * "Last activity" reader assume. When the source has no documents left
 * (e.g. its newest — or last — doc was just deleted) the columns are
 * cleared to NULL so `getLatestActivityBySource`'s `latest_doc_id IS NOT
 * NULL` filter drops the source instead of surfacing a deleted doc.
 *
 * Cheap: one `idx_documents_source_id_updated_at` seek + one PK-keyed
 * UPDATE. Runs on the writer handle inside the caller's transaction. The
 * UPDATE only touches an existing row — a source with no stats row yet
 * (never ingested) is a no-op, which is correct: there's nothing to
 * staleness-check.
 *
 * Necessary because the `latest_*` columns are NOT derived by the
 * backfill aggregation (`refreshSourceStatsRow`); only upsert and delete
 * paths maintain them, so every delete that can remove the freshest doc
 * must call this.
 */
export function refreshLatestActivity(db: Db, sourceId: string): void {
  const latest = db
    .prepare<
      [string],
      {
        id: string;
        title: string;
        source_created_at: string;
        source_updated_at: string;
        ingested_at: string;
        updated_at: string;
      }
    >(
      `SELECT id, title, source_created_at, source_updated_at, ingested_at, updated_at
         FROM documents
         WHERE source_id = ?
         ORDER BY updated_at DESC, source_updated_at DESC, id DESC
         LIMIT 1`,
    )
    .get(sourceId);
  db.prepare(
    `UPDATE source_stats
       SET latest_doc_id = ?,
           latest_title = ?,
           latest_source_created_at = ?,
           latest_source_updated_at = ?,
           latest_ingested_at = ?,
           latest_updated_at = ?
     WHERE source_id = ?`,
  ).run(
    latest?.id ?? null,
    latest?.title ?? null,
    latest?.source_created_at ?? null,
    latest?.source_updated_at ?? null,
    latest?.ingested_at ?? null,
    latest?.updated_at ?? null,
    sourceId,
  );
}

/**
 * Cached answer to "does `removed_documents` have any rows?". The single-
 * document privacy delete is rare, so the common install has an empty
 * tombstone table; this lets the hot upsert path skip the per-batch
 * lookup entirely instead of querying on every ingest. `null` = unknown
 * (reload lazily). Coherent because every writer to `removed_documents`
 * (tombstone insert, source-wipe clear) runs in the same single-writer
 * context as `upsertDocuments` and invalidates this cache.
 */
let tombstonePresenceCache: boolean | null = null;

function hasAnyTombstones(db: Db): boolean {
  if (tombstonePresenceCache === null) {
    tombstonePresenceCache =
      db.prepare("SELECT 1 FROM removed_documents LIMIT 1").get() !== undefined;
  }
  return tombstonePresenceCache;
}

/** Drop the cached presence flag after the tombstone table changes. */
function invalidateTombstoneCache(): void {
  tombstonePresenceCache = null;
}

/** Escape SQLite LIKE metacharacters (`%`, `_`, and the `\` escape char). */
function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Split incoming documents into those to write and those the user has
 * tombstoned via a single-document privacy delete (`DELETE /documents/:id`).
 * The tombstone is keyed on the natural `(provider_id, source_id, external_id)`
 * dedup key, so a re-sync or a re-capture of the same page is suppressed until
 * the whole source is removed & re-added (which clears the source's
 * tombstones). The suppressed keys are reported so a push client can learn
 * that its page was refused rather than stored. Returns the input array
 * unchanged — with zero query cost — on the common install that has never
 * deleted a document.
 */
function filterTombstonedDocuments<T extends DocumentInput>(
  db: Db,
  documents: T[],
  streams?: Readonly<Record<string, string>>,
): { kept: T[]; suppressed: Array<{ sourceId: string; externalId: string }> } {
  if (documents.length === 0 || !hasAnyTombstones(db)) return { kept: documents, suppressed: [] };
  const key = (providerId: string, sourceId: string, externalId: string): string =>
    `${providerId}\0${sourceId}\0${externalId}`;
  // Group external_ids by (provider, source) — a batch is usually one
  // source, so this collapses to a single indexed lookup per group.
  const byKey = new Map<
    string,
    { providerId: string; sourceId: string; streamId: string; ids: string[] }
  >();
  for (const d of documents) {
    const k = `${d.providerId}\0${d.sourceId}`;
    let group = byKey.get(k);
    if (!group) {
      group = {
        providerId: d.providerId,
        sourceId: d.sourceId,
        streamId: streams?.[d.sourceId] ?? "",
        ids: [],
      };
      byKey.set(k, group);
    }
    group.ids.push(d.externalId);
  }
  const removed = new Set<string>();
  const CHUNK = 500;
  for (const group of byKey.values()) {
    for (let i = 0; i < group.ids.length; i += CHUNK) {
      const chunk = group.ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = db
        .prepare<
          unknown[],
          { external_id: string }
        >(`SELECT external_id FROM removed_documents WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND external_id IN (${placeholders})`)
        .all(group.providerId, group.sourceId, group.streamId, ...chunk);
      for (const r of rows) removed.add(key(group.providerId, group.sourceId, r.external_id));
    }
  }
  if (removed.size === 0) return { kept: documents, suppressed: [] };
  const kept: T[] = [];
  const suppressed: Array<{ sourceId: string; externalId: string }> = [];
  for (const d of documents) {
    if (removed.has(key(d.providerId, d.sourceId, d.externalId))) {
      suppressed.push({ sourceId: d.sourceId, externalId: d.externalId });
    } else {
      kept.push(d);
    }
  }
  return { kept, suppressed };
}

function filterRemovedSourceDocuments<T extends DocumentInput>(db: Db, documents: T[]): T[] {
  if (documents.length === 0) return documents;
  const sourceIds = [...new Set(documents.map((document) => document.sourceId))];
  const removed = findRemovedSourceIds(db, sourceIds);
  return removed.size === 0
    ? documents
    : documents.filter((document) => !removed.has(document.sourceId));
}

export function upsertDocuments(
  db: Db,
  documents: PreparedDocumentInput[],
  options: UpsertDocumentsOptions = {},
  canonicalizers?: ReadonlyMap<string, UrlCanonicalizerSpec>,
): UpsertDocumentsResult {
  for (const document of documents) {
    if (options.replicaVersionPolicies?.[document.sourceId] !== "source-updated-at") continue;
    const canonical = (() => {
      try {
        return new Date(document.sourceUpdatedAt).toISOString() === document.sourceUpdatedAt;
      } catch {
        return false;
      }
    })();
    if (!canonical) {
      throw new Error(
        `replica source version for ${document.sourceId}/${document.externalId} must be canonical UTC ISO 8601`,
      );
    }
  }
  const rejectedSourceIds = options.writeEpochs
    ? [...new Set(documents.map((document) => document.sourceId))].filter((sourceId) =>
        writeEpochIsRejected(
          db,
          sourceId,
          options.writeEpochs?.[sourceId],
          options.cursorRows?.[sourceId] ?? "",
        ),
      )
    : [];
  if (rejectedSourceIds.length > 0) {
    return {
      remaining: [],
      rejectedSourceIds,
      ignoredReplicaDocuments: [],
      suppressedDocuments: [],
      acceptedDocumentCount: 0,
    };
  }

  // Privacy-delete suppression (#1065). Drop any incoming doc the user has
  // tombstoned via `DELETE /documents/:id` BEFORE it can be re-inserted —
  // this is the durable choke point both the collector sync path
  // (`upsertWithCursor`) and the push-source ingest path (`POST /documents`)
  // funnel through. Inert (no query) when no document has ever been deleted.
  const tombstoned = filterTombstonedDocuments(db, documents, options.streams);
  const suppressedDocuments = tombstoned.suppressed;
  documents = filterRemovedSourceDocuments(db, tombstoned.kept);

  const stmt = db.prepare(`
    INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, partition_key, title, content, content_hash, extracted_content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at, source_url)
    VALUES ($id, $provider_id, $source_id, $external_id, $stream_id, $partition_key, $title, $content, $content_hash, $extracted_content_hash, $metadata, $source_created_at, $source_updated_at, $ingested_at, $updated_at, $source_url)
    ON CONFLICT(provider_id, source_id, external_id, stream_id) DO UPDATE SET
      title = excluded.title,
      content = excluded.content,
      content_hash = excluded.content_hash,
      extracted_content_hash = excluded.extracted_content_hash,
      metadata = excluded.metadata,
      source_updated_at = excluded.source_updated_at,
      updated_at = excluded.updated_at,
      source_url = excluded.source_url,
      -- A document that moved between the source's partitions is the same
      -- document in a new place, so the latest read wins. It has to be
      -- updated rather than left: a stale key would keep a moved document
      -- inside a claim that no longer names it, and the claim's sweep would
      -- delete it for having left.
      partition_key = excluded.partition_key,
      -- Clear derived-state markers when *anything* their inputs depend on
      -- changed. Link extraction reads from content + metadata.extra.{links,
      -- threadId, parentExternalId} AND from extracted_content_hash (drives
      -- the duplicate-content cross-source dedup); people resolution reads
      -- from metadata.people. The extracted-hash comparison uses IS NOT so
      -- the NULL to value transition during migration also invalidates.
      links_extracted_at = CASE
        WHEN excluded.content_hash != documents.content_hash THEN NULL
        WHEN excluded.metadata != documents.metadata THEN NULL
        WHEN excluded.extracted_content_hash IS NOT documents.extracted_content_hash THEN NULL
        ELSE documents.links_extracted_at END,
      people_resolved_at = CASE
        WHEN excluded.content_hash != documents.content_hash THEN NULL
        WHEN excluded.metadata != documents.metadata THEN NULL
        ELSE documents.people_resolved_at END,
      -- Date extraction reads only the document content, so re-extract
      -- solely on content change. Its anchor prefers source_updated_at; a
      -- metadata-only upsert can therefore shift the anchor without a
      -- re-extraction — adopted years may lag until the next content change,
      -- an accepted staleness.
      dates_extracted_at = CASE
        WHEN excluded.content_hash != documents.content_hash THEN NULL
        ELSE documents.dates_extracted_at END
    WHERE (
        -- A move between the source's partitions is not a version conflict,
        -- so the replica policy does not get to arbitrate it. Without this the
        -- clause below is inert for a replicated source: a pure move leaves
        -- every version input identical, so the policy comparison finds them
        -- equal rather than newer, and the row keeps the partition it left —
        -- where a claim would omit it and sweep it for having moved.
        excluded.partition_key IS NOT documents.partition_key
        OR $replica_version_policy = 0
        OR julianday(excluded.source_updated_at) > julianday(documents.source_updated_at)
        OR (
          julianday(documents.source_updated_at) IS NULL
          AND julianday(excluded.source_updated_at) IS NOT NULL
        )
        OR (
          julianday(excluded.source_updated_at) = julianday(documents.source_updated_at)
          AND (
            excluded.content_hash,
            excluded.title,
            excluded.metadata,
            COALESCE(excluded.extracted_content_hash, ''),
            COALESCE(excluded.source_url, '')
          ) > (
            documents.content_hash,
            documents.title,
            documents.metadata,
            COALESCE(documents.extracted_content_hash, ''),
            COALESCE(documents.source_url, '')
          )
        )
      )
      AND (
        excluded.content_hash != documents.content_hash
        OR excluded.title != documents.title
        OR excluded.source_updated_at IS NOT documents.source_updated_at
        OR excluded.metadata != documents.metadata
        OR excluded.extracted_content_hash IS NOT documents.extracted_content_hash
        -- A move between the source's partitions changes nothing about the
        -- document's content, so without this the row is left untouched and
        -- keeps the partition it left. A claim on that partition would then
        -- omit it — correctly, it is no longer there — and sweep it, deleting
        -- a document that exists because it moved.
        OR excluded.partition_key IS NOT documents.partition_key
      )
  `);
  const exactReplicaStmt = db.prepare<
    [string, string, string, string, string, string, string, string | null, string, string | null],
    { found: number }
  >(`
    SELECT 1 AS found FROM documents
     WHERE provider_id = ? AND source_id = ? AND external_id = ? AND stream_id = ?
       AND title = ? AND content_hash = ? AND metadata = ?
       AND extracted_content_hash IS ? AND source_updated_at = ? AND source_url IS ?
  `);

  const now = new Date().toISOString();
  const documentTemporalProjection = options.documentTemporalProjection;

  let absencePlanScope = options.absencePlanScope;
  let absencePlanInvalidated = false;
  const ignoredReplicaDocuments: Array<{ sourceId: string; externalId: string }> = [];
  let acceptedDocumentCount = 0;
  const insertMany = db.transaction((docs: PreparedDocumentInput[]) => {
    const acceptedDocuments: PreparedDocumentInput[] = [];
    for (const doc of docs) {
      if (documentTemporalProjection && doc.sourceId !== documentTemporalProjection.sourceId) {
        throw new Error(
          `Document temporal projection declaration for ${documentTemporalProjection.sourceId} cannot be applied to ${doc.sourceId}`,
        );
      }
      const streamId = options.streams?.[doc.sourceId] ?? "";
      const metadata = documentsMetadataCodec.serialize(doc.metadata as DocumentsMetadata);
      const sourceUrl =
        doc.preparedSourceUrl !== undefined
          ? doc.preparedSourceUrl
          : doc.metadata.sourceUrl
            ? normalizeUrl(doc.metadata.sourceUrl, canonicalizers)
            : null;
      const stored = stmt.run({
        id: randomUUID(),
        provider_id: doc.providerId,
        source_id: doc.sourceId,
        external_id: doc.externalId,
        stream_id: streamId,
        partition_key: doc.partitionKey ?? "",
        title: doc.title,
        content: doc.content,
        content_hash: doc.contentHash,
        extracted_content_hash: doc.extractedContentHash ?? null,
        metadata,
        source_created_at: doc.sourceCreatedAt,
        source_updated_at: doc.sourceUpdatedAt,
        ingested_at: now,
        updated_at: now,
        source_url: sourceUrl,
        replica_version_policy:
          options.replicaVersionPolicies?.[doc.sourceId] === "source-updated-at" ? 1 : 0,
      });
      if (
        options.replicaVersionPolicies?.[doc.sourceId] === "source-updated-at" &&
        stored.changes === 0
      ) {
        const exact = exactReplicaStmt.get(
          doc.providerId,
          doc.sourceId,
          doc.externalId,
          streamId,
          doc.title,
          doc.contentHash,
          metadata,
          doc.extractedContentHash ?? null,
          doc.sourceUpdatedAt,
          sourceUrl,
        );
        if (!exact) {
          ignoredReplicaDocuments.push({ sourceId: doc.sourceId, externalId: doc.externalId });
          continue;
        }
      }
      acceptedDocumentCount += 1;
      acceptedDocuments.push(doc);
      if (documentTemporalProjection) {
        // The document is what this transaction exists to store; its temporal
        // projections are metadata derived from it. Anything that goes wrong
        // deriving or writing them costs those projections and nothing else.
        //
        // Without this the cost is wildly out of proportion to the fault: the
        // page is rejected, so the sync cursor never advances, so the next
        // cycle re-fetches the same page and fails identically, and the account
        // stops ingesting for good. One unusable date is worth a log line, not
        // a stalled mailbox.
        try {
          replaceDocumentTemporalProjections(
            db,
            doc,
            documentTemporalProjection.specs,
            now,
            streamId,
          );
        } catch (error) {
          log.warn(
            `Skipped temporal projections for ${doc.sourceId} ${doc.externalId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    // Every document that reached the insert is this member's word that its
    // replica holds the item — a row the version policy declined included,
    // since the claim is about presence, not about which version won. The
    // privacy-deleted and removed-source rows filtered out above never get
    // here, so they vouch for nothing.
    if (options.replicaClaimant && docs.length > 0) {
      const bySource = new Map<string, { providerId: string; externalIds: string[] }>();
      for (const doc of docs) {
        const group = bySource.get(doc.sourceId);
        if (group) group.externalIds.push(doc.externalId);
        else
          bySource.set(doc.sourceId, { providerId: doc.providerId, externalIds: [doc.externalId] });
      }
      const at = Date.now();
      for (const [sourceId, group] of bySource) {
        recordPresenceClaims(
          db,
          group.providerId,
          sourceId,
          options.replicaClaimant.deviceId,
          group.externalIds,
          at,
        );
      }
    }
    const recovery = clearDocumentAbsencesForArrivals(db, docs, options.streams, absencePlanScope);
    if (recovery.expectedScopeInvalidated) {
      absencePlanScope = undefined;
      absencePlanInvalidated = true;
    } else {
      absencePlanScope = recovery.expectedScope;
    }
    return acceptedDocuments;
  });

  // Per-source stats maintenance. We want readers (`/portal/*`, `cli
  // status`) to see fresh doc counts without doing the full
  // `SUM(LENGTH(content+title+metadata))` scan on the HTTP thread each
  // time ingestion marks a row dirty. Strategy:
  //
  //   1. Update `doc_count` inline via a cheap indexed `COUNT(*) WHERE
  //      source_id = ?` — ~50ms even on 146k-row sources because
  //      idx_documents_source covers it.
  //   2. Mark `needs_refresh = 1` so the backfill worker reconciles the
  //      heavier fields (data_size_bytes, total_units, date range) off
  //      the main thread.
  //   3. Brand-new sources get a one-shot full refresh so the row
  //      exists with real numbers before any reader arrives.
  const countStmt = db.prepare<[string], { count: number }>(
    "SELECT COUNT(*) AS count FROM documents WHERE source_id = ?",
  );
  /** Run the per-touched-source stats updates for one chunk's worth of docs. */
  const updateStatsForChunk = (chunk: DocumentInput[]) => {
    const touched = new Set<string>();
    for (const doc of chunk) touched.add(doc.sourceId);
    for (const sid of touched) {
      const exists = db.prepare("SELECT 1 FROM source_stats WHERE source_id = ?").get(sid);
      if (!exists) {
        // First time we see this source: insert a lightweight placeholder
        // (doc_count from the cheap COUNT(*), needs_refresh=1, everything
        // else default) and let the backfill worker pick it up off-thread
        // for the heavy SUM(LENGTH) + MIN/MAX scan. The brand-new-source
        // UX shows `data_size_bytes=0` until the first backfill tick (a
        // few seconds), which is acceptable. Pre-fix this aggregation
        // ran inline inside the writer transaction, blocking ingest on
        // sources that arrive with a backlog already in `documents`.
        const newCount = countStmt.get(sid)?.count ?? 0;
        db.prepare(
          `INSERT INTO source_stats (source_id, doc_count, needs_refresh, dirty_version)
           VALUES (?, ?, 1, 0)
           ON CONFLICT(source_id) DO UPDATE SET
             doc_count = excluded.doc_count,
             needs_refresh = 1,
             dirty_version = source_stats.dirty_version + 1`,
        ).run(sid, newCount);
      } else {
        const newCount = countStmt.get(sid)?.count ?? 0;
        // Bump dirty_version so a parallel split-path compute that started
        // before this upsert lands knows to discard its now-stale snapshot.
        db.prepare(
          "UPDATE source_stats SET doc_count = ?, needs_refresh = 1, dirty_version = dirty_version + 1 WHERE source_id = ?",
        ).run(newCount, sid);
      }
      // Re-query the freshest surviving doc and write the latest_*
      // columns. Necessary because we need the ACTUAL ingested_at from
      // the documents row (which the upsert preserves on UPDATE — only
      // updated_at advances), not the input doc's would-be ingested_at.
      // Cheap — uses idx_documents_source_id_updated_at, sub-ms each,
      // uncontended on the writable handle.
      refreshLatestActivity(db, sid);
    }
  };

  // Without a token: fast path identical to pre-Phase-3 behavior — one
  // big transaction over all docs, then stats updates. Backward
  // compatible with `directWriteGate` test callers + every existing
  // unit test.
  const token = options.token;
  if (!token) {
    const acceptedDocuments = insertMany(documents);
    updateStatsForChunk(acceptedDocuments);
    return {
      remaining: [],
      rejectedSourceIds: [],
      ignoredReplicaDocuments,
      suppressedDocuments,
      acceptedDocumentCount,
      ...(absencePlanScope === undefined ? {} : { absencePlanScope }),
      ...(absencePlanInvalidated ? { absencePlanInvalidated: true } : {}),
    };
  }

  // Yieldable path: one transaction per chunk; between chunks, poll
  // the preempt token. If a higher-priority op is waiting, return the
  // unprocessed tail as `remaining` — the Scheduler re-enqueues this
  // task at the same priority and the higher-priority op runs first.
  // Per-chunk stats updates run after each chunk's commit, so a yield
  // mid-batch leaves source_stats consistent with what's actually in
  // the documents table at that point.
  //
  // Default chunkSize=5 so a 20-document batch hits four yield checks per
  // call; this was 25, which exceeded a typical batch.
  const chunkSize = options.chunkSize ?? 5;
  let processed = 0;
  while (processed < documents.length) {
    const end = nextChunkEnd(documents, processed, chunkSize);
    const chunk = documents.slice(processed, end);
    const acceptedDocuments = insertMany(chunk);
    updateStatsForChunk(acceptedDocuments);
    processed = end;
    if (processed < documents.length && token.requested()) {
      return {
        remaining: documents.slice(processed),
        rejectedSourceIds: [],
        ignoredReplicaDocuments,
        suppressedDocuments,
        acceptedDocumentCount,
        ...(absencePlanScope === undefined ? {} : { absencePlanScope }),
        ...(absencePlanInvalidated ? { absencePlanInvalidated: true } : {}),
      };
    }
  }
  return {
    remaining: [],
    rejectedSourceIds: [],
    ignoredReplicaDocuments,
    suppressedDocuments,
    acceptedDocumentCount,
    ...(absencePlanScope === undefined ? {} : { absencePlanScope }),
    ...(absencePlanInvalidated ? { absencePlanInvalidated: true } : {}),
  };
}

/**
 * Where the next yieldable chunk ends.
 *
 * A huge document takes a chunk to itself: one 1MB+ TEXT body plus its 17
 * secondary-index updates is already heavy enough that bundling it with
 * siblings pushes the chunk's wall time past the per-yield budget. Its
 * ordinary siblings keep batching up to `chunkSize`, so one fat row in a page
 * cannot multiply the per-chunk stats maintenance (a COUNT(*) over the source
 * and a latest-activity refresh, plus an fsync'd commit) across the whole page.
 */
function nextChunkEnd(
  documents: readonly PreparedDocumentInput[],
  start: number,
  chunkSize: number,
): number {
  if (documents[start].content.length >= HUGE_DOC_CONTENT_BYTES) return start + 1;
  const limit = Math.min(start + chunkSize, documents.length);
  let end = start + 1;
  while (end < limit && documents[end].content.length < HUGE_DOC_CONTENT_BYTES) end += 1;
  return end;
}

/**
 * Delete documents by `(providerId, sourceId, externalId)` and return the
 * matching document IDs. The caller cascades those IDs to the index
 * database (`chunks`, `indexed_documents`) — `omnesis.db` and `index.db`
 * are separate SQLite files so the cascade can't be a pure FK / trigger;
 * the writer worker hands the IDs back, the HTTP handler completes the
 * index-side cleanup. Without this, deleted docs lingered in search for
 * up to one full reconcile interval (1h). When `expectedWipeEpoch` is set,
 * the single writer checks it before deleting so a stale snapshot cannot
 * remove documents inserted after a source wipe.
 */
/**
 * IN-list chunk for `deleteDocuments`, sized to stay within SQLite's
 * per-statement variable limit. Also the natural per-writer-op batch for
 * callers that spread a large delete across several ops (the off-writer
 * snapshot reconcile) — one chunk is one bounded statement pair.
 */
export const DELETE_IN_LIST_CHUNK = 500;

export function deleteDocuments(
  db: Db,
  providerId: string,
  sourceId: string,
  externalIds: string[],
  expectedWipeEpoch?: number,
  cursorRow = "",
  streamId = "",
  enqueueCascade = false,
): string[] {
  if (
    externalIds.length === 0 ||
    (expectedWipeEpoch !== undefined && getWipeEpoch(db, sourceId, cursorRow) !== expectedWipeEpoch)
  ) {
    return [];
  }
  const deletedIds: string[] = [];
  for (let i = 0; i < externalIds.length; i += DELETE_IN_LIST_CHUNK) {
    const chunk = externalIds.slice(i, i + DELETE_IN_LIST_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    // Capture doc.id BEFORE the DELETE so the caller has them to
    // cascade. The writer worker's single-writer transaction context
    // means no row can vanish between the SELECT and the DELETE.
    const rows = db.transaction(() => {
      const matches = db
        .prepare<
          unknown[],
          { id: string }
        >(`SELECT id FROM documents WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND external_id IN (${placeholders})`)
        .all(providerId, sourceId, streamId, ...chunk);
      purgeDocumentAnnotations(
        db,
        matches.map((row) => row.id),
      );
      db.prepare(
        `DELETE FROM documents WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND external_id IN (${placeholders})`,
      ).run(providerId, sourceId, streamId, ...chunk);
      if (enqueueCascade)
        enqueueDocumentCascade(
          db,
          matches.map((row) => row.id),
        );
      return matches;
    })();
    for (const r of rows) deletedIds.push(r.id);
  }
  markSourceStatsDirty(db, sourceId);
  // The heavy aggregation (`refreshSourceStatsRow`) does NOT touch the
  // materialized latest_* columns, so a delete that removed this source's
  // freshest doc would otherwise leave latest_doc_id pointing at a row
  // that no longer exists — getLatestActivityBySource would surface a
  // deleted doc. Recompute from the survivors (or clear when none remain).
  refreshLatestActivity(db, sourceId);
  // documents.id has ON DELETE CASCADE on document_links.source_doc_id,
  // so the row count in `document_links` shifts with every document
  // delete. Invalidate the materialized link_stats so the next
  // refresh picks up the change.
  if (deletedIds.length > 0) {
    markLinkStatsDirty(db);
    // document_people CASCADE-deletes too — interaction-score numerator
    // and denominator both shift, so every consumer-side score is stale.
    markPeopleGraphDirty(db);
    // Same cascade can wipe the aliases that anchored merge rules, so
    // merge-rule eval may need to unmerge people whose anchor went away.
    markMergeRulesDirty(db);
  }
  return deletedIds;
}

/** Retract grounded loops and mirrors atomically, recording mirror index cleanup. */
export function cascadeOpenLoopPrivacyDeleteWithMirrors(
  db: Db,
  deletedDocIds: readonly string[],
): { deletedLoopIds: string[]; deletedBriefIds: string[] } {
  return db.transaction(() => {
    const loopIds = listLoopIdsCitingDocs(db, deletedDocIds);
    if (loopIds.length > 0) {
      deleteDocuments(
        db,
        OPEN_LOOP_PROVIDER_ID,
        OPEN_LOOP_SOURCE_ID,
        loopIds,
        undefined,
        "",
        "",
        true,
      );
    }
    return cascadeOpenLoopPrivacyDelete(db, deletedDocIds, loopIds);
  })();
}

/**
 * Delete documents by their internal id, with the same derived-store
 * bookkeeping `deleteDocuments` does.
 *
 * The absence sweep addresses its victims this way because it holds the exact
 * rows an absence was recorded against: a `(source, stream, external_id)` key
 * can be re-created by a re-bootstrap between the sweep's read and its write,
 * and would then name a different, live row. An id cannot.
 */
export function deleteDocumentsByIds(db: Db, documentIds: readonly string[]): string[] {
  if (documentIds.length === 0) return [];
  const deletedIds: string[] = [];
  const sourceIds = new Set<string>();
  for (let i = 0; i < documentIds.length; i += DELETE_IN_LIST_CHUNK) {
    const chunk = documentIds.slice(i, i + DELETE_IN_LIST_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    // Capture the rows BEFORE the DELETE so the caller has the ids to cascade
    // and this function knows which sources' derived stores went stale.
    const rows = db.transaction(() => {
      const matches = db
        .prepare<
          unknown[],
          { id: string; source_id: string }
        >(`SELECT id, source_id FROM documents WHERE id IN (${placeholders})`)
        .all(...chunk);
      purgeDocumentAnnotations(
        db,
        matches.map((row) => row.id),
      );
      db.prepare(`DELETE FROM documents WHERE id IN (${placeholders})`).run(...chunk);
      return matches;
    })();
    for (const r of rows) {
      deletedIds.push(r.id);
      sourceIds.add(r.source_id);
    }
  }
  if (deletedIds.length === 0) return [];
  for (const sourceId of sourceIds) {
    markSourceStatsDirty(db, sourceId);
    // The materialized latest_* columns can point at a row this delete just
    // removed; recompute them from the survivors.
    refreshLatestActivity(db, sourceId);
  }
  // documents.id cascades into document_links and document_people, so the link
  // graph and every per-person interaction score shifted.
  markLinkStatsDirty(db);
  markPeopleGraphDirty(db);
  markMergeRulesDirty(db);
  return deletedIds;
}

/** Annotations retain verbatim source text, including superseded audit rows.
 * Purge them inside the document's writer transaction so every deletion path
 * removes that text and an in-flight annotation write cannot race the purge. */
function purgeDocumentAnnotations(db: Db, documentIds: readonly string[]): void {
  cascadeAnnotationPrivacyDelete(db, documentIds);
  cascadePersonAnnotationPrivacyDelete(db, documentIds);
}

/**
 * Record privacy-delete tombstones for a set of `(provider, source,
 * external_id)` keys so the upsert path suppresses their re-creation.
 * Re-deleting preserves the first known document id while leaving the
 * tombstone active.
 */
export function tombstoneDocuments(
  db: Db,
  providerId: string,
  sourceId: string,
  externalIds: string[],
  originalDocumentIds?: ReadonlyMap<string, string>,
  streamId = "",
): void {
  if (externalIds.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO removed_documents
       (provider_id, source_id, stream_id, external_id, removed_at, original_document_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, source_id, external_id, stream_id) DO UPDATE SET
       original_document_id =
         COALESCE(removed_documents.original_document_id, excluded.original_document_id)`,
  );
  const now = Date.now();
  for (const externalId of externalIds) {
    stmt.run(
      providerId,
      sourceId,
      streamId,
      externalId,
      now,
      originalDocumentIds?.get(externalId) ?? null,
    );
  }
  invalidateTombstoneCache();
  // The operator's own delete overrides any disagreement between replicas.
  clearClaimsForExternalIds(db, providerId, sourceId, externalIds);
}

/**
 * User-initiated single-document privacy delete (`DELETE /documents/:id`,
 * #1065). Unlike `deleteDocuments` (the collector's sync-reconcile path,
 * which removes a doc only because it vanished upstream), this:
 *
 *   1. Cascades to the document's extracted-attachment child docs
 *      (`<external_id>/att/<attachmentId>`) — the user expects "this
 *      document and its parts gone", not orphaned attachment rows.
 *   2. With `tombstone` (the default) writes a durable tombstone per deleted
 *      key so a later re-sync or re-capture can't resurrect the page. Without
 *      it only this copy goes: the source is free to bring the page back.
 *
 * Returns the deleted internal `document_id`s for the caller's index-side
 * cascade (`chunks` / `indexed_documents` live in a separate SQLite file).
 */
export function deleteDocumentForUser(
  db: Db,
  providerId: string,
  sourceId: string,
  externalId: string,
  streamId = "",
  tombstone = true,
): string[] {
  // Expand to the attachment children co-ingested under this parent. The
  // suffix match is anchored on the literal `/att/`; LIKE metacharacters
  // in the external_id (URLs carry `_`, `%`) are escaped so it can't
  // over-select an unrelated doc.
  const childPattern = `${escapeLikePattern(externalId)}/att/%`;
  const children = db
    .prepare<[string, string, string, string], { external_id: string }>(
      `SELECT external_id FROM documents WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND external_id LIKE ? ESCAPE '\\'`,
    )
    .all(providerId, sourceId, streamId, childPattern)
    .map((r) => r.external_id);
  const allExternalIds = [externalId, ...children];
  const originalDocumentIds = new Map(
    db
      .prepare<unknown[], { external_id: string; id: string }>(
        `SELECT external_id, id
           FROM documents
          WHERE provider_id = ? AND source_id = ? AND stream_id = ?
            AND external_id IN (${allExternalIds.map(() => "?").join(", ")})`,
      )
      .all(providerId, sourceId, streamId, ...allExternalIds)
      .map((row) => [row.external_id, row.id] as const),
  );
  // Reuse the snapshot-reconcile delete primitive: it removes the rows,
  // FK-cascades document_links / document_people / near_dup_* /
  // pending_edges, and marks every dependent aggregate dirty.
  const deletedIds = deleteDocuments(
    db,
    providerId,
    sourceId,
    allExternalIds,
    undefined,
    "",
    streamId,
  );
  if (tombstone) {
    tombstoneDocuments(db, providerId, sourceId, allExternalIds, originalDocumentIds, streamId);
  }
  // Privacy cascade into the Briefs / Cognition Steward feature: loops and briefs
  // derived from a privacy-deleted document are deleted with it, and the
  // cascaded loops' mirrored `open-loop` corpus docs (external id = loop
  // id) go too. No tombstones for those mirrors — nothing re-syncs them.
  const cascade = cascadeOpenLoopPrivacyDelete(db, deletedIds);
  if (cascade.deletedLoopIds.length > 0) {
    deletedIds.push(
      ...deleteDocuments(db, OPEN_LOOP_PROVIDER_ID, OPEN_LOOP_SOURCE_ID, cascade.deletedLoopIds),
    );
  }
  return deletedIds;
}

/**
 * Delete exactly one activity-trace document while retention is in progress.
 *
 * Unlike the user privacy delete, this does not expand attachment children.
 * Durable annotations can cite activity traces and are purged by the shared
 * document deletion primitive, including their superseded audit text. The
 * temporary tombstone closes the crash window while the index sidecar is
 * cleaned; the caller removes it immediately before unlinking the transcript.
 */
export function deleteDocumentForRetention(
  db: Db,
  providerId: string,
  sourceId: string,
  externalId: string,
): string | null {
  return db.transaction(() => {
    const existing = db
      .prepare<
        [string, string, string],
        { id: string }
      >("SELECT id FROM documents WHERE provider_id = ? AND source_id = ? AND external_id = ?")
      .get(providerId, sourceId, externalId);
    if (!existing) {
      return (
        db
          .prepare<[string, string, string], { original_document_id: string | null }>(
            `SELECT original_document_id
               FROM removed_documents
              WHERE provider_id = ? AND source_id = ? AND external_id = ?`,
          )
          .get(providerId, sourceId, externalId)?.original_document_id ?? null
      );
    }
    deleteDocuments(db, providerId, sourceId, [externalId]);
    tombstoneDocuments(
      db,
      providerId,
      sourceId,
      [externalId],
      new Map([[externalId, existing.id]]),
    );
    return existing.id;
  })();
}

/** Clear the one temporary activity-retention tombstone after index cleanup. */
export function completeDocumentRetention(
  db: Db,
  providerId: string,
  sourceId: string,
  externalId: string,
): void {
  db.prepare(
    "DELETE FROM removed_documents WHERE provider_id = ? AND source_id = ? AND external_id = ?",
  ).run(providerId, sourceId, externalId);
  invalidateTombstoneCache();
}

/**
 * Delete all documents for a specific source.
 * Also removes the source's sync state.
 * Returns the number of documents deleted.
 */
export function deleteAllBySource(db: Db, sourceId: string): number {
  // Count first — db.run().changes includes cascaded FK deletions
  const countRow = db
    .prepare<
      [string],
      { count: number }
    >("SELECT COUNT(*) as count FROM documents WHERE source_id = ?")
    .get(sourceId);
  const count = countRow?.count ?? 0;
  db.prepare("DELETE FROM documents WHERE source_id = ?").run(sourceId);
  db.prepare("DELETE FROM document_absence_scopes WHERE source_id = ?").run(sourceId);
  db.prepare("DELETE FROM document_absence_observations WHERE source_id = ?").run(sourceId);
  clearClaimsForSource(db, sourceId);
  db.prepare("DELETE FROM sync_state WHERE source_id = ?").run(sourceId);
  // Projection registration follows the source's sync state (no FK — see
  // document-storage.ts).
  db.prepare("DELETE FROM document_temporal_projection_sources WHERE source_id = ?").run(sourceId);
  deleteSourceWatermark(db, sourceId);
  // Bump the wipe epoch so an in-flight sync that started before this delete
  // can't resurrect its stale cursor onto the now-empty source (#551).
  bumpWipeEpoch(db, sourceId);
  db.prepare("DELETE FROM source_stats WHERE source_id = ?").run(sourceId);
  // Wipe also CASCADE-deletes every document_links row owned by the
  // source's docs. Invalidate link_stats so the next refresh sees
  // the smaller graph.
  if (count > 0) {
    markLinkStatsDirty(db);
    // document_people CASCADE wipes per-person edges too — the
    // interaction-score numerator AND denominator both moved.
    markPeopleGraphDirty(db);
    markMergeRulesDirty(db);
  }
  // person_aliases is keyed by (person_id, alias) with no FK on source_id —
  // a source removal would otherwise leave behind alias rows attributing
  // every alias the source contributed to a now-deleted source. Clean
  // those up explicitly, then sweep any `people` rows that lost ALL
  // their aliases. We DON'T also gate on `document_people` here:
  // a person with zero aliases is a ghost (can't be matched to future
  // mentions; appears in /people/search with alias_count=0 and clutters
  // the UI). If a doc still references this person via document_people,
  // CASCADE on the people delete clears that row too — the doc loses
  // attribution to this ghost identity, which is correct since the
  // identity has nothing left to identify them.
  //
  // Preserve `is_self=TRUE` people unconditionally — losing self after
  // a source delete would corrupt the self identity. Preserve people
  // with `merged_into` set, since they're losers in a still-active
  // merge that hasn't been physically applied yet.
  retractAliasAssertions(db, sourceId);
  db.prepare(
    `DELETE FROM people
     WHERE is_self = FALSE
       AND merged_into IS NULL
       AND id NOT IN (SELECT DISTINCT person_id FROM person_aliases)`,
  ).run();
  // A full source wipe is the user-facing "remove & re-add" that resets
  // privacy-delete tombstones (#1065) — clear this source's so re-adding
  // it gives a clean slate.
  db.prepare("DELETE FROM removed_documents WHERE source_id = ?").run(sourceId);
  invalidateTombstoneCache();
  return count;
}

/** What a stream wipe removed; the ids feed the index and cognition cascades. */
export interface DeleteAllByStreamResult {
  deleted: number;
  documentIds: string[];
}

/**
 * Delete one device stream of a partitioned source: its documents (and,
 * through the `documents(id)` cascades, their links, people edges,
 * projections and evidence rows), its privacy-delete tombstones, and its
 * claim on the cursor row — the row's epoch advances so a sync of that
 * stream that began before the wipe cannot write its cursor back. The
 * source itself stays: sibling streams, the shared stream, the source's
 * stats row, watermark and projection registration are untouched, because
 * every one of them is still backed by the surviving streams. The
 * `person_aliases` rows stay as well: an alias belongs to the source, not
 * to a stream (the table has no stream column), and the siblings' documents
 * still resolve through it.
 * Returns the deleted document ids for the index and cognition cascades,
 * which live outside this database.
 */
export function deleteAllByStream(
  db: Db,
  sourceId: string,
  streamId: string,
): DeleteAllByStreamResult {
  return db.transaction((): DeleteAllByStreamResult => {
    const documentIds = db
      .prepare<[string, string], { id: string }>(
        "SELECT id FROM documents WHERE source_id = ? AND stream_id = ?",
      )
      .all(sourceId, streamId)
      .map((row) => row.id);
    db.prepare("DELETE FROM documents WHERE source_id = ? AND stream_id = ?").run(
      sourceId,
      streamId,
    );
    db.prepare("DELETE FROM document_absence_scopes WHERE source_id = ? AND stream_id = ?").run(
      sourceId,
      streamId,
    );
    db.prepare(
      "DELETE FROM document_absence_observations WHERE source_id = ? AND stream_id = ?",
    ).run(sourceId, streamId);
    db.prepare("DELETE FROM removed_documents WHERE source_id = ? AND stream_id = ?").run(
      sourceId,
      streamId,
    );
    bumpWipeEpoch(db, sourceId, streamId);
    markSourceStatsDirty(db, sourceId);
    // The survivors decide the source's latest activity now (see deleteDocuments).
    refreshLatestActivity(db, sourceId);
    if (documentIds.length > 0) {
      markLinkStatsDirty(db);
      markPeopleGraphDirty(db);
      markMergeRulesDirty(db);
    }
    invalidateTombstoneCache();
    return { deleted: documentIds.length, documentIds };
  })();
}

/**
 * Delete all documents for a specific provider (all its sources).
 * Also removes sync state for all affected sources.
 * Returns the number of documents deleted.
 */
export function deleteAllByProvider(db: Db, providerId: string): number {
  // Find affected source IDs for sync state cleanup
  const affectedSources = db
    .prepare<
      [string],
      { source_id: string }
    >("SELECT DISTINCT source_id FROM documents WHERE provider_id = ?")
    .all(providerId);

  // Count first — db.run().changes includes cascaded FK deletions (provider delete)
  const countRow = db
    .prepare<
      [string],
      { count: number }
    >("SELECT COUNT(*) as count FROM documents WHERE provider_id = ?")
    .get(providerId);
  const count = countRow?.count ?? 0;

  db.prepare("DELETE FROM documents WHERE provider_id = ?").run(providerId);
  db.prepare("DELETE FROM document_absence_scopes WHERE provider_id = ?").run(providerId);
  db.prepare("DELETE FROM document_absence_observations WHERE provider_id = ?").run(providerId);
  // Provider-wide wipe CASCADE-deletes every document_links row owned
  // by the provider's docs. Invalidate link_stats.
  if (count > 0) {
    markLinkStatsDirty(db);
    // document_people cascade — interaction-score graph reshuffled.
    markPeopleGraphDirty(db);
    markMergeRulesDirty(db);
  }

  // Provider ownership is not persisted for zero-document sources. Revoke
  // every known source lease conservatively so an in-flight page from a
  // zero-document source cannot survive this provider wipe. Unrelated cursors
  // stay intact; only their current in-flight attempt retries.
  const leaseSources = db
    .prepare<[], { source_id: string }>(
      `SELECT source_id FROM source_wipe_epoch
       UNION
       SELECT source_id FROM sync_state
       UNION
       SELECT id AS source_id FROM sources`,
    )
    .all();
  const leaseSourceIds = new Set([
    ...leaseSources.map((row) => row.source_id),
    ...affectedSources.map((row) => row.source_id),
  ]);
  for (const sourceId of leaseSourceIds) bumpWipeEpoch(db, sourceId);

  // Clean up sync state + person_aliases for every affected source. Same
  // reasoning as deleteAllBySource — alias rows have no FK on source_id.
  // Unlike deleteAllBySource, the source_stats rows are NOT removed here
  // (only the provider's documents are wiped), so each affected source's
  // latest_* would keep pointing at a now-deleted doc. Recompute clears
  // it to NULL since every doc for the source is gone.
  for (const row of affectedSources) {
    db.prepare("DELETE FROM sync_state WHERE source_id = ?").run(row.source_id);
    db.prepare("DELETE FROM document_temporal_projection_sources WHERE source_id = ?").run(
      row.source_id,
    );
    deleteSourceWatermark(db, row.source_id);
    retractAliasAssertions(db, row.source_id);
    refreshLatestActivity(db, row.source_id);
  }
  // Sweep orphan `people` whose last anchor (alias or document_people)
  // is gone after the provider-wide wipe.
  db.prepare(
    `DELETE FROM people
     WHERE id NOT IN (SELECT DISTINCT person_id FROM person_aliases)
       AND id NOT IN (SELECT DISTINCT person_id FROM document_people)`,
  ).run();

  // Clear privacy-delete tombstones (#1065) for every wiped source so a
  // provider-wide remove & re-add gives a clean slate.
  db.prepare("DELETE FROM removed_documents WHERE provider_id = ?").run(providerId);
  invalidateTombstoneCache();

  return count;
}

export function getDocumentCount(db: Db, sourceId: string): number {
  const row = db
    .prepare<
      [string],
      { count: number }
    >("SELECT COUNT(*) as count FROM documents WHERE source_id = ?")
    .get(sourceId);
  return row?.count ?? 0;
}

/**
 * Per-source "what's the most recent thing that actually changed?" lookup.
 * Used by the Sources view's `Last activity` column to surface a document
 * whenever a sync genuinely added or modified content — distinct from the
 * `Last sync` heartbeat, which fires on every poll regardless.
 *
 * Implementation: N small index seeks against `idx_documents_source_id_updated_at`,
 * one per source. With ~25 sources and a warm WAL, total cost stays under
 * ~1ms even at /status's 2s portal-poll cadence.
 *
 * Returns one entry per source that has at least one document. Sources
 * with zero docs (yet-to-sync, or pure-structured like Strava/Screen Time)
 * are absent from the map — callers fall back to "no activity" UX.
 */
export function getLatestActivityBySource(db: Db): Record<string, LatestActivity> {
  // Single PK-indexed scan over source_stats — the latest_*
  // columns are maintained inline by upsertDocuments. Pre-
  // materialization this required either N per-source LIMIT-1
  // queries OR one window-function scan over all 290k+ docs;
  // both took seconds under TRUNCATE journal-mode lock contention.
  const rows = db
    .prepare<
      [],
      {
        source_id: string;
        latest_doc_id: string | null;
        latest_title: string | null;
        latest_source_created_at: string | null;
        latest_ingested_at: string | null;
        latest_updated_at: string | null;
      }
    >(
      `SELECT source_id, latest_doc_id, latest_title, latest_source_created_at,
              latest_ingested_at, latest_updated_at
       FROM source_stats
       WHERE latest_doc_id IS NOT NULL`,
    )
    .all();

  const out: Record<string, LatestActivity> = {};
  for (const row of rows) {
    out[row.source_id] = {
      kind: "document",
      docId: row.latest_doc_id!,
      title: row.latest_title!,
      latestActivityAt: row.latest_updated_at!,
      sourceCreatedAt: row.latest_source_created_at!,
      ingestedAt: row.latest_ingested_at!,
      isNew: row.latest_ingested_at === row.latest_updated_at,
    };
  }
  return out;
}

/**
 * Get the most recent documents for a source, sorted by source_created_at DESC.
 */
export function getRecentDocuments(
  db: Db,
  sourceId: string,
  limit: number = 10,
  before?: { sourceCreatedAt: string; id: string },
): RecentDocument[] {
  const cursorPredicate = before
    ? "AND (document.source_created_at < ? OR (document.source_created_at = ? AND document.id < ?))"
    : "";
  const params: Array<string | number> = [sourceId];
  if (before) params.push(before.sourceCreatedAt, before.sourceCreatedAt, before.id);
  params.push(limit);
  return db
    .prepare<(string | number)[], RecentDocument>(
      `SELECT document.id, document.source_id, document.external_id,
              document.stream_id AS device_id, origin_device.name AS device_name,
              document.title, SUBSTR(document.content, 1, 150) AS content_preview,
              document.metadata, document.source_created_at, document.source_updated_at
       FROM documents AS document
       LEFT JOIN devices AS origin_device ON origin_device.id = document.stream_id
       WHERE document.source_id = ?
         ${cursorPredicate}
       ORDER BY document.source_created_at DESC, document.id DESC
       LIMIT ?`,
    )
    .all(...params);
}

export function listDocuments(
  db: Db,
  options: ListDocumentsOptions = {},
): { documents: ListedDocumentRow[]; hasMore: boolean } {
  const { updatedSince, excludeSourceIds, includeSourceIds, afterId } = options;
  const limit = options.limit ?? 100;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (updatedSince) {
    conditions.push("updated_at >= ?");
    params.push(updatedSince);
  }

  if (excludeSourceIds && excludeSourceIds.length > 0) {
    const placeholders = excludeSourceIds.map(() => "?").join(", ");
    conditions.push(`source_id NOT IN (${placeholders})`);
    params.push(...excludeSourceIds);
  }

  if (includeSourceIds && includeSourceIds.length > 0) {
    const placeholders = includeSourceIds.map(() => "?").join(", ");
    conditions.push(`source_id IN (${placeholders})`);
    params.push(...includeSourceIds);
  }

  if (afterId) {
    conditions.push("id > ?");
    params.push(afterId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Force the covering (updated_at, id) index when we have a watermark
  // *and no positive source filter*. Without the directive, SQLite's
  // planner prefers the PK index (because ORDER BY id matches PK order
  // and the LIMIT is small), then walks every row looking for matches
  // on updated_at. On a 264k-doc DB with a now-adjacent watermark,
  // that's a 20s+ full scan even though the answer set is empty. With
  // INDEXED BY, the same query is <5ms.
  //
  // When `includeSourceIds` is supplied, the planner can pick
  // `idx_documents_source_id_updated_at` per
  // source-id and merge results — usually faster than the global
  // (updated_at, id) walk + temp B-tree sort needed to satisfy
  // ORDER BY id. Drop the directive in that case.
  const indexedBy =
    updatedSince && !(includeSourceIds && includeSourceIds.length > 0)
      ? "INDEXED BY idx_documents_updated_at_id"
      : "";

  // Fetch one extra to determine hasMore
  const sql = `SELECT id, source_id, title, content, content_hash, metadata, source_created_at, updated_at FROM documents ${indexedBy} ${where} ORDER BY id ASC LIMIT ?`;
  params.push(limit + 1);

  const rows = db
    .prepare<
      (string | number)[],
      {
        id: string;
        source_id: string;
        title: string;
        content: string;
        content_hash: string;
        metadata: string;
        source_created_at: string;
        updated_at: string;
      }
    >(sql)
    .all(...params);

  const hasMore = rows.length > limit;
  const documents: ListedDocumentRow[] = rows.slice(0, limit).map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    title: row.title,
    content: row.content,
    contentHash: row.content_hash,
    metadata: row.metadata,
    sourceCreatedAt: row.source_created_at,
    updatedAt: row.updated_at,
  }));

  return { documents, hasMore };
}

/**
 * Lightweight projection for the indexer's two-phase fetch. Returns
 * only the columns needed to decide whether a doc needs re-embedding
 * (id, source_id, content_hash, source_url, source_created_at,
 * updated_at) — skipping the potentially-large `content`, `title`, and
 * `metadata` TEXT blobs. On a 264k-doc DB where 95% of docs are
 * unchanged, this avoids materialising ~2 GB of content strings that
 * would be immediately discarded after the hash comparison.
 *
 * `source_url` is the canonicalized column, carried so the indexer can
 * detect (and propagate to `chunks.source_url`) a URL-only change whose
 * content hash is unchanged — without a full content fetch. See #462.
 */
export interface LightweightDocRow {
  id: string;
  source_id: string;
  content_hash: string;
  source_url: string | null;
  source_created_at: string;
  updated_at: string;
  /**
   * `metadata.documentType`. Carried in the lightweight scan because the
   * retention cutoff exempts contacts (see `applyMaxAgeCutoff`), and the
   * indexer applies that same cutoff from this header — without the type it
   * would drop the very documents ingest deliberately kept.
   */
  document_type: string | null;
}

export function listDocumentsLightweight(
  db: Db,
  options: ListDocumentsOptions = {},
): { documents: LightweightDocRow[]; hasMore: boolean } {
  const { updatedSince, afterId } = options;
  const limit = options.limit ?? 100;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (updatedSince) {
    conditions.push("updated_at >= ?");
    params.push(updatedSince);
  }

  if (afterId) {
    conditions.push("id > ?");
    params.push(afterId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const indexedBy = updatedSince ? "INDEXED BY idx_documents_updated_at_id" : "";

  const sql = `SELECT id, source_id, content_hash, source_url, source_created_at, updated_at,
                      json_extract(metadata, '$.documentType') AS document_type
                 FROM documents ${indexedBy} ${where} ORDER BY id ASC LIMIT ?`;
  params.push(limit + 1);

  const rows = db.prepare<(string | number)[], LightweightDocRow>(sql).all(...params);

  const hasMore = rows.length > limit;
  return { documents: rows.slice(0, limit), hasMore };
}

export function listDocumentIds(db: Db): string[] {
  const rows = db.prepare<[], { id: string }>("SELECT id FROM documents ORDER BY id").all();
  return rows.map((r) => r.id);
}

/**
 * Batch-fetch `ListedDocumentRow` rows by their UUIDs. The indexer's retry
 * loop uses this to materialise just the failed-doc set instead of
 * paginating the entire corpus once per failure (the prior O(N×M)
 * shape: 100 failures against a 260k-doc DB cost 26M fetches).
 *
 * Chunked under SQLite's per-statement parameter cap.
 */
export function listDocumentsByIds(db: Db, ids: string[]): ListedDocumentRow[] {
  if (ids.length === 0) return [];
  const CHUNK = 500;
  const out: ListedDocumentRow[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<
        string[],
        {
          id: string;
          source_id: string;
          title: string;
          content: string;
          content_hash: string;
          metadata: string;
          source_created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, source_id, title, content, content_hash, metadata,
                source_created_at, updated_at
         FROM documents WHERE id IN (${placeholders})`,
      )
      .all(...chunk);
    for (const row of rows) {
      out.push({
        id: row.id,
        sourceId: row.source_id,
        title: row.title,
        content: row.content,
        contentHash: row.content_hash,
        metadata: row.metadata,
        sourceCreatedAt: row.source_created_at,
        updatedAt: row.updated_at,
      });
    }
  }
  return out;
}

/**
 * Whether any document currently belongs to `sourceId`. Used by the indexer's
 * source-attribution reconcile to tell a live source from a retired one: a
 * source that still has documents owns its index chunks, while a source with
 * indexed chunks but zero documents has been re-homed and its chunks need
 * re-pointing.
 */
export function documentExistsForSource(db: Db, sourceId: string): boolean {
  return (
    db
      .prepare<
        [string],
        { one: number }
      >("SELECT 1 AS one FROM documents WHERE source_id = ? LIMIT 1")
      .get(sourceId) !== undefined
  );
}

/**
 * Current `source_id` for each requested document id, as a Map keyed by id.
 * Documents that no longer exist are simply absent from the map — the caller
 * (the indexer attribution reconcile) leaves those for the deletion reconcile.
 *
 * Chunked under SQLite's per-statement parameter cap, like `listDocumentsByIds`.
 */
export function getDocumentSourceIds(db: Db, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<
        string[],
        { id: string; source_id: string }
      >(`SELECT id, source_id FROM documents WHERE id IN (${placeholders})`)
      .all(...chunk);
    for (const row of rows) out.set(row.id, row.source_id);
  }
  return out;
}

/** The display essentials of a document: its title and owning source id. */
export interface DocumentTitleSource {
  title: string;
  sourceId: string;
}

/**
 * Current `title` + `source_id` for each requested document id, as a Map
 * keyed by id. Documents that no longer exist are simply absent from the map
 * — the caller substitutes nulls for a stale reference (e.g. a deleted doc a
 * brief loop still links). A read-only projection over `documents(id)` (its
 * primary key), chunked under SQLite's per-statement parameter cap like
 * {@link getDocumentSourceIds}.
 */
export function getDocumentTitlesAndSources(
  db: Db,
  ids: string[],
): Map<string, DocumentTitleSource> {
  const out = new Map<string, DocumentTitleSource>();
  if (ids.length === 0) return out;
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<
        string[],
        { id: string; title: string; source_id: string }
      >(`SELECT id, title, source_id FROM documents WHERE id IN (${placeholders})`)
      .all(...chunk);
    for (const row of rows) out.set(row.id, { title: row.title, sourceId: row.source_id });
  }
  return out;
}

/**
 * Look up the gateway-side `documents.id` for each `(provider_id,
 * source_id, external_id)` tuple. Returns a Map keyed by external_id;
 * absent entries are docs the caller asked about but the table doesn't
 * have (e.g. a doc filtered out by maxAge before insert).
 *
 * Used where a caller holds a source's own identifiers and needs the row the
 * gateway wrote for them, rather than a synthetic composite key.
 */
/**
 * Resolve a batch of caller-supplied source URLs to documentIds. URLs
 * are normalized via the same `normalizeUrl` used at ingest time,
 * including any source-declared canonicalization passed via
 * `canonicalizers`.
 *
 * Returns a map keyed by the *original* URL string the caller passed in
 * (NOT the normalized form), so the caller can match by the string it
 * sent without knowing the gateway's canonicalization rules. Each
 * value is the list of every row that matched — multiple rows can
 * legitimately share a `source_url` (e.g. an email and its attachment
 * documents both carry the parent message URL).
 *
 * Used by the eval toolkit's suite resolver — see
 * `packages/eval/src/resolver.ts`.
 */
export function lookupDocumentIdsBySourceUrl(
  db: Db,
  urls: readonly string[],
  canonicalizers?: ReadonlyMap<string, UrlCanonicalizerSpec>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (urls.length === 0) return out;

  // Normalize each input URL; remember the mapping so we can key the
  // result by the ORIGINAL URL the caller sent.
  const normalized = urls.map((u) => normalizeUrl(u, canonicalizers));

  // SELECT by the unique set of normalized URLs (saves duplicate
  // queries when several inputs canonicalize to the same key).
  const uniqueNorm = Array.from(new Set(normalized));
  const idsByNorm = new Map<string, string[]>();
  const CHUNK = 500;
  for (let i = 0; i < uniqueNorm.length; i += CHUNK) {
    const chunk = uniqueNorm.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<
        unknown[],
        { id: string; source_url: string }
      >(`SELECT id, source_url FROM documents WHERE source_url IN (${placeholders})`)
      .all(...chunk);
    for (const r of rows) {
      const list = idsByNorm.get(r.source_url);
      if (list) list.push(r.id);
      else idsByNorm.set(r.source_url, [r.id]);
    }
  }

  // Re-key by original URL. If the caller passed the same URL twice,
  // both entries collapse to one (Map semantics).
  for (let i = 0; i < urls.length; i++) {
    const ids = idsByNorm.get(normalized[i]!);
    if (ids && ids.length > 0) out.set(urls[i]!, ids);
  }
  return out;
}

export function lookupDocumentIdsByExternal(
  db: Db,
  providerId: string,
  sourceId: string,
  externalIds: string[],
  streamId = "",
): Map<string, string> {
  const out = new Map<string, string>();
  if (externalIds.length === 0) return out;
  const CHUNK = 500;
  for (let i = 0; i < externalIds.length; i += CHUNK) {
    const chunk = externalIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<unknown[], { id: string; external_id: string }>(
        `SELECT id, external_id FROM documents
          WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND external_id IN (${placeholders})`,
      )
      .all(providerId, sourceId, streamId, ...chunk);
    for (const r of rows) out.set(r.external_id, r.id);
  }
  return out;
}

/**
 * Resolve a single document id from its `(sourceId, externalId)` — the
 * row→document direction of the cross-store binding (#757). Used by the
 * cite-record path to find the document a cited analytics row co-describes,
 * after `reconstructBoundDocumentRef` inverts the row's primary key into the
 * document's source identity + external id.
 *
 * Matches on `(source_id, external_id)` only (not `provider_id`): a bound
 * source owns one provider per source_id, so the pair is unique enough, and
 * the caller has the source id but not the provider id. Returns `null` when no
 * such document exists — a valid outcome (the row simply has no bound doc), so
 * the citation persists with a `NULL` `target_doc_id`.
 *
 * `sourceId` may arrive as the bare source TYPE (e.g. `"strava-activities"`)
 * rather than the account-qualified id (`"strava-activities:43560449"`): the
 * analytics catalog collapses a single-owner table's source id to the bare
 * type, and a `boundDocument` binding without `sourceKeyColumns` carries that
 * collapsed value back here. Documents, however, are always stored
 * account-qualified. So when `sourceId` has no `:` we also accept a
 * `type:account` match — `external_id` is unique within a source type and stream, so this
 * resolves the row→document inverse without the account on hand; with several
 * streams the first stream's row is returned. A `sourceId` that already
 * names an account matches only itself, per the addressing rule.
 */
export function findDocumentIdBySourceExternalId(
  db: Db,
  sourceId: string,
  externalId: string,
  /** The stream to look in; without one the source's first stream that carries the id answers. */
  streamId?: string,
): string | null {
  const predicate = sourcePrefixPredicate("source_id", [sourceId]);
  const row = db
    .prepare<unknown[], { id: string }>(
      `SELECT id FROM documents
        WHERE external_id = ? AND (${predicate.sql}) AND (? = '' OR stream_id = ?)
        ORDER BY source_id = ? DESC, stream_id LIMIT 1`,
    )
    .get(externalId, ...predicate.params, streamId ?? "", streamId ?? "", sourceId);
  return row?.id ?? null;
}

/**
 * Pre-write projection fetch for `document.upserted` events. Returns a
 * Map keyed by external_id where each value is a `DocumentProjection`
 * (gateway-assigned id, title, content_hash, metadata blob, timestamps,
 * extracted people array). Tuples not present in the map are
 * brand-new inserts — the caller treats their `before` as null when
 * emitting the event.
 *
 * One batched SELECT per (providerId, sourceId) pair, chunked to stay
 * under the SQLite parameter limit. We pre-parse the metadata JSON
 * here once so the EventService doesn't have to re-parse for every
 * subscriber.
 */
export function fetchDocumentProjections(
  db: Db,
  providerId: string,
  sourceId: string,
  externalIds: string[],
  streamId = "",
): Map<string, DocumentProjection> {
  const out = new Map<string, DocumentProjection>();
  if (externalIds.length === 0) return out;
  const CHUNK = 500;
  interface Row {
    id: string;
    external_id: string;
    title: string;
    content_hash: string;
    metadata: string;
    source_created_at: string;
    source_updated_at: string;
  }
  for (let i = 0; i < externalIds.length; i += CHUNK) {
    const chunk = externalIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<unknown[], Row>(
        `SELECT id, external_id, title, content_hash, metadata,
                source_created_at, source_updated_at
           FROM documents
          WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND external_id IN (${placeholders})`,
      )
      .all(providerId, sourceId, streamId, ...chunk);
    for (const r of rows) {
      const metadata = documentsMetadataCodec.parseWithFallback(r.metadata, { rowId: r.id });
      const documentType =
        typeof metadata["documentType"] === "string" ? (metadata["documentType"] as string) : null;
      out.set(r.external_id, {
        id: r.id,
        providerId,
        sourceId,
        externalId: r.external_id,
        documentType,
        title: r.title,
        contentHash: r.content_hash,
        metadata,
        sourceCreatedAt: r.source_created_at,
        sourceUpdatedAt: r.source_updated_at,
        people: extractPeopleFromMetadata(metadata),
      });
    }
  }
  return out;
}

export function checkExistingExternalIds(
  db: Db,
  providerId: string,
  sourceId: string,
  externalIds: string[],
  streamId = "",
): string[] {
  if (externalIds.length === 0) return [];

  // SQLite caps parameters per query at SQLITE_MAX_VARIABLE_NUMBER (default
  // 32766 in Bun's bundled SQLite, 999 historically), so chunk the IN-list.
  const CHUNK = 500;
  const found: string[] = [];
  for (let i = 0; i < externalIds.length; i += CHUNK) {
    const chunk = externalIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<
        string[],
        { external_id: string }
      >(`SELECT external_id FROM documents WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND external_id IN (${placeholders})`)
      .all(providerId, sourceId, streamId, ...chunk);
    for (const r of rows) found.push(r.external_id);
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────
// At-least-once cursor-write (issue #322)
//
// `upsertWithCursor` runs the per-page write sequence —
// upserts → deletions → snapshot reconcile → cursor advance — inside a
// single SQLite transaction. Replaces the four independent gateway calls
// the collector used to make per page; closes the at-least-once gap
// where `setSyncState` could fail after `upsertDocuments` succeeded and
// leave the cursor stale (cheap to replay for documents — the
// (provider_id, source_id, external_id, stream_id) UNIQUE absorbs the dupes — but
// expensive for analytics rows on schemas without a primary key; the
// schema-side `validateAnalyticsSchemasHavePrimaryKey` check is the
// belt-and-braces guard for that path).
// ─────────────────────────────────────────────────────────────────────────

/** One replicated member's page, as far as the deletion ledger is concerned. */
export interface ReplicaVerdictArgs {
  providerId: string;
  sourceId: string;
  /** The member whose verdicts these are. */
  deviceId: string;
  /** The page's explicit tombstones. */
  tombstones: readonly string[];
  /** Whether this member may lead a deletion nobody has reported before. */
  deletionAuthority?: boolean;
  /** What the member's full snapshot said about the items it keeps alive. */
  restorerSnapshot?: RestorerSnapshot;
  /** The corroboration a restorer's omission must reach; required with `restorerSnapshot`. */
  absencePolicy?: SnapshotAbsencePolicy;
  wipeEpoch?: number;
  cursorRow: string;
  streamId: string;
  /** Reset sibling cursor rows after a fresh deletion actually removed data. */
  resetSiblingCursorRows?: true;
  now: number;
}

export interface ReplicaVerdictOutcome {
  /** Document ids removed, for the index and cognitive-state cascades. */
  deletedDocumentIds: string[];
  /** Tombstones kept from taking effect because another member still holds the item. */
  disputed: string[];
  /** Of `disputed`, the items this member had not asserted deleted before. */
  newlyDisputed: number;
}

/**
 * Apply a replicated member's verdicts inside the caller's transaction. A
 * member's tombstones are verdicts, not instructions: an item nobody has
 * deleted before is deleted by the lease holder alone, and its siblings are
 * reset so a healthier replica can put it back; an item with a history is
 * settled by the members that restored it — their agreement deletes it
 * without resetting anyone, and until then it stays. A restorer's snapshot
 * omissions become its verdict only once corroborated, and then take the
 * same path as a tombstone.
 */
export function applyReplicaVerdicts(db: Db, a: ReplicaVerdictArgs): ReplicaVerdictOutcome {
  const matured =
    a.restorerSnapshot !== undefined && a.absencePolicy
      ? recordRestorerOmissions(
          db,
          a.providerId,
          a.sourceId,
          a.deviceId,
          a.restorerSnapshot,
          {
            minObservations: a.absencePolicy.minObservations,
            minAgeMs: a.absencePolicy.minAgeMs,
            spacingMs: observationSpacingMs(a.absencePolicy),
          },
          a.now,
        )
      : [];
  const tombstones = [...a.tombstones, ...matured];
  if (tombstones.length === 0) return { deletedDocumentIds: [], disputed: [], newlyDisputed: 0 };
  const verdict = judgeTombstones(db, a.providerId, a.sourceId, a.deviceId, tombstones, a.now);
  // Only items that exist open a history: a tombstone for an item the corpus
  // never held, or already lost, is a no-op. A member without deletion
  // authority never gets here with a fresh, existing item: the page is
  // refused before anything is written instead.
  const fresh =
    a.deletionAuthority === false
      ? []
      : checkExistingExternalIds(db, a.providerId, a.sourceId, verdict.fresh, a.streamId);
  const freshDeletedIds = deleteDocuments(
    db,
    a.providerId,
    a.sourceId,
    fresh,
    a.wipeEpoch,
    a.cursorRow,
    a.streamId,
  );
  if (freshDeletedIds.length > 0) {
    recordDeletionClaims(db, a.providerId, a.sourceId, a.deviceId, fresh, a.now);
    if (a.resetSiblingCursorRows) resetSiblingMemberCursors(db, a.sourceId, a.cursorRow);
  }
  const settledDeletedIds = deleteDocuments(
    db,
    a.providerId,
    a.sourceId,
    verdict.settled,
    a.wipeEpoch,
    a.cursorRow,
    a.streamId,
  );
  pruneUncontestedClaims(db, a.sourceId, a.now);
  return {
    deletedDocumentIds: [...freshDeletedIds, ...settledDeletedIds],
    disputed: verdict.disputed,
    newlyDisputed: verdict.newlyDisputed,
  };
}

/** What a member's snapshot, sent on its own, did to the items it keeps alive. */
export interface ReplicaOmissionArgs {
  providerId: string;
  sourceId: string;
  deviceId: string;
  restorerSnapshot: RestorerSnapshot;
  absencePolicy: SnapshotAbsencePolicy;
  /** The write epoch the snapshot was taken under; a newer attempt rejects it. */
  wipeEpoch?: number;
  cursorRow: string;
  streamId: string;
}

/**
 * Count a replicated member's snapshot omissions and apply the verdicts that
 * matured, for a snapshot that arrives on its own rather than on a sync page
 * (the mobile apps' whole-library snapshot). The member never leads a fresh
 * deletion this way: only items it restored can mature.
 */
export function applyReplicaOmissions(db: Db, a: ReplicaOmissionArgs): ReplicaVerdictOutcome {
  return db.transaction((): ReplicaVerdictOutcome => {
    if (writeEpochIsRejected(db, a.sourceId, a.wipeEpoch, a.cursorRow)) {
      return { deletedDocumentIds: [], disputed: [], newlyDisputed: 0 };
    }
    return applyReplicaVerdicts(db, {
      providerId: a.providerId,
      sourceId: a.sourceId,
      deviceId: a.deviceId,
      tombstones: [],
      deletionAuthority: false,
      restorerSnapshot: a.restorerSnapshot,
      absencePolicy: a.absencePolicy,
      wipeEpoch: a.wipeEpoch,
      cursorRow: a.cursorRow,
      streamId: a.streamId,
      now: Date.now(),
    });
  })();
}

/**
 * Argument bundle for `upsertWithCursor`. Mirrors the body of the new
 * `POST /documents/with-cursor` HTTP route.
 */
export interface UpsertWithCursorArgs {
  pendingPageId?: string;
  providerId: string;
  sourceId: string;
  /** The `sync_state` row the cursor advances: `""` (shared) or the contributing device's own. */
  cursorDeviceId?: string;
  /** The stream the page's documents belong to — the contributing device's, for a partitioned source. */
  streamId?: string;
  /** Stable conflict resolution for shared rows written by replicated members. */
  replicaVersionPolicy?: "source-updated-at";
  /** Internal continuation state for rows ignored before a cooperative writer yield. */
  ignoredReplicaDocuments?: Array<{ sourceId: string; externalId: string }>;
  /** Internal continuation state for accepted rows written before a cooperative yield. */
  acceptedDocumentsBeforeResume?: number;
  /** Documents to upsert. Empty / omitted is fine. */
  documents?: DocumentInput[];
  /**
   * Authoritative source-owned projections over typed document metadata.
   * `undefined` means an older client supplied no coverage information;
   * `[]` explicitly retires this source's document projection contract.
   */
  documentTemporalProjections?: readonly DocumentTemporalProjectionSpec[];
  /** External IDs to tombstone. Empty / omitted is fine. */
  deletedExternalIds?: string[];
  /** Resolve and reset sibling cursor rows if an explicit tombstone actually deletes data. */
  resetSiblingCursorRows?: true;
  /**
   * The replicated member whose page this is. Its documents and tombstones
   * are recorded as that member's verdicts on items another member deleted
   * (see `ReplicaDeletionClaimRepository`); unset for every other source.
   */
  replicaClaimDeviceId?: string;
  /**
   * Whether this member may lead a deletion nobody has reported before. A
   * replicated member without the sync lease may only add its voice to an
   * item that already has a history; its fresh tombstones are dropped here.
   * Unset means unrestricted.
   */
  deletionAuthority?: boolean;
  /**
   * What this member's final-page snapshot said about the items it keeps alive
   * against another member's deletion: the ones it still named, and the ones it
   * omitted. An omission corroborated under `absencePolicy` becomes the
   * member's `deleted` verdict, applied exactly like a tombstone.
   */
  restorerSnapshot?: RestorerSnapshot;
  /**
   * Absence plan the IO worker computed from this page's snapshot, applied
   * atomically with the cursor write. The diff between what the page vouches
   * for and what is stored is taken off the writer thread, so the writer
   * receives a finished plan rather than a snapshot to compare.
   */
  absencePlan?: SnapshotAbsencePlan;
  /** Stable identity of this completed sync attempt; duplicate delivery adds no evidence. */
  observationId?: string;
  /** Whether more source pages remain after this one (guards reconcile-on-final-page). */
  hasMore: boolean;
  /**
   * Thresholds an absence must clear before it deletes, and the corroboration
   * a restorer's snapshot omission needs. Required alongside `absencePlan` or
   * `restorerSnapshot`.
   */
  absencePolicy?: SnapshotAbsencePolicy;
  /**
   * Structural edges the source declares between its documents (#430) —
   * containment, reply chains, sequences, sibling groups, cross-source
   * references. Applied in this same transaction after the documents are
   * upserted, with `source-declared` provenance; forward references (target not
   * yet ingested) are parked in `pending_edges`. Empty / omitted is fine.
   */
  edges?: EdgeDeclaration[];
  /** The cursor to persist after the writes succeed. */
  cursor: SyncCursor;
  /**
   * The write epoch this sync attempt claimed (#551; legacy name: wipeEpoch).
   * A newer attempt or source wipe advances the epoch, so stale writes are
   * rejected with no documents or cursor applied. Omitted by older collectors
   * to preserve protocol compatibility.
   */
  wipeEpoch?: number;
  /**
   * Forward-looking consent / authorization deadline (ISO 8601) the source
   * reported on this page (#927). Persisted on `sync_state` alongside the cursor
   * so the gateway can derive a non-terminal `auth-expiring` warning ahead of
   * the deadline. `undefined` leaves the stored value unchanged; `null` clears
   * it (re-consent that no longer expires). A normal successful sync without a
   * known deadline simply omits it.
   */
  consentExpiresAt?: string | null;
  /** Source-level coverage claim, accepted only on the final sync page. */
  watermark?: SourceWatermark;
  /** Optional sync-state meta (icon / label / urlPatterns / colors). */
  meta?: {
    icon?: string;
    label?: string;
    urlPatterns?: Array<{ regex: string; idGroup?: number }>;
    bgColor?: string;
    accentColor?: string;
  };
}

export interface UpsertWithCursorResult {
  /** Replicated rows ignored because the gateway already held an equal-or-newer source version. */
  ignoredReplicaDocuments: Array<{ sourceId: string; externalId: string }>;
  /**
   * Document IDs deleted because the page carried them in
   * `deletedExternalIds` — the per-page tombstone channel, where the source
   * asserts that a deletion happened rather than leaving the gateway to infer
   * one from an omission. The handler cascades these into the index database
   * (chunks + indexed_documents) and the cognitive-state purge; both key on
   * the id, and nothing else cleans up after a tombstoned document.
   */
  tombstoneDeletedDocumentIds: string[];
  /** Durable cross-store cleanup committed with the tombstones and cursor. */
  tombstoneCascade?: AbsenceCascade;
  /**
   * Tombstones the page carried for items another replica member still
   * holds. Those items were kept and the page advanced without them.
   */
  disputedDeletions?: string[];
  /** Of `disputedDeletions`, the items this member had not asserted deleted before. */
  newlyDisputedDeletions?: number;
  /** What the page's snapshot changed about this source's pending absences. */
  absence?: SnapshotAbsenceOutcome;
  /**
   * True when the write was rejected because the source was wiped after this
   * sync started (stale `wipeEpoch`) — nothing was applied. See #551.
   */
  rejected?: boolean;
  /**
   * With `rejected`: a replicated member without deletion authority named an
   * existing item nobody has deleted before. Nothing was applied; the page is
   * replayed until the lease holder has led that deletion.
   */
  deletionDeferred?: true;
}

/**
 * What a page's snapshot said, in the terms that matter for spotting a bad
 * read. A snapshot that omits everything the corpus holds, or names documents
 * the corpus lost, produces a reading here that a healthy no-op cannot.
 */
export interface SnapshotAbsenceOutcome {
  /** Absences recorded or corroborated by this snapshot. */
  marked: number;
  /** Pending absences the snapshot revoked by naming the document again. */
  cleared: number;
  /** Stored documents the snapshot omitted. */
  absent: number;
  /** Omissions left unrecorded because the snapshot hit the mark ceiling. */
  deferred: number;
  /** Ids the snapshot named that the corpus does not hold. */
  missing: number;
  /** Documents stored for this source and stream. */
  stored: number;
  /** Distinct ids the snapshot named. */
  snapshot: number;
}

/**
 * Atomic per-page sync write. Wraps every SQLite write the collector
 * needs to commit at the end of a sync page in one transaction so
 * either every effect lands or none of them do — closing the
 * "documents written, cursor never advanced" window.
 *
 * Snapshot-reconcile guard: an `absencePlan` is dropped on a partial page
 * (`hasMore=true`). A partial page names a fraction of what exists, so
 * treating it as a snapshot would record an absence for every document not on
 * that page. The contract is "reconcile only on a full snapshot"; the
 * collector-side check in `source-sync-runner.ts` is the first line of
 * defence and this is the second.
 *
 * A full snapshot's omissions are recorded, never applied — see
 * `AbsenceRepository`. Deletion is the absence sweep's job, once the
 * omission has been corroborated and has stood for long enough.
 */
function writeEpochIsRejected(
  db: Db,
  sourceId: string,
  writeEpoch: number | undefined,
  cursorRow = "",
): boolean {
  const currentWriteEpoch = getWipeEpoch(db, sourceId, cursorRow);
  return (writeEpoch !== undefined || currentWriteEpoch > 0) && writeEpoch !== currentWriteEpoch;
}

export function upsertWithCursor(
  db: Db,
  args: UpsertWithCursorArgs,
  canonicalizers?: ReadonlyMap<string, UrlCanonicalizerSpec>,
): UpsertWithCursorResult {
  const txn = db.transaction((a: UpsertWithCursorArgs): UpsertWithCursorResult => {
    // #551: if the source was wiped after this sync started (its echoed
    // wipeEpoch is now stale), reject the whole write — applying its documents
    // would re-add deleted data and advancing its cursor would resurrect a
    // stale position onto the now-empty source, defeating the resync. The
    // check is inside the txn so it's atomic with the writes (single writer).
    if (writeEpochIsRejected(db, a.sourceId, a.wipeEpoch, a.cursorDeviceId ?? "")) {
      return {
        tombstoneDeletedDocumentIds: [],
        ignoredReplicaDocuments: a.ignoredReplicaDocuments ?? [],
        rejected: true,
      };
    }
    const cursorRow = a.cursorDeviceId ?? "";
    if (a.pendingPageId !== undefined) {
      const pending = getPendingSourcePage(db, a.sourceId, cursorRow);
      if (!pending || pending.id !== a.pendingPageId)
        return {
          tombstoneDeletedDocumentIds: [],
          ignoredReplicaDocuments: [],
          rejected: true,
        };
      if (pending.cursorCommitted)
        return {
          tombstoneDeletedDocumentIds: [],
          ignoredReplicaDocuments: [],
        };
    }
    const streamId = a.streamId ?? "";
    const ignoredReplicaDocuments = [...(a.ignoredReplicaDocuments ?? [])];
    let acceptedDocumentCount = a.acceptedDocumentsBeforeResume ?? 0;
    // A replicated member without deletion authority may only add its voice
    // to an item that already has a deletion history. A tombstone for an
    // existing item with no history is refused before anything is written, so
    // the collector replays the whole page for the holder — never dropped,
    // which would lose a real deletion the service's off-writer check let
    // through because the history closed in between.
    if (
      a.deletionAuthority === false &&
      a.replicaClaimDeviceId !== undefined &&
      a.deletedExternalIds &&
      a.deletedExternalIds.length > 0
    ) {
      const claimed = new Set(
        listClaimedExternalIds(db, a.providerId, a.sourceId, a.deletedExternalIds),
      );
      const fresh = a.deletedExternalIds.filter((id) => !claimed.has(id));
      if (checkExistingExternalIds(db, a.providerId, a.sourceId, fresh, streamId).length > 0) {
        return {
          tombstoneDeletedDocumentIds: [],
          ignoredReplicaDocuments,
          rejected: true,
          deletionDeferred: true,
        };
      }
    }
    let plan = a.hasMore ? undefined : a.absencePlan;
    if (a.documents && a.documents.length > 0) {
      const upserted = upsertDocuments(
        db,
        a.documents,
        {
          writeEpochs: a.wipeEpoch === undefined ? undefined : { [a.sourceId]: a.wipeEpoch },
          cursorRows: { [a.sourceId]: cursorRow },
          streams: { [a.sourceId]: streamId },
          replicaVersionPolicies:
            a.replicaVersionPolicy === undefined
              ? undefined
              : { [a.sourceId]: a.replicaVersionPolicy },
          replicaClaimant:
            a.replicaClaimDeviceId === undefined ? undefined : { deviceId: a.replicaClaimDeviceId },
          documentTemporalProjection:
            a.documentTemporalProjections === undefined
              ? undefined
              : {
                  sourceId: a.sourceId,
                  specs: a.documentTemporalProjections,
                },
          absencePlanScope:
            plan === undefined
              ? undefined
              : {
                  providerId: plan.providerId,
                  sourceId: plan.sourceId,
                  streamId: plan.streamId,
                  generation: plan.generation,
                  revision: plan.revision,
                },
        },
        canonicalizers,
      );
      // The page's documents and its cursor advance together or not at all.
      // `upsertDocuments` applies the same fence on the same row inside this
      // transaction, so this guard only fires should the two ever diverge —
      // and then the cursor must not move past documents that were refused.
      if (upserted.rejectedSourceIds.length > 0) {
        return { tombstoneDeletedDocumentIds: [], ignoredReplicaDocuments, rejected: true };
      }
      ignoredReplicaDocuments.push(...upserted.ignoredReplicaDocuments);
      acceptedDocumentCount += upserted.acceptedDocumentCount;
      if (plan !== undefined) {
        plan =
          upserted.absencePlanInvalidated || upserted.absencePlanScope === undefined
            ? undefined
            : { ...plan, revision: upserted.absencePlanScope.revision };
      }
    }
    // Source-declared edges (#430) land after the page's documents are upserted
    // — the declaring `from` document is co-emitted in this page, so it now
    // exists — and inside this same transaction so edges and documents commit
    // atomically. A target not yet ingested is parked in `pending_edges`.
    if (a.edges && a.edges.length > 0) {
      const ignoredExternalIds = new Set(
        ignoredReplicaDocuments
          .filter(({ sourceId }) => sourceId === a.sourceId)
          .map(({ externalId }) => externalId),
      );
      const acceptedEdges = a.edges.filter(
        (edge) =>
          edge.from.kind !== "internal" || !ignoredExternalIds.has(edge.from.sourceDocumentId),
      );
      applyDeclaredEdges(db, a.sourceId, acceptedEdges, undefined, streamId);
    }
    let tombstoneDeletedIds: string[] = [];
    let disputedDeletions: string[] | undefined;
    let newlyDisputedDeletions: number | undefined;
    if (a.replicaClaimDeviceId === undefined) {
      if (a.deletedExternalIds && a.deletedExternalIds.length > 0) {
        tombstoneDeletedIds = deleteDocuments(
          db,
          a.providerId,
          a.sourceId,
          a.deletedExternalIds,
          a.wipeEpoch,
          cursorRow,
          streamId,
        );
        if (tombstoneDeletedIds.length > 0 && a.resetSiblingCursorRows) {
          resetSiblingMemberCursors(db, a.sourceId, cursorRow);
        }
      }
    } else {
      const outcome = applyReplicaVerdicts(db, {
        providerId: a.providerId,
        sourceId: a.sourceId,
        deviceId: a.replicaClaimDeviceId,
        tombstones: a.deletedExternalIds ?? [],
        deletionAuthority: a.deletionAuthority,
        restorerSnapshot: a.hasMore ? undefined : a.restorerSnapshot,
        absencePolicy: a.absencePolicy,
        wipeEpoch: a.wipeEpoch,
        cursorRow,
        streamId,
        resetSiblingCursorRows: a.resetSiblingCursorRows,
        now: Date.now(),
      });
      tombstoneDeletedIds = outcome.deletedDocumentIds;
      if (outcome.disputed.length > 0) {
        disputedDeletions = outcome.disputed;
        newlyDisputedDeletions = outcome.newlyDisputed;
      }
    }
    // A snapshot records absences; it never deletes. Only consume a finished
    // plan computed by a read handle. Falling back to a whole-source diff here
    // would park the gateway's sole writer for work proportional to the source;
    // if the read worker is unavailable, withholding the snapshot costs one
    // cycle of deletion detection and is the safe outcome.
    let absence: SnapshotAbsenceOutcome | undefined;
    if (plan !== undefined) {
      const applied = applySnapshotAbsencePlan(db, plan);
      absence = {
        marked: applied.marked,
        cleared: applied.cleared,
        absent: plan.absentCount,
        deferred: plan.deferredCount,
        missing: plan.missingCount,
        stored: plan.storedCount,
        snapshot: plan.snapshotCount,
      };
    }
    const tombstoneCascade = enqueueDocumentCascade(db, tombstoneDeletedIds);
    // `upsertWithCursor` is the only write path that carries documents, so it
    // is the only one that may advance `last_document_at`. Stamping it here
    // keeps the timestamp atomic with the documents it describes.
    setSyncState(
      db,
      a.sourceId,
      a.cursor,
      a.meta,
      a.consentExpiresAt,
      acceptedDocumentCount > 0,
      a.wipeEpoch,
      cursorRow,
    );
    if (a.pendingPageId !== undefined)
      db.prepare(
        "UPDATE pending_source_pages SET cursor_committed = 1 WHERE source_id = ? AND cursor_row = ? AND page_id = ?",
      ).run(a.sourceId, cursorRow, a.pendingPageId);
    if (a.watermark !== undefined && !a.hasMore) {
      upsertSourceWatermark(db, a.sourceId, a.watermark);
    }
    if (a.documentTemporalProjections !== undefined) {
      registerDocumentTemporalProjectionCoverage(
        db,
        a.sourceId,
        a.documentTemporalProjections,
        acceptedDocumentCount > 0,
        new Date().toISOString(),
      );
    }
    return {
      tombstoneDeletedDocumentIds: tombstoneDeletedIds,
      ...(tombstoneCascade === undefined ? {} : { tombstoneCascade }),
      ignoredReplicaDocuments,
      absence,
      ...(disputedDeletions === undefined
        ? {}
        : { disputedDeletions, newlyDisputedDeletions: newlyDisputedDeletions ?? 0 }),
    };
  });
  return txn(args);
}

/**
 * Default chunk size for the yieldable upsertWithCursor path. Sized to
 * keep one writer transaction under ~150ms on a fully-warm WAL: at
 * ~3ms per document upsert (insert + people-resolve + dirty-marks),
 * 50 docs ≈ 150ms — short enough that a realtime writer op queued
 * behind it doesn't observe a long stall.
 */
export const UPSERT_WITH_CURSOR_CHUNK_SIZE = 50;

/**
 * Yieldable variant of `upsertWithCursor`. Splits the document list
 * across multiple writer transactions; pre-final chunks upsert
 * documents ONLY, the final chunk runs the original atomic step
 * (last-chunk upsert + tombstones + absence marks + setSyncState).
 *
 * Correctness rationale:
 *
 *   - **Cursor atomicity** — `setSyncState` only runs in the final
 *     transaction, paired with whatever tombstones / absence marks / docs
 *     belong to that chunk. If the writer crashes or yields between
 *     chunks, the cursor is NOT advanced. The collector's per-page
 *     request fails or times out, the collector retries the entire
 *     page on its next sync, and `upsertDocuments` is idempotent
 *     (ON CONFLICT DO UPDATE) so already-applied chunks are no-ops
 *     on retry. No data loss.
 *
 *   - **Delete atomicity** — `deletedExternalIds` and the snapshot's
 *     absence marks are held until the final chunk. They never apply
 *     before all upserts in this page are durable, preserving the
 *     original "no half-state visible" guarantee.
 *
 *   - **Order preservation** — within the final chunk, the order is
 *     upsert → tombstone → absence marks → setSyncState. Across the call
 *     as a whole, all upserts happen before any of those (same as the
 *     one-transaction version).
 *
 *   - **Yield safety** — `token.requested()` is polled BETWEEN
 *     chunks (never mid-transaction). The yield outcome carries the
 *     remaining-docs slice as its resume args; the rest of the args
 *     (deletedExternalIds, absencePlan, hasMore,
 *     cursor, meta) flow through unchanged so the eventual final chunk
 *     has the full reconciliation context.
 *
 *   - **Small-batch fast path** — when there's no token (legacy
 *     direct-handle callers) or when docs.length is at or below the
 *     chunk size, the function delegates to `upsertWithCursor` for a
 *     single atomic transaction. No semantic change for small pages.
 *
 *   - **Empty docs** — if `documents` is empty/missing, we
 *     immediately delegate to the legacy path (just tombstones +
 *     absence marks + cursor in one txn). No reason to chunk a
 *     deletes-only page.
 *
 * Returned value semantics: same shape as `upsertWithCursor`. The
 * `absence` outcome comes from the final chunk (which only marks when
 * `hasMore=false`), so it is accurate regardless of whether the call
 * yielded mid-stream.
 */
export function upsertWithCursorYieldable(
  db: Db,
  args: UpsertWithCursorArgs,
  opts: {
    token?: { requested(): boolean };
    chunkSize?: number;
    canonicalizers?: ReadonlyMap<string, UrlCanonicalizerSpec>;
  } = {},
):
  | { kind: "done"; value: UpsertWithCursorResult }
  | { kind: "yield"; resume: UpsertWithCursorArgs } {
  const token = opts.token;
  const chunkSize = opts.chunkSize ?? UPSERT_WITH_CURSOR_CHUNK_SIZE;
  const canonicalizers = opts.canonicalizers;
  const docs = args.documents ?? [];
  if (args.pendingPageId !== undefined) {
    const pending = getPendingSourcePage(db, args.sourceId, args.cursorDeviceId ?? "");
    if (!pending || pending.id !== args.pendingPageId || pending.cursorCommitted) {
      return {
        kind: "done",
        value: {
          tombstoneDeletedDocumentIds: [],
          ignoredReplicaDocuments: [],
          ...(!pending || pending.id !== args.pendingPageId ? { rejected: true } : {}),
        },
      };
    }
  }

  // A resumed yield re-enters this function after other writer ops had a
  // chance to run. Fence it before any pre-final chunk can write.
  if (writeEpochIsRejected(db, args.sourceId, args.wipeEpoch, args.cursorDeviceId ?? "")) {
    return {
      kind: "done",
      value: {
        tombstoneDeletedDocumentIds: [],
        ignoredReplicaDocuments: args.ignoredReplicaDocuments ?? [],
        rejected: true,
      },
    };
  }

  // Fast path: small batch OR no token. Atomic single transaction —
  // matches legacy behaviour exactly.
  if (!token || docs.length <= chunkSize) {
    return { kind: "done", value: upsertWithCursor(db, args, canonicalizers) };
  }

  // Reserve the final chunk for the atomic deletes + reconcile +
  // setSyncState step. Hand every preceding doc straight to
  // `upsertDocuments` WITH the token — NOT wrapped in an outer
  // `db.transaction`. A wrapping transaction would demote
  // `upsertDocuments`'s per-chunk commits to savepoints (better-sqlite3
  // nests a `db.transaction` as a SAVEPOINT that only commits with the
  // outer one), re-bundling a huge (>=1MB) doc into one physical
  // transaction with its ~50 peers and never reaching the inner
  // huge-doc guard. Passing the token lets `upsertDocuments` own its
  // transaction boundaries: it commits each sub-chunk independently and
  // collapses to one doc per transaction when any doc is >=1MB, so a
  // single fat row never parks the writer next to a full peer chunk.
  const finalChunkStart = Math.max(0, docs.length - chunkSize);
  const preFinal = docs.slice(0, finalChunkStart);
  const {
    remaining,
    rejectedSourceIds,
    ignoredReplicaDocuments,
    acceptedDocumentCount,
    absencePlanScope,
    absencePlanInvalidated,
  } = upsertDocuments(
    db,
    preFinal,
    {
      token,
      chunkSize,
      writeEpochs: args.wipeEpoch === undefined ? undefined : { [args.sourceId]: args.wipeEpoch },
      cursorRows: { [args.sourceId]: args.cursorDeviceId ?? "" },
      streams: { [args.sourceId]: args.streamId ?? "" },
      replicaVersionPolicies:
        args.replicaVersionPolicy === undefined
          ? undefined
          : { [args.sourceId]: args.replicaVersionPolicy },
      replicaClaimant:
        args.replicaClaimDeviceId === undefined
          ? undefined
          : { deviceId: args.replicaClaimDeviceId },
      documentTemporalProjection:
        args.documentTemporalProjections === undefined
          ? undefined
          : {
              sourceId: args.sourceId,
              specs: args.documentTemporalProjections,
            },
      absencePlanScope:
        args.absencePlan === undefined
          ? undefined
          : {
              providerId: args.absencePlan.providerId,
              sourceId: args.absencePlan.sourceId,
              streamId: args.absencePlan.streamId,
              generation: args.absencePlan.generation,
              revision: args.absencePlan.revision,
            },
    },
    canonicalizers,
  );
  // The pre-final chunks are fenced on the page's cursor row like the final
  // one; a refusal there is the whole page's refusal, so the cursor never
  // advances past documents that were not stored.
  if (rejectedSourceIds.length > 0) {
    return {
      kind: "done",
      value: {
        tombstoneDeletedDocumentIds: [],
        ignoredReplicaDocuments: [
          ...(args.ignoredReplicaDocuments ?? []),
          ...ignoredReplicaDocuments,
        ],
        rejected: true,
      },
    };
  }
  const rebasedPlan =
    args.absencePlan === undefined || absencePlanInvalidated || absencePlanScope === undefined
      ? undefined
      : { ...args.absencePlan, revision: absencePlanScope.revision };
  if (remaining.length > 0) {
    // `upsertDocuments` polled the token and yielded mid pre-final. Resume by
    // document IDENTITY, not by a recomputed index: `upsertDocuments` drops
    // tombstoned docs (#1065) up front, so its `remaining` is a slice of the
    // *filtered* array whose length no longer shares a basis with the
    // unfiltered `preFinal.length` — an index like `preFinal.length -
    // remaining.length` would mis-map and silently skip real docs. `remaining`
    // is exactly the un-processed (already tombstone-filtered) pre-final tail;
    // concatenate it with the raw final chunk, which still carries the deletes,
    // reconcile, and cursor advance via `...args`. Re-upserting the un-inserted
    // `remaining` docs on resume is idempotent.
    return {
      kind: "yield",
      resume: {
        ...args,
        documents: [...remaining, ...docs.slice(finalChunkStart)],
        absencePlan: rebasedPlan,
        ignoredReplicaDocuments: [
          ...(args.ignoredReplicaDocuments ?? []),
          ...ignoredReplicaDocuments,
        ],
        acceptedDocumentsBeforeResume:
          (args.acceptedDocumentsBeforeResume ?? 0) + acceptedDocumentCount,
      },
    };
  }

  // Final chunk: the original atomic transaction over the last-chunk
  // docs + all deletes + reconcile + cursor. Its inner `upsertDocuments`
  // stays token-free (one transaction) so the cursor advance commits
  // atomically with the last docs and the reconcile deletes. A >=1MB doc
  // landing in this final chunk still bundles with its <=chunkSize peers here
  // (the huge-doc guard is bypassed) — accepted, because the cursor advance
  // MUST commit in the same transaction as the reconcile; the chunk is bounded
  // (<= chunkSize docs) so the O(chunk)-not-O(source) invariant still holds.
  const finalArgs: UpsertWithCursorArgs = {
    ...args,
    documents: docs.slice(finalChunkStart),
    absencePlan: rebasedPlan,
    ignoredReplicaDocuments: [...(args.ignoredReplicaDocuments ?? []), ...ignoredReplicaDocuments],
    acceptedDocumentsBeforeResume:
      (args.acceptedDocumentsBeforeResume ?? 0) + acceptedDocumentCount,
  };
  return { kind: "done", value: upsertWithCursor(db, finalArgs, canonicalizers) };
}
