// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { APIResponseError, APIErrorCode } from "@notionhq/client";
import { SnapshotEnumeration } from "@omnesis/source-sdk";
import { mapNotionApiError } from "./api-error.js";
import { mapDatabaseToSchema, extractDatabaseTitle } from "./schema-mapper.js";
import {
  extractRowRecord,
  buildPropertyColumnMap,
  summarizeProperties,
} from "./property-extractor.js";
import { databaseSummaryToDocument, databaseRowToDocument, rowExternalId } from "./normalizer.js";
import { INCREMENTAL_MARGIN_MS, shouldEnterSnapshotMode } from "./snapshot-state.js";
import type { NotionClient } from "./client.js";
import type { NotionDatabasesCursor, DatabaseMeta, UserMap, SkippedDatabase } from "./types.js";
import type {
  PageObjectResponse,
  DataSourceObjectResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import type { SnapshotClaim, StructuredSyncResult, TableWrite } from "@omnesis/source-sdk";
import type { ProviderId, SourceId, DocumentInput, SyncIssue } from "@omnesis/types";

const log = createLogger("source:notion-databases");

// ── Tunables ───────────────────────────────────────────────────────
//
// Notion's `search` endpoint is the loudest part of every sync cycle (one
// request per up-to-100 databases) and its results are essentially static
// minute-to-minute for any one workspace. We cache the discovered list in
// the cursor and only re-list when this TTL has elapsed. New / newly-shared
// databases are picked up on the next re-list.
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour

// `INCREMENTAL_MARGIN_MS` and `SNAPSHOT_INTERVAL_MS` live in
// `./snapshot-state.ts` so `pages.ts` and this file can't drift on the
// cadence numbers.

// Backoff schedule for databases that returned 404/403 (transiently
// unshared, archived parent, permission propagation lag). After N
// consecutive failures, wait this many ms before retrying. Capped at the
// last entry — never permanent.
const SKIP_BACKOFF_MS = [
  60 * 60 * 1000, // 1h after 1st failure
  6 * 60 * 60 * 1000, // 6h after 2nd
  24 * 60 * 60 * 1000, // 24h after 3rd+
];

/**
 * Why a rewalk that started behind an incomplete discovery cannot vouch for
 * the workspace. The database is missing from the list that says what
 * "everything" is, so no per-database gap can carry it.
 */
const DISCOVERY_HOLE_REASON =
  "discovery returned a database Notion would not describe, so it never entered the database list";

function computeSkipBackoff(failures: number): number {
  const idx = Math.min(failures - 1, SKIP_BACKOFF_MS.length - 1);
  return SKIP_BACKOFF_MS[Math.max(0, idx)]!;
}

function isFullDatabase(result: unknown): result is DataSourceObjectResponse {
  return (
    typeof result === "object" &&
    result !== null &&
    "properties" in result &&
    (result as { object?: string }).object === "data_source"
  );
}

function isFullPage(result: unknown): result is PageObjectResponse {
  return (
    typeof result === "object" &&
    result !== null &&
    "properties" in result &&
    (result as { object?: string }).object === "page"
  );
}

// Notion's search is eventually consistent with retrieve/query — a database
// ID surfaced by search can 404 when later retrieved (inline databases,
// parent-page permission propagation, sub-DBs in archived pages). Treat these
// as "skip this DB" rather than failing the entire sync.
function isInaccessibleDatabaseError(err: unknown): boolean {
  return (
    APIResponseError.isAPIResponseError(err) &&
    (err.code === APIErrorCode.ObjectNotFound || err.code === APIErrorCode.RestrictedResource)
  );
}

/**
 * Transient Notion-side / network failures that the retry-aware client
 * already gave up on. Rather than letting a 500 on DB N kill the entire
 * multi-DB sync (and lose the work for DBs 1..N-1), we mark the offending
 * DB as skipped with backoff and let `recordSkipAndAdvance` move on. The
 * next sync cycle will retry the skipped DB after its cooldown.
 */
function isTransientServerError(err: unknown): boolean {
  if (APIResponseError.isAPIResponseError(err)) {
    // Anything else from the SDK is non-transient (validation, auth, …)
    // and should still throw.
    return (
      err.code === APIErrorCode.InternalServerError || err.code === APIErrorCode.ServiceUnavailable
    );
  }
  // Non-SDK errors thrown from withRetry — fetch failures, timeouts, etc.
  // Recognise by message shape (the SDK doesn't preserve a clean error type).
  if (err instanceof Error) {
    const msg = err.message;
    if (/status: 5\d\d/i.test(msg)) return true;
    if (/timeout|timed out/i.test(msg)) return true;
    if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(msg)) return true;
  }
  return false;
}

export class NotionDatabasesSource {
  private client: NotionClient;
  private sourceId: SourceId;
  private providerId: ProviderId;
  private dataCutoff?: string;
  private userMap?: UserMap;
  private now: () => number;

