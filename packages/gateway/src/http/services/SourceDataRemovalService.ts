// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { RowKeyError } from "@omnesis/source-sdk";
import { epochScope, type SourceWriteEpochFence } from "../../source-write-epoch-fence.js";
import { HttpError } from "../errors.js";
import type Database from "better-sqlite3";
import type { AnalyticsDb } from "../../analytics-db.js";
import type { IndexWriteGate } from "../../indexer/index-write-gate.js";
import type { WriteGate } from "../../write-gate.js";

const log = createLogger("gateway:http").child("documents:removal");

export interface SourceDataRemovalDeps {
  db: Database.Database;
  writeGate: WriteGate;
  indexWriteGate?: IndexWriteGate;
  analyticsDb?: AnalyticsDb;
  sourceWriteEpochFence?: SourceWriteEpochFence;
  /** The cognitive-state cascade over deleted document ids (`purgeCognitiveStateThroughGate`). */
  purgeAnnotationsFor: (documentIds: readonly string[]) => Promise<void>;
}

/** Owns source/stream teardown and document-provider cleanup across stores. */
export class SourceDataRemovalService {
  constructor(private readonly deps: SourceDataRemovalDeps) {}

  /** Called inside the caller's write fence, before retiring recovery authority. */
  async prepareSourceRemoval(sourceId: string, streamId?: string): Promise<void> {
    try {
      await this.deps.analyticsDb?.prepareSourceRemoval(sourceId, streamId);
    } catch (error) {
      if (error instanceof RowKeyError) {
        throw new HttpError(409, "ANALYTICS_OWNERSHIP_UNRESOLVED", error.message);
      }
      throw error;
    }
  }

