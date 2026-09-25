// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Core indexing loop.
 * Fetches new/updated documents from the gateway, chunks them,
 * generates embeddings, and stores in the index database.
 *
 * Watermark safety: the watermark only advances to the max updated_at
 * of successfully processed documents. Failed documents are tracked
 * and retried on the next cycle to prevent permanent data loss.
 */

import { createHash } from "node:crypto";
import { createLogger, deriveAuthor } from "@omnesis/core";
import {
  getWatermark,
  setWatermark,
  getIndexedDocumentStates,
  adoptIndexedDocumentSourceEvent,
  markIndexedDocumentEvent,
  removeIndexedDocument,
  getAllIndexedDocumentIds,
  upsertChunksAndMarkIndexed,
  upsertChunksAndMarkIndexedBatch,
  deleteChunksByDocument,
  getChunkSourceUrls,
  updateChunkSourceUrls,
  updateChunkNonEmbeddingMetadata,
  getIndexedSourceIds,
  getChunkDocumentIdsBySource,
  repointChunkSource,
  getChunkCount,
  getIndexedDocumentCount,
  recordIndexError,
  recordIndexDegraded,
  clearIndexError,
  getErroredDocumentIds,
  type ChunkUpsertInput,
} from "./db.js";
import { buildDocumentEmbeddingPreamble } from "./chunker.js";
import { normalizeContent } from "./normalize.js";
import { embedChunksResilient } from "./resilient-embed.js";
import type {
  DocumentSource,
  Chunker,
  Chunk,
  Embedder,
  IndexableDocument,
  LightweightDocumentHeader,
} from "./types.js";
import type Database from "better-sqlite3";
type Db = Database.Database;

const log = createLogger("indexer");

// PAGE_SIZE + BETWEEN_PAGE_SLEEP_MS defaults kept as module constants
// only as a last-resort fallback for direct `new Indexer(...)` callers
// that don't pass tuning opts (tests today). Production callers go
// through the indexer worker which resolves them at boot from
// `indexer.pageSize` / `indexer.betweenPageSleep` in `omnesis.json`
// (+ `OMNESIS_INDEXER_PAGE_SIZE` / `OMNESIS_INDEXER_BETWEEN_PAGE_SLEEP`
// env overrides) — see packages/gateway/src/mitigations.ts.
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_BETWEEN_PAGE_SLEEP_MS = 500;
const DEFAULT_DB_WRITE_BATCH_SIZE = 50;
// Log every 5000 docs rather than every 500 — at steady-state "skip"
// throughput (~15k docs/s on already-indexed content) the old value
// produced 30 log lines/sec, which saturated the gateway's stdout pipe
// (16KB kernel buffer) and stalled HTTP. 5000 keeps the progress visible
// without flooding.
const PROGRESS_LOG_INTERVAL = 5000;

/**
 * Document types the retention cutoff does not apply to.
 *
 * The gateway boundary already refuses to drop these on ingest
 * (`DocumentService.applyMaxAgeCutoff` — a contact stays relevant however
 * old the record is), so a cutoff applied here would silently keep them out
 * of search: ingested, retained, and permanently unsearchable.
 */
const CUTOFF_EXEMPT_DOCUMENT_TYPES = new Set(["contact"]);

function isCutoffExempt(documentType: string | null | undefined): boolean {
  return documentType != null && CUTOFF_EXEMPT_DOCUMENT_TYPES.has(documentType);
}

export class Indexer {
  private dataCutoff: string | null;
  private getCutoffForDoc: ((doc: IndexableDocument) => string | null) | null;
  private pageSize: number;
  private betweenPageSleepMs: number;
  private dbWriteBatchSize: number;
  /** Document IDs that failed in a previous cycle, to be retried */
  private failedDocIds = new Set<string>();
  /**
   * Docs we've already logged a failure for. Certain errors (notably the
   * "longer than the context size" case) are deterministic per doc —
   * retrying them fails the same way every cycle and logs the same error.
   * At 50+ such docs the log flood can saturate the gateway's stdout pipe
   * and cause HTTP stalls. We log each doc's failure once per process;
   * follow-up retries stay silent.
   */
  private loggedFailedDocIds = new Set<string>();
  /** Set to true to cooperatively abort in-flight indexing work (shutdown). */
  private stopping = false;
  private indexWriteOptions?: import("./db.js").IndexWriteOptions;