  constructor(
    client: NotionClient,
    sourceId: SourceId,
    providerId: ProviderId,
    dataCutoff?: string,
    userMap?: UserMap,
    opts: { nowFn?: () => number } = {},
  ) {
    this.client = client;
    this.sourceId = sourceId;
    this.providerId = providerId;
    this.dataCutoff = dataCutoff;
    this.userMap = userMap;
    this.now = opts.nowFn ?? Date.now;
  }

  /**
   * The collector reads this call's failures to decide a source's state, so
   * every escaping error carries its classification rather than leaving the
   * collector to infer one from Notion's prose.
   */
  async syncStructured(
    cursor: NotionDatabasesCursor | null,
  ): Promise<StructuredSyncResult<NotionDatabasesCursor>> {
    try {
      return await this.runSyncStructured(cursor);
    } catch (err) {
      throw mapNotionApiError(err);
    }
  }

  private async runSyncStructured(
    cursor: NotionDatabasesCursor | null,
  ): Promise<StructuredSyncResult<NotionDatabasesCursor>> {
    if (!cursor) {
      return this.discoverPhase(null);
    }
    if (cursor.phase === "discover") {
      return this.discoverPhase(cursor);
    }
    if (cursor.phase === "sync-db") {
      return this.syncDbPhase(cursor);
    }
    // phase === "done"
    if (this.isDiscoveryCacheFresh(cursor)) {
      const ageMin = Math.floor((this.now() - new Date(cursor.discoveredAt!).getTime()) / 60_000);
      // Decide on snapshot mode at the entry point so the same flag
      // rides through every sync-db page until the rewalk completes.
      const inSnapshotMode = this.shouldStartSnapshot(cursor);
      log.info(
        `Discovery cache fresh (${ageMin}m old, ${cursor.databases.length} dbs) — skipping search, jumping to sync-db${inSnapshotMode ? " (SNAPSHOT mode)" : ""}`,
      );
      return this.syncDbPhase({
        ...cursor,
        phase: "sync-db",
        currentDbIndex: 0,
        dbPageCursor: undefined,
        emittedSummary: false,
        inSnapshotMode,
        snapshot: inSnapshotMode
          ? cursor.discoveryIncomplete
            ? { blindSpot: DISCOVERY_HOLE_REASON }
            : {}
          : cursor.snapshot,
        // Reset the in-progress per-table present set when a fresh rewalk
        // starts; keep `lastSnapshotRowIdsByTable` as the diff baseline.
        snapshotRowIdsByTable: inSnapshotMode ? {} : cursor.snapshotRowIdsByTable,
      });
    }
    // Cache stale → restart discovery, preserving lastSyncTime / skippedDbs /
    // summaryHashes so incremental state survives the re-list.
    return this.discoverPhase({
      ...cursor,
      phase: "discover",
      previousDatabaseIds: [
        ...new Set([
          ...(cursor.previousDatabaseIds ?? []),
          ...cursor.databases.map((database) => database.id),
        ]),
      ],
      databases: [],
      currentDbIndex: 0,
      discoveryCursor: undefined,
      discoveryIncomplete: undefined,
    });
  }

  private isDiscoveryCacheFresh(cursor: NotionDatabasesCursor): boolean {
    if (!cursor.discoveredAt || cursor.databases.length === 0) return false;
    const ageMs = this.now() - new Date(cursor.discoveredAt).getTime();
    return ageMs < DISCOVERY_TTL_MS;
  }

  private shouldStartSnapshot(cursor: NotionDatabasesCursor): boolean {
    // The shared `shouldEnterSnapshotMode` helper expects the
    // `snapshotMode` cursor field name; databases use `inSnapshotMode`
    // (kept distinct because the rewalk is rooted at a different cursor
    // shape). Map it once here so the cadence logic stays single-sourced.
    return shouldEnterSnapshotMode(
      {
        snapshotMode: cursor.inSnapshotMode,
        lastSnapshotAt: cursor.lastSnapshotAt,
      },
      this.now,
    );
  }

  // ── Discovery Phase ─────────────────────────────────────────────────

