// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createLogger,
  computeContentHash,
  extractEmailsFromText,
  extractPhonesFromText,
  normalizePhone,
  countryNameToISO2,
} from "@omnesis/core";
import { SourceId, ProviderId, parseSourceId } from "@omnesis/types";
import { APPLE_CALENDAR_EVENTS_TABLE, appleCalendarEventsSchema } from "./calendar-schema.js";
import { validateAppleCalendarSyncCursor } from "./types.js";
import { coreDataToISO, isoToCoreData } from "./epoch.js";
import {
  CALENDAR_EVENTS_FROM,
  CALENDAR_EVENTS_FILTER,
  STORE_TYPE_SUBSCRIBED,
} from "./db-helpers/calendar-db.js";
import { throwOnOpenFailure, type Db } from "./db-helpers/internal.js";
import { unavailableStorePage } from "./store-unavailable.js";
import type { CountryCode } from "libphonenumber-js";
import type { AppleProvider } from "./provider.js";
import type {
  AppleCalendarSyncCursor,
  RawCalendarEvent,
  RawCalendarParticipant,
  RawCalendarRecurrence,
} from "./types.js";
import type {
  SyncCursor,
  SyncResult,
  SyncProgress,
  StructuredSyncResult,
} from "@omnesis/source-sdk";
import type { DocumentInput, PersonMention, SyncIssue } from "@omnesis/types";

const log = createLogger("source:apple-calendar");

const PAGE_SIZE = 100;

/**
 * Modification key for the change watermark. Core Data timestamps can be
 * NEGATIVE (seconds before 2001-01-01) — subscribed feeds stamp a constant
 * pre-2001 sentinel on `last_modified` — so no scalar default is "below
 * everything"; the cursor handles that with the ROWID high-water clause,
 * not by assuming 0 is a floor. The COALESCE chain keeps the key
 * total-ordered if `last_modified` is ever NULL (`start_date` never is in
 * practice). Used identically in the keyset predicates, ORDER BY, count,
 * and snapshot signature so they can never disagree.
 */
const MOD_KEY = "COALESCE(ci.last_modified, ci.creation_date, ci.start_date, 0)";

const FREQUENCY_NAMES: Record<number, string> = {
  1: "daily",
  2: "weekly",
  3: "monthly",
  4: "yearly",
};

const FREQUENCY_UNITS: Record<number, string> = {
  1: "day",
  2: "week",
  3: "month",
  4: "year",
};

/**
 * CalendarItem.status mirrors EKEventStatus; the string vocabulary matches
 * google-calendar's `extra.status`. Status 0 (none) and unknown values
 * omit the field.
 */
const STATUS_NAMES: Record<number, string> = {
  1: "confirmed",
  2: "tentative",
  3: "cancelled",
};

/**
 * Run a SELECT defensively. Returns [] if the table or columns don't exist
 * on this macOS version. Participants and recurrence rules are enrichment —
 * a schema drift there should degrade the documents, not crash the sync.
 */