  constructor(
    private db: Db,
    private source: DocumentSource,
    private chunker: Chunker,
    private embedder: Embedder,
    opts?: {
      /**
       * Static fallback cutoff. Used by tests and when no per-doc resolver
       * is provided. Production callers (the indexer worker) pass
       * `getCutoff` instead so the cutoff can be resolved per source.
       */
      dataCutoff?: string | null;
      /**
       * Per-doc cutoff resolver. When set, takes precedence over `dataCutoff`.
       * Returns the ISO cutoff string for a given document (typically derived
       * from the doc's source ID via getSourceCutoffDate), or null for "no cutoff".
       * Called once per doc per filter site, so it should be cheap.
       */
      getCutoff?: (doc: IndexableDocument) => string | null;
      /** Docs per listDocuments call. Default 200. */
      pageSize?: number;
      /** Sleep between pages under backlog, ms. 0 = no sleep. Default 500ms. */
      betweenPageSleepMs?: number;
      /** Docs per batch DB transaction. Default 50. */
      dbWriteBatchSize?: number;
      /** Optional usearch HNSW handle for dual-index writes. */
      indexWriteOptions?: import("./db.js").IndexWriteOptions;
    },
  ) {
    this.dataCutoff = opts?.dataCutoff ?? null;
    this.getCutoffForDoc = opts?.getCutoff ?? null;
    this.pageSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
    this.betweenPageSleepMs = opts?.betweenPageSleepMs ?? DEFAULT_BETWEEN_PAGE_SLEEP_MS;
    this.dbWriteBatchSize = opts?.dbWriteBatchSize ?? DEFAULT_DB_WRITE_BATCH_SIZE;
    this.indexWriteOptions = opts?.indexWriteOptions;
    if (this.dataCutoff) {
      log.info(`Data cutoff: ${this.dataCutoff}`);
    }
  }

  /**
   * Resolve the effective cutoff for a doc, preferring the per-doc resolver
   * (hot-reloadable) over the static `dataCutoff` (boot snapshot).
   */
  private cutoffFor(doc: IndexableDocument): string | null {
    if (this.getCutoffForDoc) return this.getCutoffForDoc(doc);
    return this.dataCutoff;
  }

  /**
   * Cutoff check for lightweight headers (two-phase fetch path). The
   * header carries `sourceId` and `sourceCreatedAt` which is all the
   * per-doc cutoff resolver needs — it resolves by source ID, not by
   * full document metadata.
   */
  private cutoffForHeader(header: LightweightDocumentHeader): string | null {
    if (this.getCutoffForDoc) {
      // The getCutoff callback only reads `doc.sourceId`, so we can
      // satisfy it with a minimal stub. The cast is safe because the
      // callback contract (see `resolveCutoff` in indexer-worker.ts)
      // only accesses `sourceId`.
      return this.getCutoffForDoc({ sourceId: header.sourceId } as IndexableDocument);
    }
    return this.dataCutoff;
  }

  /**
   * Signal the indexer to cooperatively stop. Terminal — once stopped,
   * subsequent calls to indexing methods bail out immediately.
   */
  stop(): void {
    this.stopping = true;
  }