  /** Throw the one error, or every error at once, so a partial cleanup is never silent. */
  private static raise(errors: unknown[], message: string): void {
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, message);
  }

  private async purgeAnalyticsForSourceUnfenced(sourceId: string): Promise<string[]> {
    const { analyticsDb } = this.deps;
    if (!analyticsDb) return [];
    return analyticsDb.deleteAnalyticsForSource(sourceId);
  }

  /**
   * Purge every analytics row a source wrote under source-exclusive authority.
   * Used by post-removal cleanup paths that do not own the full multi-store
   * wipe. A caller already inside `runSourceExclusive` uses the private helper
   * so the non-reentrant barrier is never nested.
   */
  async purgeAnalyticsForSource(sourceId: string): Promise<string[]> {
    const purge = () => this.purgeAnalyticsForSourceUnfenced(sourceId);
    return this.deps.sourceWriteEpochFence
      ? this.deps.sourceWriteEpochFence.runSourceExclusive(sourceId, purge)
      : purge();
  }

  /**
   * Delete one device's stream of a partitioned source across every store:
   * the documents and their cascades in SQLite, their chunks in the index,
   * and the device's rows and projections in analytics. The source and its
   * other streams stay.
   *
   * The cognitive-state cascade runs before the SQLite delete, while the
   * document ids still join to what quotes them, and again after it, over
   * the ids the writer actually removed — a document that landed between
   * the two would otherwise leave its annotations behind. That cascade
   * also retracts the coverage of sources that no longer exist; a stream
   * wipe leaves the source registered, so its coverage is untouched here.
   *
   * The analytics purge is fenced on the device's own cursor row, the scope
   * its ingest pages are fenced on, so a page in flight for the stream is
   * serialized before or after the purge, never through it.
   */
  async deleteStream(
    sourceId: string,
    deviceId: string,
    options: { resetCursor?: boolean } = {},
  ): Promise<{ deleted: number; analyticsCleaned: string[] }> {
    if (deviceId === "") {
      throw new Error(
        `The shared stream of ${sourceId} is removed with the source, not on its own`,
      );
    }
    const remove = async (): Promise<{ deleted: number; analyticsCleaned: string[] }> => {
      await this.prepareSourceRemoval(sourceId, deviceId);
      const doomedDocIds = this.deps.db
        .prepare<[string, string], { id: string }>(
          "SELECT id FROM documents WHERE source_id = ? AND stream_id = ?",
        )
        .all(sourceId, deviceId)
        .map((row) => row.id);
      await this.deps.purgeAnnotationsFor(doomedDocIds);
      const { deleted, documentIds } = await this.deps.writeGate.deleteAllByStream(
        sourceId,
        deviceId,
      );
      await this.deps.purgeAnnotationsFor([...new Set([...doomedDocIds, ...documentIds])]);

      let indexDeleted = 0;
      let analyticsCleaned: string[] = [];
      const cleanupErrors: unknown[] = [];
      if (this.deps.indexWriteGate) {
        try {
          indexDeleted = await this.deps.indexWriteGate.deleteChunksByDocuments(documentIds);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (this.deps.analyticsDb) {
        try {
          analyticsCleaned = await this.deps.analyticsDb.deleteAnalyticsStream(sourceId, deviceId);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      SourceDataRemovalService.raise(
        cleanupErrors,
        `Stream cleanup incomplete for ${sourceId} (device ${deviceId})`,
      );
      if (options.resetCursor) {
        await this.deps.writeGate.resetMemberCursor(sourceId, deviceId);
      }
      log.info(
        `Deleted stream of device ${deviceId} on ${sourceId}: ${deleted} docs, ${indexDeleted} chunks, ${analyticsCleaned.length} analytics tables`,
      );
      return { deleted, analyticsCleaned };
    };
    return this.deps.sourceWriteEpochFence
      ? this.deps.sourceWriteEpochFence.run(epochScope(sourceId, deviceId), remove)
      : remove();
  }

  async deleteSource(
    sourceId: string,
    assertSourceWireAuthority?: () => void,
  ): Promise<{ deleted: number; analyticsDropped: string[] }> {
    const remove = async (): Promise<{ deleted: number; analyticsDropped: string[] }> => {
      assertSourceWireAuthority?.();
      await this.prepareSourceRemoval(sourceId);
      const doomedDocIds = this.deps.db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE source_id = ?")
        .all(sourceId)
        .map((row) => row.id);
      await this.deps.purgeAnnotationsFor(doomedDocIds);
      const deleted = await this.deps.writeGate.deleteAllBySource(sourceId);
      await this.deps.purgeAnnotationsFor(doomedDocIds);

      let indexDeleted = 0;
      let analyticsDropped: string[] = [];
      const cleanupErrors: unknown[] = [];
      if (this.deps.indexWriteGate) {
        try {
          indexDeleted = await this.deps.indexWriteGate.deleteIndexBySource(sourceId);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        analyticsDropped = await this.purgeAnalyticsForSourceUnfenced(sourceId);
      } catch (error) {
        cleanupErrors.push(error);
      }
      SourceDataRemovalService.raise(cleanupErrors, `Data cleanup incomplete for ${sourceId}`);
      log.info(
        `Deleted all data for source ${sourceId}: ${deleted} docs, ${indexDeleted} indexed, ${analyticsDropped.length} analytics tables`,
      );
      return { deleted, analyticsDropped };
    };
    return this.deps.sourceWriteEpochFence
      ? this.deps.sourceWriteEpochFence.runSourceExclusive(sourceId, remove)
      : remove();
  }

  /**
   * The document-provider endpoint selects sources through their documents.
   * It is not provider uninstall: analytics-only sources have no durable
   * document-provider association and are removed through the source API.
   */
  async deleteProvider(
    providerId: string,
    assertSourceWireAuthority?: () => void,
  ): Promise<{ deleted: number }> {
    const remove = async (): Promise<{ deleted: number }> => {
      assertSourceWireAuthority?.();
      const doomedRows = this.deps.db
        .prepare<
          [string],
          { id: string; source_id: string }
        >("SELECT id, source_id FROM documents WHERE provider_id = ?")
        .all(providerId);
      for (const sourceId of new Set(doomedRows.map((row) => row.source_id))) {
        await this.prepareSourceRemoval(sourceId);
      }
      const doomedDocIds = doomedRows.map((row) => row.id);
      await this.deps.purgeAnnotationsFor(doomedDocIds);
      const deleted = await this.deps.writeGate.deleteAllByProvider(providerId);
      await this.deps.purgeAnnotationsFor(doomedDocIds);

      const cleanupErrors: unknown[] = [];
      for (const sourceId of new Set(doomedRows.map((row) => row.source_id))) {
        if (this.deps.indexWriteGate) {
          try {
            await this.deps.indexWriteGate.deleteIndexBySource(sourceId);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        try {
          await this.purgeAnalyticsForSourceUnfenced(sourceId);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      SourceDataRemovalService.raise(
        cleanupErrors,
        `Provider cleanup incomplete for ${providerId}`,
      );
      log.info(`Deleted all documents for provider ${providerId}: ${deleted} docs`);
      return { deleted };
    };
    return this.deps.sourceWriteEpochFence
      ? this.deps.sourceWriteEpochFence.runGlobalExclusive(remove)
      : remove();
  }

  /**
   * Detach a member — or, without one, every device — from the row absences
   * its snapshots earned, so none of them becomes its verdict when swept.
   */
  async forgetAbsenceObserver(sourceId: string, deviceId?: string): Promise<void> {
    await this.deps.analyticsDb?.forgetAbsenceObserver(sourceId, deviceId);
  }
}
