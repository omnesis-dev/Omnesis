// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Double-buffered generation builder.
 *
 * Builds a NEW index generation under a (different, possibly different-
 * dimension) embedding model while the ACTIVE generation keeps serving every
 * vector search unchanged. It re-embeds the existing `chunks` corpus — keyed
 * by the same `chunks.rowid` the active index uses — and writes the result to
 * two places that the active generation never touches:
 *
 *   - the building generation's own usearch file (`index-<version>.usearch`),
 *     never the active file; and
 *   - the `chunk_embeddings_building` scratch table, so the new vectors are
 *     durable for the atomic flip's promote step.
 *
 * Because it reads `chunks.content` (+ the metadata columns) but never writes
 * `chunks.embedding` or the active usearch file, the active generation is
 * byte-for-byte intact for the whole build — the read registry keeps serving
 * it. The caller flips atomically via {@link flipActiveIndexVersion} once
 * {@link build} resolves.
 *
 * The embedding input is reconstructed through the SAME helper the live
 * chunker uses ({@link buildEmbeddingPreamble}/{@link buildEmbeddingInput}), so
 * the new generation's vectors are produced from byte-identical text — no
 * silent retrieval-quality drift between the old and new index.
 *
 * This runs on the main thread with an injected {@link Embedder}, so it is
 * embedder-agnostic — it never cares what kind of model produces the vectors,
 * only that `embed()` returns them. An HTTP target is driven by a non-blocking
 * main-thread HTTP client; a LOCAL in-process (llama.cpp) target would block the
 * event loop on the main thread, so the caller injects a `BuildWorkerEmbedder`
 * that round-trips `embed()` to a short-lived off-main-thread build worker
 * hosting the new GGUF (mechanism 1). Either way the re-embed runs
 * off the event loop and interactive search stays responsive on the active
 * generation throughout. The builder itself is unchanged by the distinction.
 */

import { unlinkSync } from "node:fs";

import { createLogger } from "@omnesis/core";

import {
  deleteBuildingEmbeddings,
  getBuildableDocumentCount,
  getBuildingEmbeddingsPage,
  getOrphanBuildingRowids,
  setIndexVersionProgress,
  upsertBuildingEmbeddings,
  usearchPathForVersion,
} from "./db.js";
import { buildEmbeddingInput, buildEmbeddingPreamble } from "./embedding-input.js";
import { UsearchWriteHandle } from "./usearch-index.js";
import type { Embedder } from "./types.js";
import type Database from "better-sqlite3";

const log = createLogger("gateway:indexer").child("generation-builder");

/**
 * Thrown by {@link GenerationBuilder.build}/{@link GenerationBuilder.catchUp}
 * when their {@link GenerationBuildOptions.signal} aborts mid-pass — the caller
 * abandoned this generation because a NEWER embedder swap arrived
 * (bounded-to-two). It is a clean, expected unwind, not a build error: the caller
 * cleans up the half-built generation and starts a fresh one for the newest
 * model, so it is logged at info, never error.
 */
export class BuildAbortedError extends Error {
  constructor(message = "generation build aborted") {
    super(message);
    this.name = "BuildAbortedError";
  }
}

interface ChunkRowForBuild {
  rowid: number;
  document_id: string;
  content: string;
  title: string;
  document_type: string | null;
  author: string | null;
  source_created_at: string | null;
}

export interface GenerationBuildOptions {
  /** Chunks embedded per batch call. */
  batchSize?: number;
  /** Save the building usearch file + flush progress every N chunks. */
  saveEveryN?: number;
  /**
   * Cooperative cancellation (abandon-in-flight). Checked at every
   * safe point between embed batches; when it aborts, {@link build}/
   * {@link catchUp} stop at the next boundary and throw a {@link
   * BuildAbortedError} WITHOUT persisting further — the partially-built
   * generation is then dropped by the caller's cleanup so a newer embedder swap
   * can start fresh. The active generation is never touched, so a mid-build
   * abandon is always safe.
   */
  signal?: AbortSignal;
}

export interface GenerationBuildResult {
  /** Vectors written to the building generation. */
  vectors: number;
  /** Distinct documents covered. */
  documents: number;
}

export interface GenerationCatchUpResult {
  /** Late-arriving chunks embedded + staged into the building generation. */
  added: number;
  /** Stale vectors removed because their `chunks` row vanished mid-rebuild. */
  removed: number;
}

export class GenerationBuilder {
  private readonly log = log;

  constructor(
    private readonly db: Database.Database,
    private readonly configDir: string,
    private readonly version: number,
    private readonly embedder: Embedder,
    private readonly embedDim: number,
    private readonly opts: GenerationBuildOptions = {},
  ) {}

  /**
   * Throw a {@link BuildAbortedError} if the caller has signalled abandon. Call
   * only at safe points between embed batches — never mid-write — so the
   * partially-built generation is left in a state the caller's cleanup can drop
   * wholesale.
   */
  private throwIfAborted(): void {
    if (this.opts.signal?.aborted) throw new BuildAbortedError();
  }

