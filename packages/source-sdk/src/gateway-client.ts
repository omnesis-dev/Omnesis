// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AccountDescriptor } from "./account-descriptor.js";
import type { RowKey } from "./row-key.js";
import type { SnapshotClaim } from "./snapshot.js";
import type {
  DocumentInput,
  PersonMention,
  AccountId,
  SourceId,
  SourceType,
  ProviderId,
} from "@omnesis/types";
import type { SourceWatermark, SyncCursor } from "./source.js";
import type { PendingStructuredPage, PrepareStructuredPage } from "./pending-source-page.js";
import type {
  AnalyticsTableSchema,
  AnalyticsCatalogEntry,
  DocumentEventProfile,
  DocumentTemporalProjectionSpec,
} from "./structured-source.js";
import type { TranscriptionResult, OcrResult, EdgeDeclaration } from "@omnesis/core";
import type { OmnesisConfig } from "@omnesis/config";

/**
 * Search query sent to the gateway's POST /search endpoint.
 */
export interface GatewaySearchQuery {
  text: string;
  filters?: {
    sourceIds?: string[];
    documentTypes?: string[];
    dateFrom?: string;
    dateTo?: string;
    tags?: string[];
    /**
     * Person filters — one entry per filter intent (`from:`/`by:` →
     * sender/author/owner roles, `to:` → recipient/attendee, `with:` → any
     * role). Refs within an entry OR; multiple entries AND so a
     * caller can express "alice sends AND bob receives".
     */
    personFilters?: Array<{ refs: string[]; roles?: string[] }>;
  };
  limit?: number;
}

/**
 * Search response from the gateway's POST /search endpoint.
 */
export interface GatewaySearchResponse {
  results: Array<{
    documentId: string;
    sourceId: string;
    documentType: string;
    title: string;
    sourceUrl?: string;
    sourceCreatedAt: string;
    author?: string;
    chunkText: string;
    score: number;
    scoreBreakdown?: {
      bm25Rank?: number;
      vectorRank?: number;
      rrfScore?: number;
      typeBoost?: number;
      finalScore?: number;
    };
  }>;
  query: {
    original: string;
    parsedFilters?: Record<string, unknown>;
    effectiveText?: string;
  };
  timing: {
    totalMs: number;
    bm25Ms?: number;
    vectorMs?: number;
  };
  facets?: {
    byType?: Record<string, number>;
    bySource?: Record<string, number>;
  };
}

/**
 * Canonical document projection — the shape served by the gateway's
 * `/documents/list` HTTP endpoint AND the in-process indexer pipeline
 * (`gateway/src/indexer/types.ts:IndexableDocument` re-exports this).
 *
 * Per #386, the indexer's local `IndexableDocument`,
 * the HTTP DTO, and this type were three near-identical shapes that
 * drifted when fields were added to one without the others. They now
 * share this single declaration; field additions land in one place.
 *
 * `sourceId` is plain `string` (not the `SourceId` brand) because the
 * shape arrives over the wire as JSON and crosses the indexer worker
 * boundary as plain string — branding it would force casts at every
 * deserialization point without buying any safety.
 */
export interface ListedDocument {
  id: string;
  sourceId: string;
  title: string;
  content: string;
  contentHash: string;
  metadata: {
    documentType?: string;
    sourceUrl?: string;
    sourceCreatedAt: string;
    /**
     * Resolved person mentions parsed from the document at ingest
     * time. Populated by the gateway's `/documents/list` for portal
     * People-tab joins and used by the indexer's chunker as a chunk
     * preamble.
     */
    people?: PersonMention[];
    tags?: string[];
    /**
     * Optional relevance bias the source ingested with the doc
     * (e.g. browser-history visit rank).
     * The search pipeline's BoostStage multiplies the bm25/vector
     * score by this value when present.
     */
    relevanceScore?: number;
  };
  updatedAt: string;
}

/**
 * Options for listing documents with filtering and pagination.
 */
