// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { createLogger } from "@omnesis/core";
import {
  defineStructuredSource,
  probeFileReadAccess,
  config as configSchema,
  type SyncProgress,
  type HistoryCoverage,
} from "@omnesis/source-sdk";
import { buildDailyDigests } from "./digest.js";
import {
  coreDataToISO,
  coreDataToDate,
  coreDataToUtcWeekday,
  appNameFromBundleId,
  KNOWLEDGE_DB_PATH,
} from "./types.js";
import { KnowledgeDbReader } from "./db-reader.js";
import { aggregateDaily } from "./aggregator.js";
import { allSchemas } from "./schemas.js";
import { screenTimeIcon } from "./icon.js";
import { screenTimeStateSpec } from "./state.js";
import type { ScreenTimeSyncCursor, UsageSession } from "./types.js";

export { buildDailyDigests } from "./digest.js";

const log = createLogger("source:screen-time");

const BATCH_SIZE = 5000;

/**
 * macOS's Knowledge Store keeps a rolling window of app-usage history and
 * prunes older rows on its own schedule — never on this source's. Whatever
 * the source reads is everything the store currently has, which is not the
 * same claim as everything the store ever had: a session older than the
 * current retention window is gone before this source can see it, with no
 * signal left behind that it ever existed. So coverage can never be vouched
 * for as `"complete"` — the honest report is always `"unknown"`.
 */
const COVERAGE: HistoryCoverage = "unknown";
const COVERAGE_DETAIL =
  "macOS keeps only a few weeks of app-usage history. Usage older than that when Omnesis first read it cannot be recovered; everything read since is kept.";

/**
 * What this cycle can say about its history, given whether the store's schema
 * was recognised.
 *
 * An unrecognised schema is not the rolling-window story. The reader answers
 * every query with nothing and raises no error, so the cycle closes cleanly at
 * 100% having read the store and taken none of it — and the rolling-window
 * sentence would explain that away as macOS pruning. This source knows it is
 * missing everything, and "partial" is the word for knowing.
 */
function coverageFor(schemaOk: boolean): { coverage: HistoryCoverage; detail: string } {
  if (schemaOk) return { coverage: COVERAGE, detail: COVERAGE_DETAIL };
  return {
    coverage: "partial",
    detail:
      "Screen Time's database has a layout this version does not recognise, so no app-usage history is being read at all. Updating Omnesis is what fixes it.",
  };
}