  async build(): Promise<GenerationBuildResult> {
    const batchSize = this.opts.batchSize ?? 32;
    const saveEvery = this.opts.saveEveryN ?? 5_000;

    const path = usearchPathForVersion(this.configDir, this.version);
    const writer = new UsearchWriteHandle(path, this.embedDim);
    // Start from a clean file at the new dimension — a stale partial file from
    // an abandoned earlier build of this same version id must not be loaded.
    writer.clear();

    // Same denominator the building generation row was seeded with
    // (`createBuildingIndexVersion` → `getBuildableDocumentCount`), so progress
    // reaches exactly 100% at completion.
    const docsTotal = getBuildableDocumentCount(this.db);

    const select = this.db.prepare<[number, number], ChunkRowForBuild>(
      `SELECT rowid, document_id, content, title, document_type, author, source_created_at
         FROM chunks
        ORDER BY document_id, chunk_index
        LIMIT ? OFFSET ?`,
    );

    const startMs = Date.now();
    let offset = 0;
    let vectors = 0;
    let documents = 0;
    let lastDocId: string | null = null;
    let sinceSave = 0;
    const PAGE = 2_000;

    for (;;) {
      this.throwIfAborted();
      const rows = select.all(PAGE, offset);
      if (rows.length === 0) break;
      offset += rows.length;

      for (let i = 0; i < rows.length; i += batchSize) {
        this.throwIfAborted();
        const batch = rows.slice(i, i + batchSize);
        const inputs = batch.map((r) =>
          buildEmbeddingInput(
            buildEmbeddingPreamble({
              documentType: r.document_type,
              title: r.title,
              author: r.author,
              sourceCreatedAt: r.source_created_at,
            }),
            r.content,
          ),
        );
        const embeddings = await this.embedder.embed(inputs);

        const staged: Array<{ chunkRowid: number; embedding: Float32Array }> = [];
        for (let j = 0; j < batch.length; j++) {
          const vec = embeddings[j];
          if (!vec) continue;
          writer.add(BigInt(batch[j].rowid), vec);
          staged.push({ chunkRowid: batch[j].rowid, embedding: vec });
          vectors++;
        }
        if (staged.length > 0) upsertBuildingEmbeddings(this.db, staged);

        for (const r of batch) {
          if (r.document_id !== lastDocId) {
            documents++;
            lastDocId = r.document_id;
          }
        }

        sinceSave += batch.length;
        if (sinceSave >= saveEvery) {
          writer.save();
          setIndexVersionProgress(this.db, this.version, Math.min(documents, docsTotal));
          sinceSave = 0;
        }
      }
    }

    writer.close(); // flushes a final save()
    setIndexVersionProgress(this.db, this.version, Math.min(documents, docsTotal));
    this.log.info(
      `Built generation ${this.version}: ${vectors} vector(s) across ${documents}/${docsTotal} doc(s) @ dim ${this.embedDim} in ${Date.now() - startMs}ms`,
    );
    return { vectors, documents };
  }

  /**
   * Crash-safe resume. Continue a `building` generation that was
   * in flight when the gateway last stopped, from where it left off — never
   * re-embedding the chunks already done. The durable record of "how far the
   * build got" is the `chunk_embeddings_building` staging table: the builder
   * commits each embed batch to it transactionally, so it survives a crash
   * intact, whereas the building usearch file is only flushed every few thousand
   * chunks and so may be stale, torn, or truncated after a crash.
   *
   * Two steps:
   *   1. Rebuild the building usearch file from the staging table, so the file
   *      is consistent with the persisted progress with NO embedding — this also
   *      heals a corrupt/truncated/stale `.usearch` left by the crash (it is
   *      discarded and rewritten from staging, never touching the active file).
   *   2. Run the same {@link catchUp} reconciliation as the mid-rebuild fan-out:
   *      embed + stage only the chunks NOT yet covered by the building generation
   *      (the remaining work), and drop vectors whose chunk vanished. Because the
   *      caller runs resume at boot BEFORE the steady-state worker starts, the
   *      corpus is frozen and this single pass fully converges, leaving the
   *      building generation complete and gap-free for the flip.
   *
   * Re-entrant: a second crash mid-resume just leaves more rows in staging, so
   * the next resume rebuilds the file from those and embeds even fewer remaining
   * chunks — it can never restart from zero.
   */
  async resume(): Promise<GenerationCatchUpResult> {
    this.throwIfAborted();
    this.rebuildUsearchFromStaging();
    return this.catchUp();
  }

