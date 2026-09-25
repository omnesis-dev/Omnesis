// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { createLogger } from "@omnesis/core";
import { RowKeyError } from "@omnesis/source-sdk";
import { AnalyticsPageReceiptConflict } from "../../analytics/page-receipt-store.js";
import { catalogOwnerIds } from "../../analytics/catalog-store.js";
import { BadRequestError, ConflictError, InsufficientStorageError } from "../errors.js";
import { hasFreeDiskSpace, type DiskSpaceCheck } from "../../disk-guard.js";
import { epochScope, type SourceWriteEpochFence } from "../../source-write-epoch-fence.js";
import type { EventBus } from "../../events.js";
import type { SourcePageWriteAuthority } from "../../sync-lease.js";
import type { AnalyticsTableSchema, RowKey } from "@omnesis/source-sdk";
import type { AnalyticsAbsenceOutcome } from "../../analytics/absence-store.js";
import type { AnalyticsReplicaHooks } from "../../analytics/table-manager.js";
import type { AnalyticsDb } from "../../analytics-db.js";
import type { SnapshotAbsencePolicy } from "../../data/repositories/AbsenceRepository.js";
import type {
  AnalyticsPresenceArgs,
  AnalyticsRestorerSnapshotArgs,
  AnalyticsTombstoneArgs,
  AnalyticsTombstoneVerdict,
} from "../../data/repositories/AnalyticsReplicaClaimRepository.js";

const log = createLogger("gateway:http").child("analytics");

export interface AnalyticsIngestInput {
  /** Computed at the service boundary, before lease-dependent transformations. */
  receiptDigest?: string;
  pendingPageId?: string;
  writeOrdinal?: number;
  tableName: string;
  records: Record<string, unknown>[];
  schema?: AnalyticsTableSchema;
  sourceId?: string;
  /** Values to delete from `tableName` (upstream tombstones). */
  deletedIds?: string[];
  /** The same tombstones as keys over the table's declared delete key. */
  deletedKeys?: RowKey[];
  /**
   * Column the `deletedIds` values match on. Omit it for a single-column primary
   * key (the value IS that column). Set it when one upstream record fans out into
   * several rows (heart-rate samples share their `record_id`, sleep stages their
   * `session_id`). REQUIRED for a composite primary key — a single-column delete
   * cannot match a composite key without over-deleting, so a composite-PK delete
   * with no `deleteKeyColumn` is rejected (#669).
   */
  deleteKeyColumn?: string;
  /** Deletions the gateway derived from the replica ledger, already canonical. */
  ledgerDeletedKeys?: string[];
  /** Final-page snapshot of row ids currently present upstream. */
  presentIds?: string[];
  /** The same snapshot as keys over the table's declared delete key. */
  presentKeys?: RowKey[];
  /** Write epoch claimed by this collector sync attempt on `cursorRow`. */
  writeEpoch?: number;
  /** Stable identity of this completed snapshot observation. */
  observationId?: string;
  /** The cursor row `writeEpoch` was claimed on (`""` = shared, else a member device's own). */
  cursorRow?: string;
  /** The device stream the page belongs to (`""` = the source's one stream). */
  streamId?: string;
  /**
   * The replicated member whose page this is. Its rows, tombstones and
   * snapshot are that member's verdicts in the replica deletion ledger; unset
   * for every other identity.
   */
  replicaClaimDeviceId?: string;
  /**
   * Whether that member may lead a deletion nobody has reported before, and
   * have its snapshot reconciled — the lease holder's authority. A member
   * without it only adds its voice to rows that already have a history.
   */
  deletionAuthority?: boolean;
}

export interface AnalyticsIngestResult {
  ingested: number;
  deleted: number;
  absence?: AnalyticsAbsenceOutcome;
  /** Tombstones kept from taking effect because another member still holds the row. */
  deletionDisputed?: number;
  /** A fresh deletion the member may not lead was withheld; the page should be replayed. */
  deletionDeferred?: true;
}

/**
 * The replica deletion ledger as the analytics plane reaches it: the SQLite
 * writer for the verdicts, plus the two reads a page needs before it starts.
 */
export interface AnalyticsReplicaLedger {
  /** Every cursor row of the source, so a page that may reset siblings is fenced against all of them. */
  cursorRows(sourceId: string): string[];
  /** Restored rows and durable deletion verdicts whose DuckDB write may need retrying. */
  omissionCandidates(sourceId: string, tableName: string, deviceId: string): string[];
  /** Of `keyValues`, the rows of one table that have a history in the ledger. */
  claimedKeys(sourceId: string, tableName: string, keyValues: readonly string[]): string[];
  judgeTombstones(args: AnalyticsTombstoneArgs): Promise<AnalyticsTombstoneVerdict>;
  recordPresence(args: AnalyticsPresenceArgs): Promise<void>;
  recordRestorerOmissions(args: AnalyticsRestorerSnapshotArgs): Promise<string[]>;
}