function safeSelect<T>(db: Db, sql: string, params: unknown[]): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch (err) {
    log.debug(
      `Optional calendar query skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/** Strip a `mailto:` prefix from a CalDAV identity address. */
function stripMailto(address: string | null): string | null {
  if (!address) return null;
  return address.toLowerCase().startsWith("mailto:") ? address.slice(7) : address;
}

/**
 * Render a Recurrence row human-readably ("Repeats every 2 weeks until
 * 2026-01-01"). The proprietary `specifier` column (day-of-week patterns
 * like "D=-1MO") is intentionally not parsed — the frequency summary is
 * enough for search and display.
 */
function renderRecurrence(rule: RawCalendarRecurrence): string {
  const interval = rule.repeatInterval ?? 1;
  let text: string;
  if (interval > 1) {
    const unit = FREQUENCY_UNITS[rule.frequency];
    text = unit ? `Repeats every ${interval} ${unit}s` : "Repeats";
  } else {
    const name = FREQUENCY_NAMES[rule.frequency];
    text = name ? `Repeats ${name}` : "Repeats";
  }
  if (!FREQUENCY_NAMES[rule.frequency]) {
    log.debug(`Unknown recurrence frequency ${rule.frequency}`);
  }
  if (rule.repeatCount && rule.repeatCount > 0) {
    text += `, ${rule.repeatCount} times`;
  }
  if (rule.endDate) {
    text += ` until ${coreDataToISO(rule.endDate).slice(0, 10)}`;
  }
  return text;
}

/**
 * Machine-readable event boundary for `metadata.extra`: bare UTC ISO, or
 * date-only for all-day events — the same shape google-calendar stores.
 */
function whenValue(timestamp: number | null, allDay: boolean): string | undefined {
  if (timestamp === null) return undefined;
  const iso = coreDataToISO(timestamp);
  return allDay ? iso.slice(0, 10) : iso;
}

/**
 * Render an event boundary for the "When" content line. All-day events
 * render date-only (Apple stores an exclusive next-midnight end, the same
 * shape Google produces for date-only events); timed events render as UTC
 * ISO with the IANA timezone as a hint. `_float` marks a floating time (no
 * timezone) — rendered without a hint.
 */
function renderWhen(timestamp: number | null, tz: string | null, allDay: boolean): string {
  if (timestamp === null) return "";
  const iso = coreDataToISO(timestamp);
  if (allDay) return iso.slice(0, 10);
  if (tz && tz !== "_float") return `${iso} (${tz})`;
  return iso;
}

/**
 * Apple Calendar source.
 * Reads events from the local Calendar.sqlitedb and produces one document
 * per event (recurring series masters and detached occurrences each count
 * as one event row, hence one document).
 */
/** One sync page carrying both representations so `sync` and `syncStructured`
 * share a single DB read. */
interface AppleCalendarPage {
  documents: DocumentInput[];
  records: Record<string, unknown>[];
  deletedExternalIds: string[];
  presentExternalIds: string[] | undefined;
  cursor: SyncCursor;
  hasMore: boolean;
  progress?: SyncProgress;
  issues?: SyncIssue[];
}

export class AppleCalendarSource {
  readonly id: SourceId;
  readonly providerId: ProviderId;

  readonly watchPaths: string[];

  /** Optional ISO 8601 cutoff — single events ending before this date are excluded. */
  readonly dataCutoff?: string;
  /**
   * The region a bare national number should be read in.
   *
   * Without it `normalizePhone` guesses from the process locale, and a
   * ten-digit national number from another country parses as a *valid*
   * number in that guess — turning an alias that matched nothing into one
   * that confidently matches the wrong person. Every other Apple surface is
   * given this; the calendar was the one that was not.
   */
  private readonly phoneRegion?: string;

  /**
   * Pattern A author identity: the source-account email, stamped on events
   * with no organizer on record. Resolves to self via the alias graph.
   * Unset when the account id is not email-shaped (`local`).
   */
  private readonly selfAuthorEmail?: string;

  constructor(
    private provider: AppleProvider,
    opts: { sourceId: string; providerId: string; dataCutoff?: string; phoneRegion?: string },
  ) {
    this.id = SourceId(opts.sourceId);
    this.providerId = ProviderId(opts.providerId);
    const dbPath = provider.calendarDbFilePath;
    this.watchPaths = [dbPath, `${dbPath}-wal`];
    this.dataCutoff = opts.dataCutoff;
    this.phoneRegion = opts.phoneRegion;
    const { accountId } = parseSourceId(this.id);
    this.selfAuthorEmail = accountId.includes("@") ? accountId : undefined;
  }

  /** Document-only view of a sync page (the unstructured contract / existing
   * tests). Delegates to `syncPage`. */
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

  /** Hybrid view: the same documents PLUS one `apple_calendar_events` row per
   * event. Deletion stays snapshot-based via `presentExternalIds`. */
  async syncStructured(cursor: SyncCursor | null): Promise<StructuredSyncResult> {
    const p = await this.syncPage(cursor);
    return {
      analytics: {
        tableName: APPLE_CALENDAR_EVENTS_TABLE,
        records: p.records,
        presentIds: p.presentExternalIds,
      },
      documents: p.documents,
      deletedExternalIds: p.deletedExternalIds,
      presentExternalIds: p.presentExternalIds,
      cursor: p.cursor,
      hasMore: p.hasMore,
      progress: p.progress,
      issues: p.issues,
    };
  }

  analyticsSchemas = [appleCalendarEventsSchema];

  /** The regions a bare national number may belong to, best guess first. */
  private phoneHints(): CountryCode[] | undefined {
    const region = countryNameToISO2(this.phoneRegion);
    return region ? [region] : undefined;
  }

  private async syncPage(cursor: SyncCursor | null): Promise<AppleCalendarPage> {
    const db = this.provider.getCalendarDb();
    if (!db) {
      throwOnOpenFailure(this.provider.getCalendarOpenFailure());
      return {
        ...unavailableStorePage(cursor ?? { lastModifiedTimestamp: 0 }),
        records: [],
        presentExternalIds: undefined,
      };
    }

    let state = validateAppleCalendarSyncCursor(cursor);

    // Generation guard: ROWID monotonicity (which the insertion high-water
    // mark depends on) only holds within one database file's lifetime, and
    // Calendar.sqlitedb is a rebuildable cache — macOS recreates it on
    // corruption or account re-add, restarting the AUTOINCREMENT sequence.
    // A sequence below our high-water mark means the file was rebuilt;
    // reset to a fresh bootstrap so every rebuilt row is re-indexed.
    if (state && state.pageModKey === undefined && (state.insertRowIdHighWater ?? 0) > 0) {
      const seqRows = safeSelect<{ seq: number }>(
        db,
        `SELECT seq as seq FROM sqlite_sequence WHERE name = 'CalendarItem'`,
        [],
      );
      const seq = seqRows[0]?.seq ?? 0;
      if (seq < (state.insertRowIdHighWater ?? 0)) {
        log.warn(
          `Calendar database was rebuilt (ROWID sequence ${seq} < high-water ${state.insertRowIdHighWater}) — re-bootstrapping`,
        );
        state = null;
      }
    }

    // Membership watermarks — pinned for the whole cycle. A row is in this
    // cycle's queue when its (modKey, ROWID) advanced past the modification
    // watermark OR its ROWID is above the insertion high-water mark. The
    // ROWID clause is what picks up rows that APPEAR with past-valued
    // modification keys (newly subscribed feeds, CalDAV imports) — at
    // bootstrap it is 0 and matches every row, so negative sentinel keys
    // are covered from the start.
    const wmMod = state?.lastModifiedTimestamp ?? 0;
    const wmRowId = state?.lastModifiedRowId ?? 0;
    const insertHighWater = state?.insertRowIdHighWater ?? 0;
    // Page position of an in-flight multi-page cycle (absent at cycle
    // start). Advances per page while the membership watermarks hold still.
    const pagePos =
      state?.pageModKey !== undefined
        ? { modKey: state.pageModKey, rowId: state.pageRowId ?? 0 }
        : null;
    // A pending full rescan re-walks the entire filtered set (membership
    // reduced to the ceiling bound below). Scheduled when the snapshot
    // signature shows content drift that the watermark cannot see.
    const rescan = !!state?.rescanPending;

    // Per-cycle ROWID ceiling, pinned at cycle start and carried across
    // pages. Bounding every page to rows that existed when the cycle began
    // makes the cycle's universe immutable: a row inserted mid-walk —
    // possibly behind the page position, where the walk would never revisit
    // it — is excluded now and deterministically swept next cycle by the
    // `ROWID > insertRowIdHighWater` clause (the high-water mark is promoted
    // to exactly this ceiling when the cycle completes).
    const maxRowIdNow = (
      db.prepare(`SELECT COALESCE(MAX(ROWID), 0) as maxRowId FROM CalendarItem`).get() as {
        maxRowId: number;
      }
    ).maxRowId;
    const ceiling = pagePos ? (state?.cycleRowIdCeiling ?? maxRowIdNow) : maxRowIdNow;

    const membershipClause = rescan
      ? ` AND ci.ROWID <= ?`
      : ` AND (${MOD_KEY} > ? OR (${MOD_KEY} = ? AND ci.ROWID > ?) OR ci.ROWID > ?) AND ci.ROWID <= ?`;
    const membershipParams: number[] = rescan
      ? [ceiling]
      : [wmMod, wmMod, wmRowId, insertHighWater, ceiling];
    const pageClause = pagePos ? ` AND (${MOD_KEY} > ? OR (${MOD_KEY} = ? AND ci.ROWID > ?))` : "";
    const pageParams: number[] = pagePos ? [pagePos.modKey, pagePos.modKey, pagePos.rowId] : [];

    // The cutoff is occurrence-based (matches google-calendar semantics, not
    // the creation-date filter Notes uses): recurring masters are always
    // kept — without expanding the rule we can't prove their last occurrence
    // predates the cutoff — and single events are kept when they end at or
    // after it. Applied to every query below so the count, page, signature,
    // and snapshot can never disagree about which rows exist.
    const cutoffTimestamp = this.dataCutoff ? isoToCoreData(this.dataCutoff) : null;
    const cutoffClause =
      cutoffTimestamp !== null
        ? ` AND (ci.has_recurrences > 0 OR COALESCE(ci.end_date, ci.start_date) >= ?)`
        : "";
    const cutoffParams: number[] = cutoffTimestamp !== null ? [cutoffTimestamp] : [];

    // Queue size for this cycle, counted once on the first page and pinned
    // in the cursor so the progress bar's `total` stays stable across pages.
    let totalEvents: number | undefined = state?.cycleQueueTotal;
    if (totalEvents === undefined) {
      const totalResult = db
        .prepare(
          `SELECT COUNT(*) as count
           ${CALENDAR_EVENTS_FROM}
           WHERE ${CALENDAR_EVENTS_FILTER}${membershipClause}${cutoffClause}`,
        )
        .get(...membershipParams, ...cutoffParams) as { count: number };
      totalEvents = totalResult.count;
    }

    const query = `
      SELECT
        ci.ROWID as pk,
        ci.UUID as uuid,
        ci.summary as summary,
        ci.description as description,
        ci.start_date as startDate,
        ci.start_tz as startTz,
        ci.end_date as endDate,
        ci.end_tz as endTz,
        ci.all_day as allDay,
        ci.status as status,
        ci.url as url,
        ci.conference_url as conferenceUrl,
        ci.conference_url_detected as conferenceUrlDetected,
        COALESCE(ci.orig_item_id, 0) as origItemId,
        ci.unique_identifier as iCalUid,
        ci.creation_date as creationDate,
        ${MOD_KEY} as modKey,
        c.UUID as calendarUuid,
        c.title as calendarTitle,
        s.name as storeName,
        s.type as storeType,
        loc.title as locationTitle,
        loc.address as locationAddress,
        op.email as organizerEmail,
        op.phone_number as organizerPhone,
        oid.display_name as organizerName,
        oid.address as organizerAddress
      ${CALENDAR_EVENTS_FROM}
      LEFT JOIN Location loc ON loc.ROWID = ci.location_id
      LEFT JOIN Participant op ON op.ROWID = ci.organizer_id
      LEFT JOIN Identity oid ON oid.ROWID = op.identity_id
      WHERE ${CALENDAR_EVENTS_FILTER}${membershipClause}${pageClause}${cutoffClause}
      ORDER BY ${MOD_KEY} ASC, ci.ROWID ASC
      LIMIT ?
    `;

    const rows = db
      .prepare(query)
      .all(
        ...membershipParams,
        ...pageParams,
        ...cutoffParams,
        PAGE_SIZE + 1,
      ) as RawCalendarEvent[];

    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    // Batched 1:N enrichment for the page: attendees and recurrence rules.
    const pagePks = pageRows.map((r) => r.pk);
    const participantsByOwner = new Map<number, RawCalendarParticipant[]>();
    const recurrencesByOwner = new Map<number, RawCalendarRecurrence[]>();
    if (pagePks.length > 0) {
      const placeholders = pagePks.map(() => "?").join(",");
      const participantRows = safeSelect<RawCalendarParticipant>(
        db,
        `SELECT p.owner_id as ownerId, p.email as email, p.phone_number as phone,
                i.display_name as displayName, i.address as address
         FROM Participant p
         LEFT JOIN Identity i ON i.ROWID = p.identity_id
         WHERE p.owner_id IN (${placeholders})
         ORDER BY p.ROWID ASC`,
        pagePks,
      );
      for (const row of participantRows) {
        const list = participantsByOwner.get(row.ownerId) ?? [];
        list.push(row);
        participantsByOwner.set(row.ownerId, list);
      }

      const recurrenceRows = safeSelect<RawCalendarRecurrence>(
        db,
        `SELECT r.owner_id as ownerId, r.frequency as frequency,
                r.interval as repeatInterval, r.count as repeatCount,
                r.end_date as endDate
         FROM Recurrence r
         WHERE r.owner_id IN (${placeholders})
         ORDER BY r.ROWID ASC`,
        pagePks,
      );
      for (const row of recurrenceRows) {
        const list = recurrencesByOwner.get(row.ownerId) ?? [];
        list.push(row);
        recurrencesByOwner.set(row.ownerId, list);
      }
    }

    const documents: DocumentInput[] = pageRows.map((row) =>
      this.normalizeEvent(
        row,
        participantsByOwner.get(row.pk) ?? [],
        recurrencesByOwner.get(row.pk) ?? [],
      ),
    );

    // One analytics row per event, in the same pass — subscribed
    // feeds (holidays/birthdays) emit a document but no row.
    const records: Record<string, unknown>[] = [];
    for (const row of pageRows) {
      const record = this.eventToRow(
        row,
        participantsByOwner.get(row.pk) ?? [],
        recurrencesByOwner.get(row.pk) ?? [],
      );
      if (record) records.push(record);
    }

    // Page position advances to the `(modKey, ROWID)` of the last row on
    // the page — the query sorts by both ASC, so every earlier row is
    // covered. An empty page leaves it where it was.
    let nextPagePos = pagePos;
    if (pageRows.length > 0) {
      const boundary = pageRows[pageRows.length - 1];
      nextPagePos = { modKey: boundary.modKey, rowId: boundary.pk };
    }

    const isBootstrap =
      !!state?.bootstrapInProgress ||
      (wmMod === 0 && wmRowId === 0 && insertHighWater === 0 && !pagePos);
    const phase = isBootstrap ? "bootstrap" : rescan ? "rescan" : "incremental";

    // Calendar.app deletes rows physically (an AFTER DELETE trigger cascades
    // to child tables), so there are no tombstones to emit as incremental
    // `deletedExternalIds`; transient `hidden = 1` rows leave the filtered
    // set the same way. All deletion detection rides the snapshot
    // reconciliation below.
    //
    // Snapshot: emit `presentExternalIds` only on the FINAL page of a sync
    // run (`!hasMore`) — mid-bootstrap emission would tell the gateway to
    // delete every event not yet paged in. Cheap aggregate signature first;
    // the full ID enumeration only runs when it changed.
    //
    // The signature's components each catch a change class the others miss:
    // `cnt` (adds/removes), `maxMod` (ordinary edits), `maxRowId`
    // (equal-count feed swaps — replaced rows get fresh AUTOINCREMENT
    // ROWIDs), and `sumMod` (in-place edits stamped with a PAST
    // `last_modified`, e.g. CalDAV copying a server-side LAST-MODIFIED that
    // trails the watermark). When ONLY `sumMod` moved, something changed
    // that the watermark cannot see — schedule a one-shot full rescan; the
    // gateway dedupes unchanged re-emissions on contentHash.
    let presentExternalIds: string[] | undefined;
    let snapshotSignature = state?.lastSnapshotSignature;
    let scheduleRescan = false;
    if (!hasMore) {
      const sig = db
        .prepare(
          `SELECT COUNT(*) as cnt, COALESCE(MAX(${MOD_KEY}), 0) as maxMod,
                  COALESCE(MAX(ci.ROWID), 0) as maxRowId,
                  CAST(ROUND(COALESCE(TOTAL(${MOD_KEY}), 0)) AS INTEGER) as sumMod
           ${CALENDAR_EVENTS_FROM}
           WHERE ${CALENDAR_EVENTS_FILTER}${cutoffClause}`,
        )
        .get(...cutoffParams) as { cnt: number; maxMod: number; maxRowId: number; sumMod: number };
      const newSignature = `${sig.cnt}:${sig.maxMod}:${sig.maxRowId}:${sig.sumMod}`;
      if (newSignature !== state?.lastSnapshotSignature) {
        const enumRows = db
          .prepare(
            `SELECT ci.UUID as uuid
             ${CALENDAR_EVENTS_FROM}
             WHERE ${CALENDAR_EVENTS_FILTER}${cutoffClause}`,
          )
          .all(...cutoffParams) as { uuid: string }[];
        presentExternalIds = enumRows.map((r) => r.uuid);

        if (!rescan && snapshotSignature !== undefined) {
          const oldParts = snapshotSignature.split(":");
          const newParts = newSignature.split(":");
          scheduleRescan =
            oldParts.length === 4 &&
            newParts[0] === oldParts[0] &&
            newParts[1] === oldParts[1] &&
            newParts[2] === oldParts[2] &&
            newParts[3] !== oldParts[3];
          if (scheduleRescan) {
            log.info(`Snapshot drift without visible changes (${newSignature}) — full rescan`);
          }
        }
        snapshotSignature = newSignature;
      }
    }

    log.info(
      `Sync produced ${documents.length} docs (${phase}, hasMore: ${hasMore}, snapshot: ${presentExternalIds?.length ?? "unchanged"})`,
    );

    let nextCursor: SyncCursor;
    if (hasMore) {
      // Mid-cycle: membership watermarks and the ceiling stay pinned; only
      // the page position advances.
      nextCursor = {
        lastModifiedTimestamp: wmMod,
        lastModifiedRowId: wmRowId,
        insertRowIdHighWater: insertHighWater,
        cycleRowIdCeiling: ceiling,
        pageModKey: nextPagePos?.modKey,
        pageRowId: nextPagePos?.rowId,
        rescanPending: rescan ? true : undefined,
        bootstrapInProgress: isBootstrap ? true : undefined,
        cycleQueueTotal: totalEvents,
        lastSnapshotSignature: snapshotSignature,
      } satisfies AppleCalendarSyncCursor;
    } else {
      // Cycle complete: promote the watermarks and clear the page state.
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
        rescanPending: scheduleRescan ? true : undefined,
        lastSnapshotSignature: snapshotSignature,
      } satisfies AppleCalendarSyncCursor;
    }

    return {
      documents,
      records,
      deletedExternalIds: [],
      presentExternalIds,
      cursor: nextCursor,
      // `scheduleRescan` reports hasMore so the engine re-invokes promptly
      // and the rescan cycle starts without waiting for the next interval.
      hasMore: hasMore || scheduleRescan,
      issues: hasMore || scheduleRescan ? undefined : [],
      progress:
        totalEvents > 0
          ? {
              phase,
              processed: documents.length,
              total: totalEvents,
            }
          : undefined,
    };
  }

  private normalizeEvent(
    row: RawCalendarEvent,
    participants: RawCalendarParticipant[],
    recurrences: RawCalendarRecurrence[],
  ): DocumentInput {
    const title = row.summary || "(no title)";
    const allDay = !!row.allDay;

    const start = renderWhen(row.startDate, row.startTz, allDay);
    const end = renderWhen(row.endDate, row.endTz, allDay);
    const whenLine =
      start && end
        ? `**When:** ${start} → ${end}`
        : start || end
          ? `**When:** ${start || end}`
          : "";
    const recurrenceText =
      recurrences.length > 0 ? recurrences.map(renderRecurrence).join("; ") : undefined;
    const location = row.locationTitle ?? row.locationAddress ?? undefined;
    const meetingLink = row.conferenceUrl ?? row.conferenceUrlDetected ?? row.url ?? undefined;

    // People: organizer → author, attendees → attendee, description
    // emails/phones → mentioned. Dedupe by lowercased email / raw phone;
    // a deduped participant is also dropped from the rendered Attendees
    // line so the organizer and case-variant duplicates don't render twice.
    const people: PersonMention[] = [];
    const seenEmails = new Set<string>();
    const seenPhones = new Set<string>();

    const organizerEmail = row.organizerEmail ?? stripMailto(row.organizerAddress);
    if (organizerEmail) {
      seenEmails.add(organizerEmail.toLowerCase());
      people.push({
        role: "author",
        name: row.organizerName ?? undefined,
        emails: [organizerEmail],
      });
    } else if (row.organizerPhone) {
      // Normalised here, because the gateway does not do it on this path. It
      // canonicalises an email on the way in and passes a phone through
      // verbatim, so a raw store value is an alias that matches nothing —
      // including the same person arriving normalised from another source.
      // A number that will not parse is not pushed as an identity. Every other
      // Apple surface drops it rather than storing a value that can only fail
      // to match; the organiser keeps the name the mention was carrying.
      const organizerPhone = normalizePhone(row.organizerPhone, this.phoneHints());
      if (organizerPhone) seenPhones.add(organizerPhone);
      people.push({
        role: "author",
        name: row.organizerName ?? undefined,
        ...(organizerPhone ? { phones: [organizerPhone] } : {}),
      });
    } else if (row.storeType !== STORE_TYPE_SUBSCRIBED && this.selfAuthorEmail) {
      // Pattern A: no organizer on record — stamp the source's account email
      // as author (resolves to self via the alias graph). Skipped for
      // subscribed feeds: holiday/fixture events aren't authored by the user.
      people.push({ role: "author", emails: [this.selfAuthorEmail], phones: [] });
      seenEmails.add(this.selfAuthorEmail.toLowerCase());
    }

    const attendeeNames: string[] = [];
    for (const p of participants) {
      const email = p.email ?? stripMailto(p.address);
      const name = p.displayName ?? undefined;
      if (email) {
        if (seenEmails.has(email.toLowerCase())) continue;
        seenEmails.add(email.toLowerCase());
        people.push({ role: "attendee", name, emails: [email] });
        attendeeNames.push(name ?? email);
      } else if (p.phone) {
        const phone = normalizePhone(p.phone, this.phoneHints());
        if (!phone) {
          if (name) {
            people.push({ role: "attendee", name });
            attendeeNames.push(name);
          }
          continue;
        }
        if (seenPhones.has(phone)) continue;
        seenPhones.add(phone);
        people.push({ role: "attendee", name, phones: [phone] });
        attendeeNames.push(name ?? phone);
      } else if (name) {
        attendeeNames.push(name);
      }
    }

    if (row.description) {
      for (const email of extractEmailsFromText(row.description)) {
        if (seenEmails.has(email.toLowerCase())) continue;
        seenEmails.add(email.toLowerCase());
        people.push({ role: "mentioned", emails: [email] });
      }
      for (const phone of extractPhonesFromText(row.description)) {
        if (seenPhones.has(phone)) continue;
        seenPhones.add(phone);
        people.push({ role: "mentioned", phones: [phone], allowPersonCreation: false });
      }
    }

    const calendarLine =
      row.calendarTitle && row.storeName && row.storeName !== row.calendarTitle
        ? `${row.calendarTitle} (${row.storeName})`
        : (row.calendarTitle ?? row.storeName ?? "");

    const content = [
      `# ${title}`,
      "",
      calendarLine ? `**Calendar:** ${calendarLine}` : "",
      whenLine,
      recurrenceText ? `**Recurrence:** ${recurrenceText}` : "",
      location ? `**Location:** ${location}` : "",
      attendeeNames.length > 0 ? `**Attendees:** ${attendeeNames.join(", ")}` : "",
      meetingLink ? `**Meeting link:** ${meetingLink}` : "",
      "",
      row.description ? "---\n\n" + row.description : "",
    ]
      .filter(Boolean)
      .join("\n");

    // creation_date is NULL for subscribed-feed events; fall back to the
    // event's start, then the modification key.
    const createdCoreData = row.creationDate ?? row.startDate ?? row.modKey;

    return {
      providerId: this.providerId,
      sourceId: this.id,
      externalId: row.uuid,
      title,
      content,
      contentHash: computeContentHash(content),
      metadata: {
        // `ical://ekevent/<UUID>` opens the event in Calendar.app on macOS;
        // `calshow:<seconds>` opens Calendar at the event's date on iOS
        // (it can't target a specific event). Both are best-effort.
        sourceUrl: `ical://ekevent/${row.uuid}`,
        appUrl: row.startDate !== null ? `calshow:${row.startDate}` : undefined,
        documentType: "event",
        people,
        tags: [],
        extra: {
          calendarId: row.calendarUuid ?? undefined,
          calendarName: row.calendarTitle ?? undefined,
          storeName: row.storeName ?? undefined,
          location,
          status: STATUS_NAMES[row.status],
          start: whenValue(row.startDate, allDay),
          end: whenValue(row.endDate, allDay),
          allDay,
          startTimeZone: row.startTz && row.startTz !== "_float" ? row.startTz : undefined,
          endTimeZone: row.endTz && row.endTz !== "_float" ? row.endTz : undefined,
          conferenceUrl: meetingLink,
          recurrence: recurrenceText,
          isDetachedOccurrence: row.origItemId > 0 ? true : undefined,
          // RFC 5545 UID — the standard identifier shared by every system
          // that exposes this event. The gateway's link graph resolves
          // `calendar-event` cross-source links (e.g. from email-attached
          // ICS invites) through this key
          iCalUID: row.iCalUid ?? undefined,
        },
      },
      sourceCreatedAt: coreDataToISO(createdCoreData),
      sourceUpdatedAt: coreDataToISO(row.modKey),
    };
  }

  /**
   * Build the `apple_calendar_events` row for an event — the structured twin of
   * `normalizeEvent`, keyed on the same UUID so the doc↔row `same-entity` edge
   * is 1:1. Returns null for subscribed-feed events (holidays /
   * birthdays), which get a document but pollute meeting-time analytics.
   */
  private eventToRow(
    row: RawCalendarEvent,
    participants: RawCalendarParticipant[],
    recurrences: RawCalendarRecurrence[],
  ): Record<string, unknown> | null {
    if (row.storeType === STORE_TYPE_SUBSCRIBED) return null;

    const allDay = !!row.allDay;

    // Core Data timestamps are seconds since 2001 — the delta is plain seconds.
    let durationMinutes: number | null = null;
    if (!allDay && row.startDate !== null && row.endDate !== null && row.endDate >= row.startDate) {
      durationMinutes = (row.endDate - row.startDate) / 60;
    }

    // Distinct attendees by lowercased email (falling back to phone).
    const attendeeIds = new Set<string>();
    for (const p of participants) {
      const email = p.email ?? stripMailto(p.address);
      if (email) attendeeIds.add(email.toLowerCase());
      else if (p.phone) attendeeIds.add(p.phone);
    }

    return {
      id: row.uuid,
      calendar_id: row.calendarUuid ?? null,
      calendar_name: row.calendarTitle ?? null,
      ical_uid: row.iCalUid ?? null,
      title: row.summary ?? null,
      start_time: whenValue(row.startDate, allDay) ?? null,
      end_time: whenValue(row.endDate, allDay) ?? null,
      duration_minutes: durationMinutes,
      all_day: allDay,
      recurring: recurrences.length > 0,
      // Apple's private recurrence `specifier` grammar is not safely
      // expandable here. A detached exception has its own concrete start/end
      // (`orig_item_id > 0`) and is safe; an RRULE-bearing master is not.
      temporal_projection_eligible: row.origItemId > 0 || recurrences.length === 0,
      organizer_email: row.organizerEmail ?? stripMailto(row.organizerAddress) ?? null,
      attendee_count: attendeeIds.size > 0 ? attendeeIds.size : null,
      // Apple's local store doesn't surface the viewer's RSVP in the columns we read.
      response_status: null,
      location: row.locationTitle ?? row.locationAddress ?? null,
      // Reuse the shared EKEventStatus vocabulary (1 confirmed / 2 tentative /
      // 3 cancelled; 0/none → null).
      status: STATUS_NAMES[row.status] ?? null,
    };
  }
}