  /**
   * Reconstruct the building generation's usearch file from the durable staged
   * vectors. Starts from a clean file (the on-disk one may be torn by the crash)
   * and re-adds every staged vector, keyed by the same `chunks.rowid` the active
   * index uses. No embedding — this is a cheap, exact rebuild of a derived
   * artifact from its source of truth. The active generation's file is never
   * touched.
   */
  private rebuildUsearchFromStaging(): void {
    const path = usearchPathForVersion(this.configDir, this.version);
    // Discard any file the crash left behind BEFORE constructing the handle:
    // it may be stale (only the last periodic save), torn, or truncated, and the
    // WriteHandle constructor would otherwise try to `load()` it (which can throw
    // on a corrupt file). The staging table is the source of truth.
    for (const p of [path, `${path}.tmp`]) {
      try {
        unlinkSync(p);
      } catch {
        // missing file is fine
      }
    }
    const writer = new UsearchWriteHandle(path, this.embedDim);
    const PAGE = 5_000;
    let cursor = 0;
    let restored = 0;
    for (;;) {
      this.throwIfAborted();
      const rows = getBuildingEmbeddingsPage(this.db, cursor, PAGE);
      if (rows.length === 0) break;
      for (const r of rows) {
        const vec = new Float32Array(
          r.embedding.buffer,
          r.embedding.byteOffset,
          r.embedding.byteLength / 4,
        );
        writer.add(BigInt(r.chunk_rowid), vec);
        restored++;
      }
      cursor = rows[rows.length - 1].chunk_rowid;
    }
    writer.close();
    this.log.info(
      `Resuming generation ${this.version}: rebuilt usearch file from ${restored} durably-staged vector(s); embedding only the remaining chunks.`,
    );
  }

  /**
   * Mid-rebuild ingest fan-out. Reconciles the building generation
   * against the CURRENT `chunks` state so that documents ingested while the
   * main {@link build} pass was running — which the still-live steady-state
   * worker chunked + embedded into the ACTIVE generation — also land in the
   * building generation, and documents deleted mid-rebuild are dropped from it.
   * After this returns the building generation covers exactly the rows in
   * `chunks` (one staged vector per `chunks.rowid`, no orphans), so the atomic
   * flip's promote leaves no NULL embedding and no resurrected vector.
   *
   * The constraint requires the building generation to be complete AT FLIP
   * TIME, so the caller runs this AFTER quiescing the steady-state worker (the
   * corpus snapshot then stops moving) and BEFORE the pointer move — never
   * after the flip. With ingest quiesced this single pass fully converges; it
   * is also safe to call repeatedly (idempotent: a chunk already staged no
   * longer matches the unstaged predicate).
   *
   * Steady-state re-chunking of a document deletes its old rowids and inserts
   * new ones (see `upsertChunksAndMarkIndexedBatch` with `isUpdate`), so an
   * update surfaces here as an orphan removal of the old rowids plus an
   * addition of the new ones — no stale-content vector survives.
   */
  async catchUp(): Promise<GenerationCatchUpResult> {
    const batchSize = this.opts.batchSize ?? 32;
    const PAGE = 2_000;
    const path = usearchPathForVersion(this.configDir, this.version);
    const writer = new UsearchWriteHandle(path, this.embedDim);

    // 1. Drop vectors whose chunk vanished since it was staged (deleted or
    //    re-chunked mid-rebuild) so nothing resurrects in the new generation.
    const orphans = getOrphanBuildingRowids(this.db);
    for (const rowid of orphans) writer.remove(BigInt(rowid));
    if (orphans.length > 0) deleteBuildingEmbeddings(this.db, orphans);

    // 2. Embed + stage chunks not yet covered by the building generation
    //    (new docs, and the new rowids of re-chunked docs). Paginate by a
    //    rowid cursor — stable under the staging writes this very loop makes,
    //    and it can't spin on an unembeddable row the way a fixed OFFSET would.
    const select = this.db.prepare<[number, number], ChunkRowForBuild>(
      `SELECT c.rowid, c.document_id, c.content, c.title, c.document_type, c.author, c.source_created_at
         FROM chunks c
         LEFT JOIN chunk_embeddings_building b ON b.chunk_rowid = c.rowid
        WHERE b.chunk_rowid IS NULL AND c.rowid > ?
        ORDER BY c.rowid
        LIMIT ?`,
    );

    let added = 0;
    let cursor = 0;
    for (;;) {
      this.throwIfAborted();
      const rows = select.all(cursor, PAGE);
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].rowid;

      for (let i = 0; i < rows.length; i += batchSize) {
        this.throwIfAborted();
        const batch = rows.slice(i, i + batchSize);
        const inputs = batch.map((r) =>
          buildEmbeddingInput(
            buildEmbeddingPreamble({
              documentType: r.document_type,
              title: r.title,
              author: r.author,
              sourceCreatedAt: r.source_created_at,
            }),
            r.content,
          ),
        );
        const embeddings = await this.embedder.embed(inputs);

        const staged: Array<{ chunkRowid: number; embedding: Float32Array }> = [];
        for (let j = 0; j < batch.length; j++) {
          const vec = embeddings[j];
          if (!vec) continue;
          writer.add(BigInt(batch[j].rowid), vec);
          staged.push({ chunkRowid: batch[j].rowid, embedding: vec });
          added++;
        }
        if (staged.length > 0) upsertBuildingEmbeddings(this.db, staged);
      }
    }

    writer.close();

    const documents = getBuildableDocumentCount(this.db);
    setIndexVersionProgress(this.db, this.version, documents);

    if (added > 0 || orphans.length > 0) {
      this.log.info(
        `Generation ${this.version} catch-up: +${added} late-arrival vector(s), -${orphans.length} stale vector(s)`,
      );
    }
    return { added, removed: orphans.length };
  }
}
