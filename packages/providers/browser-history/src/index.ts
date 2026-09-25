// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { join } from "node:path";
import { createLogger } from "@omnesis/core";
import {
  defineStructuredSource,
  probeFileReadAccess,
  SnapshotEnumeration,
} from "@omnesis/source-sdk";
import { detectInstalledBrowsers, getBrowserInfo } from "./paths.js";
import { probeChromiumReadAccess } from "./read-access.js";
import { ChromiumHistoryReader, msToChromiumTimestamp } from "./readers/chromium.js";
import { SafariHistoryReader, msToSafariTimestamp } from "./readers/safari.js";
import { shouldIncludeVisit, visitDropReason, type VisitDropReason } from "./filters.js";
import { buildDailyDocument, buildDailyEdges } from "./normalizer.js";
import { aggregateDaily } from "./aggregator.js";
import { allSchemas } from "./schemas.js";
import { browserHistoryCatalogIconDataUri, getBrowserIconImage } from "./icons.js";
import { browserHistoryStateSpec } from "./state.js";
import type { EdgeDeclaration } from "@omnesis/core";
import type { BrowserHistoryReader } from "./readers/types.js";
import type { BrowserHistoryCursor, BrowserHistoryConfig, RawVisit, BrowserId } from "./types.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";

/** Per-browser brand colour for the iOS SF Symbol tint. */
const BROWSER_TINTS: Record<BrowserId, string> = {
  chrome: "#4285F4",
  safari: "#1EA7FF",
  arc: "#F65A47",
  brave: "#FB542B",
  edge: "#0078D4",
  vivaldi: "#EF3B39",
};

const log = createLogger("source:browser-history");
const BATCH_SIZE = 5000;

/**
 * A browser's history table can age entries out on its own — Safari alone
 * offers a user-configurable auto-expiry ("Remove history items") distinct
 * from an explicit clear — and a user can clear it entirely at any time.
 * Nothing in the database records what has already been removed, so this
 * source can never establish whether the visits it reads are the whole
 * history or a remnant of one — only that it is reading everything the
 * browser currently retains.
 */
const HISTORY_COVERAGE_DETAIL =
  "Browsers delete old history on their own, and history can be cleared at any time. Omnesis keeps what the browser keeps, so older visits may not be here.";

/** Short hash for making unique IDs from URLs */
function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}

