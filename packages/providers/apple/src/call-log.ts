// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Call-log source design (verified against the
// real CallHistory.storedata schema on macOS 26.3.1; several assumptions in
// that issue turned out wrong, corrected inline below).

import { createHash } from "node:crypto";
import {
  createLogger,
  computeContentHash,
  countryNameToISO2,
  normalizeEmail,
  normalizePhone,
} from "@omnesis/core";
import { SourceId, ProviderId, parseSourceId } from "@omnesis/types";
import { APPLE_CALL_LOG_TABLE, appleCallLogSchema } from "./call-log-schema.js";
import { validateAppleCallLogSyncCursor } from "./types.js";
import { coreDataToISO, isoToCoreData, APPLE_EPOCH_OFFSET_SECONDS } from "./epoch.js";
import { CALL_LOG_FILTER } from "./db-helpers/call-log-db.js";
import { throwOnOpenFailure, type Db } from "./db-helpers/internal.js";
import { unavailableStorePage } from "./store-unavailable.js";
import type { AppleCallLogSyncCursor, RawCallRecord } from "./types.js";
import type { AppleProvider } from "./provider.js";
import type {
  SyncCursor,
  SyncResult,
  SyncProgress,
  StructuredSyncResult,
} from "@omnesis/source-sdk";
import type { DocumentInput, PersonMention, SyncIssue } from "@omnesis/types";

const log = createLogger("source:apple-call-log");

const PAGE_SIZE = 100;

/**
 * Modification key for the change watermark. `ZDATE` is never NULL, and
 * the insertion high-water mark also catches backdated arrivals. Day
 * summaries additionally reconcile full content because deletion and
 * replacement need not advance either watermark.
 */
const MOD_KEY = "ZDATE";

/** One raw call row, straight off `ZCALLRECORD`. */
function callRowSelect(hasCountryCode: boolean, hasDisconnectedCause: boolean): string {
  return `
  SELECT
    Z_PK as pk,
    ZUNIQUE_ID as uniqueId,
    ZADDRESS as address,
    ${hasCountryCode ? "ZISO_COUNTRY_CODE" : "NULL"} as isoCountryCode,
    ZNAME as name,
    ${MOD_KEY} as date,
    ZDURATION as duration,
    ZORIGINATED as originated,
    ZANSWERED as answered,
    ${hasDisconnectedCause ? "ZDISCONNECTED_CAUSE" : "NULL"} as disconnectedCause,
    ZSERVICE_PROVIDER as serviceProvider,
    ZCALLTYPE as callType,
    ZCALL_CATEGORY as callCategory
  FROM ZCALLRECORD
`;
}

function hasCallCountryCode(db: Db): boolean {
  const columns = db.prepare("PRAGMA table_info(ZCALLRECORD)").all() as Array<{ name?: string }>;
  return columns.some((column) => column.name === "ZISO_COUNTRY_CODE");
}

function hasDisconnectedCause(db: Db): boolean {
  const columns = db.prepare("PRAGMA table_info(ZCALLRECORD)").all() as Array<{ name?: string }>;
  return columns.some((column) => column.name === "ZDISCONNECTED_CAUSE");
}

/**
 * Whether a call actually connected. `ZANSWERED` is only meaningful for
 * INCOMING calls — verified empirically: real outgoing calls show
 * `ZANSWERED = 0` regardless of whether they connected and ran up
 * substantial talk time. For outgoing calls, `ZDURATION > 0` is the
 * reliable signal instead.
 */
function isConnected(row: RawCallRecord): boolean {
  if (row.originated === 1) return row.duration > 0;
  return row.answered === 1;
}

/**
 * Whether an incoming call was picked up on a different Apple device than
 * the Mac holding this database. Such rows show `ZANSWERED = 1` with ~zero
 * `ZDURATION` (the Mac never joined audio) and `ZDISCONNECTED_CAUSE = 1`,
 * while calls answered with real talk time carry a NULL cause — Phone.app
 * labels exactly these rows "Answered on other device". Duration alone
 * cannot tell them apart: both present as connected 0s calls.
 */
function isAnsweredElsewhere(row: RawCallRecord): boolean {
  return row.originated === 0 && row.answered === 1 && (row.disconnectedCause ?? null) === 1;
}