export default defineStructuredSource({
  id: "screen-time",
  name: "Screen Time",
  description: "App usage tracking from macOS Screen Time",
  authType: "local",
  unitName: "sessions",
  contract: {
    // The host resolves the stored cursor against this before `sync` runs,
    // so the sync below only ever receives the current shape.
    state: screenTimeStateSpec,
    // Declared because the migration chain is what carries an install off
    // the pre-tiebreaker shape. A host without envelope support would hand
    // the raw stored value to a decoder that rejects it, which reads as a
    // first run.
    requires: ["state-envelope"],
  },
  singleInstance: true,
  supportedPlatforms: ["darwin"],
  multiDevice: { mode: "partitioned" },
  icon: screenTimeIcon,
  analyticsSchemas: allSchemas,
  config: configSchema.object({
    dbPath: configSchema.path({
      label: "Screen Time database",
      // Member-scoped: it names a file on one Mac, and a second Mac hosting
      // this source has its own.
      scope: "member",
      // Not a setup question. macOS keeps this database in one place, and
      // this exists for a copy taken somewhere else.
      advanced: true,
      mustExist: "file",
      help: "Leave blank to use this Mac's own Screen Time database",
    }),
  }),

  async discover() {
    if (process.platform !== "darwin") return [];
    if (!existsSync(KNOWLEDGE_DB_PATH)) return [];
    return ["local"];
  },

  async create({ config, sourceId, providerId }) {
    const dbPath = config?.dbPath ?? KNOWLEDGE_DB_PATH;

    async function syncSessions(cur: ScreenTimeSyncCursor) {
      const reader = new KnowledgeDbReader(dbPath);
      try {
        // Skip COUNT(*) on incremental cycles. The percent display has no
        // useful meaning once bootstrap is past `lastCreationDate > 0` —
        // total minus already-processed isn't the right denominator
        // (sessions are still arriving mid-cycle), and the SELECT COUNT is
        // a full-table scan amortised across thousands of small pages.
        const isBootstrap = cur.lastCreationDate === 0;
        const totalSessions = isBootstrap ? reader.countSessions() : 0;
        const { sessions, invalidDurationCount } = reader.fetchSessions(
          cur.lastCreationDate,
          cur.lastPk,
          BATCH_SIZE,
        );

        if (invalidDurationCount > 0) {
          log.warn(
            `Dropped ${invalidDurationCount} session row(s) with negative or >24h duration ` +
              `from this batch (sanity bound).`,
          );
        }

        // Recorded before the empty-batch return, because an unreadable store
        // takes exactly that return: the reader answers every query with
        // nothing and raises no error, so this is the only point on that path
        // where the schema is still in scope.
        cur.schemaUnreadable = !reader.schemaOk;

        if (sessions.length === 0) {
          log.info(`Sessions phase complete: ${cur.sessionsProcessed} sessions`);
          cur.phase = "daily";
          return {
            cursor: cur,
            hasMore: true,
          };
        }

        // Track affected dates for targeted daily aggregation
        const newDates = new Set(cur.affectedDates);
        for (const s of sessions) {
          newDates.add(coreDataToDate(s.startDate));
        }
        cur.affectedDates = Array.from(newDates);

        // Convert to records — date / day_of_week both anchored to UTC
        // so a late-night session can't desync the (date, day_of_week) pair.
        const records = sessions.map((s) => {
          const startISO = coreDataToISO(s.startDate);
          return {
            id: `${s.bundleId}:${startISO}`,
            bundle_id: s.bundleId,
            app_name: appNameFromBundleId(s.bundleId),
            start_time: startISO,
            end_time: coreDataToISO(s.endDate),
            duration_seconds: s.durationSeconds,
            date: coreDataToDate(s.startDate),
            day_of_week: coreDataToUtcWeekday(s.startDate),
          };
        });

        // Advance the composite (creationDate, pk) cursor to the last emitted
        // session. Z_PK is the tiebreaker so a batch ending mid-tie on
        // ZCREATIONDATE never drops the rows sharing the boundary timestamp.
        const lastSession = sessions[sessions.length - 1]!;
        cur.lastCreationDate = lastSession.creationDate;
        cur.lastPk = lastSession.pk;
        cur.sessionsProcessed += sessions.length;

        const hasMore = sessions.length === BATCH_SIZE;
        if (!hasMore) {
          log.info(`Sessions phase complete: ${cur.sessionsProcessed} sessions`);
          cur.phase = "daily";
        }

        const progress: SyncProgress | undefined =
          isBootstrap && totalSessions > 0
            ? {
                phase: "bootstrap",
                total: totalSessions,
                processed: cur.sessionsProcessed,
                percentComplete: Math.min(
                  100,
                  Math.round((cur.sessionsProcessed / totalSessions) * 100),
                ),
                ...coverageFor(!cur.schemaUnreadable),
              }
            : undefined;

        return {
          analytics: { tableName: "screen_time_sessions", records },
          cursor: cur,
          hasMore: true,
          progress,
        };
      } finally {
        reader.close();
      }
    }

    async function syncDaily(cur: ScreenTimeSyncCursor) {
      const affectedDates = cur.affectedDates;

      if (affectedDates.length === 0) {
        log.info("No sessions to aggregate, skipping daily phase");
        cur.phase = "done";
        // A round that found nothing still closes with the coverage caveat.
        // Reporting no progress at all would leave `coverage` absent, which
        // reads as the question not applying to this source — the one thing
        // a rolling store can never say.
        return {
          cursor: cur,
          hasMore: false,
          progress: {
            phase: "aggregate" as const,
            total: cur.sessionsProcessed,
            processed: cur.sessionsProcessed,
            percentComplete: 100,
            ...coverageFor(!cur.schemaUnreadable),
          },
        };
      }

      // Re-read every session for each affected date from the DB and
      // re-aggregate the whole day. The daily row is upserted by
      // `${bundle_id}:${date}` with REPLACE semantics, so aggregating only
      // this cycle's freshly-read sessions would clobber the day's prior
      // total on every incremental sync. Reading the full day keeps the
      // rollup equal to the sum of all sessions for that date.
      const reader = new KnowledgeDbReader(dbPath);
      let daySessions: UsageSession[];
      try {
        daySessions = affectedDates.flatMap((date) => reader.fetchSessionsForDate(date));
      } finally {
        reader.close();
      }

      const dailyRecords = aggregateDaily(daySessions, new Set(affectedDates));

      log.info(
        `Daily aggregation: ${dailyRecords.length} app-day rows from ${affectedDates.length} dates`,
      );

      cur.phase = "done";
      cur.affectedDates = [];

      return {
        analytics:
          dailyRecords.length > 0
            ? { tableName: "screen_time_daily", records: dailyRecords }
            : undefined,
        // Per-day digest documents make Screen Time BM25-searchable.
        documents: buildDailyDigests(dailyRecords, providerId, sourceId),
        cursor: cur,
        hasMore: false,
        progress: {
          phase: "aggregate" as const,
          total: cur.sessionsProcessed,
          processed: cur.sessionsProcessed,
          percentComplete: 100,
          ...coverageFor(!cur.schemaUnreadable),
        },
      };
    }

    return {
      analyticsSchemas: allSchemas,
      probeReadAccess: (options) => probeFileReadAccess(dbPath, options),
      watchPaths: [dbPath, `${dbPath}-wal`],

      async syncStructured(cursor: ScreenTimeSyncCursor | null) {
        const cur: ScreenTimeSyncCursor = cursor ?? {
          phase: "sessions",
          lastCreationDate: 0,
          lastPk: 0,
          sessionsProcessed: 0,
          affectedDates: [],
        };

        switch (cur.phase) {
          case "sessions":
            return syncSessions(cur);
          case "daily":
            return syncDaily(cur);
          case "done":
            // Reset to sessions phase to pick up new data since last sync
            cur.phase = "sessions";
            return syncSessions(cur);
          default:
            throw new Error(`Unknown sync phase: ${(cur as { phase: string }).phase}`);
        }
      },
    };
  },
});