export interface ListDocumentsOptions {
  updatedSince?: string; // ISO 8601
  excludeSourceIds?: string[]; // exclude these source_ids
  limit?: number; // page size, default 100
  /** Opaque cursor from the previous page's `Page<T>.pageInfo.nextCursor`.
   *  Replaces the legacy `afterId` field (which the gateway no longer
   *  reads — kept here only as a deprecated alias for one cycle). */
  cursor?: string;
  /** @deprecated Use `cursor`. The gateway accepts `?cursor=` only after
   *  the Page<T> rollout. */
  afterId?: string;
}

/**
 * Stored sync state as returned by the gateway.
 */
export interface SourceSyncMeta {
  /** Discovery metadata; omission preserves descriptors reported by newer peers. */
  account?: AccountDescriptor;
  icon?: string;
  label?: string;
  urlPatterns?: Array<{ regex: string; idGroup?: number }>;
  bgColor?: string;
  accentColor?: string;
  contentRetention?: "complete" | "best-effort";
  /**
   * The display identity of the source's family — its definition's own name
   * and icon, before any per-instance override.
   *
   * Carried beside the source's own identity rather than pushed separately,
   * because a client that shows a source by type needs it from the moment the
   * first account of that type reports, and the two are the same declaration
   * read at two levels. It is deliberately not derivable from the fields
   * above: two accounts of one type legitimately differ, so a family assembled
   * from one of them is named after one of its members.
   */
  family?: SourceFamilyMeta;
}

/** See {@link SourceSyncMeta.family}. */
export interface SourceFamilyMeta {
  icon?: string;
  label?: string;
  bgColor?: string;
  accentColor?: string;
}

export interface SyncState {
  sourceId: SourceId;
  cursor: SyncCursor;
  lastSyncedAt: string; // ISO 8601
  hasMeta?: boolean;
  /**
   * The source's wipe epoch when this state was read. The collector echoes
   * it back on each cursor write so the gateway can reject a write from a
   * sync that began before a later wipe (#551). Absent on older gateways.
   */
  wipeEpoch?: number;
}

/**
 * Stats about documents for a specific source.
 */
export interface SourceStats {
  documentCount: number;
  earliestSourceDate: string | null;
  latestSourceDate: string | null;
  /** Sum of per-doc unit counts from metadata (e.g. message count for chat sources) */
  totalUnitCount: number | null;
  /** Total size of content + title + metadata in bytes */
  dataSizeBytes: number;
}

// ── Wire-shape responses ────────────────────────────────────────────────────
//
// One canonical TypeScript type for every gateway → collector / CLI response
// payload. Previously each `HttpGatewayClient` method re-extracted
// fields off `unknown` with `?? 0` / `?? []` defaults; a typo on the
// gateway side would turn into a silent zero on the wire instead of a
// loud error. Now both ends import the same shape.

/**
 * What a snapshot said about the corpus, and what the gateway did about it.
 *
 * A snapshot's omissions do not delete. Each one is recorded with a deadline —
 * several later snapshots must corroborate it, and a minimum span of time must
 * pass — and a snapshot that names the document again revokes the record. The
 * gateway's absence sweep is what eventually deletes, so a source sees its
 * omissions counted here, not applied.
 */
export interface SnapshotAbsenceOutcome {
  /** Absences recorded or corroborated by this snapshot. */
  marked: number;
  /** Pending absences the snapshot revoked by naming the document again. */
  cleared: number;
  /** Stored documents the snapshot omitted. */
  absent: number;
  /** Omissions left unrecorded because the snapshot hit the gateway's mark ceiling. */
  deferred: number;
  /** Ids the snapshot named that the gateway does not hold. */
  missing: number;
  /** Documents the gateway stores for this source and stream. */
  stored: number;
  /** Distinct ids the snapshot named. */
  snapshot: number;
}

/** POST /documents/reconcile response. */
export interface ReconcileResponse {
  /**
   * Documents the reconcile itself removed. A snapshot's omissions carry a
   * deadline instead of deleting, so this is 0; the gateway's absence sweep
   * reports what it eventually removes.
   */
  deleted: number;
  /** What the snapshot changed about this source's pending absences. */
  absence?: SnapshotAbsenceOutcome;
}

