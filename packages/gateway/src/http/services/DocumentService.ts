// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createLogger,
  getSourceCutoffDate,
  parseSourceKey,
  validateDocumentTemporalProjectionContracts,
} from "@omnesis/core";
import { SourceId, sourceTypeOf, type DocumentInput, type Scope } from "@omnesis/types";
import {
  fetchDocumentProjections,
  getDocumentCount,
  getRecentDocuments,
  listDocuments,
  listDocumentIds,
  checkExistingExternalIds,
  listClaimedExternalIds,
  listRestoredExternalIdsByDevice,
  computeSnapshotAbsencePlan,
  lookupDocumentIdsBySourceUrl,
  getSourceStats,
  getSourceStatsBulk,
  getWipeEpoch,
  type UpsertWithCursorArgs,
  type SnapshotAbsenceOutcome,
  type SnapshotAbsencePlan,
  type SnapshotAbsencePolicy,
} from "../../db.js";
import {
  getDocumentRefs,
  getDocumentRefsPage,
  getDocumentEdges,
  getLinkStats,
  invalidateUrlPatternCache,
} from "../../links.js";
import { collectPriorContents } from "../../data/document-prior-content.js";
import { yieldToEventLoop, DEFAULT_INGEST_YIELD_BATCH } from "../../async-yield.js";
import { resolveRuntimeSettings } from "../../runtime-settings.js";
import { getNearDupEdges } from "../../near-dupes/index.js";
import { withHiddenSourcesExcluded } from "../../search/hidden-sources.js";
import { runWithPriority } from "../../priority.js";
import { isSourceRemoved } from "../../data/repositories/SourceRepository.js";
import { hasFreeDiskSpace, type DiskSpaceCheck } from "../../disk-guard.js";
import { BadRequestError, InsufficientStorageError } from "../errors.js";
import { normalizeSnapshot, vouchesForWholeSource } from "../../absence/snapshot-claims.js";
import { finishDocumentCascade } from "../../absence/document-cascade.js";
import { normalizeIcon } from "../../icon-normalizer.js";
import { getUrlCanonicalizers, getUrlCanonicalizerSpecs } from "../../url-canonicalizers.js";
import { enforceWriteScopeForSource, enforceWriteScopeForSourceType } from "../scope.js";
import { listLiveAnnotationsForDoc } from "../../brain/index.js";
import {
  countLiveDependentsForAnnotation,
  listLiveDependentsForAnnotation,
} from "../../brain/storage/consumption-edges.js";
import { purgeCognitiveStateThroughGate } from "../../brain/cognitive-state-cascade.js";
import {
  InvalidAnalyticsRecentCursorError,
  type AnalyticsDb,
  type AnalyticsRecentCursor,
} from "../../analytics-db.js";
import { epochScope, type SourceWriteEpochFence } from "../../source-write-epoch-fence.js";
import { SourceSyncStateService } from "./SourceSyncStateService.js";
import type { SourceDataRemovalService } from "./SourceDataRemovalService.js";
import type { SourcePageWriteAuthority } from "../../sync-lease.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { SourceSyncMeta, SyncCursor } from "@omnesis/source-sdk";
import type Database from "better-sqlite3";
import type { DocumentProjection } from "../../events.js";
import type { IndexWriteGate } from "../../indexer/index-write-gate.js";
import type { WriteGate } from "../../write-gate.js";
import type { ConfigStore } from "../../config-store.js";
import type { IComputeScheduler } from "./ports.js";
import type { EventService } from "./EventService.js";

type Db = Database.Database;

const log = createLogger("gateway:http").child("documents");

/** Documents a page is trying to write, for logging a refusal. */
function docCount(body: { documents?: unknown[] }): number {
  return body.documents?.length ?? 0;
}

/** The documents not named by `omitted` (replica rows already held, or tombstoned pages). */
function omitDocuments(
  documents: readonly DocumentInput[],
  omitted: readonly { sourceId: string; externalId: string }[],
): DocumentInput[] {
  if (omitted.length === 0) return [...documents];
  const keys = new Set(omitted.map(({ sourceId, externalId }) => `${sourceId}\0${externalId}`));
  return documents.filter((doc) => !keys.has(`${doc.sourceId}\0${doc.externalId}`));
}

/** The `POST /documents` verdict a push client reads. */
export interface IngestResult {
  /** Documents stored (or idempotently re-stored) by this request. */
  ingested: number;
  /**
   * External ids refused because the user deleted them for good. Present only
   * when non-empty, so a push client can stop re-sending the page and never
   * count it as synced.
   */
  suppressed?: string[];
  rejectedSourceIds?: string[];
}

export interface DocumentServiceDeps {
  db: Db;
  writeGate: WriteGate;
  events: EventService;
  configStore?: ConfigStore;
  config?: OmnesisConfig;
  /**
   * Typed gate for `index.db` writes. When omitted
   * (test path that doesn't wire an index DB), the post-delete chunk
   * cleanup is skipped — same behaviour as the prior raw-handle path.
   */
  indexWriteGate?: IndexWriteGate;
  analyticsDb?: AnalyticsDb;
  ioGate?: IComputeScheduler;
  sourceWriteEpochFence?: SourceWriteEpochFence;
  /** The multi-store source/provider wipes behind `deleteAllBySource` / `deleteAllByProvider`. */
  sourceDataRemoval: SourceDataRemovalService;
  indexerWake?: () => void;
  onDocumentsUpserted?: (sourceId: string, count: number) => void;
  /**
   * Sub-batch size for the ingest before-state capture's event-loop yield
   * (`gateway.ingestYieldBatch`). Omitted in tests → DEFAULT_INGEST_YIELD_BATCH.
   */
  ingestYieldBatch?: number;
  /**
   * Low-disk write guard. Filesystem path whose free space gates
   * ingestion — typically the gateway DB file. When omitted the guard is
   * inert (test paths that don't care about disk). The directory of this
   * path is what's checked, so a not-yet-created DB file still resolves to
   * a real volume.
   */
  gatewayDbPath?: string;
  /**
   * Minimum free bytes required on `gatewayDbPath`'s volume before an
   * ingest write proceeds. Below it, `ingest` / `upsertWithCursor` throw
   * 507. Omitted (or with no `gatewayDbPath`) disables the guard.
   */
  minFreeDiskBytes?: number;
  /**
   * Disk-space check seam. Defaults to the real `hasFreeDiskSpace`; tests
   * inject a stub to drive the low-disk branch without a real full volume.
   */
  checkDiskSpace?: (path: string, minFreeBytes: number) => DiskSpaceCheck;
}

interface CursorUpsertRequest {
  assertSourceWireAuthority?: () => void;
  pageWriteAuthority?: () => SourcePageWriteAuthority;
  callerScopes: readonly Scope[];
  /** The `sync_state` row this page's cursor advances (see `cursorDeviceFor`). */
  cursorDeviceId?: string;
  /** The stream the page's documents belong to — the contributing device's, for a partitioned source. */
  streamId?: string;
  /** Stable version ordering for rows contributed by replicated members. */
  replicaVersionPolicy?: "source-updated-at";
  /** Whether this member may run the page's snapshot reconcile. */
  reconcileAuthority?: boolean;
  /** Whether this member may apply explicit tombstones for a shared replica. */
  deletionAuthority?: boolean;
  /** Resolve and invalidate sibling cursors atomically after authoritative tombstones. */
  resetReplicaCursors?: true;
  /**
   * The replicated member this page comes from. Its documents and tombstones
   * are recorded as verdicts on items another member deleted, which is what
   * lets two replicas that disagree about an item converge instead of taking
   * turns deleting and restoring it. Unset for every other source.
   */
  replicaClaimDeviceId?: string;
  body: {
    pendingPageId?: string;
    providerId: string;
    sourceId: string;
    /** Wire-shape documents; validated by the route before this service boundary. */
    documents?: unknown[];
    documentTemporalProjections?: UpsertWithCursorArgs["documentTemporalProjections"];
    deletedExternalIds?: string[];
    presentExternalIds?: string[];
    /** See `SyncResult.presentClaims`. Mutually exclusive with the above. */
    presentClaims?: readonly { partition: string; ids: readonly string[] }[];
    observationId?: string;
    edges?: UpsertWithCursorArgs["edges"];
    hasMore: boolean;
    cursor: Record<string, unknown>;
    wipeEpoch?: number;
    consentExpiresAt?: string | null;
    watermark?: UpsertWithCursorArgs["watermark"];
    meta?: UpsertWithCursorArgs["meta"];
  };
}