/**
 * Call medium. FaceTime's audio-vs-video split (`ZCALLTYPE`/`ZCALL_CATEGORY`)
 * could not be pinned down with confidence from the small real sample (3
 * FaceTime calls) available during development — rather than risk silently
 * mislabeling a video call as audio (or vice versa), FaceTime calls are
 * labeled generically. Revisit if a larger verified sample (or a published
 * mac_apt/iLEAPP field mapping) resolves the split.
 */
function callMedium(row: RawCallRecord): "phone" | "facetime" {
  return row.serviceProvider === "com.apple.FaceTime" ? "facetime" : "phone";
}

/** Format a duration in seconds as a short human string ("12m", "1m 30s", "45s"). */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** UTC calendar date (`YYYY-MM-DD`) for a call row. */
function callDateKey(row: RawCallRecord): string {
  return coreDataToISO(row.date).slice(0, 10);
}

/** Build the peer `PersonMention` for a call row, or undefined if the peer is unidentifiable. */
function peerMention(row: RawCallRecord, deviceRegion?: string): PersonMention | undefined {
  if (!row.address) return undefined;
  const name = row.name ?? undefined;
  if (row.address.includes("@")) {
    return { role: "participant", name, emails: [normalizeEmail(row.address)] };
  }
  const phone = normalizePhone(
    row.address,
    [countryNameToISO2(row.isoCountryCode ?? undefined), countryNameToISO2(deviceRegion)].filter(
      (region): region is NonNullable<typeof region> => region !== undefined,
    ),
  );
  if (!phone) return undefined;
  return { role: "participant", name, phones: [phone] };
}

/** Peer display label for the content line — name if known, else the raw address. */
function peerLabel(row: RawCallRecord): string {
  return row.name ?? row.address ?? "Unknown";
}

interface CallLogPage {
  records: Record<string, unknown>[];
  documents: DocumentInput[];
  deletedExternalIds: string[];
  presentExternalIds: string[] | undefined;
  cursor: SyncCursor;
  hasMore: boolean;
  progress?: SyncProgress;
  issues?: SyncIssue[];
}

/**
 * Apple Call Log source. Reads phone + FaceTime calls from the macOS-local,
 * iCloud-synced `CallHistory.storedata` and produces one `call-log` document
 * per calendar day (aggregating every call that day, all peers) alongside one
 * `apple_call_log` analytics row per raw call.
 *
 * WhatsApp/CallKit calls do NOT sync into this database (verified empirically
 * ) — this source covers Apple phone + FaceTime only.
 */
export class AppleCallLogSource {
  readonly id: SourceId;
  readonly providerId: ProviderId;
  readonly watchPaths: string[];
  readonly dataCutoff?: string;

  /** Pattern A self identity: the source-account email, stamped as a
   * participant on every day-document. Unset when the account id is not
   * email-shaped (`local`). */
  private readonly selfEmail?: string;

  constructor(
    private provider: AppleProvider,
    private opts: {
      sourceId: string;
      providerId: string;
      dataCutoff?: string;
      phoneRegion?: string;
    },
  ) {
    this.id = SourceId(opts.sourceId);
    this.providerId = ProviderId(opts.providerId);
    const dbPath = provider.callLogDbFilePath;
    this.watchPaths = [dbPath, `${dbPath}-wal`];
    this.dataCutoff = opts.dataCutoff;
    const { accountId } = parseSourceId(this.id);
    this.selfEmail = accountId.includes("@") ? accountId : undefined;
  }

  async sync(cursor: SyncCursor | null): Promise<SyncResult> {
    const p = await this.syncPage(cursor);
    return {
      documents: p.documents,
      deletedExternalIds: p.deletedExternalIds,
      presentExternalIds: p.presentExternalIds,
      cursor: p.cursor,
      hasMore: p.hasMore,
      progress: p.progress,
      issues: p.issues,
    };
  }

  async syncStructured(cursor: SyncCursor | null): Promise<StructuredSyncResult> {
    const p = await this.syncPage(cursor);
    return {
      analytics: { tableName: APPLE_CALL_LOG_TABLE, records: p.records },
      documents: p.documents,
      deletedExternalIds: p.deletedExternalIds,
      presentExternalIds: p.presentExternalIds,
      cursor: p.cursor,
      hasMore: p.hasMore,
      progress: p.progress,
      issues: p.issues,
    };
  }