export default defineStructuredSource<BrowserHistoryCursor>({
  id: "browser-history",
  name: "Browser History",
  description: "Browsing history from Chrome, Safari, Arc, Brave, Edge, and Vivaldi",
  authType: "local",
  unitName: "visits",
  contract: {
    // The host resolves the stored cursor against this before `sync` runs,
    // so a value from a build that could not read it never reaches `sync`.
    state: browserHistoryStateSpec,
    requires: ["state-envelope"],
  },
  icon: {
    sfSymbol: "globe",
    color: "#007AFF",
    bgColor: "#0E2236",
    imageDataUri: browserHistoryCatalogIconDataUri,
  },
  // Browser history is bulky and low-signal compared to personal docs.
  // The bench measured competing results with cosine differences <0.1,
  // so a small additive downweight pushes browsing visits below an
  // email or note matching the same query — unless BM25 finds a strong
  // rare-token match, in which case the bypass keeps the visit visible.
  defaultSourcePrior: -0.04,
  // Daily-visit summaries are a referential URL bag — let the gateway
  // skip `url` edges through them in graph subgraph walks.
  urlHub: true,
  analyticsSchemas: allSchemas,
  // Deliberately exclusive. A browser profile can contain both device-local
  // visits and visits copied by browser sync. Partitioning would duplicate
  // the copied subset; replication could erase the local-only subset when a
  // lagging profile reconciles. A non-exclusive mode requires stable synced
  // profile identity plus cross-device presentation/deletion semantics.

  async discover() {
    // TODO: Add Firefox detection when Firefox support is implemented (#158)
    return detectInstalledBrowsers().map((b) => b.id);
  },

  async create({ accountId, sourceId, providerId, sourceConfig, dataCutoff }) {
    const browserId = accountId as BrowserId;
    const browserInfo = getBrowserInfo(browserId);
    if (!browserInfo) {
      throw new Error(`Browser "${browserId}" not found or not installed`);
    }

    const config = sourceConfig?.params as BrowserHistoryConfig | undefined;
    log.info(`Creating browser history source for ${browserInfo.name} (${browserId})`);

    function createReader(): BrowserHistoryReader {
      if (browserInfo!.engine === "chromium") {
        return new ChromiumHistoryReader(browserInfo!, config);
      }
      return new SafariHistoryReader(browserInfo!);
    }

    /** Convert ms since epoch to the native timestamp format for cursor storage */
    function msToNativeTimestamp(ms: number): number {
      if (browserInfo!.engine === "chromium") return msToChromiumTimestamp(ms);
      return msToSafariTimestamp(ms);
    }

    /** Get an initial cursor timestamp respecting dataCutoff */
    function getInitialTimestamp(): number {
      if (dataCutoff) {
        return msToNativeTimestamp(new Date(dataCutoff).getTime());
      }
      return 0;
    }

    const reader = createReader();
    const watchPaths = reader.getWatchPaths();
    const hasMultipleProfiles =
      browserInfo.engine === "chromium" && (reader as ChromiumHistoryReader).hasMultipleProfiles();
    reader.close();

    async function syncVisits(
      cur: BrowserHistoryCursor,
    ): Promise<StructuredSyncResult<BrowserHistoryCursor>> {
      const reader = createReader();
      try {
        // Per-profile cursor watermarks. Backward compat: the old cursor
        // shape was keyed by browserId (`cur.lastVisitTime["chrome"]`); we
        // pass that as the default-after for any profile that doesn't
        // have its own entry yet, so existing cursors don't force a
        // re-bootstrap after this migration.
        const defaultAfter = cur.lastVisitTime[browserId] ?? getInitialTimestamp();
        const {
          visits,
          hasMore: moreInDb,
          lastByProfile,
          profileFailures,
        } = reader.readVisits(cur.lastVisitTime, defaultAfter, BATCH_SIZE);

        // Tag every visit with its drop reason once so the included list
        // and the per-reason debug counters share one classification pass.
        const dropCounts: Partial<Record<VisitDropReason, number>> = {};
        const filtered: RawVisit[] = [];
        for (const v of visits) {
          const reason = visitDropReason(v, config);
          if (reason === null) {
            filtered.push(v);
          } else {
            dropCounts[reason] = (dropCounts[reason] ?? 0) + 1;
          }
        }
        const dropped = visits.length - filtered.length;

        // Track affected dates
        const dateSet = new Set(cur.affectedDates);
        for (const v of filtered) {
          dateSet.add(new Date(v.timestamp).toISOString().slice(0, 10));
        }
        cur.affectedDates = Array.from(dateSet);

        // Convert to DuckDB records
        const records = filtered.map((v) => ({
          id: `${v.browser}:${v.profile}:${v.timestamp}:${hashUrl(v.url)}`,
          browser: v.browser,
          profile: v.profile,
          timestamp: new Date(v.timestamp).toISOString(),
          url: v.url,
          domain: v.domain,
          title: v.title || "",
          visit_duration_seconds: v.visitDuration ?? null,
          transition_type: v.transitionType ?? null,
          is_synced: v.isSynced,
        }));

        // Advance cursor per-profile using the reader-reported watermarks.
        // Without this, a transient lock on profile A combined with the
        // legacy single-key cursor would let A's high-water mark filter
        // out B's older visits forever once the lock cleared.
        for (const [profile, ts] of Object.entries(lastByProfile)) {
          cur.lastVisitTime[profile] = ts;
        }
        cur.visitsProcessed += filtered.length;

        const done = !moreInDb || visits.length < BATCH_SIZE;
        if (done) {
          cur.phase = "daily";
        }

        log.info(
          `Synced ${filtered.length} ${browserInfo!.name} visits ` +
            `(${cur.visitsProcessed} total, dropped=${dropped}, profile_failures=${profileFailures}, ` +
            `${done ? "moving to daily" : "more pages"})`,
        );
        if (dropped > 0) {
          const reasons = Object.entries(dropCounts)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ");
          log.debug(`Drop reasons: ${reasons}`);
        }

        return {
          analytics: records.length > 0 ? { tableName: "browser_visits", records } : undefined,
          cursor: cur,
          hasMore: true,
          // The count the reader already produced, reported rather than
          // interpolated into a log line. A page that skipped a profile
          // finished successfully and still cost the operator something, and
          // this is the channel for saying so without failing the run.
          ...(profileFailures > 0
            ? {
                issues: [
                  {
                    scope: "partition" as const,
                    kind: "permission" as const,
                    count: profileFailures,
                    subject: browserInfo!.name,
                    message: `${profileFailures} ${browserInfo!.name} profile${
                      profileFailures === 1 ? "" : "s"
                    } could not be opened on this pass; their history is not included. The read is retried on the next sync.`,
                  },
                ],
              }
            : {}),
          // A profile that would not open is not the pruning story, and this
          // source knows the difference: the reader counts the profiles it
          // could not read.
          //
          // The claim is per page, not per cycle. This source names no
          // coverage subject — it folds every profile into one count and makes
          // one claim — so a later page replaces an earlier one rather than
          // being ranked against it. That is sound here because the visits
          // phase only ends on a page that read less than a full batch: a
          // failure on the final page is what the cycle reports, and a failure
          // on an earlier page is followed by a page that re-reads the same
          // profile from an un-advanced watermark. It is not sound if this
          // source ever starts claiming per profile.
          progress: {
            phase: "bootstrap",
            processed: cur.visitsProcessed,
            ...(profileFailures > 0
              ? {
                  coverage: "partial" as const,
                  detail: `${profileFailures} ${browserInfo!.name} profile${
                    profileFailures === 1 ? "" : "s"
                  } could not be read on this pass, so their history is not here. It is retried on the next sync.`,
                }
              : { coverage: "unknown" as const, detail: HISTORY_COVERAGE_DETAIL }),
          },
        };
      } finally {
        reader.close();
      }
    }

    async function syncDaily(
      cur: BrowserHistoryCursor,
    ): Promise<StructuredSyncResult<BrowserHistoryCursor>> {
      if (cur.affectedDates.length === 0) {
        cur.phase = browserInfo!.engine === "chromium" ? "search_terms" : "documents";
        return { cursor: cur, hasMore: true };
      }

      // Re-read every visit for each affected date from the DB (not just the
      // current cycle's buffer). The browser_daily upsert overwrites by
      // `${browser}:${profile}:${date}`, so aggregating only the cycle buffer
      // would replace a prior day's full total with this cycle's partial count
      // whenever a date spans more than one sync. Re-reading mirrors
      // syncDocuments and keeps the aggregate consistent with the day-document.
      const reader = createReader();
      try {
        const dayVisits: RawVisit[] = [];
        for (const date of cur.affectedDates) {
          for (const v of reader.readVisitsForDate(date)) {
            if (shouldIncludeVisit(v, config)) dayVisits.push(v);
          }
        }

        const records = aggregateDaily(dayVisits, new Set(cur.affectedDates));
        log.info(
          `Aggregated ${records.length} daily summaries for ${cur.affectedDates.length} dates`,
        );

        cur.phase = browserInfo!.engine === "chromium" ? "search_terms" : "documents";
        return {
          analytics: records.length > 0 ? { tableName: "browser_daily", records } : undefined,
          cursor: cur,
          hasMore: true,
        };
      } finally {
        reader.close();
      }
    }

    async function syncSearchTerms(
      cur: BrowserHistoryCursor,
    ): Promise<StructuredSyncResult<BrowserHistoryCursor>> {
      if (browserInfo!.engine !== "chromium") {
        cur.phase = "documents";
        return { cursor: cur, hasMore: true };
      }

      const reader = createReader();
      try {
        const defaultAfter = cur.lastVisitTime[browserId] ?? getInitialTimestamp();
        // Read against the same per-profile watermark map the visits phase
        // advances. Previously search-terms used a single legacy
        // key (`cur.lastVisitTime[browserId]`) the visits phase no longer
        // touched, so every sync re-read the entire keyword_search_terms
        // table for every profile.
        const { terms, lastByProfile } = reader.readSearchTerms(
          cur.lastVisitTime,
          defaultAfter,
          BATCH_SIZE,
        );

        const records = terms.map((t) => ({
          id: `${t.browser}:${t.profile}:${hashUrl(t.term)}:${t.timestamp}`,
          browser: t.browser,
          profile: t.profile,
          timestamp: new Date(t.timestamp).toISOString(),
          term: t.term,
          normalized_term: t.normalizedTerm,
          search_engine_domain: t.searchEngineDomain,
        }));

        // Search-terms watermarks are tracked alongside the visits ones —
        // both are bounded by `MAX(visits.visit_time)`, so advancing on a
        // search-terms read also bumps the per-profile floor used by the
        // visits phase next cycle.
        for (const [profile, ts] of Object.entries(lastByProfile)) {
          cur.lastVisitTime[profile] = ts;
        }

        log.info(`Synced ${records.length} search terms`);
        cur.phase = "documents";
        return {
          analytics:
            records.length > 0 ? { tableName: "browser_search_terms", records } : undefined,
          cursor: cur,
          hasMore: true,
        };
      } finally {
        reader.close();
      }
    }

    async function syncDocuments(
      cur: BrowserHistoryCursor,
    ): Promise<StructuredSyncResult<BrowserHistoryCursor>> {
      // Snapshot reconciliation: enumerate every (browser, date) day-doc
      // external_id currently backed by at least one visit. The reader
      // signals `partialFailure` if any profile DB couldn't be read —
      // in that case we MUST refuse to emit, because a partial enum
      // would tell the gateway to delete every day-doc belonging to
      // the unread profile (browser-history:chrome with one profile
      // locked by a running Chrome would otherwise lose 1/N of the
      // day-docs every sync). Skip-on-partial defers deletion
      // detection to a future cycle when every profile is readable
      // — an acceptable correctness trade.
      const enumReader = createReader();
      let presentExternalIds: string[] | undefined;
      try {
        const enumResult = enumReader.readDistinctVisitDates();
        // All-or-nothing on purpose, where other multi-store sources narrow the
        // assertion to the stores they could read. The profile is the read
        // unit, but it is not a partition of the corpus: a day document is
        // keyed `${browser}:${date}` and merges every profile's visits for that
        // day into one body, so no document belongs to one profile. Claiming
        // per profile would first mean re-keying every day document by profile
        // — a full re-ingest, and a different product: one row per profile per
        // day rather than one day. Until that is worth doing, an unreadable
        // profile defers the whole browser's deletion detection by a cycle.
        if (enumResult.partialFailure) {
          log.warn(
            `Skipping snapshot emission for ${browserInfo!.name} — at least one profile DB couldn't be read. Deletion detection deferred to next cycle.`,
          );
        } else {
          presentExternalIds = enumResult.dates.map((d) => `${browserId}:${d}`);
          log.info(
            `Snapshot ready for ${browserInfo!.name}: ${presentExternalIds.length} day(s) currently backed by visits`,
          );
        }
      } finally {
        enumReader.close();
      }
      const issues =
        presentExternalIds === undefined
          ? [
              new SnapshotEnumeration([browserId])
                .gap(browserId, "one or more browser profiles could not be enumerated")
                .withheldIssue()!,
            ]
          : [];

      if (cur.affectedDates.length === 0) {
        cur.phase = "done";
        return {
          cursor: cur,
          hasMore: false,
          presentExternalIds,
          issues,
        };
      }

      const reader = createReader();
      try {
        const documents = [];
        const edges: EdgeDeclaration[] = [];
        for (const date of cur.affectedDates) {
          // Re-read all visits for this date from the DB (not just the buffer)
          // This ensures the daily document has the complete picture
          const dayVisits = reader.readVisitsForDate(date);
          const filtered = dayVisits.filter((v) => shouldIncludeVisit(v, config));

          if (filtered.length > 0) {
            documents.push(
              buildDailyDocument(
                browserId,
                browserInfo!.name,
                date,
                filtered,
                sourceId,
                providerId,
                hasMultipleProfiles,
              ),
            );
            // One `browsing-history → webpage` edge per distinct URL visited that
            // day (#895): the day stays its own document and joins the canonical
            // `web` pages it touched, resolving now or via `pending_edges`.
            edges.push(...buildDailyEdges(browserId, date, filtered));
          }
        }

        log.info(
          `Built ${documents.length} daily browsing documents, ${edges.length} visited edges`,
        );

        cur.phase = "done";
        cur.affectedDates = [];

        return {
          cursor: cur,
          hasMore: false,
          documents,
          edges,
          presentExternalIds,
          issues,
        };
      } finally {
        reader.close();
      }
    }

    return {
      analyticsSchemas: allSchemas,
      async probeReadAccess(options) {
        return browserInfo.engine === "chromium"
          ? probeChromiumReadAccess(browserInfo.baseDir, config?.excludeProfiles ?? [], options)
          : probeFileReadAccess(join(browserInfo.baseDir, "History.db"), options);
      },
      watchPaths,
      // Per-account icon override — each browser gets its own brand icon
      // (Chrome, Safari, Arc, …) instead of the generic globe from the
      // source definition. The collector pushes this to the gateway
      // keyed by the full sourceId (browser-history:chrome vs
      // browser-history:safari), so the portal/iOS can show
      // the right icon per account.
      icon: {
        sfSymbol: "globe",
        color: BROWSER_TINTS[browserId] ?? "#007AFF",
        ...getBrowserIconImage(browserId),
      },

      async syncStructured(cursor) {
        const cur: BrowserHistoryCursor = cursor ?? {
          phase: "visits",
          lastVisitTime: {},
          visitsProcessed: 0,
          affectedDates: [],
        };

        switch (cur.phase) {
          case "visits":
            return syncVisits(cur);
          case "daily":
            return syncDaily(cur);
          case "search_terms":
            return syncSearchTerms(cur);
          case "documents":
            return syncDocuments(cur);
          case "done":
            // Reset to visits phase to pick up new visits since last sync
            cur.phase = "visits";
            return syncVisits(cur);
          default:
            throw new Error(`Unknown sync phase: ${(cur as Record<string, unknown>).phase}`);
        }
      },
    };
  },
});