  private async discoverPhase(
    cursor: NotionDatabasesCursor | null,
  ): Promise<StructuredSyncResult<NotionDatabasesCursor>> {
    const currentCursor: NotionDatabasesCursor = cursor ?? {
      phase: "discover",
      databases: [],
      currentDbIndex: 0,
    };

    const response = await this.client.searchDatabases(currentCursor.discoveryCursor);

    const newDatabases: DatabaseMeta[] = [...currentCursor.databases];

    let undescribedDatabases = 0;
    for (const result of response.results) {
      if (!isFullDatabase(result)) {
        // A database Notion acknowledged but would not describe never enters
        // the walk list, so a later rewalk cannot even know it is missing. It
        // is a hole in the enumeration, not an absence.
        undescribedDatabases++;
        continue;
      }

      // Skip archived or trashed databases
      if (result.archived || ("in_trash" in result && result.in_trash)) continue;

      newDatabases.push({
        id: result.parent.database_id,
        dataSourceId: result.id,
        title: extractDatabaseTitle(result),
        lastEditedTime: result.last_edited_time,
      });
    }

    if (response.has_more && response.next_cursor) {
      // More databases to discover
      const newCursor: NotionDatabasesCursor = {
        ...currentCursor,
        phase: "discover",
        databases: newDatabases,
        discoveryCursor: response.next_cursor,
        discoveryIncomplete: this.carryDiscoveryHole(currentCursor, undescribedDatabases),
      };

      log.info(`Discovered ${newDatabases.length} databases so far (has more)`);

      return {
        cursor: newCursor,
        hasMore: true,
      };
    }

    // Discovery complete — transition to sync-db
    log.info(`Discovery complete: ${newDatabases.length} databases found`);

    const discoveredAt = new Date(this.now()).toISOString();
    const discoveryHole =
      response.has_more || this.carryDiscoveryHole(currentCursor, undescribedDatabases) === true;
    const known = new Set(newDatabases.map((d) => d.id));
    const missingDatabaseIds = [
      ...new Set([
        ...(currentCursor.missingDatabaseIds ?? []),
        ...(!discoveryHole ? (currentCursor.previousDatabaseIds ?? []) : []),
      ]),
    ].filter((id) => !known.has(id));
    // Empty baselines retain which tables were actually registered. Missing
    // databases need repeated empty snapshots to mature gateway deadlines.
    const retainedRowIds = { ...currentCursor.lastSnapshotRowIdsByTable };
    if (!discoveryHole)
      for (const id of missingDatabaseIds) {
        const table = `notion_${id.replace(/-/g, "")}`;
        if (Object.hasOwn(retainedRowIds, table)) retainedRowIds[table] = [];
      }

    if (newDatabases.length === 0) {
      // Through `finishRewalk` like every other exit to `done`. A rewalk that
      // was in flight when discovery came back empty would otherwise reach a
      // terminal cursor still believing it was mid-rewalk, holding an
      // accumulator nothing would ever read or clear.
      const finished = this.finishRewalk({
        ...currentCursor,
        phase: "done",
        databases: [],
        currentDbIndex: 0,
        discoveredAt,
        inSnapshotMode: true,
        missingDatabaseIds,
        lastSnapshotRowIdsByTable: retainedRowIds,
        previousDatabaseIds: discoveryHole ? currentCursor.previousDatabaseIds : undefined,
        snapshot: discoveryHole ? { blindSpot: DISCOVERY_HOLE_REASON } : {},
        discoveryCursor: undefined,
        discoveryIncomplete: discoveryHole || undefined,
      });
      return {
        cursor: finished.cursor,
        hasMore: false,
        presentExternalIds: finished.presentExternalIds,
        presentClaims: finished.presentClaims,
        analytics: finished.analytics,
        issues: finished.issues,
      };
    }

    // Trim summaryHashes / skippedDbs to only databases that still exist —
    // entries for deleted DBs would otherwise grow forever.
    const trimmedSummaryHashes = trimMap(currentCursor.summaryHashes, known);
    const trimmedSkippedDbs = trimMap(currentCursor.skippedDbs, known);

    // Decide whether this freshly-discovered cycle should run as a
    // snapshot rewalk. Same gating as the cache-fresh fast-path.
    const inSnapshotMode = missingDatabaseIds.length > 0 || this.shouldStartSnapshot(currentCursor);
    if (discoveryHole && inSnapshotMode) {
      log.warn(
        "Discovery could not describe at least one database — the rewalk starting now cannot " +
          "enumerate it, so its snapshot will be withheld.",
      );
    }

    const syncCursor: NotionDatabasesCursor = {
      phase: "sync-db",
      databases: newDatabases,
      missingDatabaseIds,
      previousDatabaseIds: discoveryHole ? currentCursor.previousDatabaseIds : undefined,
      currentDbIndex: 0,
      lastSyncTime: currentCursor.lastSyncTime,
      discoveredAt,
      discoveryCursor: undefined,
      skippedDbs: trimmedSkippedDbs,
      summaryHashes: trimmedSummaryHashes,
      lastSnapshotAt: currentCursor.lastSnapshotAt,
      inSnapshotMode,
      // A rewalk starting behind a discovery that could not describe every
      // database it was handed is already incomplete on its first step: the
      // database it is missing is missing from the list that says what
      // "everything" is, so no partition can carry it.
      snapshot: inSnapshotMode
        ? discoveryHole
          ? { blindSpot: DISCOVERY_HOLE_REASON }
          : {}
        : undefined,
      // Cached discoveries retain their uncertainty until a complete search
      // replaces them; a retrying rewalk cannot repair a missing partition.
      discoveryIncomplete: discoveryHole || undefined,
      // Carry the diff baseline across re-discovery;
      // start a clean in-progress accumulator when a rewalk begins.
      lastSnapshotRowIdsByTable: retainedRowIds,
      snapshotRowIdsByTable: inSnapshotMode ? {} : currentCursor.snapshotRowIdsByTable,
    };

    return {
      cursor: syncCursor,
      hasMore: true,
    };
  }

  // ── Sync Db Phase ─────────────────────────────────────────────