/** POST /documents/with-cursor response. */
export interface UpsertWithCursorResponse {
  /** Number of documents upserted (the body's `documents.length`). */
  ingested: number;
  /**
   * @deprecated Snapshot reconciliation no longer deletes inline. Kept at 0
   * on the wire while older collectors still add it to their sync counters.
   */
  reconciledDeleted: number;
  /** Documents actually removed through this page's explicit tombstones. */
  tombstonedDeleted?: number;
  /**
   * What the page's snapshot changed about this source's pending absences.
   * Absent when the body carried no `presentExternalIds`, when `hasMore` was
   * true, or when the page's device had no authority to reconcile.
   */
  absence?: SnapshotAbsenceOutcome;
  /**
   * True when another replica held deletion authority and at least one named
   * row still existed. The whole page is refused for replay; after an authority
   * holder resolves the tombstones, the retry is acknowledged as a no-op.
   */
  deletionDeferred?: true;
  /**
   * Explicit tombstones kept from taking effect because another replica
   * member still holds the item. The page was committed without them; the
   * items stay until every member that restored them agrees they are gone.
   */
  deletionDisputed?: number;
  /**
   * Number of `chunks` / `indexed_documents` rows the indexer-DB cleanup
   * cascade removed for this page's tombstoned documents; 0 when the page
   * tombstoned nothing or the gateway didn't wire an indexWriteGate.
   */
  indexCleanedRows: number;
  /** True when a newer sync attempt or wipe revoked this page's write authority. */
  rejected?: true;
  /** Why the page was refused when not by a newer attempt: the sync lease is another device's. */
  reason?: "lease";
  /** The device holding the lease when `reason` is `lease`. */
  holder?: string;
  /** True when durable source removal refused this page. */
  rejectedAsRemoved?: true;
  /** @deprecated Snapshot work is recorded in one bounded pass; retries are unnecessary. */
  retrySnapshot?: true;
}

/** GET /documents/count/:sourceId response. */
export interface DocumentCountResponse {
  count: number;
}

/** POST /documents/exists response. */
export interface DocumentExistsResponse {
  /** Subset of the requested externalIds that already exist in the store. */
  existingIds: string[];
}

/** POST /documents/delete-all/{source,provider}/:id response. */
export interface DeleteAllResponse {
  /** Total documents deleted by the cascade. */
  deleted: number;
}

/** GET /documents/ids response. */
export interface DocumentIdsResponse {
  ids: string[];
}

/** GET /db-size response. */
export interface DbSizeResponse {
  /** Bytes on disk for the gateway's main SQLite store. `null` when the
   *  file isn't present yet (e.g. before the first write). */
  sizeBytes: number | null;
}

/** One source rejected from a multi-source analytics page. */
export interface AnalyticsSourcePushRejection {
  sourceId: string;
  reason: "removed" | "paused";
}

/** POST /analytics/ingest response. */
export interface IngestAnalyticsResponse {
  /** Number of analytics rows the gateway accepted. */
  ingested: number;
  /** Number of explicit tombstones the page applied. */
  deleted?: number;
  /** What an analytics snapshot changed about pending row absences. */
  absence?: SnapshotAbsenceOutcome;
  /**
   * True when the page named a fresh deletion this replica may not lead: the
   * lease holder deletes what nobody has reported before. The page's rows
   * are kept; the page itself should be replayed once the holder has led.
   */
  deletionDeferred?: true;
  /** Tombstones kept from taking effect because another replica still holds the row. */
  deletionDisputed?: number;
  /** A whole-page lease rejection, or individual paused/removed sources. */
  rejected?: true | AnalyticsSourcePushRejection[];
  /** Why the page was refused. */
  reason?: "lease";
  /** The device holding the handoff lease when the page was refused. */
  holder?: string;
}

/** Whether the gateway refused the entire analytics page because its lease was lost. */
export function isAnalyticsLeaseRejection(
  response: IngestAnalyticsResponse,
): response is IngestAnalyticsResponse & { rejected: true; reason: "lease" } {
  return response.rejected === true && response.reason === "lease";
}

/**
 * Interface for communicating with the gateway.
 * The collector uses this to send documents and manage sync state.
 */
/**
 * One table's worth of a sync page, as the gateway ingests it.
 *
 * Rows to write, rows to delete and what the page vouches for, all addressed
 * by the columns the table declares as its delete key — never by a column the
 * page chose, which is how one table came to be addressed two ways.
 */