export class AnalyticsService {
  constructor(
    private readonly analyticsDb: AnalyticsDb,
    _eventBus: EventBus | undefined,
    _hasOrchestrator: boolean,
    private readonly currentWriteEpoch?: (sourceId: string, cursorRow: string) => number,
    private readonly writeEpochFence?: SourceWriteEpochFence,
    /**
     * Thresholds an omitted row's absence must clear before it deletes. Read
     * fresh per page so a live config edit applies; omitted only on test paths,
     * where a page then records no absences rather than deleting on the spot.
     */
    private readonly absencePolicy?: () => SnapshotAbsencePolicy,
    private readonly replicaLedger?: AnalyticsReplicaLedger,
    private readonly diskGuard?: {
      readonly dbPath: string;
      readonly minFreeBytes: number;
      readonly check?: (path: string, minFreeBytes: number) => DiskSpaceCheck;
    },
  ) {}

  async ingest(
    body: AnalyticsIngestInput,
    assertSourceWireAuthority?: () => void,
    pageWriteAuthority?: () => SourcePageWriteAuthority,
  ): Promise<AnalyticsIngestResult> {
    try {
      const receiptDigest =
        body.pendingPageId === undefined
          ? undefined
          : createHash("sha256")
              .update(
                JSON.stringify({
                  tableName: body.tableName,
                  records: body.records,
                  schema: body.schema,
                  deletedIds: body.deletedIds,
                  deletedKeys: body.deletedKeys,
                  deleteKeyColumn: body.deleteKeyColumn,
                  presentIds: body.presentIds,
                  presentKeys: body.presentKeys,
                }),
              )
              .digest("hex");
      return await this.ingestWithFence(
        { ...body, receiptDigest },
        assertSourceWireAuthority,
        pageWriteAuthority,
      );
    } catch (error) {
      if (error instanceof RowKeyError) throw new BadRequestError(error.message);
      throw error;
    }
  }

  private async ingestWithFence(
    body: AnalyticsIngestInput,
    assertSourceWireAuthority?: () => void,
    pageWriteAuthority?: () => SourcePageWriteAuthority,
  ): Promise<AnalyticsIngestResult> {
    this.assertWriteSpace();
    const sourceId = body.sourceId;
    const member = body.replicaClaimDeviceId;
    if (sourceId && member !== undefined) {
      // A member's page without the ledger would reconcile a non-holder's
      // snapshot as authoritative; fail closed instead.
      if (!this.replicaLedger) {
        throw new Error(
          `replicated analytics page for ${sourceId} without the replica deletion ledger`,
        );
      }
      const ledger = this.replicaLedger;
      const run = () => {
        assertSourceWireAuthority?.();
        return this.ingestReplicated(
          { ...body, ...pageWriteAuthority?.() },
          sourceId,
          member,
          ledger,
        );
      };
      if (!this.writeEpochFence) return run();
      // A member's verdict can reset its siblings, so a page that carries one
      // is fenced against every member's epoch; a page of rows alone is not.
      const carriesVerdicts =
        (body.deletedIds?.length ?? 0) > 0 ||
        (body.deletedKeys?.length ?? 0) > 0 ||
        body.presentIds !== undefined ||
        body.presentKeys !== undefined;
      const scopes = carriesVerdicts
        ? ledger.cursorRows(sourceId).map((cursorRow) => epochScope(sourceId, cursorRow))
        : [epochScope(sourceId, body.cursorRow ?? "")];
      return this.writeEpochFence.runAll(scopes, run);
    }
    if (sourceId && this.writeEpochFence) {
      return this.writeEpochFence.run(epochScope(sourceId, body.cursorRow ?? ""), () => {
        assertSourceWireAuthority?.();
        pageWriteAuthority?.();
        return this.ingestFenced(body);
      });
    }
    if (!sourceId && this.writeEpochFence && assertSourceWireAuthority) {
      return this.writeEpochFence.runGlobalExclusive(() => {
        assertSourceWireAuthority();
        return this.ingestFenced(body);
      });
    }
    assertSourceWireAuthority?.();
    pageWriteAuthority?.();
    return this.ingestFenced(body);
  }