  analyticsSchemas = [appleCallLogSchema];

  private async syncPage(cursor: SyncCursor | null): Promise<CallLogPage> {
    const db = this.provider.getCallLogDb();
    if (!db) {
      throwOnOpenFailure(this.provider.getCallLogOpenFailure());
      return {
        ...unavailableStorePage(cursor ?? { lastModifiedTimestamp: 0 }),
        records: [],
        presentExternalIds: undefined,
      };
    }

    // One read transaction pins the page's fingerprint, day bodies and
    // inventory to the same SQLite view, even while iCloud changes the WAL.
    return db.transaction(() => this.readPage(db, cursor))();
  }

  private readPage(db: Db, cursor: SyncCursor | null): CallLogPage {
    let state = validateAppleCallLogSyncCursor(cursor);

    // Optional-column probe, once per page: Apple varies this schema across
    // releases, so a missing column degrades to NULL instead of breaking the
    // whole sync. Threaded to every query site below (page + day rebuild).
    const schemaFlags = {
      hasCountryCode: hasCallCountryCode(db),
      hasDisconnectedCause: hasDisconnectedCause(db),
    };

    if (state?.dayReconciliation) {
      return this.reconcileDays(db, state, schemaFlags);
    }

    const maxPkNow = (
      db
        .prepare(`SELECT COALESCE(MAX(Z_PK), 0) as maxPk FROM ZCALLRECORD WHERE ${CALL_LOG_FILTER}`)
        .get() as { maxPk: number }
    ).maxPk;

    // Generation guard: unlike Calendar.sqlitedb, ZCALLRECORD's Z_PK is a
    // plain `INTEGER PRIMARY KEY` with no `AUTOINCREMENT` (verified — this
    // database has no `sqlite_sequence` table at all), so there's no
    // dedicated sequence counter to compare against a rebuild. Falling back
    // to the data actually available: if the table's current max Z_PK has
    // dropped below our own high-water mark (only possible if the table
    // was emptied and repopulated from scratch), the file was very likely
    // rebuilt — reset to a fresh bootstrap so every row is re-indexed
    // rather than permanently excluded by a now-stale high-water mark.
    if (state && state.pageModKey === undefined && (state.insertRowIdHighWater ?? 0) > 0) {
      if (maxPkNow < (state.insertRowIdHighWater ?? 0)) {
        log.warn(
          `Call Log database's max Z_PK (${maxPkNow}) dropped below our high-water mark (${state.insertRowIdHighWater}) — likely rebuilt; re-bootstrapping`,
        );
        state = null;
      }
    }

    const wmMod = state?.lastModifiedTimestamp ?? 0;
    const wmRowId = state?.lastModifiedRowId ?? 0;
    const insertHighWater = state?.insertRowIdHighWater ?? 0;
    const pagePos =
      state?.pageModKey !== undefined
        ? { modKey: state.pageModKey, rowId: state.pageRowId ?? 0 }
        : null;

    const ceiling = pagePos ? (state?.cycleRowIdCeiling ?? maxPkNow) : maxPkNow;

    const membershipClause = ` AND (${MOD_KEY} > ? OR (${MOD_KEY} = ? AND Z_PK > ?) OR Z_PK > ?) AND Z_PK <= ?`;
    const membershipParams: number[] = [wmMod, wmMod, wmRowId, insertHighWater, ceiling];
    const pageClause = pagePos ? ` AND (${MOD_KEY} > ? OR (${MOD_KEY} = ? AND Z_PK > ?))` : "";
    const pageParams: number[] = pagePos ? [pagePos.modKey, pagePos.modKey, pagePos.rowId] : [];

    const cutoffTimestamp = this.dataCutoff ? isoToCoreData(this.dataCutoff) : null;
    const cutoffClause = cutoffTimestamp !== null ? ` AND ${MOD_KEY} >= ?` : "";
    const cutoffParams: number[] = cutoffTimestamp !== null ? [cutoffTimestamp] : [];

    let totalCalls: number | undefined = state?.cycleQueueTotal;
    if (totalCalls === undefined) {
      const totalResult = db
        .prepare(
          `SELECT COUNT(*) as count FROM ZCALLRECORD
           WHERE ${CALL_LOG_FILTER}${membershipClause}${cutoffClause}`,
        )
        .get(...membershipParams, ...cutoffParams) as { count: number };
      totalCalls = totalResult.count;
    }

    const rows = db
      .prepare(
        `${callRowSelect(schemaFlags.hasCountryCode, schemaFlags.hasDisconnectedCause)}
         WHERE ${CALL_LOG_FILTER}${membershipClause}${pageClause}${cutoffClause}
         ORDER BY ${MOD_KEY} ASC, Z_PK ASC
         LIMIT ?`,
      )
      .all(...membershipParams, ...pageParams, ...cutoffParams, PAGE_SIZE + 1) as RawCallRecord[];

    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const records: Record<string, unknown>[] = pageRows.map((row) => this.callToRow(row));

    let nextPagePos = pagePos;
    if (pageRows.length > 0) {
      const boundary = pageRows[pageRows.length - 1];
      nextPagePos = { modKey: boundary.date, rowId: boundary.pk };
    }

    const isBootstrap =
      !!state?.bootstrapInProgress ||
      (wmMod === 0 && wmRowId === 0 && insertHighWater === 0 && !pagePos);
    const phase = isBootstrap ? "bootstrap" : "incremental";

    log.info(`Sync produced ${records.length} call rows (${phase}, hasMore: ${hasMore})`);

    let nextCursor: AppleCallLogSyncCursor;
    if (hasMore) {
      nextCursor = {
        lastModifiedTimestamp: wmMod,
        lastModifiedRowId: wmRowId,
        insertRowIdHighWater: insertHighWater,
        cycleRowIdCeiling: ceiling,
        pageModKey: nextPagePos?.modKey,
        pageRowId: nextPagePos?.rowId,
        bootstrapInProgress: isBootstrap ? true : undefined,
        cycleQueueTotal: totalCalls,
        lastSnapshotSignature: state?.lastSnapshotSignature,
        dayReconciliationComplete: state?.dayReconciliationComplete,
      } satisfies AppleCallLogSyncCursor;
    } else {
      let newWmMod = wmMod;
      let newWmRowId = wmRowId;
      if (
        nextPagePos &&
        (nextPagePos.modKey > wmMod ||
          (nextPagePos.modKey === wmMod && nextPagePos.rowId > wmRowId))
      ) {
        newWmMod = nextPagePos.modKey;
        newWmRowId = nextPagePos.rowId;
      }
      nextCursor = {
        lastModifiedTimestamp: newWmMod,
        lastModifiedRowId: newWmRowId,
        insertRowIdHighWater: Math.max(insertHighWater, ceiling),
        lastSnapshotSignature: state?.lastSnapshotSignature,
        dayReconciliationComplete: state?.dayReconciliationComplete,
      } satisfies AppleCallLogSyncCursor;
    }

    if (!hasMore) {
      const signature = this.dayContentSignature(db, schemaFlags);
      if (!state?.dayReconciliationComplete || signature !== state.lastSnapshotSignature) {
        const reconciled = this.reconcileDays(
          db,
          {
            ...nextCursor,
            dayReconciliation: { afterDay: "", signature },
          },
          schemaFlags,
          signature,
        );
        return { ...reconciled, records };
      }
    }

    return {
      records,
      documents: [],
      deletedExternalIds: [],
      presentExternalIds: undefined,
      cursor: nextCursor,
      hasMore,
      issues: hasMore ? undefined : [],
      progress:
        totalCalls > 0 ? { phase, processed: records.length, total: totalCalls } : undefined,
    };
  }