export interface AnalyticsPageIngest {
  pendingPageId?: string;
  writeOrdinal?: number;
  tableName: string;
  records: Record<string, unknown>[];
  /** The table's shape, when the page creates or evolves it. */
  schema?: AnalyticsTableSchema;
  /** The source these rows belong to; the host scopes the write to it. */
  sourceId?: string;
  /** Rows to delete, each a key over the table's delete key. */
  deletedKeys?: RowKey[];
  /**
   * Every row present upstream, on a final page that enumerated the table in
   * full. Omitted means no snapshot; `[]` means the table is empty.
   */
  presentKeys?: RowKey[];
  /**
   * The single-column spellings of the two fields above.
   *
   * Forwarded rather than resolved here on purpose: a producer does not always
   * hold the table's schema — a phone pushing rows never does, and a collector
   * only holds one for a table its source declared or re-sent this page. The
   * gateway always has the persisted schema, so it is the one place that can
   * say which columns address the table, and it normalises there.
   *
   * @deprecated Send `deletedKeys` / `presentKeys`.
   */
  deletedIds?: string[];
  /** @deprecated The delete key belongs to the table, not to a page. */
  deleteKeyColumn?: string;
  /** @deprecated See {@link deletedIds}. */
  presentIds?: string[];
  /** The write epoch this sync attempt claimed; a stale one is refused. */
  writeEpoch?: number;
  /** Stable identity of this completed snapshot; duplicate delivery adds no evidence. */
  observationId?: string;
}

export interface GatewayClient {
  /** Send a batch of documents to the gateway for upserting */
  upsertDocuments(documents: DocumentInput[]): Promise<void>;

  /**
   * Transcribe source audio (e.g. a WhatsApp voice note) via the gateway's
   * locally-hosted speech-to-text model. The bytes are sent over the wire and
   * held only for the request — nothing is persisted. Returns null when
   * transcription is disabled, no transcriber is configured, or it failed —
   * best-effort, so it never throws and never blocks a sync.
   */
  transcribe(
    audio: Uint8Array,
    mimeType: string,
    opts?: { language?: string },
  ): Promise<TranscriptionResult | null>;

  /**
   * Recognize text in an image (or scanned PDF) attachment via the gateway's
   * locally-hosted / self-hosted OCR backend. The bytes are sent over the wire
   * and held only for the request — nothing is persisted. Returns null when OCR
   * is disabled, no backend is configured, or no text was found — best-effort,
   * so it never throws and never blocks a sync.
   */
  ocr(
    image: Uint8Array,
    mimeType: string,
    opts?: { language?: string; pages?: number[] },
  ): Promise<OcrResult | null>;

  /** Mark documents as deleted in the gateway */
  deleteDocuments(providerId: ProviderId, sourceId: SourceId, externalIds: string[]): Promise<void>;

  /**
   * Reconcile the gateway's known external_ids against a snapshot of
   * currently-present IDs in the source-of-truth. Anything in the gateway but
   * missing from the snapshot has its absence recorded with a deadline; the
   * gateway's absence sweep deletes it once several later snapshots have
   * agreed and enough time has passed.
   *
   * Caller must still guarantee the snapshot is complete for the given source:
   * the deadline buys back a bad read that recovers, not one that persists.
   * Returns the number deleted inline (always 0 under the deadline contract),
   * preserving the original numeric API. Use `reconcileSnapshotAbsence` when
   * the diagnostic outcome is needed.
   */
  reconcileSnapshot(
    providerId: ProviderId,
    sourceId: SourceId,
    presentExternalIds: string[],
  ): Promise<number>;

  /**
   * Snapshot outcome companion for callers that need absence diagnostics.
   * Optional so existing GatewayClient implementations remain source-compatible.
   */
  reconcileSnapshotAbsence?(
    providerId: ProviderId,
    sourceId: SourceId,
    presentExternalIds: string[],
  ): Promise<SnapshotAbsenceOutcome | undefined>;

  /** Get the document count for a specific source */
  getDocumentCount(sourceId: SourceId): Promise<number>;