  private async syncDbPhase(
    cursor: NotionDatabasesCursor,
  ): Promise<StructuredSyncResult<NotionDatabasesCursor>> {
    const db = cursor.databases[cursor.currentDbIndex];
    if (!db) {
      return this.transitionToDone(cursor);
    }

    // Skip-list short-circuit: if this DB is in backoff and the cooldown
    // has not elapsed, advance immediately. If it has elapsed, drop the
    // entry and give the DB a fresh attempt.
    const skipEntry = cursor.skippedDbs?.[db.id];
    if (skipEntry) {
      const retryAfterMs = new Date(skipEntry.retryAfter).getTime();
      if (this.now() < retryAfterMs) {
        log.warn(
          `Skipping db "${db.title}" (${db.id}) — in backoff until ${skipEntry.retryAfter} (${skipEntry.failures} failures, last: ${skipEntry.lastError})`,
        );
        return this.advanceToNextDb(
          this.gapDatabase(cursor, db.id, `in backoff until ${skipEntry.retryAfter}`),
        );
      }
    }

    // Fetch the full database schema
    let dbResponse;
    try {
      dbResponse = await this.client.getDatabase(db.id, db.dataSourceId);
    } catch (err) {
      if (isInaccessibleDatabaseError(err) || isTransientServerError(err)) {
        // Transient 5xx / network errors get the same skip-with-backoff
        // treatment as 404s — the next sync retries this DB after the
        // cooldown rather than failing the entire multi-DB sync and
        // losing the work for DBs 1..N-1.
        return this.recordSkipAndAdvance(cursor, db, err, "retrieve");
      }
      throw err;
    }
    if (!isFullDatabase(dbResponse)) {
      log.warn(`Db ${db.id} is not accessible, skipping`);
      return this.advanceToNextDb(
        this.gapDatabase(cursor, db.id, "Notion returned it as a partial object"),
      );
    }

    const fullDb = dbResponse;
    const schema = mapDatabaseToSchema(fullDb);
    const propertyColumnMap = buildPropertyColumnMap(fullDb);

    // Apply 2-minute safety margin to lastSyncTime so we don't miss minute-
    // granular `last_edited_time` updates that landed during the previous
    // sync window. In snapshot mode we suppress the filter so every row
    // is enumerated — the snapshot's job is to surface the full present
    // set, not just changed rows.
    const effectiveLastSync = cursor.inSnapshotMode
      ? undefined
      : applyIncrementalMargin(cursor.lastSyncTime);

    // Query rows from the database
    let queryResponse;
    try {
      queryResponse = await this.client.queryDatabase(
        db.id,
        cursor.dbPageCursor,
        effectiveLastSync,
        db.dataSourceId,
      );
    } catch (err) {
      if (isInaccessibleDatabaseError(err) || isTransientServerError(err)) {
        return this.recordSkipAndAdvance(cursor, db, err, "query");
      }
      throw err;
    }

    const records: Record<string, unknown>[] = [];
    const documents: DocumentInput[] = [];
    let nextSummaryHash: string | undefined;
    // Snapshot accumulator for THIS page — added to this database's partition
    // of the rewalk's enumeration below. We collect every row + summary
    // external_id we see so the gateway can diff against its known set on
    // rewalk completion.
    const snapshotIdsThisPage: string[] = [];
    // Present analytics-row primary keys (`id` = page UUID, dashes stripped)
    // seen on THIS page — flushed into cursor.snapshotRowIdsByTable below.
    // Excludes the summary doc, which has no analytics row.
    const snapshotRowIdsThisPage: string[] = [];

    // Emit summary document on the first page of each database — but only
    // when the schema/title has actually changed since we last emitted it.
    if (!cursor.dbPageCursor && !cursor.emittedSummary) {
      const summaryDoc = databaseSummaryToDocument(
        fullDb,
        schema,
        this.sourceId,
        this.providerId,
        this.userMap,
      );
      // Track the summary's externalId for the snapshot regardless of
      // whether we re-emit the doc this cycle — it's a "currently
      // present" anchor for this DB.
      if (cursor.inSnapshotMode) {
        snapshotIdsThisPage.push(summaryDoc.externalId);
      }
      const prevHash = cursor.summaryHashes?.[db.id];
      if (cursor.inSnapshotMode || prevHash !== summaryDoc.contentHash) {
        // A full read also stamps legacy documents with their partition, even
        // when the rendered summary is unchanged.
        documents.push({ ...summaryDoc, partitionKey: db.id });
        nextSummaryHash = summaryDoc.contentHash;
      }
    }

    for (const result of queryResponse.results) {
      if (!isFullPage(result)) {
        // A partial/reference object (no `properties`) — the row still exists
        // upstream, just without a full payload this page. Both planes record
        // it as present: the analytics diff would otherwise mistake a transient
        // object shape for an upstream delete, and the document snapshot
        // would order the deletion of a row document whose row is still there.
        // Nothing to upsert without `properties`.
        if (cursor.inSnapshotMode) {
          snapshotRowIdsThisPage.push(result.id.replace(/-/g, ""));
          snapshotIdsThisPage.push(rowExternalId(result.id));
        }
        continue;
      }

      const page = result;

      // Data retention cutoff: skip *ingesting* rows older than the window, but
      // still record the PK in the snapshot present set. The cutoff is a local
      // `created_time` filter (Notion still returns the row) and a ROLLING
      // window recomputed at every source instantiation — so an aged-out row is
      // present upstream, NOT deleted. Recording it keeps the deletion diff from
      // conflating retention with an upstream delete and tombstoning a live row.
      //Retention pruning, if ever wanted, is a separate concern.
      if (this.dataCutoff && page.created_time < this.dataCutoff) {
        if (cursor.inSnapshotMode) {
          snapshotRowIdsThisPage.push(page.id.replace(/-/g, ""));
          // The document plane for the same reason: a row that aged out of the
          // window is present upstream, so a snapshot that omitted it would
          // delete a document for something that still exists. Retention
          // pruning, if ever wanted, is a separate concern.
          snapshotIdsThisPage.push(rowExternalId(page.id));
        }
        continue;
      }

      const record = extractRowRecord(page, schema, propertyColumnMap);
      records.push(record);
      if (cursor.inSnapshotMode) {
        // The analytics PK is `id` (page UUID, dashes stripped) — see
        // schema-mapper (primaryKey: ["id"]) and extractRowRecord.
        snapshotRowIdsThisPage.push(String(record.id));
      }

      const summary = summarizeProperties(page);
      const summaryEntries = Object.entries(summary).map(([name, value]) => ({
        name,
        value,
      }));
      const rowDoc = databaseRowToDocument(
        page,
        summaryEntries,
        db.title,
        this.sourceId,
        this.providerId,
        this.userMap,
      );
      documents.push({ ...rowDoc, partitionKey: db.id });
      if (cursor.inSnapshotMode) {
        snapshotIdsThisPage.push(rowDoc.externalId);
      }
    }

    // ── Cursor update ────────────────────────────────────────────────

    // First: drop the skip-list entry if present (we just succeeded).
    let nextSkippedDbs = cursor.skippedDbs;
    if (nextSkippedDbs?.[db.id]) {
      const copy = { ...nextSkippedDbs };
      delete copy[db.id];
      nextSkippedDbs = Object.keys(copy).length > 0 ? copy : undefined;
    }

    // Update the summary hash map if we emitted a new summary doc.
    let nextSummaryHashes = cursor.summaryHashes;
    if (nextSummaryHash !== undefined) {
      nextSummaryHashes = { ...(cursor.summaryHashes ?? {}), [db.id]: nextSummaryHash };
    }

    let updatedCursor: NotionDatabasesCursor;
    // Accumulate this page's ids into the rewalk's enumeration, under this
    // database. Adding is not vouching: the database is covered below, on the
    // page that ends it, and only a covered one becomes a claim.
    const snapshotAfterPage = cursor.inSnapshotMode
      ? this.resumeSnapshot(cursor).add(db.id, snapshotIdsThisPage)
      : undefined;

    // Accumulate present analytics-row PKs for this DB's table.
    // Keyed on `schema.tableName` so multi-page pagination across this
    // database lands in the same bucket. Only meaningful in snapshot mode.
    const accumulatedRowIdsByTable = cursor.inSnapshotMode
      ? appendRowIds(cursor.snapshotRowIdsByTable, schema.tableName, snapshotRowIdsThisPage)
      : cursor.snapshotRowIdsByTable;

    // Analytics-row tombstones for THIS database, emitted on its
    // completion page (the page whose `tableName` IS this DB's table).
    let deletedKeys: { id: string }[] | undefined;

    // A page that says there is more and hands back no cursor cannot be
    // resumed. The walk neither continues nor finished, so the database is
    // neither covered nor diffed: covering it would claim a set this read
    // admits is short, and rolling the analytics baseline forward would emit a
    // delete for every row the walk never reached.
    const truncated = queryResponse.has_more === true && !queryResponse.next_cursor;
    if (truncated && cursor.inSnapshotMode) {
      snapshotAfterPage?.gap(
        db.id,
        "the row listing reported more rows and returned no cursor to continue from",
      );
    }
    if (queryResponse.has_more && queryResponse.next_cursor) {
      // More rows in this database
      updatedCursor = {
        ...cursor,
        dbPageCursor: queryResponse.next_cursor,
        emittedSummary: nextSummaryHash !== undefined ? true : cursor.emittedSummary,
        skippedDbs: nextSkippedDbs,
        summaryHashes: nextSummaryHashes,
        snapshot: snapshotAfterPage?.toLedger() ?? cursor.snapshot,
        snapshotRowIdsByTable: accumulatedRowIdsByTable,
      };
    } else {
      // This database is fully enumerated this cycle. In snapshot mode,
      // diff its now-complete present set against the last clean rewalk
      // to derive deleted analytics rows, then roll the baseline forward
      // and drop the in-progress bucket for this table.
      //
      // Per-table delete emission is deliberately INDEPENDENT of whether the
      // rewalk can vouch for the workspace as a whole: a database whose OWN
      // enumeration completed cleanly yields a valid diff even if a sibling DB
      // was skipped 404/403. A skipped DB never reaches this completion branch
      // (it routes through recordSkipAndAdvance), so its baseline is preserved
      // and it emits no deletes — don't "fix" this by gating on the
      // enumeration's completeness.
      let nextLastRowIdsByTable = cursor.lastSnapshotRowIdsByTable;
      let nextRowIdsByTable = accumulatedRowIdsByTable;
      // This database reached the end of its own row pages, so the ids
      // accumulated under it are its complete set — the one thing that lets it
      // be claimed. Every other way out of this database (a skip, a backoff, a
      // partial object) leaves before here and so leaves it uncovered.
      // Covering a database the walk already gapped changes nothing — a
      // declared gap withholds it whatever else happens — so the cover is left
      // unconditional and the gap above is the single place that decides.
      // The analytics diff below is not: it would name every row the truncated
      // walk did not reach, so it is skipped outright.
      snapshotAfterPage?.cover(db.id);
      if (cursor.inSnapshotMode && !truncated) {
        const presentRowIds = accumulatedRowIdsByTable?.[schema.tableName] ?? [];
        const deletes = diffDeletedRowIds(
          cursor.lastSnapshotRowIdsByTable?.[schema.tableName],
          presentRowIds,
        );
        if (deletes.length > 0) {
          // `id` is this table's primary key, and so its delete key.
          deletedKeys = deletes.map((id) => ({ id }));
          log.info(
            `Db "${db.title}": ${deletes.length} analytics row(s) deleted (snapshot diff on ${schema.tableName})`,
          );
        }
        nextLastRowIdsByTable = {
          ...(cursor.lastSnapshotRowIdsByTable ?? {}),
          [schema.tableName]: presentRowIds,
        };
        nextRowIdsByTable = dropTable(accumulatedRowIdsByTable, schema.tableName);
      }

      const nextIndex = cursor.currentDbIndex + 1;
      if (nextIndex >= cursor.databases.length) {
        updatedCursor = {
          ...cursor,
          phase: "done",
          currentDbIndex: nextIndex,
          dbPageCursor: undefined,
          emittedSummary: false,
          lastSyncTime: new Date(this.now()).toISOString(),
          skippedDbs: nextSkippedDbs,
          summaryHashes: nextSummaryHashes,
          snapshot: snapshotAfterPage?.toLedger() ?? cursor.snapshot,
          snapshotRowIdsByTable: nextRowIdsByTable,
          lastSnapshotRowIdsByTable: nextLastRowIdsByTable,
        };
      } else {
        updatedCursor = {
          ...cursor,
          currentDbIndex: nextIndex,
          dbPageCursor: undefined,
          emittedSummary: false,
          skippedDbs: nextSkippedDbs,
          summaryHashes: nextSummaryHashes,
          snapshot: snapshotAfterPage?.toLedger() ?? cursor.snapshot,
          snapshotRowIdsByTable: nextRowIdsByTable,
          lastSnapshotRowIdsByTable: nextLastRowIdsByTable,
        };
      }
    }

    const hasMore = updatedCursor.phase !== "done";

    log.info(
      `Db "${db.title}": ${records.length} rows, ${documents.length} docs (hasMore=${hasMore})`,
    );

    // A rewalk that has walked past the last database closes here.
    const finished = this.finishRewalk(updatedCursor);

    return {
      analytics: [
        {
          tableName: schema.tableName,
          records,
          schema,
          presentKeys: finished.analytics?.find((write) => write.tableName === schema.tableName)
            ?.presentKeys,
          ...(deletedKeys ? { deletedKeys } : {}),
        },
        ...(finished.analytics ?? []).filter((write) => write.tableName !== schema.tableName),
      ],
      documents,
      cursor: finished.cursor,
      hasMore,
      presentExternalIds: finished.presentExternalIds,
      presentClaims: finished.presentClaims,
      issues: finished.issues,
    };
  }