interface CursorUpsertResult {
  ingested: number;
  reconciledDeleted: number;
  indexCleanedRows: number;
  /** What the page's snapshot changed about this source's pending absences. */
  absence?: SnapshotAbsenceOutcome;
  /** Set when the source carries a removal tombstone; nothing was written. */
  rejectedAsRemoved?: boolean;
  /** Set when a newer sync attempt or wipe revoked this page's write authority. */
  rejected?: true;
  /** A deferred replicated tombstone rejects the page so its cursor can be replayed by a lease holder. */
  reason?: "lease";
  /** Set when the page carried a snapshot its device had no authority to reconcile. */
  reconcileDeferred?: true;
  /** Set when explicit tombstones were withheld because another replica holds deletion authority. */
  deletionDeferred?: true;
  /** Documents actually removed through `deletedExternalIds`. */
  tombstonedDeleted: number;
  /**
   * Tombstones kept from taking effect because another replica member still
   * holds the item. The page advanced without them; the items stay until
   * every member that restored them agrees they are gone.
   */
  deletionDisputed?: number;
}

/**
 * HTTP document-domain façade. SourceSyncStateService owns epoch claims,
 * cancellation, metadata-only writes, and legacy cursor fencing; the injected
 * SourceDataRemovalService owns multi-store source/provider deletion (it is
 * shared with SourceService, whose detach and resync paths wipe streams).
 * Existing callers keep this public surface; add those concerns to their
 * collaborators.
 */
export class DocumentService {
  private readonly sourceSyncState: SourceSyncStateService;

  constructor(private readonly deps: DocumentServiceDeps) {
    this.sourceSyncState = new SourceSyncStateService(deps);
  }

  /**
   * Refuse the write when free disk on the DB volume is below the
   * configured floor — writing under low disk risks a partial /
   * corrupting SQLite write. A 507 leaves the sync cursor un-advanced, so the
   * collector re-sends the same page on its next scheduled sync once disk
   * frees (the source shows a transient error state meanwhile) — nothing is
   * lost. Inert when no `gatewayDbPath` / `minFreeDiskBytes` is wired.
   */
  private assertDiskSpace(): void {
    const { gatewayDbPath, minFreeDiskBytes } = this.deps;
    if (!gatewayDbPath || minFreeDiskBytes === undefined) return;
    const check = this.deps.checkDiskSpace ?? hasFreeDiskSpace;
    // Check the containing directory: the DB file itself may not exist yet
    // on a fresh install, but its volume always does.
    const { ok, freeBytes } = check(dirname(gatewayDbPath), minFreeDiskBytes);
    if (!ok) {
      const freeMb = Math.round(freeBytes / (1024 * 1024));
      const minMb = Math.round(minFreeDiskBytes / (1024 * 1024));
      log.warn(`Rejecting ingest: ${freeMb}MB free < ${minMb}MB minimum on the DB volume`);
      throw new InsufficientStorageError(
        `Insufficient disk space: ${freeMb}MB free is below the ${minMb}MB minimum on the gateway DB volume. Free up disk; ingestion resumes automatically.`,
      );
    }
  }