  /** Get stats (date range, message counts) for a specific source */
  getSourceStats(sourceId: SourceId): Promise<SourceStats>;

  /** Get the last sync state for a source */
  getSyncState(sourceId: SourceId): Promise<SyncState | null>;
  /**
   * The source's current wipe epoch, independent of whether it has a cursor.
   *
   * `getSyncState` returns null once a resync or removal has cleared the
   * cursor — which is exactly when the epoch matters, because the next sync
   * bootstraps from scratch and its writes must still be rejected if another
   * wipe lands underneath it. Reading it separately is what keeps #551's guard
   * armed across the wipe it was built for.
   */
  getWipeEpoch(sourceId: SourceId): Promise<number | undefined>;

  /**
   * Claim a new per-source write epoch. Optional for compatibility with older
   * gateways, which only fence writes across explicit source wipes.
   */
  beginSyncAttempt?(
    sourceId: SourceId,
    options?: { signal?: AbortSignal; attemptId?: string },
  ): Promise<number | undefined>;
  /** Revoke exactly one timed-out attempt; no-op after a newer claim. */
  revokeSyncAttempt?(sourceId: SourceId, writeEpoch?: number, attemptId?: string): Promise<boolean>;
  /**
   * Claim the sync lease on a handoff or replicated source before syncing
   * it. Optional for compatibility with gateways that have no lease; a
   * refusal names the holder.
   */
  claimSyncLease?(
    sourceId: SourceId,
    options?: { signal?: AbortSignal },
  ): Promise<{ granted: boolean; holder?: string; reason?: string; expiresAt?: number }>;
  /** Give the sync lease up so another member's next tick takes it. */
  releaseSyncLease?(sourceId: SourceId): Promise<boolean>;
  /** Run provider work with an attempt epoch inherited by direct analytics writes. */
  runWithSourceWriteEpoch?<T>(
    sourceId: SourceId,
    writeEpoch: number,
    operation: () => Promise<T>,
  ): Promise<T>;

  /** @deprecated Cursor writes belong in `upsertWithCursor`. */
  setSyncState(sourceId: SourceId, cursor: SyncCursor, meta?: SourceSyncMeta): Promise<void>;
  getPendingStructuredPage?(sourceId: SourceId): Promise<PendingStructuredPage | null>;
  prepareStructuredPage?(
    sourceId: SourceId,
    page: PrepareStructuredPage,
  ): Promise<PendingStructuredPage>;
  acknowledgeStructuredPage?(
    sourceId: SourceId,
    page: { id: string; writeEpoch: number },
  ): Promise<{ acknowledged: boolean }>;
  /** Refresh source display/query metadata without reading or rewriting its cursor. */
  setSourceMeta?(sourceId: SourceId, meta: SourceSyncMeta): Promise<void>;

  /**
   * Push the full list of per-source URL canonicalizers to the gateway.
   * Called once on collector startup. Each entry maps a list of
   * hostnames to ordered regex rewrite rules. The gateway holds the
   * registry in memory and applies it during ingest and `/documents/by-url`
   * lookups, keeping all source-specific URL knowledge inside the
   * source packages.
   */
  setUrlCanonicalizers(
    canonicalizers: Array<{
      hosts: string[];
      rules: Array<{ match: string; replacement: string }>;
    }>,
  ): Promise<void>;
  setLinkDeclarations(input: {
    canonicalizers: Array<{
      hosts: string[];
      rules: Array<{ match: string; replacement: string }>;
    }>;
    traversalHubPrefixes: string[];
    fallbackRepresentationPrefixes: string[];
    referenceOnlyPrefixes: string[];
    patterns: Array<{ regex: string }>;
  }): Promise<void>;

  /**
   * Push the per-source-type score priors declared by every loaded
   * source. Called once on collector startup. Each entry maps a
   * source-type prefix (e.g. `"browser-history"`) to its additive
   * search-score adjustment. The gateway merges these with the user's
   * `search.sourcePriors.weights` in `omnesis.json` — user keys win.
   * Replaces the collector-declared layer; built-in gateway defaults
   * are preserved.
   */
  setSourcePriorDefaults(entries: Array<{ sourceIdPrefix: string; weight: number }>): Promise<void>;