  /**
   * Close out a rewalk that has reached the end of the database list, and
   * decide what it may assert about what still exists.
   *
   * The workspace-wide form (`presentExternalIds`) is an instruction to delete
   * every Notion document the enumeration does not name, so it is earned only
   * by a rewalk that read every database it discovered *and* was handed a
   * discovery that could describe them all. One database in a 403 backoff
   * used to withhold it for the whole workspace, for as long as the backoff
   * lasted — a database unshared by accident could suspend deletion detection
   * for every other one indefinitely.
   *
   * A rewalk that fell short still knows exactly which databases it read to
   * the end, and says so with a claim each. The gateway sweeps only documents
   * whose `partitionKey` names a claimed database, so the unread one's summary
   * and rows are left untouched — which is what withholding was protecting,
   * without stopping the rest.
   *
   * Returns the cursor unchanged for a cycle that is not a rewalk.
   */
  private finishRewalk(cursor: NotionDatabasesCursor): {
    cursor: NotionDatabasesCursor;
    presentExternalIds?: string[];
    presentClaims?: SnapshotClaim[];
    analytics?: TableWrite[];
    issues?: SyncIssue[];
  } {
    if (cursor.phase !== "done" || !cursor.inSnapshotMode) return { cursor };

    const snapshot = this.resumeSnapshot(cursor);
    const analytics = snapshot.claims().flatMap(({ partition }) => {
      const tableName = `notion_${partition.replace(/-/g, "")}`;
      const ids = cursor.lastSnapshotRowIdsByTable?.[tableName];
      return ids === undefined
        ? []
        : [{ tableName, records: [], presentKeys: ids.map((id) => ({ id })) }];
    });

    const cleared: NotionDatabasesCursor = {
      ...cursor,
      inSnapshotMode: false,
      snapshot: undefined,
      // Per-table baselines were rolled at each database's completion. What is
      // left here belongs to databases that never completed one, and is
      // discarded rather than rolled: a partial set diffed against the last
      // clean one would name every row the walk did not reach.
      snapshotRowIdsByTable: undefined,
    };

    if (snapshot.complete) {
      const ids = snapshot.result() ?? [];
      log.info(
        `Snapshot rewalk complete: ${ids.length} ids enumerated across ${cursor.databases.length} dbs`,
      );
      return {
        cursor: { ...cleared, lastSnapshotAt: new Date(this.now()).toISOString() },
        presentExternalIds: ids,
        analytics,
        issues: [],
      };
    }

    const claims = snapshot.claims();
    const issue = snapshot.withheldIssue();
    const issues = issue ? [issue] : [];
    log.warn(snapshot.withheldReason() ?? "Snapshot withheld.");
    if (claims.length === 0) {
      log.warn(
        "Snapshot rewalk read no database to completion — no deletions detected this cycle.",
      );
      // No lastSnapshotAt stamp: the next cycle re-attempts the full rewalk.
      return { cursor: cleared, issues };
    }
    log.info(
      `Claiming ${claims.length} of ${cursor.databases.length} dbs read in full — deletion detection proceeds inside them and is deferred for the rest.`,
    );
    return { cursor: cleared, presentClaims: claims, analytics, issues };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /**
   * End the cycle at the last database, whatever brought it here.
   *
   * A rewalk closes through this too, because it is the exit a skipped last
   * database takes: `advanceToNextDb` walks past the end of the list and the
   * row-query path never runs again. A cycle that only closed the rewalk on
   * the query path would leave `inSnapshotMode` set with a full accumulator
   * and assert nothing at all — every database read to the end, and no
   * deletion detected anywhere, because the last one was in a backoff.
   */
  private transitionToDone(
    cursor: NotionDatabasesCursor,
  ): StructuredSyncResult<NotionDatabasesCursor> {
    const finished = this.finishRewalk({
      ...cursor,
      phase: "done",
      lastSyncTime: new Date(this.now()).toISOString(),
    });
    return {
      cursor: finished.cursor,
      hasMore: false,
      presentExternalIds: finished.presentExternalIds,
      presentClaims: finished.presentClaims,
      analytics: finished.analytics,
      issues: finished.issues,
    };
  }

  /**
   * Record that the in-progress rewalk could not read one database.
   *
   * Every path that leaves a database unread has to go through here. A rewalk
   * that skipped one and finished anyway would emit a snapshot naming only the
   * databases it did read, and the gateway would delete the skipped one's
   * summary document and every row document under it — a backoff cooldown,
   * which is the ordinary consequence of one transient 5xx, turning into a
   * permanent deletion.
   *
   * The gap is per database, so the rest of the workspace is unaffected: those
   * databases are still claimed by name and deletions inside them are still
   * detected this cycle.
   */
  private gapDatabase(
    cursor: NotionDatabasesCursor,
    databaseId: string,
    reason: string,
  ): NotionDatabasesCursor {
    return this.withSnapshot(cursor, (snapshot) => snapshot.gap(databaseId, reason));
  }

  /**
   * Apply `mutate` to this rewalk's enumeration and hand back the cursor
   * holding the result. A cycle that is not a rewalk has no enumeration and is
   * returned untouched.
   *
   * The partitions come from the cursor's database list rather than from the
   * stored ledger, so the cycle's own idea of what the workspace holds is
   * always what the enumeration is judged against.
   */
  private withSnapshot(
    cursor: NotionDatabasesCursor,
    mutate: (snapshot: SnapshotEnumeration) => void,
  ): NotionDatabasesCursor {
    if (!cursor.inSnapshotMode) return cursor;
    const snapshot = this.resumeSnapshot(cursor);
    mutate(snapshot);
    return { ...cursor, snapshot: snapshot.toLedger() };
  }

  /** This rewalk's enumeration so far, judged against the databases it holds now. */
  private resumeSnapshot(cursor: NotionDatabasesCursor): SnapshotEnumeration {
    const missing =
      cursor.snapshot?.blindSpot || cursor.discoveryIncomplete
        ? []
        : (cursor.missingDatabaseIds ?? []);
    const snapshot = SnapshotEnumeration.resume(
      [...cursor.databases.map((db) => db.id), ...missing],
      cursor.snapshot,
    );
    for (const id of missing) snapshot.cover(id, []);
    return snapshot;
  }

  /**
   * Accumulate a discovery-phase hole across the pages of one discovery pass.
   *
   * Deliberately not gated on `inSnapshotMode`: discovery runs before the cycle
   * knows whether it will rewalk, so a mode test here reads false on every
   * ordinary discovery and the hole is silently dropped. Whether the hole
   * matters is decided once, at the transition into the walk.
   */
  private carryDiscoveryHole(
    cursor: NotionDatabasesCursor,
    undescribed: number,
  ): boolean | undefined {
    if (undescribed > 0) {
      log.warn(
        `${undescribed} database(s) came back as partial objects during discovery — they cannot ` +
          `be enumerated, so a rewalk built on this discovery will withhold its snapshot.`,
      );
      return true;
    }
    return cursor.discoveryIncomplete;
  }

  private advanceToNextDb(
    cursor: NotionDatabasesCursor,
  ): StructuredSyncResult<NotionDatabasesCursor> {
    const nextIndex = cursor.currentDbIndex + 1;
    if (nextIndex >= cursor.databases.length) {
      return this.transitionToDone(cursor);
    }

    const updatedCursor: NotionDatabasesCursor = {
      ...cursor,
      currentDbIndex: nextIndex,
      dbPageCursor: undefined,
      emittedSummary: false,
    };

    return {
      cursor: updatedCursor,
      hasMore: true,
    };
  }

  /** Record a skip-list entry for `db`, then advance to the next DB. */
  private recordSkipAndAdvance(
    cursor: NotionDatabasesCursor,
    db: DatabaseMeta,
    err: unknown,
    stage: "retrieve" | "query",
  ): StructuredSyncResult<NotionDatabasesCursor> {
    const errCode = APIResponseError.isAPIResponseError(err) ? err.code : "unknown";
    const prev = cursor.skippedDbs?.[db.id];
    const failures = (prev?.failures ?? 0) + 1;
    const backoffMs = computeSkipBackoff(failures);
    const retryAfter = new Date(this.now() + backoffMs).toISOString();
    const entry: SkippedDatabase = {
      failures,
      retryAfter,
      lastError: `${stage}:${errCode}`,
    };

    log.warn(
      `Db "${db.title}" (${db.id}) inaccessible on ${stage} (${errCode}) — skipping until ${retryAfter} (${failures} failures).`,
    );

    const nextSkippedDbs = { ...(cursor.skippedDbs ?? {}), [db.id]: entry };
    // During a rewalk this database is a gap: the enumeration is missing its
    // rows, so it is not vouched for and the gateway leaves its documents
    // alone. The databases read either side of it are unaffected.
    return this.advanceToNextDb(
      this.gapDatabase(
        { ...cursor, skippedDbs: nextSkippedDbs },
        db.id,
        `${stage} failed (${errCode})`,
      ),
    );
  }
}

/** Subtract `INCREMENTAL_MARGIN_MS` from a timestamp; returns undefined if input is undefined. */
function applyIncrementalMargin(lastSyncTime?: string): string | undefined {
  if (!lastSyncTime) return undefined;
  const ms = new Date(lastSyncTime).getTime() - INCREMENTAL_MARGIN_MS;
  return new Date(ms).toISOString();
}

/** Return a copy of `map` with only keys present in `keep`. Returns undefined
 *  if the input was undefined; an empty object becomes undefined too. */
function trimMap<V>(
  map: Record<string, V> | undefined,
  keep: Set<string>,
): Record<string, V> | undefined {
  if (!map) return undefined;
  const out: Record<string, V> = {};
  let hadAny = false;
  for (const [k, v] of Object.entries(map)) {
    if (keep.has(k)) {
      out[k] = v;
      hadAny = true;
    }
  }
  return hadAny ? out : undefined;
}

// ── Snapshot accumulation helpers ─────────────────────────────────────

/** Append `ids` to `map[key]`, returning a new map. Accumulates a rewalk's
 *  present set across the pages of one database — analytics-row primary keys
 *  keyed by table, document external ids keyed by database. */
function appendRowIds(
  map: Record<string, string[]> | undefined,
  key: string,
  ids: string[],
): Record<string, string[]> {
  const out = { ...(map ?? {}) };
  out[key] = [...(out[key] ?? []), ...ids];
  return out;
}

/** Return a copy of `map` without `table`, or undefined when that empties it. */
function dropTable(
  map: Record<string, string[]> | undefined,
  table: string,
): Record<string, string[]> | undefined {
  if (!map || !(table in map)) return map;
  const out = { ...map };
  delete out[table];
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Rows present at the last clean rewalk but absent now → deleted. Returns
 *  empty when there is no prior baseline (first rewalk of a table never
 *  deletes — a missing prior set means "unknown", not "all gone"). */
function diffDeletedRowIds(previous: string[] | undefined, current: string[]): string[] {
  if (!previous || previous.length === 0) return [];
  const present = new Set(current);
  return previous.filter((id) => !present.has(id));
}