  /**
   * Gate a page's document temporal-projection declarations on the shared
   * contract validator, the same one `defineSource` runs at build time and
   * `ensureTable` runs on the analytics plane. A declaration arrives from
   * outside the gateway's compile unit — a collector on an older build, a
   * device shipping its own copy of the contract — so a spec that is
   * structurally well-formed can still be semantically illegal (a mapping
   * with an empty map, a slot the wire shape spells legally). Rejecting here
   * keeps a spec the derivation cannot honour out of the writer transaction.
   *
   * Contract failures are the caller's, so they surface as 400 rather than
   * falling through to the sanitized 500 an unhandled throw would produce.
   */
  private assertProjectionContracts(
    sourceId: string,
    specs: UpsertWithCursorArgs["documentTemporalProjections"],
  ): void {
    try {
      validateDocumentTemporalProjectionContracts(specs, `upsertWithCursor('${sourceId}')`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Rejecting page for ${sourceId}: ${message}`);
      throw new BadRequestError(message);
    }
  }

  /**
   * Apply per-source-type write-scope checks against the caller's scopes: the
   * same rule every other source mutation uses (`enforceWriteScopeForSource`),
   * applied once per distinct source type in the batch. Throws
   * `ForbiddenError` on the first type the token may not write.
   *
   * The type half is read with the total helper rather than by branding the
   * id. The ingest body schema admits any non-empty string as a `sourceId`,
   * so a malformed one reaches here — and a branded constructor throws an
   * error this layer does not classify, which the top-level handler turns
   * into a sanitized 500 and an "unhandled error" in the journal. It is a
   * client mistake, and `enforceWriteScopeForSourceType` already says so with
   * a 400 for a type it cannot parse.
   */
  enforceWriteScope(scopes: readonly Scope[], docs: readonly DocumentInput[]): void {
    const seenTypes = new Set<string>();
    for (const d of docs) {
      if (!d.sourceId) continue;
      const sourceType = sourceTypeOf(d.sourceId);
      if (seenTypes.has(sourceType)) continue;
      seenTypes.add(sourceType);
      enforceWriteScopeForSourceType(scopes, sourceType);
    }
  }

  /**
   * Drop documents older than the effective per-source maxAge (contacts
   * are exempt — they stay relevant indefinitely). Shared by `ingest`
   * and `upsertWithCursor` so the cutoff applies at the gateway boundary
   * regardless of which write path the collector picked.
   */
  private applyMaxAgeCutoff(documents: readonly DocumentInput[]): DocumentInput[] {
    const liveConfig = this.deps.configStore?.get() ?? this.deps.config ?? {};
    const cutoffCache = new Map<string, string | null>();
    const before = documents.length;
    const filtered = documents.filter((d) => {
      if (d.metadata?.documentType === "contact") return true;
      let cutoff = cutoffCache.get(d.sourceId);
      if (cutoff === undefined) {
        cutoff = getSourceCutoffDate(liveConfig, d.sourceId);
        cutoffCache.set(d.sourceId, cutoff);
      }
      return cutoff === null || d.sourceCreatedAt >= cutoff;
    });
    const dropped = before - filtered.length;
    if (dropped > 0) {
      log.debug(`Dropped ${dropped} documents older than cutoff`);
    }
    return filtered;
  }

  private assertDocumentBatchContracts(
    documents: readonly DocumentInput[],
    streams: Readonly<Record<string, string>> | undefined,
    replicaVersionPolicies: Readonly<Record<string, "source-updated-at">> | undefined,
  ): void {
    const identities = new Map<string, DocumentInput>();
    for (const document of documents) {
      const identity = JSON.stringify([
        document.providerId,
        document.sourceId,
        document.externalId,
        streams?.[document.sourceId] ?? "",
      ]);
      const prior = identities.get(identity);
      if (prior !== undefined && prior !== document && !isDeepStrictEqual(prior, document)) {
        throw new BadRequestError(
          `conflicting document identity in one page: ${document.sourceId}/${document.externalId}`,
        );
      }
      identities.set(identity, document);
      if (replicaVersionPolicies?.[document.sourceId] !== "source-updated-at") continue;
      try {
        if (new Date(document.sourceUpdatedAt).toISOString() === document.sourceUpdatedAt) continue;
      } catch {
        // Mapped to the same boundary error below.
      }
      throw new BadRequestError(
        `sourceUpdatedAt for replicated document ${document.sourceId}/${document.externalId} must be canonical UTC ISO 8601`,
      );
    }
  }

  async ingest(
    documents: DocumentInput[],
    writeEpochs?: Readonly<Record<string, number>>,
    enforceWriteEpochs = false,
    /** The cursor row each source's epoch was claimed on (`""` = shared). */
    cursorRows?: Readonly<Record<string, string>>,
    /** The stream each source's documents belong to (`""` = the source's one stream). */
    streams?: Readonly<Record<string, string>>,
    replicaVersionPolicies?: Readonly<Record<string, "source-updated-at">>,
    assertSourceWireAuthority?: () => void,
  ): Promise<IngestResult> {
    const ingest = () => {
      assertSourceWireAuthority?.();
      return this.ingestFenced(
        documents,
        writeEpochs,
        enforceWriteEpochs,
        cursorRows,
        streams,
        replicaVersionPolicies,
      );
    };
    if (!this.deps.sourceWriteEpochFence) return ingest();
    const scopes = [...new Set(documents.map((document) => document.sourceId))].map((sourceId) =>
      epochScope(sourceId, cursorRows?.[sourceId] ?? ""),
    );
    return this.deps.sourceWriteEpochFence.runAll(scopes, ingest);
  }

  private async ingestFenced(
    documents: DocumentInput[],
    writeEpochs?: Readonly<Record<string, number>>,
    enforceWriteEpochs = false,
    cursorRows?: Readonly<Record<string, string>>,
    streams?: Readonly<Record<string, string>>,
    replicaVersionPolicies?: Readonly<Record<string, "source-updated-at">>,
  ): Promise<IngestResult> {
    const { db, writeGate: w, events } = this.deps;

    // Pause ingestion under low disk before any write.
    this.assertDiskSpace();

    const docs = this.applyMaxAgeCutoff(documents);
    this.assertDocumentBatchContracts(docs, streams, replicaVersionPolicies);
    const effectiveWriteEpochs: Record<string, number> = {};
    const rejectedSourceIds: string[] = [];
    for (const sourceId of new Set(docs.map((document) => document.sourceId))) {
      const currentWriteEpoch = getWipeEpoch(db, sourceId, cursorRows?.[sourceId] ?? "");
      const writeEpoch = writeEpochs?.[sourceId];
      if (
        enforceWriteEpochs &&
        (writeEpoch !== undefined || currentWriteEpoch > 0) &&
        writeEpoch !== currentWriteEpoch
      ) {
        rejectedSourceIds.push(sourceId);
      } else {
        effectiveWriteEpochs[sourceId] = writeEpoch ?? currentWriteEpoch;
      }
    }
    if (rejectedSourceIds.length > 0) return { ingested: 0, rejectedSourceIds };

    // Snapshot the projection of every pre-existing (providerId,
    // sourceId, externalId) tuple BEFORE the upsert so we can emit
    // `document.upserted` events with both `before` and `after`
    // payloads. Brand-new inserts have no entry in this map; their
    // emitted event has `before: null`.
    // Sub-batched, event-loop-yielding capture (same shape as
    // upsertWithCursor) so a large multi-source post can't freeze the loop —
    // grouped by (provider, source) pair within each sub-batch. beforeContents
    // self-gates to empty unless a prior-content subscriber is registered.
    const wantEmit = events.wantsEmit;
    const yieldBatch = this.deps.ingestYieldBatch ?? DEFAULT_INGEST_YIELD_BATCH;
    const beforeProjections = new Map<string, DocumentProjection>();
    let beforeContents: Map<string, string> | undefined;
    if (wantEmit && docs.length > 0) {
      beforeContents = new Map<string, string>();
      for (let i = 0; i < docs.length; i += yieldBatch) {
        const sub = docs.slice(i, i + yieldBatch);
        const byPairCheck = new Map<string, string[]>();
        for (const d of sub) {
          const key = `${d.providerId}|${d.sourceId}`;
          const arr = byPairCheck.get(key);
          if (arr) arr.push(d.externalId);
          else byPairCheck.set(key, [d.externalId]);
        }
        const subProjections = new Map<string, DocumentProjection>();
        for (const [key, externalIds] of byPairCheck) {
          const [providerId, sourceId] = key.split("|", 2);
          const existing = fetchDocumentProjections(
            db,
            providerId,
            sourceId,
            externalIds,
            streams?.[sourceId] ?? "",
          );
          for (const [extId, projection] of existing) {
            const tripleKey = `${providerId}|${sourceId}|${extId}`;
            beforeProjections.set(tripleKey, projection);
            subProjections.set(tripleKey, projection);
          }
        }
        for (const [k, v] of collectPriorContents(db, sub, subProjections, streams)) {
          beforeContents.set(k, v);
        }
        if (i + yieldBatch < docs.length) await yieldToEventLoop();
      }
    }

    const writeResult = await w.upsertDocuments(
      docs,
      getUrlCanonicalizerSpecs(),
      effectiveWriteEpochs,
      cursorRows,
      streams,
      replicaVersionPolicies,
    );
    if (writeResult.rejectedSourceIds.length > 0) {
      return { ingested: 0, rejectedSourceIds: writeResult.rejectedSourceIds };
    }
    const acceptedDocuments = omitDocuments(
      omitDocuments(docs, writeResult.ignoredReplicaDocuments),
      writeResult.suppressedDocuments,
    );
    log.debug(`Upserted ${acceptedDocuments.length} documents`);

    if (acceptedDocuments.length > 0) this.deps.indexerWake?.();

    if (wantEmit)
      await events.emitDocumentUpserted(
        acceptedDocuments,
        beforeProjections,
        beforeContents,
        streams,
      );

    if (this.deps.onDocumentsUpserted && acceptedDocuments.length > 0) {
      const bySource = new Map<string, number>();
      for (const doc of acceptedDocuments) {
        bySource.set(doc.sourceId, (bySource.get(doc.sourceId) ?? 0) + 1);
      }
      for (const [sourceId, count] of bySource) {
        this.deps.onDocumentsUpserted(sourceId, count);
      }
    }

    return {
      ingested: acceptedDocuments.length,
      ...(writeResult.suppressedDocuments.length > 0
        ? { suppressed: writeResult.suppressedDocuments.map((document) => document.externalId) }
        : {}),
    };
  }

  /**
   * Purge the cognitive state grounded on deleted documents. Wired at every
   * document-delete path here that yields deleted ids (explicit deletes + sync
   * reconcile); source removal runs the same cascade from `SourceService`.
   */
  private async purgeAnnotationsFor(deletedDocIds: readonly string[]): Promise<void> {
    await purgeCognitiveStateThroughGate(this.deps.db, this.deps.writeGate, deletedDocIds);
  }

  async deleteByIds(
    providerId: string,
    sourceId: string,
    externalIds: string[],
    writeEpoch?: number,
    enforceWriteEpoch = false,
    /** The cursor row `writeEpoch` was claimed on (`""` = shared). */
    cursorRow = "",
    /** The stream the deletions belong to (`""` = the source's one stream). */
    streamId = "",
    assertSourceWireAuthority?: () => void,
  ): Promise<{ deleted: number }> {
    const remove = async () => {
      assertSourceWireAuthority?.();
      const { writeGate: w, indexWriteGate } = this.deps;
      const currentWriteEpoch = getWipeEpoch(this.deps.db, sourceId, cursorRow);
      if (
        enforceWriteEpoch &&
        (writeEpoch !== undefined || currentWriteEpoch > 0) &&
        writeEpoch !== currentWriteEpoch
      ) {
        return { deleted: 0 };
      }
      const deletedDocIds = await w.deleteDocuments(
        providerId,
        sourceId,
        externalIds,
        writeEpoch ?? currentWriteEpoch,
        cursorRow,
        streamId,
      );
      let indexCleanedRows = 0;
      if (indexWriteGate && deletedDocIds.length > 0) {
        indexCleanedRows = await indexWriteGate.deleteChunksByDocuments(deletedDocIds);
      }
      await this.purgeAnnotationsFor(deletedDocIds);
      log.debug(`Deleted ${externalIds.length} documents`, {
        providerId,
        sourceId,
        indexCleanedRows,
      });
      return { deleted: deletedDocIds.length };
    };
    return this.deps.sourceWriteEpochFence
      ? this.deps.sourceWriteEpochFence.run(epochScope(sourceId, cursorRow), remove)
      : remove();
  }

  /**
   * User-initiated single-document privacy delete (`DELETE /documents/:id`).
   * Removes the document and its extracted-attachment children and
   * cascades the cleanup into the separate index DB. With `tombstone` (the
   * default) it also writes a durable tombstone (inside
   * `writeGate.deleteDocumentForUser`) so a later re-sync / re-capture can't
   * bring the page back, and removes the analytics rows that cite the
   * document's URL — the source's own record of the same page. Without it only
   * this copy goes, and the source may bring the page back. `deleted` is the
   * actual number of rows removed (the parent plus any attachment children),
   * not the count of ids requested.
   */
  async deleteDocumentForUser(
    providerId: string,
    sourceId: string,
    externalId: string,
    /** The stream the document belongs to (`""` = the source's one stream). */
    streamId = "",
    options: { tombstone?: boolean } = {},
  ): Promise<{ deleted: number }> {
    const result = await this.deleteDocumentsForUser(
      providerId,
      sourceId,
      [{ externalId, streamId }],
      options,
    );
    return { deleted: result.deleted };
  }

  /**
   * The privacy delete for several documents of one source at once — a domain
   * purge, say. Each document is its own writer operation, so the writer is
   * never held for the whole batch, while the analytics cascade of a tombstoned
   * delete resolves the URL-citing columns once and removes every deleted URL
   * per table in one statement. `documents` counts the parents removed,
   * `deleted` every row including attachment children.
   */
  async deleteDocumentsForUser(
    providerId: string,
    sourceId: string,
    keys: ReadonlyArray<{ externalId: string; streamId: string }>,
    options: { tombstone?: boolean } = {},
  ): Promise<{ documents: number; deleted: number }> {
    const { db, writeGate: w, indexWriteGate } = this.deps;
    const tombstone = options.tombstone ?? true;
    const readUrl = db.prepare<[string, string, string, string], { source_url: string | null }>(
      "SELECT source_url FROM documents WHERE provider_id = ? AND source_id = ? AND external_id = ? AND stream_id = ?",
    );
    const urls: string[] = [];
    let documents = 0;
    let deleted = 0;
    for (const { externalId, streamId } of keys) {
      const url = tombstone
        ? (readUrl.get(providerId, sourceId, externalId, streamId)?.source_url ?? null)
        : null;
      const deletedDocIds = await w.deleteDocumentForUser(
        providerId,
        sourceId,
        externalId,
        streamId,
        tombstone,
      );
      if (deletedDocIds.length === 0) continue;
      documents += 1;
      deleted += deletedDocIds.length;
      if (url) urls.push(url);
      let indexCleanedRows = 0;
      if (indexWriteGate) {
        indexCleanedRows = await indexWriteGate.deleteChunksByDocuments(deletedDocIds);
      }
      await this.purgeAnnotationsFor(deletedDocIds);
      log.debug(
        `Privacy-deleted document ${externalId}: ${deletedDocIds.length} rows (incl. attachments), ${indexCleanedRows} index rows${tombstone ? "" : ", no tombstone"}`,
        { providerId, sourceId },
      );
    }
    if (urls.length > 0) await this.deleteAnalyticsCitingUrls(sourceId, urls);
    return { documents, deleted };
  }

  /**
   * Remove the analytics rows of `sourceId`'s tables that cite one of `urls`
   * through a column declared `references: "url"` — the source's statement
   * that such a row is about that page (a browser visit of it, say), which is
   * why a page deleted for good takes its rows with it without any
   * source-specific code here. A table the catalog attributes to the bare
   * source type rather than this source id is left alone. Best-effort: the
   * documents are already gone, so a failure is logged rather than surfaced.
   */
  private async deleteAnalyticsCitingUrls(sourceId: string, urls: string[]): Promise<void> {
    const { analyticsDb } = this.deps;
    if (!analyticsDb) return;
    try {
      for (const table of await analyticsDb.getCatalog()) {
        if (table.sourceId !== sourceId) continue;
        for (const column of table.columns) {
          if (column.references !== "url") continue;
          await analyticsDb.deleteRecords(table.tableName, urls, column.name);
          log.debug(`Removed ${table.tableName} rows citing ${urls.length} deleted page(s)`);
        }
      }
    } catch (error) {
      log.warn(
        `Analytics rows citing deleted ${sourceId} pages were not removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Atomic per-page sync write. Bundles
   * documents + tombstones + snapshot reconcile + cursor advance into
   * one SQLite transaction so either every effect lands or none of
   * them do. Replaces the prior four-step
   * `upsertDocuments → deleteDocuments → reconcile → setSyncState`
   * sequence — closes the at-least-once gap where `setSyncState` could
   * throw after `upsertDocuments` succeeded.
   *
   * Mirrors the cross-cutting concerns of the three split endpoints:
   *   - per-source-type write-scope enforcement (same as `ingest`).
   *   - per-source `maxAge` cutoff filter (same as `ingest`) — drops
   *     docs older than the configured horizon before they hit the DB.
   *   - icon normalization on `meta.icon` (same as
   *     `POST /sync-state/:sourceId`) — rasterizes SVG / hosted URLs
   *     into a uniform PNG data URI so portal/iOS/iTerm can render
   *     without a per-consumer SVG decoder.
   *   - URL-pattern cache invalidation when `meta.urlPatterns` is set
   *     (same as `POST /sync-state/:sourceId`).
   *   - indexer-wake on doc churn (same as `ingest`).
   *   - event emission for documents.upserted / documents.deleted /
   *     analytics.ingested (same as `ingest` + `reconcile`).
   *   - index-DB cleanup cascade for the docs this page tombstoned.
   *
   * The snapshot reconcile computes its diff on the IO worker and applies the
   * resulting absence marks in the same writer transaction as the cursor
   * advance, so a page's documents and the absences its snapshot implies commit
   * together or not at all.
   */
  async upsertWithCursor(args: CursorUpsertRequest): Promise<CursorUpsertResult> {
    const upsert = () => {
      args.assertSourceWireAuthority?.();
      return this.upsertWithCursorFenced(args);
    };
    return this.deps.sourceWriteEpochFence
      ? this.deps.sourceWriteEpochFence.run(
          epochScope(args.body.sourceId, args.cursorDeviceId ?? ""),
          upsert,
        )
      : upsert();
  }

  private async upsertWithCursorFenced(args: CursorUpsertRequest): Promise<CursorUpsertResult> {
    enforceWriteScopeForSource(args.callerScopes, args.body.sourceId);
    this.assertProjectionContracts(args.body.sourceId, args.body.documentTemporalProjections);
    // A removed source's in-flight page must stop the collector, not send it
    // into conflict retries. Preserve this result before refreshing lease or
    // membership authority; both checks remain inside the same write fence.
    if (isSourceRemoved(this.deps.db, SourceId(args.body.sourceId))) {
      log.info(
        `Refused ingest for removed source ${args.body.sourceId} (${docCount(args.body)} documents)`,
      );
      return {
        ingested: 0,
        reconciledDeleted: 0,
        tombstonedDeleted: 0,
        indexCleanedRows: 0,
        rejectedAsRemoved: true,
      };
    }
    args = { ...args, ...args.pageWriteAuthority?.() };

    // The two spellings of a snapshot — a whole-source enumeration and a set
    // of per-partition claims — collapse once, here, so every decision below
    // reads one shape. A second normalisation further down would be a second
    // place to remember the claim form, and the one that forgot it would
    // silently treat a partial read as a whole-source one.
    let snapshot = normalizeSnapshot(args.body);
    // A replicated member's snapshot speaks about the items it keeps alive
    // against another member's deletion: naming one is positive evidence, and
    // omitting one counts towards that member's own deletion verdict — the only
    // one a source without tombstones can give — under the same corroboration
    // an absence needs. The sets are read here, before a non-holder's snapshot
    // is set aside below, and are bounded by the member's disputes, not by the
    // snapshot; the writer counts them inside the page transaction.
    let restorerSnapshot: { omitted: string[]; named: string[] } | undefined;
    if (
      args.replicaClaimDeviceId !== undefined &&
      snapshot.presentExternalIds !== undefined &&
      // A claim-shaped snapshot cannot supply this verdict. A restored item is
      // recorded per device, not per partition, so an item living in a
      // partition this cycle could not read is absent from the claim's ids for
      // the same reason a deleted one is — and counting it as omitted deletes
      // it on the strength of a read that never opened its store. That is the
      // loss the claim exists to prevent, arriving by another route.
      vouchesForWholeSource(snapshot) &&
      !args.body.hasMore
    ) {
      const restored = listRestoredExternalIdsByDevice(
        this.deps.db,
        args.body.providerId,
        args.body.sourceId,
        args.replicaClaimDeviceId,
      );
      if (restored.length > 0) {
        const present = new Set(snapshot.presentExternalIds);
        const tombstoned = new Set(args.body.deletedExternalIds ?? []);
        restorerSnapshot = {
          named: restored.filter((id) => present.has(id)),
          omitted: restored.filter((id) => !present.has(id) && !tombstoned.has(id)),
        };
      }
    }
    const reconcileDeferred =
      args.reconcileAuthority === false && snapshot.presentExternalIds !== undefined;
    const deletionDeferred =
      args.deletionAuthority === false && (args.body.deletedExternalIds?.length ?? 0) > 0;
    if (reconcileDeferred) {
      // Both spellings are set aside, not just the one the body happened to
      // use: a member without reconcile authority makes no absence claim at
      // all, whichever shape it made it in.
      args = {
        ...args,
        body: {
          ...args.body,
          presentExternalIds: undefined,
          presentClaims: undefined,
        },
      };
      snapshot = { presentExternalIds: undefined, claimedPartitions: undefined };
    }
    const { writeGate: w, indexWriteGate, events } = this.deps;
    let body = args.body;
    // Unlike a full snapshot, an incremental tombstone may be emitted only
    // once after a source-side modification. A non-holder must not commit the
    // page cursor past an unresolved tombstone: reject the whole page so it is
    // replayed. Once an authority holder has removed every named row, the
    // tombstones are harmless no-ops; strip them and let the replica advance
    // through the retained page. A tombstone for an item that already has a
    // deletion history is different again: it is this member's verdict on a
    // disagreement between replicas, which the writer records — and which
    // settles the item when this member was the one keeping it alive — so the
    // page carries those ids through and advances. The reads are deliberately
    // outside the writer: a later concurrent insert remains safe because a
    // non-holder never forwards a fresh delete, and the writer re-judges the
    // claimed ids inside its own transaction.
    if (deletionDeferred) {
      const named = args.body.deletedExternalIds ?? [];
      const claimed = new Set(
        args.replicaClaimDeviceId === undefined
          ? []
          : listClaimedExternalIds(this.deps.db, args.body.providerId, args.body.sourceId, named),
      );
      const unresolved = checkExistingExternalIds(
        this.deps.db,
        args.body.providerId,
        args.body.sourceId,
        named.filter((id) => !claimed.has(id)),
        args.streamId ?? "",
      );
      if (unresolved.length > 0) {
        return {
          ingested: 0,
          reconciledDeleted: 0,
          tombstonedDeleted: 0,
          indexCleanedRows: 0,
          rejected: true,
          reason: "lease",
          deletionDeferred: true,
        };
      }
      args = {
        ...args,
        body: {
          ...args.body,
          deletedExternalIds: claimed.size > 0 ? named.filter((id) => claimed.has(id)) : undefined,
        },
      };
      body = args.body;
    }

    // Pause ingestion under low disk before any write. This path
    // always also advances the sync cursor, so a 507 here means the
    // collector re-sends the same page (with its cursor) once disk frees.
    this.assertDiskSpace();

    const rawDocuments = (body.documents ?? []) as unknown as DocumentInput[];
    if (rawDocuments.length > 0) {
      this.enforceWriteScope(args.callerScopes, rawDocuments);
    }
    const documents = rawDocuments.length > 0 ? this.applyMaxAgeCutoff(rawDocuments) : rawDocuments;
    this.assertDocumentBatchContracts(
      documents,
      { [body.sourceId]: args.streamId ?? "" },
      args.replicaVersionPolicy ? { [body.sourceId]: args.replicaVersionPolicy } : undefined,
    );

    // Normalize the icon at the write boundary so every consumer (portal,
    // iOS, iTerm OSC inline-image) reads back a uniform PNG data URI —
    // mirrors the older `POST /sync-state/:sourceId` route. Hosted
    // SVG URLs and SVG data URIs get rasterized once here instead of
    // forcing each renderer to decode SVG.
    let meta = body.meta;
    if (meta?.icon !== undefined) {
      const normalized = (await normalizeIcon(meta.icon)) ?? undefined;
      meta = { ...meta, icon: normalized };
    }

    // Capture the before-projection for documents.upserted event emission —
    // same pattern as `ingest`, but this endpoint is per-source (single
    // providerId/sourceId in the body), so each sub-batch is a single
    // fetch rather than `ingest`'s group-by-pair fetch.
    const wantEmit = events.wantsEmit && documents.length > 0;
    // Capture the pre-write projections (and, when a prior-content subscriber
    // is registered, the pre-write bodies) for document.upserted emission.
    // Walk the batch in sub-batches with an event-loop yield between them: on a
    // large batch these synchronous SELECT + metadata-parse passes would
    // otherwise stall the single event loop for seconds and freeze every
    // interactive read (see async-yield.ts). The capture and the write are not
    // atomic (they never were — the read handle is separate from the writer),
    // so the emit does a post-write id lookup and drops any doc that didn't
    // survive; the yield only widens that already-tolerated window.
    const yieldBatch = this.deps.ingestYieldBatch ?? DEFAULT_INGEST_YIELD_BATCH;
    const beforeProjections = new Map<string, DocumentProjection>();
    let beforeContents: Map<string, string> | undefined;
    if (wantEmit) {
      beforeContents = new Map<string, string>();
      for (let i = 0; i < documents.length; i += yieldBatch) {
        const sub = documents.slice(i, i + yieldBatch);
        const existing = fetchDocumentProjections(
          this.deps.db,
          body.providerId,
          body.sourceId,
          sub.map((d) => d.externalId),
          args.streamId ?? "",
        );
        const subProjections = new Map<string, DocumentProjection>();
        for (const [extId, projection] of existing) {
          const key = `${body.providerId}|${body.sourceId}|${extId}`;
          beforeProjections.set(key, projection);
          subProjections.set(key, projection);
        }
        // Self-gates: returns empty unless a prior-content subscriber exists.
        for (const [k, v] of collectPriorContents(this.deps.db, sub, subProjections, {
          [body.sourceId]: args.streamId ?? "",
        })) {
          beforeContents.set(k, v);
        }
        if (i + yieldBatch < documents.length) await yieldToEventLoop();
      }
    }

    // Diff the snapshot against the corpus off-writer, then apply the resulting
    // absence marks inside the cursor-advancing transaction. The scan is the
    // expensive half and it never touches the writer; the marks it produces are
    // bounded by the policy's ceiling, so the writer's share of a wholesale
    // absence is a fixed number of short statements rather than one row per
    // missing document.
    // Read once per page: the thresholds are a floor under an irreversible
    // operation, and the plan and the writer fallback must judge by the same one.
    const absencePolicy = this.absencePolicy();
    const offWriterAbsence =
      this.deps.ioGate !== undefined &&
      snapshot.presentExternalIds !== undefined &&
      !body.hasMore &&
      (body.wipeEpoch === undefined ||
        body.wipeEpoch === getWipeEpoch(this.deps.db, body.sourceId, args.cursorDeviceId ?? ""));
    let absencePlan: SnapshotAbsencePlan | undefined;
    if (offWriterAbsence) {
      absencePlan = await runWithPriority("realtime", () =>
        this.deps.ioGate!.snapshotAbsencePlan(
          body.providerId,
          body.sourceId,
          snapshot.presentExternalIds!,
          absencePolicy,
          {
            streamId: args.streamId ?? "",
            arrivingExternalIds: documents.map((d) => d.externalId),
            observationId: body.observationId,
            observedBy: args.cursorDeviceId ?? "",
            claimedPartitions: snapshot.claimedPartitions,
          },
        ),
      );
    }

    // The page commit runs at the caller's priority — `realtime` for the
    // collector, which is what every pull sync's paging loop waits on. The
    // expensive half of a snapshot (the corpus diff) already ran off the
    // writer above, so all the writer sees here is the page's upserts, its
    // tombstones, a bounded set of absence marks and the cursor advance.
    // Demoting it to `background` would order the collector behind every
    // backfill drip and stall it entirely under `POST /admin/background/pause`,
    // whose contract is that collector ingestion keeps flowing.
    const result = await w.upsertWithCursor(
      {
        providerId: body.providerId,
        sourceId: body.sourceId,
        documents,
        documentTemporalProjections: body.documentTemporalProjections,
        deletedExternalIds: body.deletedExternalIds,
        resetSiblingCursorRows: args.resetReplicaCursors,
        replicaClaimDeviceId: args.replicaClaimDeviceId,
        deletionAuthority: args.deletionAuthority,
        restorerSnapshot,
        absencePolicy,
        absencePlan,
        edges: body.edges,
        hasMore: body.hasMore,
        cursor: body.cursor as UpsertWithCursorArgs["cursor"],
        cursorDeviceId: args.cursorDeviceId,
        streamId: args.streamId,
        replicaVersionPolicy: args.replicaVersionPolicy,
        wipeEpoch: body.wipeEpoch,
        pendingPageId: body.pendingPageId,
        consentExpiresAt: body.consentExpiresAt,
        watermark: body.hasMore ? undefined : body.watermark,
        meta,
      },
      getUrlCanonicalizerSpecs(),
    );

    const absence = result.absence;

    // Tombstones and the cursor commit share one writer transaction. Clean
    // derived stores only for IDs it actually deleted — the page's snapshot
    // deletes nothing, so the tombstone channel is the whole cascade here.
    const cascadeDeletedDocumentIds = result.tombstoneDeletedDocumentIds;
    const indexCleanedRows = result.tombstoneCascade
      ? await finishDocumentCascade(result.tombstoneCascade, {
          deleteIndex: indexWriteGate
            ? (ids) => indexWriteGate.deleteChunksByDocuments(ids)
            : undefined,
          purgeCognition: (ids) => this.purgeAnnotationsFor(ids),
          acknowledge: (id, part) => w.acknowledgeAbsenceCascade(id, part),
        })
      : 0;

    // The source was wiped after this sync started — the writer
    // applied nothing (no docs, no cursor advance). Surface it so the
    // collector logs it; the next sync reads the empty cursor and
    // re-bootstraps cleanly.
    if (result.rejected && result.deletionDeferred) {
      // The writer found a fresh deletion this non-holder may not lead — the
      // item's history closed between this service's read and the write.
      // Nothing was applied; the collector replays the page for the holder.
      return {
        ingested: 0,
        reconciledDeleted: 0,
        tombstonedDeleted: 0,
        indexCleanedRows,
        rejected: true,
        reason: "lease",
        deletionDeferred: true,
      };
    }
    if (result.rejected) {
      log.warn(
        `upsertWithCursor for ${body.sourceId}: rejected stale write (source superseded mid-sync, epoch=${body.wipeEpoch}) — ${documents.length} docs not applied, cursor not advanced`,
      );
      return {
        ingested: 0,
        reconciledDeleted: 0,
        tombstonedDeleted: 0,
        indexCleanedRows,
        rejected: true as const,
      };
    }

    const acceptedDocuments = omitDocuments(documents, result.ignoredReplicaDocuments);

    if (meta?.urlPatterns) {
      invalidateUrlPatternCache();
    }

    if (acceptedDocuments.length > 0) this.deps.indexerWake?.();

    if (wantEmit) {
      await events.emitDocumentUpserted(acceptedDocuments, beforeProjections, beforeContents, {
        [body.sourceId]: args.streamId ?? "",
      });
    }

    if (this.deps.onDocumentsUpserted && acceptedDocuments.length > 0) {
      const bySource = new Map<string, number>();
      for (const doc of acceptedDocuments) {
        bySource.set(doc.sourceId, (bySource.get(doc.sourceId) ?? 0) + 1);
      }
      for (const [sourceId, count] of bySource) {
        this.deps.onDocumentsUpserted(sourceId, count);
      }
    }

    const disputed = result.disputedDeletions ?? [];
    if (disputed.length > 0) {
      const named = disputed.slice(0, 3).join(", ") + (disputed.length > 3 ? ", …" : "");
      const line =
        `upsertWithCursor for ${body.sourceId}: ${disputed.length} deletion${disputed.length === 1 ? "" : "s"} asserted by device ${args.replicaClaimDeviceId} kept in dispute (${named})` +
        ` — another replica still holds the item${disputed.length === 1 ? "" : "s"}; nothing was deleted and no sibling was reset`;
      if ((result.newlyDisputedDeletions ?? 0) > 0) log.info(line);
      else log.debug(line);
    }

    this.logSyncPage(body.sourceId, {
      ingested: acceptedDocuments.length,
      tombstoned: cascadeDeletedDocumentIds.length,
      indexCleanedRows,
      absence,
    });

    return {
      ingested: acceptedDocuments.length,
      // Older collectors add this field to every page's deletion counter.
      // Omitting it turns the counter into NaN even on pages with no snapshot.
      reconciledDeleted: 0,
      tombstonedDeleted: cascadeDeletedDocumentIds.length,
      indexCleanedRows,
      ...(absence ? { absence } : {}),
      ...(reconcileDeferred ? { reconcileDeferred: true as const } : {}),
      ...(disputed.length > 0 ? { deletionDisputed: disputed.length } : {}),
    };
  }

  /**
   * The thresholds an absence must clear before it deletes, read fresh from
   * the live config so an operator can widen the window on a source that is
   * misbehaving without restarting the gateway.
   */
  private absencePolicy(): SnapshotAbsencePolicy {
    const settings = resolveRuntimeSettings(this.deps.configStore?.get() ?? this.deps.config);
    return {
      minObservations: settings.snapshotAbsenceMinObservations,
      minAgeMs: settings.snapshotAbsenceMinAgeMs,
      maxMarksPerSnapshot: settings.snapshotAbsenceMaxMarksPerSnapshot,
    };
  }

  /**
   * One line per sync page, at a level that matches what the page did.
   *
   * A page that removed rows or that read strangely is reported at info: a
   * mass absence and a snapshot naming documents the corpus does not hold are
   * both indistinguishable from a healthy no-op in every other respect, so the
   * numbers are the only thing that can tell them apart. A snapshot that omits
   * everything the source has is loud:
   * that is the exact shape of an impoverished read, and the operator should
   * see it in the window before the deadline runs out, not after.
   */
  private logSyncPage(
    sourceId: string,
    page: {
      ingested: number;
      tombstoned: number;
      indexCleanedRows: number;
      absence?: SnapshotAbsenceOutcome;
    },
  ): void {
    const a = page.absence;
    const head = `upsertWithCursor for ${sourceId}: +${page.ingested} docs, -${page.tombstoned} tombstoned`;
    if (a === undefined) {
      if (page.tombstoned > 0) {
        log.info(
          `${head} (cleaned ${page.indexCleanedRows} chunk row${page.indexCleanedRows === 1 ? "" : "s"})`,
        );
      } else {
        log.debug(`${head}, cursor advanced`);
      }
      return;
    }
    const snapshot =
      `snapshot named ${a.snapshot} of ${a.stored} stored` +
      `, ${a.absent} absent (${a.marked} marked, ${a.cleared} cleared` +
      (a.deferred > 0 ? `, ${a.deferred} deferred past the mark ceiling` : "") +
      `), ${a.missing} named but not stored`;
    if (a.stored > 0 && a.absent === a.stored) {
      log.warn(
        `${head}; ${snapshot} — the snapshot omits every document this source has. Nothing was deleted: the absences carry a deadline and are dropped if a later snapshot names them again.`,
      );
      return;
    }
    if (a.absent > 0 || a.missing > 0 || page.tombstoned > 0) {
      log.info(`${head}; ${snapshot}`);
      return;
    }
    log.debug(`${head}; ${snapshot}`);
  }

  /**
   * Snapshot reconcile: record what a source's snapshot says is gone.
   *
   * The diff runs off the writer when an IO gate is wired; the resulting plan
   * is bounded by the policy's mark ceiling, so the writer's work is a fixed
   * number of short statements whatever the size of the source. Nothing is
   * deleted here — an omission carries a deadline, and the absence sweep is
   * what spends it.
   *
   * The wipe epoch fences the whole operation: a wipe and re-bootstrap
   * racing this read must not mark fresh bootstrap documents as absent on the
   * strength of a snapshot taken before the wipe.
   */
  async reconcile(
    providerId: string,
    sourceId: string,
    presentExternalIds: string[],
    writeEpoch?: number,
    enforceWriteEpoch = false,
    /** The cursor row `writeEpoch` was claimed on (`""` = shared). */
    cursorRow = "",
    /** The stream the snapshot describes (`""` = the source's one stream). */
    streamId = "",
    /** Stable identity of this completed snapshot; retries add no evidence. */
    observationId?: string,
    /**
     * The replicated member whose snapshot this is. Its omissions of items it
     * keeps alive against another member's deletion are counted, and the ones
     * that mature are applied as that member's verdict. Unset for every other
     * source.
     */
    replicaClaimDeviceId?: string,
    /**
     * The partitions this snapshot vouches for, when the source enumerated
     * some of its stores and not others. Unset means the enumeration covers
     * the whole source, which is what every source said before partitions
     * existed and what a source with one backing store still says.
     */
    claimedPartitions?: readonly string[],
    assertSourceWireAuthority?: () => void,
  ): Promise<{
    deleted: number;
    deletedIds: string[];
    absence?: SnapshotAbsenceOutcome;
    deletionDisputed?: number;
  }> {
    const reconcile = async () => {
      assertSourceWireAuthority?.();
      const { writeGate: w, ioGate, indexWriteGate } = this.deps;
      const currentWriteEpoch = getWipeEpoch(this.deps.db, sourceId, cursorRow);
      if (
        enforceWriteEpoch &&
        (writeEpoch !== undefined || currentWriteEpoch > 0) &&
        writeEpoch !== currentWriteEpoch
      ) {
        return { deleted: 0, deletedIds: [] };
      }
      const policy = this.absencePolicy();
      const scope = { streamId, observationId, observedBy: cursorRow, claimedPartitions };
      const plan = await runWithPriority("background", async () =>
        ioGate
          ? ioGate.snapshotAbsencePlan(providerId, sourceId, presentExternalIds, policy, scope)
          : computeSnapshotAbsencePlan(
              this.deps.db,
              providerId,
              sourceId,
              presentExternalIds,
              policy,
              scope,
            ),
      );
      const applied = await runWithPriority("background", () =>
        w.applySnapshotAbsencePlan(plan, currentWriteEpoch, cursorRow),
      );
      const absence: SnapshotAbsenceOutcome = {
        marked: applied.marked,
        cleared: applied.cleared,
        absent: plan.absentCount,
        deferred: plan.deferredCount,
        missing: plan.missingCount,
        stored: plan.storedCount,
        snapshot: plan.snapshotCount,
      };
      // A snapshot removes nothing directly; the absence sweep reports what it
      // removes. The one exception is a replicated member's own restore: an item
      // it keeps alive and has stopped naming, once its omission is corroborated,
      // is deleted here as that member's verdict.
      let deletedIds: string[] = [];
      let deletionDisputed: number | undefined;
      if (replicaClaimDeviceId !== undefined) {
        const restored = listRestoredExternalIdsByDevice(
          this.deps.db,
          providerId,
          sourceId,
          replicaClaimDeviceId,
        );
        // Same rule as the cursor path: a partition-scoped snapshot gives no
        // verdict about the partitions it did not name.
        if (restored.length > 0 && claimedPartitions === undefined) {
          const present = new Set(presentExternalIds);
          const outcome = await runWithPriority("background", () =>
            w.applyReplicaOmissions({
              providerId,
              sourceId,
              deviceId: replicaClaimDeviceId,
              restorerSnapshot: {
                named: restored.filter((id) => present.has(id)),
                omitted: restored.filter((id) => !present.has(id)),
              },
              absencePolicy: policy,
              wipeEpoch: currentWriteEpoch,
              cursorRow,
              streamId,
            }),
          );
          deletedIds = outcome.deletedDocumentIds;
          if (indexWriteGate && deletedIds.length > 0) {
            await indexWriteGate.deleteChunksByDocuments(deletedIds);
          }
          await this.purgeAnnotationsFor(deletedIds);
          if (outcome.disputed.length > 0) deletionDisputed = outcome.disputed.length;
        }
      }
      this.logSyncPage(sourceId, {
        ingested: 0,
        tombstoned: deletedIds.length,
        indexCleanedRows: 0,
        absence,
      });
      return {
        deleted: deletedIds.length,
        deletedIds,
        absence,
        ...(deletionDisputed === undefined ? {} : { deletionDisputed }),
      };
    };
    return this.deps.sourceWriteEpochFence
      ? this.deps.sourceWriteEpochFence.run(epochScope(sourceId, cursorRow), reconcile)
      : reconcile();
  }

  deleteAllBySource(
    sourceId: string,
    assertSourceWireAuthority?: () => void,
  ): Promise<{ deleted: number; analyticsDropped: string[] }> {
    return this.deps.sourceDataRemoval.deleteSource(sourceId, assertSourceWireAuthority);
  }

  deleteAllByProvider(
    providerId: string,
    assertSourceWireAuthority?: () => void,
  ): Promise<{ deleted: number }> {
    return this.deps.sourceDataRemoval.deleteProvider(providerId, assertSourceWireAuthority);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Read-side passthroughs (routes only call services).
  // Each method is a 1-line forward to the canonical helper in `db.ts` /
  // `links.ts`; the service exists so routes don't import those modules
  // directly. New cross-cutting concerns (caching, audit, request-id
  // correlation) land here once instead of per-route.
  // ───────────────────────────────────────────────────────────────────────

  count(sourceId: string) {
    return getDocumentCount(this.deps.db, sourceId);
  }

  sourceStats(sourceId: string) {
    return getSourceStats(this.deps.db, sourceId);
  }

  sourceStatsBulk(sourceIds: string[]) {
    return getSourceStatsBulk(this.deps.db, sourceIds);
  }

  recent(sourceId: string, limit: number, before?: { sourceCreatedAt: string; id: string }) {
    return getRecentDocuments(this.deps.db, sourceId, limit, before);
  }

  async recentPage(
    sourceId: string,
    limit: number,
    cursor?:
      | { kind: "documents"; sourceCreatedAt: string; id: string }
      | { kind: "analytics"; table: string; after: AnalyticsRecentCursor },
  ) {
    if (!cursor || cursor.kind === "documents") {
      const probe = getRecentDocuments(
        this.deps.db,
        sourceId,
        limit + 1,
        cursor?.kind === "documents" ? cursor : undefined,
      );
      if (probe.length > 0 || cursor?.kind === "documents") {
        return {
          kind: "documents" as const,
          items: probe.slice(0, limit),
          hasMore: probe.length > limit,
        };
      }
    }

    const analyticsDb = this.deps.analyticsDb;
    if (!analyticsDb) return { kind: "empty" as const };
    const catalog = await analyticsDb.getCatalog();
    const { sourceType } = parseSourceKey(sourceId);
    const candidates = catalog.filter(
      (table) =>
        (table.sourceId === sourceId || table.sourceId === sourceType) && table.recordCount > 0,
    );
    if (candidates.length === 0) return { kind: "empty" as const };
    candidates.sort((a, b) => b.recordCount - a.recordCount);
    const best =
      cursor?.kind === "analytics"
        ? candidates.find((entry) => entry.tableName === cursor.table)
        : candidates[0];
    if (!best) throw new BadRequestError("Invalid pagination cursor");
    try {
      const result = await analyticsDb.getRecentRows(
        best.tableName,
        limit + 1,
        cursor?.kind === "analytics" ? cursor.after : undefined,
      );
      const hasMore = result.rows.length > limit;
      return {
        kind: "analytics" as const,
        table: best.tableName,
        displayName: best.displayName,
        columns: result.columns,
        columnDefs: best.columns,
        rows: result.rows.slice(0, limit),
        next: hasMore ? (result.cursors[limit - 1] ?? null) : null,
        hasMore,
      };
    } catch (error) {
      if (error instanceof InvalidAnalyticsRecentCursorError) {
        throw new BadRequestError("Invalid pagination cursor");
      }
      throw error;
    }
  }

  list(opts: Parameters<typeof listDocuments>[1]) {
    // The HTTP listing hides hidden-from-general-search system sources
    // (see search/hidden-sources.ts) unless explicitly included; the
    // indexer's feed calls `listDocuments` directly and stays unfiltered
    // — those documents are indexed, just not listed.
    const excludeSourceIds = withHiddenSourcesExcluded(
      opts?.excludeSourceIds,
      opts?.includeSourceIds,
    );
    return listDocuments(this.deps.db, { ...opts, excludeSourceIds });
  }

  listIds() {
    return listDocumentIds(this.deps.db);
  }

  checkExistingExternalIds(
    providerId: string,
    sourceId: string,
    externalIds: string[],
    streamId = "",
  ) {
    return checkExistingExternalIds(this.deps.db, providerId, sourceId, externalIds, streamId);
  }

  /**
   * Resolve a batch of source URLs to documentIds. Returns a map keyed
   * by the *original* URL the caller sent; the value is the list of
   * every row that matched (multiple rows can share a source_url —
   * e.g. an email and its attachments). URL canonicalization is
   * applied internally using the current per-source registry, so
   * callers don't need to canonicalize before sending. Used by the
   * eval-toolkit `doctor` command.
   */
  lookupDocumentIdsBySourceUrl(urls: readonly string[]) {
    return lookupDocumentIdsBySourceUrl(this.deps.db, urls, getUrlCanonicalizers());
  }

  getRefs(id: string) {
    return getDocumentRefs(this.deps.db, id);
  }

  getRefsPage(
    id: string,
    direction: "inbound" | "outbound",
    options: { limit: number; afterSortId?: number },
  ) {
    return getDocumentRefsPage(this.deps.db, id, direction, options);
  }

  resolveIdPrefix(idPrefix: string): string[] {
    return this.deps.db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE id LIKE ? LIMIT 2")
      .all(`${idPrefix}%`)
      .map((row) => row.id);
  }

  listAnnotations(
    documentId: string,
    options: {
      limit: number;
      before?: { createdAt: number; id: string };
      includeDependents: boolean;
    },
  ): {
    items: Array<{
      id: string;
      claimType: string;
      claimText: string;
      evidenceDocId: string;
      evidenceQuote: string;
      confidence: number;
      claimBasis: string;
      createdAt: string;
      verificationState: string | null;
      lastVerifiedAt: string | null;
      dependentCount: number;
      dependents?: Array<{ kind: "brief" | "loop"; id: string; title: string }>;
      sortCreatedAt: number;
    }>;
    hasMore: boolean;
  } {
    const probe = listLiveAnnotationsForDoc(this.deps.db, documentId, {
      limit: options.limit + 1,
      ...(options.before ? { before: options.before } : {}),
    });
    const hasMore = probe.length > options.limit;
    const annotations = hasMore ? probe.slice(0, options.limit) : probe;
    return {
      hasMore,
      items: annotations.map((annotation) => {
        const dependents = options.includeDependents
          ? listLiveDependentsForAnnotation(this.deps.db, "doc", annotation.id)
          : null;
        return {
          id: annotation.id,
          claimType: annotation.claimType,
          claimText: annotation.claimText,
          evidenceDocId: annotation.evidenceDocId,
          evidenceQuote: annotation.evidenceQuote,
          confidence: annotation.confidence,
          claimBasis: annotation.claimBasis,
          createdAt: new Date(annotation.createdAt).toISOString(),
          verificationState: annotation.verificationState,
          lastVerifiedAt:
            annotation.lastVerifiedAt === null
              ? null
              : new Date(annotation.lastVerifiedAt).toISOString(),
          dependentCount:
            dependents?.length ??
            countLiveDependentsForAnnotation(this.deps.db, "doc", annotation.id),
          ...(dependents
            ? {
                dependents: dependents.map((dependent) => ({
                  kind: dependent.kind,
                  id: dependent.id,
                  title: dependent.title,
                })),
              }
            : {}),
          sortCreatedAt: annotation.createdAt,
        };
      }),
    };
  }

  /** Provenance-annotated edges incident to a document, plus pending forward refs. */
  getEdges(id: string) {
    return getDocumentEdges(this.deps.db, id);
  }

  /**
   * Near-duplicate edges for a document, produced by the near-dup
   * pipeline (`packages/gateway/src/near-dupes/`). Read-only — runs on
   * the gateway's read handle without a writer-worker hop.
   */
  getNearDupes(id: string, opts: { limit?: number; cursor?: string | null } = {}) {
    return getNearDupEdges(this.deps.db, id, opts);
  }

  getLinkStats() {
    return getLinkStats(this.deps.db);
  }

  /** Claim write authority on one cursor row (`""` = shared, else a member's own). */
  beginSyncAttempt(
    sourceId: string,
    attemptId?: string,
    cursorRow = "",
    assertSourceWireAuthority?: () => void,
  ): Promise<number | undefined> {
    return this.sourceSyncState.beginAttempt(
      sourceId,
      attemptId,
      cursorRow,
      assertSourceWireAuthority,
    );
  }

  revokeSyncAttempt(
    sourceId: string,
    expectedEpoch?: number,
    attemptId?: string,
    cursorRow = "",
    assertSourceWireAuthority?: () => void,
  ): Promise<boolean> {
    return this.sourceSyncState.revokeAttempt(
      sourceId,
      expectedEpoch,
      attemptId,
      cursorRow,
      assertSourceWireAuthority,
    );
  }

  setSourceMeta(
    sourceId: string,
    meta: SourceSyncMeta,
    assertSourceWireAuthority?: () => void,
  ): Promise<void> {
    return this.sourceSyncState.setMeta(sourceId, meta, assertSourceWireAuthority);
  }

  setLegacySyncState(
    sourceId: string,
    cursor: SyncCursor,
    meta: SourceSyncMeta,
    writeEpoch?: number,
    deviceId = "",
    assertSourceWireAuthority?: () => void,
  ): Promise<boolean> {
    return this.sourceSyncState.setLegacyState(
      sourceId,
      cursor,
      meta,
      writeEpoch,
      deviceId,
      assertSourceWireAuthority,
    );
  }

  /** One row of a source's sync state: `""` (shared) or a member device's own. */
  getSyncState(sourceId: string, deviceId = "") {
    return this.sourceSyncState.getState(sourceId, deviceId);
  }

  /** Current write epoch of one cursor row (0 if never claimed or wiped). */
  getWipeEpoch(sourceId: string, cursorRow = ""): number {
    return this.sourceSyncState.getEpoch(sourceId, cursorRow);
  }

  invalidateUrlPatternCache(): void {
    invalidateUrlPatternCache();
  }
}