  /**
   * Push the complete descriptor-derived URL role sets. Called once on
   * collector startup. Traversal hubs suppress noisy graph pivots; fallback
   * representations and reference-only documents independently control URL
   * target selection and retroactive repair.
   */
  setUrlGraphRoles(
    prefixes: string[],
    fallbackRepresentationPrefixes: string[],
    referenceOnlyPrefixes: string[],
  ): Promise<void>;

  /** @deprecated Use setUrlGraphRoles. */
  setUrlHubSources(prefixes: string[]): Promise<void>;

  /**
   * Declare the self-identity hooks of the sources this collector hosts,
   * from `defineSource.selfIdentity`. Called on collector startup and
   * after every source add. Each entry maps a source-type prefix to the LID
   * alias shape its normalizer emits on the user's self-authored documents.
   * The gateway merges entries by source type across collectors — a push is
   * complete for this collector and never erases what a sibling declared —
   * and runs its self-detection pass to resolve those PersonMentions to the
   * self person without branching on a source name.
   */
  declareSelfIdentitySources(
    entries: Array<{ sourceType: string; aliasPrefix: string; accountPattern?: string }>,
  ): Promise<void>;

  /**
   * Push the url-id patterns declared by every KNOWN source type (every
   * loaded source definition's `urlPatterns`), not just the added ones.
   * Called once on collector startup. The gateway holds the set in memory
   * and uses it as the link-extraction keep-gate so an unresolved `url`
   * link whose target matches a known source type survives — and resolves
   * once that source is added and ingested, instead of being dropped
   * permanently (#668). Replaces the collector-declared layer.
   */
  setKnownUrlPatterns(patterns: Array<{ regex: string }>): Promise<void>;

  /**
   * Push the union of every KNOWN source type's `ownedWebDomains` (every
   * loaded source definition's declared web hosts), not just the added ones.
   * Called once on collector startup. The gateway holds the set in memory and
   * serves it on the public `GET /owned-web-domains` route; the
   * browser-capture source (#791) fetches the union and skips any visited
   * host already owned by another source. Replaces whatever was previously
   * registered.
   */
  setOwnedWebDomains(domains: string[]): Promise<void>;

  /**
   * Push the `documentEventProfile` of every KNOWN source type (every loaded
   * source definition's declaration), not just the added ones. Called once on
   * collector startup. The gateway PERSISTS the set so subscription
   * compilation can project a source's queryable document surface — document
   * types, populated person roles, metadata fields and their vocabularies —
   * without the compiler holding any source-specific knowledge. Replaces
   * whatever was previously stored.
   */
  setDocumentEventProfiles(
    entries: Array<{ sourceType: string; profile: DocumentEventProfile }>,
  ): Promise<void>;

  /**
   * Push the union of external widget-vendor origins declared by every KNOWN
   * `link-widget` source (every loaded source descriptor's `widgetOrigins`),
   * not just the added ones. Called once on collector startup. The gateway
   * holds the aggregate in memory and folds it into the portal's
   * Content-Security-Policy so a source's hosted widget (Plaid Link, …) can
   * load its vendor SDK and iframe in the browser — which the portal's
   * otherwise strict, zero-external-load CSP forbids. Replaces whatever was
   * previously registered.
   */
  setWidgetOrigins(origins: {
    script: string[];
    frame: string[];
    connect: string[];
  }): Promise<void>;

  /**
   * Push the hosted-widget renderer modules declared by every KNOWN
   * `link-widget` source/provider. Called once on collector startup. The
   * gateway serves each registered provider-owned module under a same-origin
   * `/portal/widget-renderers/*` URL, and the portal imports by opaque widget
   * `kind` without naming the vendor.
   */
  setWidgetRenderers(renderers: Array<{ kind: string; modulePath: string }>): Promise<void>;

  /**
   * Re-derive `source_url` on every existing document row using the
   * currently-registered canonicalizers. Idempotent. Useful right after
   * `setUrlCanonicalizers` for installs whose documents were ingested
   * before the canonicalizers were known.
   */
  recomputeSourceUrls(): Promise<void>;