  private assertWriteSpace(): void {
    if (!this.diskGuard) return;
    const check = this.diskGuard.check ?? hasFreeDiskSpace;
    const result = check(dirname(this.diskGuard.dbPath), this.diskGuard.minFreeBytes);
    if (result.ok) return;
    throw new InsufficientStorageError(
      `Analytics ingestion paused: ${Math.floor(result.freeBytes / (1024 * 1024))}MB free is below the configured ${Math.round(this.diskGuard.minFreeBytes / (1024 * 1024))}MB minimum`,
    );
  }

  /**
   * A stale attempt's page is dropped whole. Legacy schema-registration calls
   * carry no epoch and remain allowed after a modern attempt has claimed the
   * source. Once a caller supplies an epoch, however, schema evolution is a
   * write by that attempt too: a schema-only page fetched before a wipe must
   * not archive or retype the replacement generation's table.
   */
  private epochRejected(body: AnalyticsIngestInput): boolean {
    const schemaOnly =
      body.schema !== undefined &&
      body.records.length === 0 &&
      (body.deletedIds?.length ?? 0) === 0 &&
      (body.deletedKeys?.length ?? 0) === 0 &&
      body.presentIds === undefined &&
      body.presentKeys === undefined;
    if (
      (schemaOnly && body.writeEpoch === undefined) ||
      !body.sourceId ||
      !this.currentWriteEpoch
    ) {
      return false;
    }
    const currentWriteEpoch = this.currentWriteEpoch(body.sourceId, body.cursorRow ?? "");
    return (
      (body.writeEpoch !== undefined || currentWriteEpoch > 0) &&
      body.writeEpoch !== currentWriteEpoch
    );
  }

  private async ingestFenced(body: AnalyticsIngestInput): Promise<AnalyticsIngestResult> {
    if (this.epochRejected(body)) return { ingested: 0, deleted: 0 };
    return this.writePage(body);
  }

  /**
   * A replicated member's page. Its rows are its presence claims and its
   * tombstones its verdicts, judged by the ledger from inside the DuckDB
   * transaction. Its snapshot is reconciled only with deletion authority, but
   * it speaks for every member about the rows that member keeps alive against
   * another's deletion: an omission corroborated under the absence policy is
   * the member's verdict and joins the page's tombstones.
   */
  private async ingestReplicated(
    body: AnalyticsIngestInput,
    sourceId: string,
    deviceId: string,
    ledger: AnalyticsReplicaLedger,
  ): Promise<AnalyticsIngestResult> {
    if (this.epochRejected(body)) return { ingested: 0, deleted: 0 };
    const now = Date.now();
    const tableName = body.tableName;
    const policy = this.absencePolicy?.();
    let matured: string[] = [];
    const vouches = body.presentIds !== undefined || body.presentKeys !== undefined;
    if (vouches && policy) {
      // Resolved off the writer: restorations and settled verdicts cross to it.
      // The latter survive a failed DuckDB commit after SQLite settled a key.
      const restored = ledger.omissionCandidates(sourceId, tableName, deviceId);
      {
        // The ledger speaks in canonical keys, so a page that named its rows
        // as records has to be encoded before it can be compared with one —
        // otherwise a restorer's omissions read as an empty snapshot and its
        // rows are never judged at all.
        const named = await this.analyticsDb.pageRowKeys(body);
        const present = new Set(named.present ?? []);
        const tombstoned = new Set(named.deleted ?? []);
        matured = await ledger.recordRestorerOmissions({
          observation:
            body.pendingPageId !== undefined && body.writeOrdinal !== undefined
              ? { pageId: body.pendingPageId, ordinal: body.writeOrdinal }
              : undefined,
          sourceId,
          tableName,
          deviceId,
          snapshot: {
            named: restored.filter((key) => present.has(key)),
            omitted: restored.filter((key) => !present.has(key) && !tombstoned.has(key)),
          },
          absencePolicy: policy,
          now,
        });
      }
    }
    let verdict: AnalyticsTombstoneVerdict | undefined;
    const hooks: AnalyticsReplicaHooks = {
      recordPresence: async (keyValues) => {
        // Only rows with a history concern the ledger, and which ones is read
        // off the writer: a history that appears while this page is in flight
        // comes with a reset of this member, whose bootstrap then re-states
        // its presence, so nothing this read can miss is lost.
        const claimed = ledger.claimedKeys(sourceId, tableName, keyValues);
        if (claimed.length > 0) {
          await ledger.recordPresence({ sourceId, tableName, deviceId, keyValues: claimed, now });
        }
      },
      judgeDeletions: async (existingIds) => {
        verdict = await ledger.judgeTombstones({
          sourceId,
          tableName,
          deviceId,
          existingIds,
          deletionAuthority: body.deletionAuthority === true,
          now,
        });
        return { apply: verdict.apply, deferred: verdict.deferred.length > 0 };
      },
    };
    const result = await this.writePage(
      {
        ...body,
        // The matured omissions are already ledger keys, so they ride beside
        // the page's own deletions rather than being merged into a spelling
        // that cannot express them.
        ledgerDeletedKeys: matured,
        presentIds: body.deletionAuthority ? body.presentIds : undefined,
        presentKeys: body.deletionAuthority ? body.presentKeys : undefined,
      },
      hooks,
      deviceId,
    );
    if (!verdict) return result;
    if (verdict.disputed.length > 0) {
      const line = `${verdict.disputed.length} row deletion(s) asserted by device ${deviceId} on ${sourceId}/${tableName} kept in dispute — another member still holds the rows`;
      if (verdict.newlyDisputed > 0) log.info(line);
      else log.debug(line);
    }
    if (verdict.deferred.length > 0) {
      log.debug(
        `${verdict.deferred.length} fresh row deletion(s) by device ${deviceId} on ${sourceId}/${tableName} withheld: the lease holder leads a deletion nobody has reported`,
      );
    }
    return {
      ...result,
      ...(verdict.disputed.length > 0 ? { deletionDisputed: verdict.disputed.length } : {}),
      ...(verdict.deferred.length > 0 ? { deletionDeferred: true as const } : {}),
    };
  }