  /** Stream exact day-document inputs, rather than retaining a per-day cursor map. */
  private dayContentSignature(
    db: Db,
    schemaFlags: { hasCountryCode: boolean; hasDisconnectedCause: boolean },
  ): string {
    const cutoff = this.dataCutoff ? isoToCoreData(this.dataCutoff) : null;
    const hash = createHash("sha256");
    // Rendering context can change even when the underlying store does not.
    hash.update(JSON.stringify([this.selfEmail, this.opts.phoneRegion, this.dataCutoff]));
    for (const row of db
      .prepare(
        `${callRowSelect(schemaFlags.hasCountryCode, schemaFlags.hasDisconnectedCause)}
      WHERE ${CALL_LOG_FILTER}${cutoff === null ? "" : ` AND ${MOD_KEY} >= ?`} ORDER BY Z_PK`,
      )
      .iterate(...(cutoff === null ? [] : [cutoff]))) {
      hash.update(JSON.stringify(row));
      hash.update("\n");
    }
    return hash.digest("hex");
  }

  /** Rebuild at most one page of complete days; publish absence only after a stable walk. */
  private reconcileDays(
    db: Db,
    state: AppleCallLogSyncCursor,
    schemaFlags: { hasCountryCode: boolean; hasDisconnectedCause: boolean },
    knownSignature?: string,
  ): CallLogPage {
    const cutoff = this.dataCutoff ? isoToCoreData(this.dataCutoff) : null;
    const where = `${CALL_LOG_FILTER}${cutoff === null ? "" : ` AND ${MOD_KEY} >= ?`}`;
    const params = cutoff === null ? [] : [cutoff];
    const current = knownSignature ?? this.dayContentSignature(db, schemaFlags);
    const scan = state.dayReconciliation!;
    const after = scan.signature === current ? scan.afterDay : "";
    // SQLite's date parser rounds fractional milliseconds; floor seconds
    // first so the final submillisecond cannot jump into tomorrow's ID.
    const daySql = `date(floor(${MOD_KEY} + ${APPLE_EPOCH_OFFSET_SECONDS}), 'unixepoch')`;
    const days = db
      .prepare(
        `SELECT DISTINCT ${daySql} AS day FROM ZCALLRECORD
      WHERE ${where} AND ${daySql} > ? ORDER BY day LIMIT ?`,
      )
      .all(...params, after, PAGE_SIZE + 1) as { day: string }[];
    const page = days.slice(0, PAGE_SIZE);
    const documents = page.map(({ day }) => this.buildDayDocument(db, day, schemaFlags));
    const hasMore = days.length > PAGE_SIZE;
    let presentExternalIds: string[] | undefined;
    if (!hasMore) {
      const inventory = db
        .prepare(`SELECT DISTINCT ${daySql} AS day FROM ZCALLRECORD WHERE ${where}`)
        .all(...params) as { day: string }[];
      presentExternalIds = inventory.map(({ day }) => `call-log:${day}`);
    }
    // readPage's SQLite transaction keeps the signature and all page reads
    // on one snapshot; changes between pages restart the keyset walk above.
    return {
      records: [],
      documents,
      deletedExternalIds: [],
      presentExternalIds,
      hasMore,
      issues: hasMore ? undefined : [],
      cursor: {
        ...state,
        affectedDates: [],
        lastSnapshotSignature: hasMore ? state.lastSnapshotSignature : current,
        dayReconciliationComplete: hasMore ? state.dayReconciliationComplete : true,
        dayReconciliation: hasMore
          ? { afterDay: page.at(-1)?.day ?? after, signature: current }
          : undefined,
      } satisfies AppleCallLogSyncCursor,
    };
  }