  /**
   * Atomic per-page sync write (issue #322). Bundles upserts +
   * tombstones + snapshot reconcile + cursor advance into one
   * gateway-side SQLite transaction. Replaces the prior four-step
   * `upsertDocuments → deleteDocuments → reconcileSnapshot →
   * setSyncState` sequence in the collector — closes the
   * at-least-once gap where the cursor could lag the documents on a
   * partial failure.
   *
   * The snapshot-reconcile field (`presentExternalIds`) is only
   * consumed on the final page (`hasMore=false`); a partial-page
   * snapshot names a fraction of what exists, so every document not on
   * it would be recorded as absent. The gateway enforces this
   * defence-in-depth too, but the collector should only set it when
   * the source's snapshot enumeration is complete.
   */
  upsertWithCursor(args: {
    providerId: ProviderId;
    sourceId: SourceId;
    documents?: DocumentInput[];
    /**
     * Authoritative source-owned projections over typed document dates.
     * Send an empty list to explicitly declare that this source owns none.
     */
    documentTemporalProjections?: DocumentTemporalProjectionSpec[];
    deletedExternalIds?: string[];
    presentExternalIds?: string[];
    /** See `SyncResult.presentClaims`. Mutually exclusive with the above. */
    presentClaims?: SnapshotClaim[];
    /** Stable identity of this completed attempt for replay-safe snapshot evidence. */
    observationId?: string;
    /** Source-declared structural edges for this page (#430). */
    edges?: EdgeDeclaration[];
    hasMore: boolean;
    cursor: SyncCursor;
    /** Wipe epoch read at sync start; lets the gateway reject stale writes (#551). */
    wipeEpoch?: number;
    pendingPageId?: string;
    /**
     * Forward-looking consent / authorization deadline (ISO 8601) the source
     * reported on this page; persisted on the sync state so the gateway can
     * derive a non-terminal `auth-expiring` warning ahead of the deadline (#927).
     * `null` clears a previously-stored deadline; omitted leaves it unchanged.
     */
    consentExpiresAt?: string | null;
    watermark?: SourceWatermark;
    meta?: Omit<SourceSyncMeta, "contentRetention">;
  }): Promise<UpsertWithCursorResponse>;

  /** List documents with filtering and pagination. The wire envelope is
   *  the canonical `Page<T>` — the implementation re-shapes
   *  it into this `{ documents, hasMore, nextCursor }` tuple for the
   *  existing collector consumers. New callers should prefer reading
   *  `pageInfo.nextCursor` style (and we'll migrate this interface in a
   *  follow-up). */
  listDocuments(
    opts: ListDocumentsOptions,
  ): Promise<{ documents: ListedDocument[]; hasMore: boolean; nextCursor?: string }>;

  /** Check which external IDs already exist in the gateway */
  checkExistingExternalIds(
    providerId: ProviderId,
    sourceId: SourceId,
    externalIds: string[],
  ): Promise<string[]>;

  /** Delete all documents and sync state for a source */
  deleteAllBySource(sourceId: SourceId): Promise<number>;

  /** Delete all documents and sync state for a provider */
  deleteAllByProvider(providerId: ProviderId): Promise<number>;

  /** Get all document IDs (for deletion reconciliation by indexer) */
  listDocumentIds(): Promise<string[]>;

  /** Get the database file size in bytes */
  getDbSize(): Promise<number | null>;

  /** Get indexing stats (per-source indexed/total counts) */
  getIndexStats(): Promise<IndexStats | null>;

  /** Hybrid search via the search pipeline */
  search(query: GatewaySearchQuery): Promise<GatewaySearchResponse>;

  /**
   * Ingest one table's worth of a page into DuckDB.
   *
   * One argument rather than nine positions, because the rows, the deletions
   * and the snapshot are one page's worth of one table and are only correct
   * together: a caller that passes them separately can leave a gap in the
   * middle of the list and shift every field after it.
   */
  ingestAnalyticsPage(page: AnalyticsPageIngest): Promise<IngestAnalyticsResponse>;

  /** Get the analytics catalog (available tables) */
  getAnalyticsCatalog(): Promise<AnalyticsCatalogEntry[]>;