  /**
   * Run one indexing cycle: process new/updated documents.
   *
   * Two-phase fetch: a lightweight first pass reads only
   * `(id, content_hash, source_created_at, updated_at)` from the
   * gateway DB, compares hashes against the index in batch, and
   * full-fetches only the subset that actually needs re-embedding.
   * At steady-state (~95% unchanged) this avoids materialising
   * gigabytes of content strings that would be immediately discarded.
   *
   * Pipelining: after chunking a page, the embed HTTP call is fired
   * and the next page's lightweight scan starts immediately. The
   * synchronous SQLite read runs while the HTTP round-trip is in
   * flight; when the sync work finishes, the embed response is
   * typically already buffered. The embed result from the previous
   * page is then written to the DB before processing the next batch.
   */
  async indexUpdated(): Promise<{
    indexed: number;
    updated: number;
    skipped: number;
    errors: number;
  }> {
    const watermark = getWatermark(this.db, "last_updated_at");
    // The scan filters on `updated_at` but pages on `id`, so a write that
    // lands behind the id cursor is invisible to this cycle. Its stamp is
    // necessarily at or after the cycle began, so the watermark must not
    // pass that instant however far ahead the documents this cycle did
    // process have moved — otherwise the missed write sits permanently
    // behind the filter and nothing ever re-examines it.
    const cycleStartedAt = new Date().toISOString();
    let indexed = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let total = 0;
    let safeWatermark = watermark; // only advances past successful docs
    let afterId: string | undefined;
    let hasMore = true;
    let lastProgressLog = 0;
    const newFailedIds = new Set<string>();

    // Pipelining state: the in-flight embed promise from the previous
    // page, plus the prepared data it operates on. Resolved and written
    // at the top of the next iteration (or after the loop for the last
    // page).
    let pendingEmbed: {
      embedPromise: Promise<Float32Array[] | null>;
      toEmbed: Prepared[];
    } | null = null;

    type Prepared = {
      doc: IndexableDocument;
      chunks: ReturnType<Chunker["chunk"]>;
      isUpdate: boolean;
    };

    /** Resolve a pending embed and write results to the DB. */
    const flushPendingEmbed = async (): Promise<void> => {
      if (!pendingEmbed) return;
      const { embedPromise, toEmbed } = pendingEmbed;
      pendingEmbed = null;

      let allEmbeddings = await embedPromise;
      // The fast path slices this batch positionally across docs; a misaligned
      // length would silently drop chunks, so discard it and re-embed each doc
      // resiliently instead.
      const expectedEmbeddings = toEmbed.reduce((n, { chunks }) => n + chunks.length, 0);
      if (allEmbeddings && allEmbeddings.length !== expectedEmbeddings) {
        log.warn(
          `embed batch returned ${allEmbeddings.length} vectors for ${expectedEmbeddings} chunks; isolating per-doc`,
        );
        allEmbeddings = null;
      }

      type WritePayload = {
        documentId: string;
        contentHash: string;
        chunks: ChunkUpsertInput[];
        sourceEventAt: string;
        isUpdate: boolean;
      };
      const writeBatch: WritePayload[] = [];
      const writeMetadata: Array<{
        doc: IndexableDocument;
        isUpdate: boolean;
        truncated: number;
        dropped: number;
      }> = [];

      let offset = 0;
      for (const { doc, chunks, isUpdate } of toEmbed) {
        try {
          let chunkRows: ChunkUpsertInput[];
          let truncated = 0;
          let dropped = 0;
          if (allEmbeddings) {
            // Page batch succeeded — every chunk embedded cleanly.
            chunkRows = buildChunkRows(
              doc,
              chunks,
              allEmbeddings.slice(offset, offset + chunks.length),
            );
            offset += chunks.length;
          } else {
            // Page batch failed — embed this doc resiliently in isolation.
            ({ chunkRows, truncated, dropped } = await this.embedDocChunks(doc, chunks));
          }
          writeBatch.push({
            documentId: doc.id,
            contentHash: doc.contentHash,
            chunks: chunkRows,
            isUpdate,
            sourceEventAt: doc.updatedAt,
          });
          writeMetadata.push({ doc, isUpdate, truncated, dropped });
        } catch (err) {
          errors++;
          newFailedIds.add(doc.id);
          recordIndexError(
            this.db,
            doc.id,
            doc.sourceId,
            err instanceof Error ? err.message : String(err),
          );
          if (!this.loggedFailedDocIds.has(doc.id)) {
            this.loggedFailedDocIds.add(doc.id);
            log.error(
              `Failed to index "${doc.title}" (${doc.id}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      // A delete that landed while this page was embedding must win. The HTTP
      // cascade (privacy delete, sync tombstone, stream wipe) removes the
      // gateway row and the index rows from the main thread; this page was read
      // before that and is written after it, so re-writing would put the
      // document's title and full chunk text back into `chunks` and leave it
      // searchable until the hourly deletion reconcile. One indexed lookup over
      // the ids about to be written closes all but the microseconds between
      // this check and the write.
      await this.dropVanishedDocuments(writeBatch, writeMetadata);

      for (let i = 0; i < writeBatch.length; i += this.dbWriteBatchSize) {
        const slice = writeBatch.slice(i, i + this.dbWriteBatchSize);
        upsertChunksAndMarkIndexedBatch(this.db, slice, this.indexWriteOptions);
      }
      for (const { doc, isUpdate, truncated, dropped } of writeMetadata) {
        if (isUpdate) updated++;
        else indexed++;
        if (truncated > 0 || dropped > 0) {
          recordIndexDegraded(this.db, doc.id, doc.sourceId, truncated, dropped);
        }
        if (!safeWatermark || doc.updatedAt > safeWatermark) safeWatermark = doc.updatedAt;
        this.failedDocIds.delete(doc.id);
      }
    };

    while (hasMore) {
      if (this.stopping) break;
      // ── Phase 1: lightweight scan ─────────────────────────────────
      // Fetch only (id, content_hash, source_created_at, updated_at)
      // to determine which docs need re-embedding.
      const lightPage = await this.source.listUpdatedLightweight(watermark, this.pageSize, afterId);

      // Filter: cutoff + indexed event-state comparison (batched).
      const candidateIds: string[] = [];
      const headerById = new Map<string, LightweightDocumentHeader>();
      for (const header of lightPage.documents) {
        total++;
        headerById.set(header.id, header);

        const cutoff = this.cutoffForHeader(header);
        if (cutoff && header.sourceCreatedAt < cutoff && !isCutoffExempt(header.documentType)) {
          skipped++;
          if (!safeWatermark || header.updatedAt > safeWatermark) safeWatermark = header.updatedAt;
          continue;
        }
        candidateIds.push(header.id);
      }

      // A matching content hash alone is insufficient: title and selected
      // metadata fields participate in the embedding preamble, while any real
      // gateway update must still become a subscription event even when its
      // current vectors can be reused.
      const indexedStates = getIndexedDocumentStates(this.db, candidateIds);
      const needFetchIds: string[] = [];
      for (const id of candidateIds) {
        const header = headerById.get(id)!;
        const existing = indexedStates.get(id);
        if (
          existing &&
          existing.contentHash === header.contentHash &&
          existing.sourceEventAt === ""
        ) {
          // Rows created before the source-event clock existed cannot prove
          // whether metadata changed. Honor the no-backfill contract: adopt
          // the current gateway revision without manufacturing a new event.
          adoptIndexedDocumentSourceEvent(this.db, id, header.updatedAt);
          const chunkUrls = getChunkSourceUrls(this.db, id);
          if (chunkUrls.some((url) => url !== header.sourceUrl)) {
            const touched = updateChunkSourceUrls(this.db, id, header.sourceUrl);
            if (touched > 0) updated++;
            else skipped++;
          } else {
            skipped++;
          }
          if (!safeWatermark || header.updatedAt > safeWatermark) safeWatermark = header.updatedAt;
          continue;
        }
        if (
          existing &&
          existing.contentHash === header.contentHash &&
          existing.sourceEventAt === header.updatedAt
        ) {
          // No new gateway event. A URL can still drift after an index repair;
          // keep the denormalized search column coherent without manufacturing
          // a subscription event.
          const chunkUrls = getChunkSourceUrls(this.db, id);
          if (chunkUrls.some((u) => u !== header.sourceUrl)) {
            const touched = updateChunkSourceUrls(this.db, id, header.sourceUrl);
            if (touched > 0) updated++;
            else skipped++;
          } else {
            skipped++;
          }
          if (!safeWatermark || header.updatedAt > safeWatermark) safeWatermark = header.updatedAt;
          continue;
        }
        needFetchIds.push(id);
      }

      // ── Phase 2: full fetch + chunk (only changed docs) ───────────
      const toEmbed: Prepared[] = [];
      if (needFetchIds.length > 0 && !this.stopping) {
        const fullDocs = await this.source.getByIds(needFetchIds);
        for (const doc of fullDocs) {
          if (this.stopping) break;
          doc.content = normalizeContent(doc.content);
          const existing = indexedStates.get(doc.id);
          const embeddingChanged =
            !existing ||
            existing.contentHash !== doc.contentHash ||
            existing.embeddingPreamble !== buildDocumentEmbeddingPreamble(doc);
          if (!embeddingChanged) {
            // A source timestamp, URL, tags, relevance, or other non-preamble
            // metadata field changed. Preserve the current vectors but stamp a
            // fresh semantic event so every real corpus update still reaches
            // the subscription precision pipeline.
            const metadataTouched = updateChunkNonEmbeddingMetadata(this.db, doc.id, {
              sourceUrl: doc.metadata.sourceUrl ?? null,
              tags: doc.metadata.tags,
              relevanceScore: doc.metadata.relevanceScore,
            });
            const eventTouched = markIndexedDocumentEvent(this.db, doc.id, doc.updatedAt);
            if (eventTouched || metadataTouched > 0) updated++;
            else skipped++;
            if (!safeWatermark || doc.updatedAt > safeWatermark) safeWatermark = doc.updatedAt;
            this.failedDocIds.delete(doc.id);
            continue;
          }
          const chunks = this.chunker.chunk(doc);
          // A doc that chunks to nothing (e.g. whitespace-only large content)
          // still flows through so it gets a terminal indexed marker (zero
          // chunks) — it counts toward 100% and isn't reprocessed every cycle.
          toEmbed.push({ doc, chunks, isUpdate: existing !== undefined });
        }
      }

      // ── Phase 3: pipeline — fire embed, flush previous ────────────
      // Before starting the embed for this page, flush the previous
      // page's embed result (if any). This ensures writes happen in
      // page order.
      await flushPendingEmbed();

      if (toEmbed.length > 0 && !this.stopping) {
        const allInputs = toEmbed.flatMap(({ chunks }) => chunks.map((c) => c.embeddingInput));
        const embedPromise = this.embedder.embed(allInputs).catch((): null => null);
        pendingEmbed = { embedPromise, toEmbed };
      }

      // Periodic progress logging
      if (total - lastProgressLog >= PROGRESS_LOG_INTERVAL) {
        lastProgressLog = total;
        const stats = this.getStats();
        log.info(
          `Indexing progress: ${total} processed, ${indexed} indexed, ${updated} updated, ${skipped} skipped, ${errors} errors, ${stats.chunks} chunks`,
        );
      }

      hasMore = lightPage.hasMore;
      if (lightPage.documents.length > 0) {
        afterId = lightPage.documents[lightPage.documents.length - 1].id;
      }

      // Yield between pages so the writer worker's commits have gaps
      // to land in without a reader mid-page. Skipped when there's no
      // more work so the cycle ends promptly once caught up.
      if (hasMore && !this.stopping && this.betweenPageSleepMs > 0) {
        await new Promise((r) => setTimeout(r, this.betweenPageSleepMs));
      }
    }

    /**
     * Persist the cycle's progress, never past the instant it began: a
     * document written behind the id cursor carries a stamp at or after
     * `cycleStartedAt`, and only a watermark held at that instant leaves it
     * in front of the next cycle's filter.
     */
    const persistWatermark = (): void => {
      if (!safeWatermark) return;
      const next = safeWatermark > cycleStartedAt ? cycleStartedAt : safeWatermark;
      if (next !== watermark) setWatermark(this.db, "last_updated_at", next);
    };

    // Flush the last page's embed (the loop only flushes at the top of
    // the *next* iteration, so the final page is still pending here).
    await flushPendingEmbed();

    // Cooperative shutdown: persist any watermark progress and bail before
    // retry/reconcile work that would keep the disposed embedder busy.
    if (this.stopping) {
      persistWatermark();
      return { indexed, updated, skipped, errors };
    }

    // Retry previously failed documents that are now behind the watermark
    if (this.failedDocIds.size > 0) {
      const retried = await this.retryFailed();
      indexed += retried.indexed;
      errors += retried.errors;
      if (retried.indexed > 0) {
        log.info(`Retried ${retried.indexed} previously failed documents`);
      }
    }

    // Update the failed set for next cycle. The union, not the page scan's
    // failures alone: `retryFailed` leaves the documents that failed AGAIN in
    // `this.failedDocIds`, and the watermark has already moved past them, so
    // overwriting the set would strand a twice-failed document until the
    // hourly `reindexMissing` backstop.
    for (const id of this.failedDocIds) newFailedIds.add(id);
    this.failedDocIds = newFailedIds;

    // Advance watermark only to the safe point
    persistWatermark();

    if (indexed > 0 || updated > 0 || errors > 0) {
      log.info(
        `Indexing cycle complete: ${indexed} indexed, ${updated} updated, ${skipped} skipped, ${errors} errors, ${getChunkCount(this.db)} chunks`,
      );
    }

    return { indexed, updated, skipped, errors };
  }

  /**
   * Remove, in place, every entry of a page's write batch whose document no
   * longer exists in the gateway.
   *
   * The two arrays are the same page in two shapes — `batch` is what is
   * written, `metadata` is what the counters and the watermark are derived
   * from — so both have to lose the same entries or the cycle would report
   * indexing a document it did not write.
   *
   * `getSourceIdsByIds` omits ids that are gone, which makes it the cheapest
   * existence probe the `DocumentSource` contract already offers.
   */
  private async dropVanishedDocuments(
    batch: Array<{ documentId: string }>,
    metadata: Array<{ doc: IndexableDocument }>,
  ): Promise<void> {
    if (batch.length === 0) return;
    const present = await this.source.getSourceIdsByIds(batch.map((w) => w.documentId));
    if (present.size === batch.length) return;
    const vanished = batch.filter((w) => !present.has(w.documentId)).map((w) => w.documentId);
    log.info(
      `Skipping ${vanished.length} document(s) deleted while their page was embedding: ${vanished.join(", ")}`,
    );
    const gone = new Set(vanished);
    let write = 0;
    for (let read = 0; read < batch.length; read += 1) {
      if (gone.has(batch[read].documentId)) continue;
      batch[write] = batch[read];
      metadata[write] = metadata[read];
      write += 1;
    }
    batch.length = write;
    metadata.length = write;
  }

  /**
   * Retry documents that failed in a previous cycle.
   *
   * Batched fetch via `source.getByIds`, one page at a time. A single call
   * over the whole set would materialise every failed document's full
   * CONTENT at once — an embedder outage across a backlog puts the entire
   * corpus in the worker's heap — so this walks `pageSize` ids per fetch,
   * the same bound every other fetch in this file obeys.
   */
  private async retryFailed(): Promise<{ indexed: number; errors: number }> {
    let indexed = 0;
    let errors = 0;
    const stillFailed = new Set<string>();

    if (this.failedDocIds.size === 0) return { indexed, errors };
    const failedIds = Array.from(this.failedDocIds);

    for (let start = 0; start < failedIds.length; start += this.pageSize) {
      if (this.stopping) break;
      const page = failedIds.slice(start, start + this.pageSize);
      const docs = await this.source.getByIds(page);
      const docsById = new Map(docs.map((d) => [d.id, d]));
      const indexedStates = getIndexedDocumentStates(this.db, page);

      for (const docId of page) {
        if (this.stopping) break;
        const doc = docsById.get(docId);
        if (!doc) continue; // Document may have been deleted from the source

        const cutoff = this.cutoffFor(doc);
        if (
          cutoff &&
          doc.metadata.sourceCreatedAt < cutoff &&
          !isCutoffExempt(doc.metadata.documentType)
        ) {
          continue; // Intentionally skipped
        }

        try {
          const existing = indexedStates.get(doc.id);
          if (
            existing &&
            existing.contentHash === doc.contentHash &&
            existing.sourceEventAt === doc.updatedAt &&
            existing.embeddingPreamble === buildDocumentEmbeddingPreamble(doc)
          ) {
            continue; // Already indexed (maybe by another path)
          }
          if (existing) {
            deleteChunksByDocument(this.db, doc.id, this.indexWriteOptions);
          }
          await this.indexDocument(doc);
          indexed++;
        } catch (err) {
          errors++;
          stillFailed.add(docId);
          if (!this.loggedFailedDocIds.has(doc.id)) {
            this.loggedFailedDocIds.add(doc.id);
            log.error(
              `Retry failed for "${doc.title}" (${doc.id}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    // Keep only the ones that still failed
    this.failedDocIds = stillFailed;
    return { indexed, errors };
  }

  /**
   * Re-index documents that exist in the gateway but are missing from the index.
   * This fixes gaps caused by the watermark-advancement bug where failed docs
   * were permanently skipped.
   *
   * Uses the same batched embed pattern as `indexUpdated()`: fetches pages of
   * missing docs via `source.getByIds()`, chunks all docs in the page, sends
   * all chunks to `embedder.embed()` in one call, then distributes vectors
   * and writes per-doc. On batch embed failure, falls back to per-doc
   * embedding so one bad doc doesn't block the rest of the page.
   */
  async reindexMissing(): Promise<{ indexed: number; errors: number }> {
    const gatewayIds = new Set(await this.source.listAllIds());
    const indexedIds = getAllIndexedDocumentIds(this.db);

    const missingIds: string[] = [];
    for (const id of gatewayIds) {
      if (!indexedIds.has(id)) {
        missingIds.push(id);
      }
    }

    let indexed = 0;
    let errors = 0;
    let lastProgressLog = 0;

    if (missingIds.length > 0) {
      log.info(`Found ${missingIds.length} documents missing from index, re-indexing...`);
    }

    for (let batchStart = 0; batchStart < missingIds.length; batchStart += this.pageSize) {
      if (this.stopping) break;

      const batchIds = missingIds.slice(batchStart, batchStart + this.pageSize);
      const docs = await this.source.getByIds(batchIds);
      const docsProcessed = batchStart + batchIds.length;

      // Phase 1: chunk all docs in this batch, filtering cutoff-skipped docs.
      type Prepared = {
        doc: IndexableDocument;
        chunks: ReturnType<Chunker["chunk"]>;
      };
      const toEmbed: Prepared[] = [];

      for (const doc of docs) {
        if (this.stopping) break;

        const cutoff = this.cutoffFor(doc);
        if (
          cutoff &&
          doc.metadata.sourceCreatedAt < cutoff &&
          !isCutoffExempt(doc.metadata.documentType)
        )
          continue;

        doc.content = normalizeContent(doc.content);
        const chunks = this.chunker.chunk(doc);
        // Zero-chunk docs still flow through for a terminal indexed marker.
        toEmbed.push({ doc, chunks });
      }

      // Phase 2: batch-embed all chunks across all docs in one call.
      // On batch failure, fall back to per-document embedding so one bad
      // doc doesn't block the rest of the batch.
      if (toEmbed.length > 0 && !this.stopping) {
        const allInputs = toEmbed.flatMap(({ chunks }) => chunks.map((c) => c.embeddingInput));
        let allEmbeddings: Float32Array[] | null = null;
        try {
          allEmbeddings = await this.embedder.embed(allInputs);
        } catch {
          // Batch failed — fall back to per-document embedding below.
        }
        // Guard the positional slice mapping: a misaligned length would
        // silently drop chunks, so isolate per-doc instead.
        if (allEmbeddings && allEmbeddings.length !== allInputs.length) {
          allEmbeddings = null;
        }

        // Phase 3: distribute embeddings back, prepare write payloads,
        // and batch-write to DB.
        type WritePayload = {
          documentId: string;
          contentHash: string;
          chunks: ChunkUpsertInput[];
          sourceEventAt: string;
        };
        const writeBatch: WritePayload[] = [];
        const degradedByDoc: Array<{
          doc: IndexableDocument;
          truncated: number;
          dropped: number;
        }> = [];

        let offset = 0;
        for (const { doc, chunks } of toEmbed) {
          try {
            let chunkRows: ChunkUpsertInput[];
            let truncated = 0;
            let dropped = 0;
            if (allEmbeddings) {
              // Page batch succeeded — every chunk embedded cleanly.
              chunkRows = buildChunkRows(
                doc,
                chunks,
                allEmbeddings.slice(offset, offset + chunks.length),
              );
              offset += chunks.length;
            } else {
              // Page batch failed — embed this doc resiliently in isolation.
              ({ chunkRows, truncated, dropped } = await this.embedDocChunks(doc, chunks));
            }
            writeBatch.push({
              documentId: doc.id,
              contentHash: doc.contentHash,
              chunks: chunkRows,
              sourceEventAt: doc.updatedAt,
            });
            if (truncated > 0 || dropped > 0) {
              degradedByDoc.push({ doc, truncated, dropped });
            }
          } catch (err) {
            errors++;
            recordIndexError(
              this.db,
              doc.id,
              doc.sourceId,
              err instanceof Error ? err.message : String(err),
            );
            if (!this.loggedFailedDocIds.has(doc.id)) {
              this.loggedFailedDocIds.add(doc.id);
              log.error(
                `Failed to re-index "${doc.title}" (${doc.id}): ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }

        // Flush write payloads in batches of dbWriteBatchSize.
        for (let i = 0; i < writeBatch.length; i += this.dbWriteBatchSize) {
          const slice = writeBatch.slice(i, i + this.dbWriteBatchSize);
          upsertChunksAndMarkIndexedBatch(this.db, slice, this.indexWriteOptions);
        }
        for (const { doc, truncated, dropped } of degradedByDoc) {
          recordIndexDegraded(this.db, doc.id, doc.sourceId, truncated, dropped);
        }
        indexed += writeBatch.length;
      }

      // Periodic progress logging
      if (docsProcessed - lastProgressLog >= PROGRESS_LOG_INTERVAL) {
        lastProgressLog = docsProcessed;
        log.info(
          `Re-index progress: ${docsProcessed}/${missingIds.length} processed, ${indexed} indexed, ${errors} errors`,
        );
      }

      // Yield between batches so other work (HTTP, writer commits) can land.
      const hasMoreBatches = batchStart + this.pageSize < missingIds.length;
      if (hasMoreBatches && !this.stopping && this.betweenPageSleepMs > 0) {
        await new Promise((r) => setTimeout(r, this.betweenPageSleepMs));
      }
    }

    if (missingIds.length > 0) {
      log.info(`Re-indexed ${indexed} missing documents (${errors} errors)`);
    }

    // Reconcile persistent error rows against the live index so a transient
    // failure recorded in a prior session (whose in-memory retry set was lost
    // on restart) doesn't linger as a phantom "failed" forever.
    const reconciled = await this.reconcilePersistentErrors();
    indexed += reconciled.indexed;
    errors += reconciled.errors;
    return { indexed, errors };
  }

  /**
   * Reconcile rows in `indexing_errors` (severity = 'error') against the live
   * index. The in-memory retry set is lost across a restart, so a doc that
   * errored transiently in a prior session and is otherwise fine would linger
   * as a phantom "failed" forever. For each errored doc:
   *  - gone from the gateway → clear the row;
   *  - indexed at the current content, preamble, and source event → clear the
   *    row (the error was stale);
   *  - indexed at stale content or metadata → re-attempt through the resilient
   *    path (which clears, degrades, or re-records as appropriate).
   * Docs missing from the index entirely are left to `reindexMissing`'s main
   * pass and skipped here.
   */
  private async reconcilePersistentErrors(): Promise<{ indexed: number; errors: number }> {
    const erroredIds = getErroredDocumentIds(this.db);
    if (erroredIds.length === 0) return { indexed: 0, errors: 0 };

    let indexed = 0;
    let errors = 0;
    let cleared = 0;
    // Paged for the same reason `retryFailed` is: `getByIds` materialises full
    // document CONTENT, and after an embedder outage this set can be the whole
    // corpus.
    for (let start = 0; start < erroredIds.length; start += this.pageSize) {
      if (this.stopping) break;
      const page = erroredIds.slice(start, start + this.pageSize);
      const docs = await this.source.getByIds(page);
      const docById = new Map(docs.map((d) => [d.id, d]));
      const indexedStates = getIndexedDocumentStates(this.db, page);

      for (const id of page) {
        if (this.stopping) break;
        const doc = docById.get(id);
        if (!doc) {
          clearIndexError(this.db, id); // no longer in the gateway
          cleared++;
          continue;
        }
        const existing = indexedStates.get(id);
        if (!existing) continue; // missing from index — reindexMissing handles it
        if (
          existing.contentHash === doc.contentHash &&
          existing.sourceEventAt === doc.updatedAt &&
          existing.embeddingPreamble === buildDocumentEmbeddingPreamble(doc)
        ) {
          clearIndexError(this.db, id); // index is current; the error was stale
          cleared++;
          continue;
        }
        // Indexed at stale content — re-attempt the current content.
        try {
          deleteChunksByDocument(this.db, id, this.indexWriteOptions);
          await this.indexDocument(doc);
          indexed++;
        } catch {
          // indexDocument already recorded the (transient) error; leave pending.
          errors++;
        }
      }
    }
    if (cleared > 0) log.info(`Reconciled ${cleared} stale indexing-error row(s)`);
    return { indexed, errors };
  }

  /**
   * Reconcile deletions: find documents in our index that no longer
   * exist in the gateway and remove them.
   */
  async reconcileDeletedDocuments(): Promise<number> {
    const gatewayIds = new Set(await this.source.listAllIds());
    const indexedIds = getAllIndexedDocumentIds(this.db);
    let deleted = 0;

    for (const id of indexedIds) {
      if (this.stopping) break;
      if (!gatewayIds.has(id)) {
        deleteChunksByDocument(this.db, id, this.indexWriteOptions);
        removeIndexedDocument(this.db, id);
        clearIndexError(this.db, id);
        deleted++;
      }
    }

    if (deleted > 0) {
      log.info(`Reconciled ${deleted} deleted documents`);
    }

    return deleted;
  }

  /**
   * Repair denormalized `chunks.source_id` that drifted from the document's
   * current source in the gateway.
   *
   * A one-time migration can re-home documents onto a different source without
   * changing their content — legacy browser-extension pages were folded into
   * the `web` source. The incremental scan
   * skips content-unchanged docs (it only repairs `source_url` drift in place),
   * so the chunks keep the retired `source_id`. The per-source index
   * stats then count those docs under a source that no longer has any
   * documents, leaving the survivor stuck below 100% indexed forever and a
   * phantom retired source lingering in `/index/stats`.
   *
   * The repair compares the per-source chunk attribution against which sources
   * still own documents: a source with indexed chunks but zero gateway
   * documents has been re-homed *wholesale*, so each of its documents is
   * re-pointed onto its current source — fanning out across multiple survivors
   * if the fold split one source into several (documents that no longer exist
   * at all are left to `reconcileDeletedDocuments`). No re-embed — only the
   * denormalized column moves. Cheap and a no-op in steady state, so it runs on
   * every worker boot.
   *
   * Scope: only a *whole-source* re-home is detected — a source where every
   * document moved away. A partial re-home (some documents move, some stay)
   * keeps the source alive, so its moved documents' chunks would not be caught
   * here. That is acceptable because the only re-homes that happen are
   * whole-source folds; a steady-state producer never changes an
   * individual document's `source_id` (the incremental scan's drift path
   * likewise only covers `source_url`, not `source_id`).
   *
   * Repairs chunks only; the caller is responsible for rebuilding the per-source
   * summary afterwards (the indexer worker's boot `refreshIndexStats` does, so
   * the first `/index/stats` already drops the retired source and credits the
   * survivor).
   */
  async reconcileSourceAttribution(): Promise<{ repaired: number; sources: number }> {
    let repaired = 0;
    let sources = 0;

    for (const sourceId of getIndexedSourceIds(this.db)) {
      if (this.stopping) break;
      // A source that still owns documents owns its chunks — nothing to repair.
      if (await this.source.hasDocuments(sourceId)) continue;

      const docIds = getChunkDocumentIdsBySource(this.db, sourceId);
      if (docIds.length === 0) continue;
      const currentBySource = await this.source.getSourceIdsByIds(docIds);

      // Group the orphaned source's documents by their current (new) source.
      const idsByNewSource = new Map<string, string[]>();
      for (const id of docIds) {
        const newSourceId = currentBySource.get(id);
        // Absent → deleted (left to reconcileDeletedDocuments); unchanged →
        // already correct (defensive — hasDocuments said this source is empty).
        if (!newSourceId || newSourceId === sourceId) continue;
        const bucket = idsByNewSource.get(newSourceId);
        if (bucket) bucket.push(id);
        else idsByNewSource.set(newSourceId, [id]);
      }

      let repairedHere = 0;
      for (const [newSourceId, ids] of idsByNewSource) {
        repairedHere += repointChunkSource(this.db, ids, newSourceId);
      }
      if (repairedHere > 0) {
        repaired += repairedHere;
        sources += 1;
        log.info(
          `Re-pointed ${repairedHere} chunk(s) of re-homed source "${sourceId}" onto ${idsByNewSource.size} surviving source(s)`,
        );
      }
    }

    return { repaired, sources };
  }

  /**
   * Resiliently embed a document's chunks and assemble its index rows. Drops
   * chunks the embedder can't handle (so one bad chunk never blocks the whole
   * document) and reports how many were truncated / dropped so the caller can
   * record the degradation. Throws only on transient failures, leaving the
   * document pending for a later retry.
   */
  private async embedDocChunks(
    doc: IndexableDocument,
    chunks: Chunk[],
  ): Promise<{ chunkRows: ChunkUpsertInput[]; truncated: number; dropped: number }> {
    let truncated = 0;
    let dropped = 0;
    const embeddings = await embedChunksResilient(
      this.embedder,
      chunks.map((c) => c.embeddingInput),
      {
        onTruncate: () => {
          truncated++;
        },
        onDrop: () => {
          dropped++;
        },
      },
    );
    return { chunkRows: buildChunkRows(doc, chunks, embeddings), truncated, dropped };
  }

  /**
   * Index a single document: chunk, embed, and store.
   *
   * The document always reaches a terminal indexed state — chunks the embedder
   * can't handle are degraded (truncated) or dropped rather than failing the
   * whole document, and even a zero-chunk document gets an indexed marker so it
   * counts toward 100% and isn't reprocessed every cycle. A genuinely transient
   * failure throws, so `indexDocument` records a retryable error and the doc
   * stays pending. Degraded outcomes are recorded for the /index/stats signal.
   */
  private async indexDocument(doc: IndexableDocument): Promise<void> {
    try {
      return await this.indexDocumentInner(doc);
    } catch (err) {
      recordIndexError(
        this.db,
        doc.id,
        doc.sourceId,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  private async indexDocumentInner(doc: IndexableDocument): Promise<void> {
    const chunks = this.chunker.chunk(doc);
    const { chunkRows, truncated, dropped } = await this.embedDocChunks(doc, chunks);
    upsertChunksAndMarkIndexed(
      this.db,
      doc.id,
      doc.contentHash,
      chunkRows,
      this.indexWriteOptions,
      doc.updatedAt,
    );
    if (truncated > 0 || dropped > 0) {
      recordIndexDegraded(this.db, doc.id, doc.sourceId, truncated, dropped);
    }
  }

  getStats(): { documents: number; chunks: number } {
    return {
      documents: getIndexedDocumentCount(this.db),
      chunks: getChunkCount(this.db),
    };
  }
}

/**
 * Build index rows for a document, one per successfully-embedded chunk.
 * Chunks whose embedding is `null` (dropped by the resilient embedder) are
 * skipped, so a document with some unembeddable chunks still indexes the rest.
 */
function buildChunkRows(
  doc: IndexableDocument,
  chunks: Chunk[],
  embeddings: Array<Float32Array | null>,
): ChunkUpsertInput[] {
  const rows: ChunkUpsertInput[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const embedding = embeddings[i];
    if (!embedding) continue;
    rows.push({
      id: chunkId(doc.id, chunks[i].index),
      documentId: doc.id,
      chunkIndex: chunks[i].index,
      content: chunks[i].text,
      embedding,
      sourceId: doc.sourceId,
      documentType: doc.metadata.documentType,
      title: doc.title,
      sourceUrl: doc.metadata.sourceUrl,
      sourceCreatedAt: doc.metadata.sourceCreatedAt,
      author: deriveAuthor(doc.metadata.people),
      tags: doc.metadata.tags,
      relevanceScore: doc.metadata.relevanceScore,
    });
  }
  return rows;
}

/** Deterministic chunk ID from document ID + chunk index. */
function chunkId(documentId: string, chunkIndex: number): string {
  return createHash("sha256").update(`${documentId}#${chunkIndex}`).digest("hex").slice(0, 32);
}