  /** Build the `apple_call_log` analytics row for one raw call. */
  private callToRow(row: RawCallRecord): Record<string, unknown> {
    const direction = row.originated === 1 ? "outgoing" : "incoming";
    const mention = peerMention(row, this.opts.phoneRegion);
    const counterparty = mention?.emails?.[0] ?? mention?.phones?.[0] ?? row.address ?? "unknown";
    return {
      id: row.uniqueId,
      date: callDateKey(row),
      time: coreDataToISO(row.date),
      direction,
      medium: callMedium(row),
      duration_seconds: row.duration,
      // Answered-anywhere, deliberately: a call picked up on another device
      // still counts as connected here (the day-document, not this table,
      // is where the answered-elsewhere distinction is drawn).
      connected: isConnected(row),
      counterparty,
      counterparty_name: row.name ?? null,
    };
  }

  /** Re-read every call for `date` (UTC) and rebuild that day's aggregate document. */
  private buildDayDocument(
    db: Db,
    date: string,
    schemaFlags: { hasCountryCode: boolean; hasDisconnectedCause: boolean },
  ): DocumentInput {
    const dayStart = isoToCoreData(`${date}T00:00:00.000Z`);
    const dayEnd = dayStart + 24 * 60 * 60;
    // `dataCutoff` is an arbitrary instant, not necessarily midnight-aligned,
    // so a day can straddle it — clamp the lower bound so pre-cutoff calls on
    // an affected day never leak into the rebuilt document (they're already
    // excluded from the analytics rows via the same cutoff elsewhere in this
    // file, and must be excluded here too for the two views to agree).
    const cutoffTimestamp = this.dataCutoff ? isoToCoreData(this.dataCutoff) : null;
    const lowerBound = cutoffTimestamp !== null ? Math.max(dayStart, cutoffTimestamp) : dayStart;
    const rows = db
      .prepare(
        `${callRowSelect(schemaFlags.hasCountryCode, schemaFlags.hasDisconnectedCause)}
         WHERE ${CALL_LOG_FILTER} AND ${MOD_KEY} >= ? AND ${MOD_KEY} < ?
         ORDER BY ${MOD_KEY} ASC`,
      )
      .all(lowerBound, dayEnd) as RawCallRecord[];

    const lines: string[] = [`# Calls — ${date}`, ""];
    let totalDuration = 0;
    const calls: Record<string, unknown>[] = [];
    const people: PersonMention[] = [];
    if (this.selfEmail) {
      people.push({ role: "participant", emails: [this.selfEmail] });
    }
    const seenPeers = new Set<string>();

    for (const row of rows) {
      const time = coreDataToISO(row.date).slice(11, 16);
      const outgoing = row.originated === 1;
      const connected = isConnected(row);
      const answeredElsewhere = isAnsweredElsewhere(row);
      const medium = callMedium(row) === "facetime" ? "FaceTime" : "Phone";
      const label = peerLabel(row);
      const arrow = outgoing ? "→" : "←";
      const direction = outgoing ? "Outgoing" : "Incoming";

      let qualifier: string;
      if (answeredElsewhere) {
        // A handoff race can leave a few seconds of local audio on the
        // row — show them rather than silently dropping them, but only
        // when they round to a nonzero duration.
        const localSeconds = Math.max(0, Math.round(row.duration));
        qualifier =
          localSeconds > 0
            ? ` (answered on another device, ${formatDuration(row.duration)})`
            : " (answered on another device)";
        totalDuration += row.duration;
      } else if (connected) {
        qualifier = `, ${formatDuration(row.duration)}`;
        totalDuration += row.duration;
      } else {
        qualifier = outgoing ? " (no answer)" : ", missed";
      }
      lines.push(`- ${time} ${direction} ${medium} ${arrow} ${label}${qualifier}`);

      const mention = peerMention(row, this.opts.phoneRegion);
      if (mention) {
        const key = mention.emails?.[0] ?? mention.phones?.[0] ?? "";
        if (key && !seenPeers.has(key)) {
          seenPeers.add(key);
          people.push(mention);
        }
      }

      calls.push({
        time: coreDataToISO(row.date),
        direction: outgoing ? "outgoing" : "incoming",
        medium: callMedium(row),
        durationSeconds: row.duration,
        connected,
        answeredElsewhere,
        peer: mention?.emails?.[0] ?? mention?.phones?.[0] ?? row.address ?? null,
      });
    }

    lines.splice(
      2,
      0,
      `**Total:** ${rows.length} call${rows.length === 1 ? "" : "s"}, ${formatDuration(totalDuration)}`,
      "",
    );
    const content = lines.join("\n");

    return {
      providerId: this.providerId,
      sourceId: this.id,
      externalId: `call-log:${date}`,
      title: `Calls — ${date}`,
      content,
      contentHash: computeContentHash(content),
      metadata: {
        documentType: "call-log",
        // Rewritten every time a call lands on this date — route to the
        // daily batch instead of waking the real-time background agent on
        // every edit (mirrors the Screen Time digest).
        rollingAggregate: true,
        people: people.length > 0 ? people : undefined,
        tags: [],
        extra: {
          date,
          callCount: rows.length,
          totalDurationSeconds: totalDuration,
          calls,
        },
      },
      sourceCreatedAt: `${date}T00:00:00.000Z`,
      sourceUpdatedAt: `${date}T23:59:59.999Z`,
    };
  }
}