  /**
   * Read-only SQL query against the gateway's analytics DuckDB. Used by
   * enrichment-style sources that enumerate already-ingested rows lacking a
   * given enrichment stamp, rather than re-walking the upstream every cycle.
   * Returns `{ columns, rows }` shaped like the underlying DuckDB result.
   *
   * `sourceId` narrows the query to the tables that source owns, and the
   * gateway resolves which those are — a caller cannot widen its own scope by
   * naming a different source's id than the tables it goes on to read. Omit it
   * for the operator's own SQL surfaces, which reach the whole database.
   */
  queryAnalytics(
    sql: string,
    limit?: number,
    sourceId?: string,
  ): Promise<{ columns: string[]; rows: Record<string, unknown>[] }>;

  /** Fetch the config view (shape: `{ config, version }`). */
  getConfig(): Promise<{ config: OmnesisConfig; version: number }>;

  /**
   * Register (or update) a batch of sources owned by this device in the
   * gateway's `sources` table. Called from the collector after `addSources`
   * so the portal / iOS see the source in `/admin/sources` —
   * without this step the source only appears in the in-memory sync-status
   * registry and gets filtered out as "orphan drift".
   *
   * Hits `POST /devices/sources/bulk-upsert`. Idempotent: existing rows are
   * updated in place (device re-homing + config/enabled patch); new rows
   * are inserted.
   */
  bulkUpsertSources(
    sources: Array<{
      /** Optional explicit ID for singleton sources. */
      id?: SourceId;
      type: SourceType;
      accountId: AccountId;
      /**
       * What the source declares about this account. Omitted when it declares
       * nothing, which is most of them.
       */
      account?: AccountDescriptor;
      config?: Record<string, unknown>;
      memberConfig?: Record<string, unknown>;
      enabled?: boolean;
    }>,
  ): Promise<{
    count: number;
    sources: Array<{ id: string; updated: boolean; memberConfigApplied?: boolean }>;
    /**
     * Per-entry rejections (e.g. the source is hosted by another device).
     * The call succeeds with partial results; callers registering specific
     * accounts must check their entries actually landed.
     */
    errors: Array<{ entry: unknown; error: string }>;
  }>;

  /** Health check */
  ping(): Promise<boolean>;
}

/**
 * Indexing stats returned by the gateway.
 */
export interface IndexStats {
  enabled: boolean;
  totalIndexed: number;
  totalChunks: number;
  totalGatewayDocs: number;
  /** Documents indexed with some chunks truncated and/or dropped to fit the embedder. */
  totalDegraded?: number;
  totalTruncatedChunks?: number;
  totalDroppedChunks?: number;
  watermark: string | null;
  /**
   * The double-buffered index generations (epic #1011), computed entirely in
   * the gateway so clients render this neutral payload with no inference. The
   * `active` generation is the one currently serving every vector search,
   * complete on its model; `building` is a next-generation rebuild in flight
   * under a new model (a graceful embedder swap), or null when none is running.
   *
   * The headline-progress fields above (`totalIndexed`, `percentIndexed`) keep
   * reflecting the ACTIVE generation while a build is in flight, so a graceful
   * rebuild never reads as the existing index falling apart. The building
   * generation's separate `docsBuilt`/`docsTotal`/`percent` is the migration
   * progress to surface as a distinct "upgrading in the background" readout.
   * Absent on older gateways that predate the versioned-index model.
   */
  indexVersions?: {
    active: { version: number; embedModel: string; embedDim: number } | null;
    building: {
      version: number;
      embedModel: string;
      embedDim: number;
      docsBuilt: number;
      docsTotal: number;
      percent: number;
    } | null;
  };
  bySource: Record<
    string,
    {
      indexedDocs: number;
      gatewayDocs: number;
      chunks: number;
      percentIndexed: number;
      /** Documents that failed to index (transient/unrecognised) and are pending retry. */
      indexErrors?: number;
      /** Documents indexed but degraded (some chunks truncated/dropped). */
      degradedDocs?: number;
      truncatedChunks?: number;
      droppedChunks?: number;
      earliestIndexedDate: string | null;
      latestIndexedDate: string | null;
    }
  >;
}