  private async writePage(
    body: AnalyticsIngestInput,
    replica?: AnalyticsReplicaHooks,
    observedBy?: string,
  ): Promise<AnalyticsIngestResult> {
    let result: AnalyticsIngestResult;
    try {
      result = await this.analyticsDb.ingestPage({
        receipt:
          body.pendingPageId !== undefined && body.writeOrdinal !== undefined
            ? {
                pageId: body.pendingPageId,
                ordinal: body.writeOrdinal,
                cursorRow: body.cursorRow ?? "",
                // Attempts, authority and inferred omissions can change on replay;
                // only the exact source-produced mutation belongs to its identity.
                digest: body.receiptDigest!,
              }
            : undefined,
        tableName: body.tableName,
        records: body.records,
        schema: body.schema,
        sourceId: body.sourceId ?? "unknown",
        deletedIds: body.deletedIds,
        deletedKeys: body.deletedKeys,
        ledgerDeletedKeys: body.ledgerDeletedKeys,
        deleteKeyColumn: body.deleteKeyColumn,
        presentIds: body.presentIds,
        presentKeys: body.presentKeys,
        observationId: body.observationId,
        absencePolicy: this.absencePolicy?.(),
        streamId: body.streamId,
        replica,
        observedBy,
      });
    } catch (error) {
      if (error instanceof AnalyticsPageReceiptConflict) throw new ConflictError(error.message);
      const message = error instanceof Error ? error.message : String(error);
      // RowKeyError is translated at the complete ingest boundary, including
      // replica preflight. These older refusals still arrive as bare errors.
      if (
        message.startsWith("Cannot delete from") ||
        message.startsWith("Invalid identifier") ||
        (message.startsWith("Analytics table ") && message.includes(" belongs to source type "))
      ) {
        throw new BadRequestError(message);
      }
      throw error;
    }

    return result;
  }

  async sql(sql: string, limit?: number, sourceId?: string) {
    // A source reads only what it declared. It is named rather than trusted
    // with a table list: the gate resolves ownership from the catalog rows the
    // source's own schemas created, so a source cannot widen its own scope.
    //
    // Ownership resolved the one way the catalog records it, which is both
    // spellings — see `catalogOwnerIds`. Naming only the full id denies a
    // source the very table its rows live in whenever a sibling account
    // shares that table.
    //
    // This widening is for a source querying itself, and belongs here rather
    // than in the gate: a delegated grant that names one account should not
    // silently reach a table holding every account's rows.
    return this.analyticsDb.executeQuery(sql, {
      limit,
      ...(sourceId === undefined ? {} : { permittedSourceIds: new Set(catalogOwnerIds(sourceId)) }),
    });
  }

  async catalog() {
    const tables = await this.analyticsDb.getCatalog();
    return { tables };
  }

  async tableInfo(table: string) {
    return this.analyticsDb.getTableInfo(table);
  }

  async tableActivity(table: string, days: number) {
    return this.analyticsDb.getTableActivity(table, days);
  }
}
