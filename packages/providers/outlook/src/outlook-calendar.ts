// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createLogger,
  computeContentHash,
  extractEmailsFromText,
  extractPhonesFromText,
  htmlToMarkdown,
  parseSourceKey,
} from "@omnesis/core";
import {
  SourceId,
  ProviderId,
  isTransientSyncError,
  type SyncIssue,
  type SourceId as SourceIdType,
  type ProviderId as ProviderIdType,
  type DocumentInput,
  type PersonMention,
} from "@omnesis/types";
import { SnapshotEnumeration, tableWrites } from "@omnesis/source-sdk";
import {
  GraphClient,
  DeltaExpiredError,
  AuthError,
  toConnectionAuthError,
} from "./graph-client.js";
import {
  OUTLOOK_CALENDAR_EVENTS_TABLE,
  outlookCalendarEventsSchema,
} from "./outlook-calendar-schema.js";
import { CALENDAR_PAGE_SIZE } from "./outlook-calendar-types.js";
import {
  validateOutlookCalendarCursor,
  type CalendarDeltaResponse,
  type CalendarListResponse,
  type GraphCalendar,
  type CalendarGraphClientLike,
  type GraphDateTimeTimeZone,
  type GraphEvent,
  type GraphPatternedRecurrence,
  type OutlookCalendarCursor,
  type OutlookCalendarSourceOptions,
} from "./outlook-calendar-types.js";
import type {
  SnapshotClaim,
  SyncResult,
  SyncProgress,
  StructuredSyncResult,
  SyncCursor,
  TableWrite,
} from "@omnesis/source-sdk";

const log = createLogger("source:outlook-calendar");

/**
 * How an event marks the calendar's availability.
 *
 * Graph keeps this on its own axis rather than folding it into a lifecycle
 * status: an event is either cancelled or not, while `showAs` says whether the
 * time it occupies is a commitment at all. A free placeholder and a booked
 * meeting are both confirmed events, and only this tells them apart.
 */
const SHOW_AS_VALUES = new Set(["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"]);

/** Graph's `showAs`, or null when absent or a value this version does not know. */
function showAsOf(event: GraphEvent): string | null {
  const raw = event.showAs;
  return raw && SHOW_AS_VALUES.has(raw) ? raw : null;
}

/**
 * The `calendarView` window, in years on either side of "now".
 *
 * `calendarView` requires a bounded `startDateTime`/`endDateTime`; the bound is
 * baked into the issued delta token, so the future edge does not roll forward on
 * its own. A re-bootstrap (a fresh sync from a cleared cursor, or after a 410
 * delta expiry) recomputes the window around the new "now". One year back / one
 * year ahead keeps the common "what's on my calendar" range live without
 * enumerating a decade of stale history.
 */
const WINDOW_PAST_YEARS = 1;
const WINDOW_FUTURE_YEARS = 1;
const WINDOW_REFRESH_DAYS = 30;

/** One sync page, carrying both representations so `sync` and `syncStructured`
 * format the same fetch without a second Graph round-trip. */
interface CalendarPage {
  documents: DocumentInput[];
  records: Record<string, unknown>[];
  deletedExternalIds: string[];
  deletedIds: string[];
  presentIds?: string[];
  /**
   * The same complete set, for the document side. Emitted only on a finished
   * enumeration — a partial page would read as "everything else is gone".
   */
  presentExternalIds?: string[];
  /**
   * The document side narrowed to the calendars this cycle could read, for a
   * cycle that could not read them all. Never set together with
   * `presentExternalIds`, and never with `presentIds`: the analytics rows have
   * no per-partition form, so a claiming cycle says nothing about the table.
   */
  presentClaims?: SnapshotClaim[];
  issues?: SyncIssue[];
  cursor: SyncCursor;
  hasMore: boolean;
  progress?: SyncProgress;
}

/** Normalize a Graph `dateTimeTimeZone` to an ISO 8601 UTC instant. */
function graphDateTimeToIso(dt: GraphDateTimeTimeZone | undefined): string | undefined {
  const raw = dt?.dateTime;
  if (!raw) return undefined;
  // Already carries an offset or a `Z` — parse directly.
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  // Graph defaults to UTC; the wall-clock string omits the `Z`, so add it.
  const tz = dt?.timeZone;
  if (!tz || tz.toUpperCase() === "UTC") {
    const d = new Date(`${raw}Z`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Render a Graph `patternedRecurrence` (series master only) as a short human
 * string, e.g. `"weekly every 1 on monday, wednesday"`. */
function formatRecurrence(
  recurrence: GraphPatternedRecurrence | null | undefined,
): string | undefined {
  const pattern = recurrence?.pattern;
  if (!pattern?.type) return undefined;
  const parts: string[] = [pattern.type];
  if (pattern.interval && pattern.interval > 0) parts.push(`every ${pattern.interval}`);
  if (pattern.daysOfWeek && pattern.daysOfWeek.length > 0) {
    parts.push(`on ${pattern.daysOfWeek.join(", ")}`);
  } else if (pattern.dayOfMonth) {
    parts.push(`on day ${pattern.dayOfMonth}`);
  }
  return parts.join(" ");
}

/**
 * Whether the event belongs to a recurring series. `seriesMasterId` is the
 * second signal: a delta page can arrive sparse enough to omit `type` while
 * still naming the series the event belongs to.
 */
function isRecurring(event: GraphEvent): boolean {
  if (event.seriesMasterId) return true;
  return event.type !== undefined && event.type !== "singleInstance";
}

/**
 * Fields an occurrence inherits from its series master when Graph omits them.
 *
 * `calendarView/delta` sends an occurrence as a delta against its master: id,
 * start, end, and whatever that instance overrode. Everything the instance
 * shares with the series — subject, body, location, attendees, organizer — is
 * simply absent, on the initial enumeration as much as on later ticks. An
 * occurrence taken at face value therefore normalizes to a document titled
 * "(no title)" with nothing in it.
 *
 * Start and end are deliberately absent from this list: they are the two things
 * an occurrence always owns. So is `isCancelled`, which is per-instance by
 * definition — a single cancelled occurrence must not be resurrected by a live
 * master, nor the reverse.
 */
/**
 * Whether an occurrence is missing anything its series master could supply.
 *
 * Checking only the subject would be narrower than the merge it guards. Graph
 * sends an *exception* — one instance the organizer edited — carrying its id,
 * its times and just the property that changed, so renaming a single instance
 * of a standing meeting produces an event that has a subject and is otherwise
 * as bare as any other occurrence. Judging by the subject alone would leave
 * exactly that instance without its room, attendees or body while its siblings
 * kept theirs.
 *
 * An empty-string subject counts as missing: Graph returns one for an event
 * created without a title, and it would otherwise slip past both this check and
 * the `?? "(no title)"` fallback to produce a document with no title at all.
 */
function needsHydration(event: GraphEvent): boolean {
  if (!event.seriesMasterId) return false;
  return (
    !event.subject ||
    event.body === undefined ||
    event.bodyPreview === undefined ||
    event.location === undefined ||
    event.attendees === undefined ||
    event.organizer === undefined
  );
}

/**
 * Merge the master's descriptive fields into an occurrence that lacks them.
 *
 * The merge cannot tell "absent because unchanged" from "cleared on this
 * instance" — the payload carries no way to distinguish them — so an occurrence
 * whose organizer deliberately removed the room inherits the series' room. The
 * shared case is overwhelmingly the common one, and the alternative is the
 * empty documents this exists to prevent.
 */
function hydrateFromMaster(occurrence: GraphEvent, master: GraphEvent): GraphEvent {
  return {
    ...occurrence,
    // `||`, not `??`: an empty subject is the absence of one, and `"" ?? x`
    // would keep the empty string and title the document with nothing.
    subject: occurrence.subject || master.subject,
    body: occurrence.body ?? master.body,
    bodyPreview: occurrence.bodyPreview ?? master.bodyPreview,
    location: occurrence.location ?? master.location,
    attendees: occurrence.attendees ?? master.attendees,
    organizer: occurrence.organizer ?? master.organizer,
    categories: occurrence.categories ?? master.categories,
    onlineMeeting: occurrence.onlineMeeting ?? master.onlineMeeting,
    webLink: occurrence.webLink ?? master.webLink,
    responseStatus: occurrence.responseStatus ?? master.responseStatus,
    // Whether the account owns the series is fixed for the series, and the
    // master is not itself a document — so without this every occurrence of a
    // meeting the user organised would deny that they organised it.
    isOrganizer: occurrence.isOrganizer ?? master.isOrganizer,
    // Every instance of a series shares the series' RFC 5545 UID, which is what
    // lets an emailed invite resolve to the occurrence it refers to.
    iCalUId: occurrence.iCalUId ?? master.iCalUId,
    // The recurrence pattern lives only on the master; carrying it lets each
    // occurrence say what series it belongs to.
    recurrence: occurrence.recurrence ?? master.recurrence,
  };
}

/**
 * Outlook Calendar source.
 *
 * Reads every calendar on the account: `/me/calendars` enumerates them and each
 * gets its own `calendarView/delta` — a delta query over a bounded date window.
 * Graph event ids are unique within a calendar and not across them, so events
 * are keyed `calendarId:eventId` throughout. Each event normalizes into a
 * Document AND an `outlook_calendar_events` analytics row (a hybrid source).
 * Recurring series arrive pre-expanded by `calendarView` as individual
 * instances, one document per occurrence.
 */
export class OutlookCalendarSource {
  readonly id: SourceIdType;
  readonly providerId: ProviderIdType;

  private graph: CalendarGraphClientLike;
  /**
   * Series masters resolved during this source instance's life, including the
   * ones that could not be read (stored as null) so a failure is not retried
   * per-occurrence.
   */
  private masterCache = new Map<string, GraphEvent | null>();
  private dataCutoff?: Date;
  private readonly accountId: string;

  constructor(
    getAccessToken: () => Promise<string>,
    sourceId: string,
    providerId: string,
    dataCutoff?: string,
    opts?: OutlookCalendarSourceOptions,
  ) {
    this.graph = opts?.graph ?? new GraphClient(getAccessToken);
    this.id = SourceId(sourceId);
    this.providerId = ProviderId(providerId);
    this.accountId = parseSourceKey(sourceId).accountId;
    if (dataCutoff) {
      this.dataCutoff = new Date(dataCutoff);
      log.info(`Data cutoff: ${dataCutoff}`);
    }
  }

  analyticsSchemas = [outlookCalendarEventsSchema];

  /** Document-only view of a sync page. Delegates to `syncPageInternal`. */
  async sync(cursor: SyncCursor | null): Promise<SyncResult<OutlookCalendarCursor>> {
    const page = await this.guardedSyncPage(cursor);
    return {
      documents: page.documents,
      deletedExternalIds: page.deletedExternalIds,
      ...(page.presentExternalIds ? { presentExternalIds: page.presentExternalIds } : {}),
      ...(page.presentClaims ? { presentClaims: page.presentClaims } : {}),
      cursor: page.cursor as OutlookCalendarCursor,
      hasMore: page.hasMore,
      progress: page.progress,
      issues: page.issues,
    };
  }

  /**
   * Hybrid view of a sync page: the same documents PLUS one
   * `outlook_calendar_events` row per event. Cancelled / removed events are
   * tombstoned on both the document and structured sides.
   */
  async syncStructured(
    cursor: SyncCursor | null,
  ): Promise<StructuredSyncResult<OutlookCalendarCursor>> {
    const page = await this.guardedSyncPage(cursor);
    const write: TableWrite = {
      tableName: OUTLOOK_CALENDAR_EVENTS_TABLE,
      records: page.records,
      deletedIds: page.deletedIds,
      ...(page.presentIds ? { presentIds: page.presentIds } : {}),
    };
    return {
      // A page that neither wrote nor deleted a row nor closed a snapshot
      // walk asks the host for nothing, so it carries no analytics at all.
      analytics: tableWrites(write).length > 0 ? write : undefined,
      documents: page.documents,
      deletedExternalIds: page.deletedExternalIds,
      ...(page.presentExternalIds ? { presentExternalIds: page.presentExternalIds } : {}),
      ...(page.presentClaims ? { presentClaims: page.presentClaims } : {}),
      cursor: page.cursor as OutlookCalendarCursor,
      hasMore: page.hasMore,
      progress: page.progress,
      issues: page.issues,
    };
  }

  /**
   * The `startDateTime`/`endDateTime` bounding `calendarView`.
   *
   * The future edge rolls forward with "now" so newly scheduled events come
   * into view. The past edge is fixed the first time it is computed and then
   * carried on the cursor, because the enumeration doubles as a whole-source
   * snapshot: an advancing past edge would drop older events out of it while
   * their documents stayed indexed, and the gateway deletes whatever a snapshot
   * omits. Anchored, the enumerated range only ever grows, so it stays a
   * superset of what has been ingested.
   */
  private window(anchored?: string): { startDateTime: string; endDateTime: string } {
    let start: Date;
    if (anchored) {
      start = new Date(anchored);
    } else if (this.dataCutoff) {
      start = new Date(this.dataCutoff);
    } else {
      start = new Date();
      start.setUTCFullYear(start.getUTCFullYear() - WINDOW_PAST_YEARS);
    }
    const end = new Date();
    end.setUTCFullYear(end.getUTCFullYear() + WINDOW_FUTURE_YEARS);
    return { startDateTime: start.toISOString(), endDateTime: end.toISOString() };
  }

  private nextWindowRefresh(now = new Date()): string {
    const refresh = new Date(now);
    refresh.setUTCDate(refresh.getUTCDate() + WINDOW_REFRESH_DAYS);
    return refresh.toISOString();
  }

  /**
   * Every calendar on the account, paged.
   *
   * `/me/calendarView` covers only the default calendar, so a second one is
   * reachable solely through its own `/me/calendars/{id}/calendarView`.
   */
  private async listCalendars(): Promise<GraphCalendar[]> {
    const calendars: GraphCalendar[] = [];
    let url: string | undefined = "/me/calendars?$select=id,name,owner,isDefaultCalendar";
    while (url) {
      const page: CalendarListResponse = await this.graph.get<CalendarListResponse>(url);
      for (const c of page.value) if (c.id) calendars.push(c);
      url = page["@odata.nextLink"];
    }
    return calendars;
  }

  /**
   * Whether this account owns the calendar, as opposed to reading one somebody
   * shared with it.
   *
   * Graph defines an event's `isOrganizer` against the *calendar owner*, and
   * that flag is what marks the organizer mention as the user. On a calendar
   * belonging to someone else the same flag means that person organized the
   * meeting, so honouring it there would attach the user's identity to another
   * person's events.
   *
   * `isDefaultCalendar` is the reliable signal: the default calendar is the
   * account's own by definition. The owner address alone is not enough on its
   * own — the account id is the sign-in name, which on a work account is the
   * UPN, while Graph reports the mailbox's primary SMTP address, and in many
   * tenants those differ. So the address is a positive signal when it matches
   * and, for a non-default calendar Graph did not attribute at all, absence is
   * read as the account's own mailbox.
   */
  private ownsCalendar(calendar: GraphCalendar | undefined): boolean {
    if (calendar?.isDefaultCalendar) return true;
    const owner = calendar?.owner?.address;
    if (!owner) return true;
    return owner.toLowerCase() === this.accountId.toLowerCase();
  }

  /**
   * `syncPageInternal`, converting an escaping `AuthError` before it reaches
   * either public entry point. Mail, Calendar and OneDrive all read through
   * the same account token (see `toConnectionAuthError`), so a dead
   * credential is never a fact about this one calendar.
   */
  private async guardedSyncPage(cursor: SyncCursor | null): Promise<CalendarPage> {
    try {
      return await this.syncPageInternal(cursor);
    } catch (error) {
      if (error instanceof AuthError) throw toConnectionAuthError(error);
      throw error;
    }
  }

  /**
   * Walk one calendar's events for one page.
   *
   * Every calendar the account can see gets its own delta stream, and the
   * queue is drained one page per `sync()` call. Draining a whole cycle in one
   * call would mean a transient Graph failure on a busy account costs the
   * cycle's progress rather than a single page.
   */
  private async syncPageInternal(cursor: SyncCursor | null): Promise<CalendarPage> {
    const state = validateOutlookCalendarCursor(cursor) ?? {};
    const windowStart = state.windowStart ?? this.window().startDateTime;
    let windowRefreshAfter = state.windowRefreshAfter ?? this.nextWindowRefresh();

    // Resolved every call — cheap, and it is what notices a calendar added or
    // removed since the last one.
    const calendars = await this.listCalendars();
    const liveIds = new Set(calendars.map((c) => c.id));

    const calendarLinks: Record<string, string> = { ...(state.calendarLinks ?? {}) };
    let pending = state.pendingCalendars ? [...state.pendingCalendars] : undefined;
    let snapshotCalendars = state.snapshotCalendars;
    let snapshotLedger = state.snapshot;
    let enumeratedMasters = state.enumeratedMasters;
    // The enumeration is rebuilt from the cursor on every call and written back
    // after each change, so no page can hold a stale copy of it. A cycle that is
    // not enumerating has none, and every call here is a no-op.
    const withSnapshot = (mutate: (enumeration: SnapshotEnumeration) => void): void => {
      if (snapshotLedger === undefined) return;
      const enumeration = SnapshotEnumeration.resume(snapshotCalendars ?? [], snapshotLedger);
      mutate(enumeration);
      snapshotLedger = enumeration.toLedger();
    };
    // A resume link belongs to the calendar that issued it, never to whichever
    // one happens to be at the head of the queue. Pairing the two means a queue
    // that shifts underneath it — a calendar deleted while it was mid-page —
    // drops the link, instead of replaying one calendar's page under another's
    // id and filing its delta link against the wrong stream.
    let resume =
      state.resumeLink && state.pendingCalendars?.[0]
        ? { calendarId: state.pendingCalendars[0], link: state.resumeLink }
        : undefined;

    if (pending === undefined) {
      // Graph bakes the calendarView bounds into every delta link it issues, so
      // the future edge only advances by abandoning that generation.
      if (Date.parse(windowRefreshAfter) <= Date.now()) {
        for (const id of Object.keys(calendarLinks)) delete calendarLinks[id];
        windowRefreshAfter = this.nextWindowRefresh();
        log.info("Calendar occurrence window expired, re-enumerating");
      }
      // A cycle that starts with no links reads every calendar in full, so what
      // it collects is a snapshot. A cycle resuming from delta links collects
      // only changes, and must not be mistaken for one.
      if (Object.keys(calendarLinks).length === 0) {
        // Frozen here: the calendar list is re-read every call, and an
        // enumeration judged against a list that changed under it would either
        // vouch for a calendar it never opened or be short one it did.
        snapshotCalendars = calendars.map((c) => c.id);
        snapshotLedger = {};
        enumeratedMasters = [];
        // A full enumeration re-reads every master, so anything remembered from
        // an earlier one is at best redundant and at worst a stale title.
        this.masterCache.clear();
      }
      pending = calendars.map((c) => c.id);
      resume = undefined;
    }

    // The queue and the enumeration's partition list are born together above,
    // and every return writes them together. A cursor that arrives with one and
    // not the other would walk a calendar the enumeration was never opened
    // with, and `add` refuses that by throwing — a page that fails the same way
    // on every tick, with a cursor valid enough that no policy replaces it.
    if (snapshotLedger !== undefined) {
      const opened = new Set(snapshotCalendars ?? []);
      pending = pending.filter((id) => opened.has(id));
    }

    // A calendar the user removed leaves the queue and takes its link with it —
    // following a link for a calendar that no longer exists would 404 the cycle
    // on every tick from here on.
    const retired = Object.keys(calendarLinks).filter((id) => !liveIds.has(id));
    const droppedFromQueue = pending.filter((id) => !liveIds.has(id));
    pending = pending.filter((id) => liveIds.has(id));
    for (const id of retired) delete calendarLinks[id];
    // A calendar that leaves the account while the enumeration is still walking
    // it is not an unread partition — the account listing says it holds
    // nothing. Covering it with no ids is how that is said, and it keeps the
    // cycle able to vouch for the whole account: left merely uncovered it would
    // withhold the account-wide form, and nothing would re-enumerate until the
    // window rolls, so its events would read as meetings that still exist for
    // up to a month.
    for (const id of droppedFromQueue) {
      withSnapshot((enumeration) => {
        if ((snapshotCalendars ?? []).includes(id)) enumeration.empty(id);
      });
    }

    if (retired.length > 0 && snapshotLedger === undefined) {
      // Dropping the link stops the source reading a calendar that is gone, but
      // its events stay indexed, reading as meetings that still exist. Only a
      // whole-source snapshot retires them, so start the cycle that produces
      // one rather than waiting up to a window roll for it.
      log.info(
        `${retired.length} calendars are no longer on the account — re-enumerating so their events are reconciled away`,
      );
      return this.emptyPage(
        { calendarLinks: {}, windowStart, windowRefreshAfter, knownMasters: state.knownMasters },
        true,
      );
    }

    if (pending.length === 0) {
      // A cycle that saw no calendars has not enumerated the account. The
      // gateway deletes every document and analytics row a snapshot omits, and
      // a claim deletes everything its named partitions do not hold, so
      // publishing either from an empty `/me/calendars` would delete the
      // corpus — and an empty list is far likelier to be a transient read than
      // an account that genuinely lost every calendar. Withhold both and let
      // the next cycle try again.
      const enumeration =
        snapshotLedger !== undefined
          ? SnapshotEnumeration.resume(
              calendars.length > 0 ? (snapshotCalendars ?? []) : [],
              snapshotLedger,
            )
          : undefined;
      if (snapshotLedger !== undefined && calendars.length === 0) {
        log.warn(
          "No calendars enumerated — withholding the snapshot rather than reconciling to empty",
        );
      }
      // Whole-account only when every calendar was read. The analytics rows have
      // no per-partition form, so a cycle that has to claim withholds
      // `presentIds` entirely rather than telling the table those are all the
      // rows there are — the claim covers the documents alone.
      const snapshot = enumeration?.complete === true ? enumeration.result()?.sort() : undefined;
      const claims = snapshot === undefined ? (enumeration?.claims() ?? []) : [];
      if (enumeration !== undefined && snapshot === undefined) {
        log.warn(enumeration.withheldReason() ?? "Snapshot withheld");
      }
      const issue = enumeration?.withheldIssue();
      return {
        documents: [],
        records: [],
        issues: enumeration ? (issue ? [issue] : []) : undefined,
        deletedExternalIds: [],
        deletedIds: [],
        ...(snapshot ? { presentIds: snapshot, presentExternalIds: snapshot } : {}),
        ...(claims.length > 0 ? { presentClaims: claims } : {}),
        cursor: {
          calendarLinks,
          windowStart,
          windowRefreshAfter,
          knownMasters: enumeratedMasters ?? state.knownMasters,
        },
        hasMore: false,
      };
    }

    const calendarId = pending[0]!;
    const calendar = calendars.find((c) => c.id === calendarId);
    const calendarName = calendar?.name;

    let page: CalendarDeltaResponse;
    try {
      const link = resume?.calendarId === calendarId ? resume.link : calendarLinks[calendarId];
      page = link
        ? await this.graph.get<CalendarDeltaResponse>(link)
        : await this.graph.get<CalendarDeltaResponse>(
            `/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta`,
            this.window(windowStart),
            // Graph refuses `$top` on a change-tracked `calendarView`: it
            // cannot guarantee a page size there, and says so by rejecting the
            // whole request. The preference header is the channel it does
            // accept, and without it every calendar fails to enumerate — which
            // this source correctly reports as a withheld snapshot, so the
            // symptom is silently degraded deletion detection rather than a
            // visible error.
            { Prefer: `odata.maxpagesize=${CALENDAR_PAGE_SIZE}` },
          );
    } catch (error) {
      if (error instanceof AuthError || isTransientSyncError(error)) {
        // A condition of the account, not a fact about this calendar: every
        // calendar behind it would fail the same way, and the collector decides
        // `needs-auth` and its backoff from what escapes.
        throw error;
      }
      if (error instanceof DeltaExpiredError) {
        // This calendar's token aged out. Drop the link but leave the calendar
        // at the head of the queue: the next call re-reads it in full over a
        // fresh window and the cycle carries on. Restarting the whole cycle
        // would re-walk every calendar already visited — quadratic on an
        // account whose tokens all expired together, as they were all minted at
        // the same window roll.
        log.warn(
          `Delta token expired for calendar ${calendarName ?? calendarId}, re-reading it in full`,
        );
        delete calendarLinks[calendarId];
        return this.emptyPage(
          {
            calendarLinks,
            pendingCalendars: pending,
            windowStart,
            windowRefreshAfter,
            ...(snapshotCalendars ? { snapshotCalendars } : {}),
            ...(snapshotLedger ? { snapshot: snapshotLedger } : {}),
            ...(enumeratedMasters ? { enumeratedMasters } : {}),
            knownMasters: state.knownMasters,
          },
          true,
        );
      }
      // A calendar this account cannot read — a subscribed feed, one shared in
      // with rights that stop short of a delta query — must not starve the
      // calendars behind it in the queue. Skip it for this cycle, and record it
      // as the one calendar this enumeration cannot vouch for. The calendars
      // around it are still covered and still claimed, so a meeting deleted in
      // one of them is found on this cycle rather than after the unreadable one
      // is fixed, which may be never.
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(`Skipping calendar ${calendarName ?? calendarId} this cycle: ${msg}`);
      delete calendarLinks[calendarId];
      withSnapshot((enumeration) => enumeration.gap(calendarId, msg));
      return this.emptyPage(
        {
          calendarLinks,
          pendingCalendars: pending.slice(1),
          windowStart,
          windowRefreshAfter,
          ...(snapshotCalendars ? { snapshotCalendars } : {}),
          ...(snapshotLedger ? { snapshot: snapshotLedger } : {}),
          ...(enumeratedMasters ? { enumeratedMasters } : {}),
          knownMasters: state.knownMasters,
        },
        true,
      );
    }

    const knownMasters = new Set(state.knownMasters ?? []);
    const result = await this.processCalendarPage(page, calendarId, calendarName, knownMasters, {
      enumerating: snapshotLedger !== undefined,
      ownedByAccount: this.ownsCalendar(calendar),
    });

    if (result.deletedSeries > 0) {
      // Deleting a series tombstones its master alone, and the master is not a
      // document — so nothing is removed until a full cycle republishes the
      // snapshot. Waiting for the window roll would leave the occurrences
      // reading as meetings that still exist.
      log.info(
        `${result.deletedSeries} recurring series deleted — re-enumerating so their occurrences are reconciled away`,
      );
      return {
        ...result.page,
        cursor: {
          calendarLinks: {},
          windowStart,
          windowRefreshAfter,
          knownMasters: [...knownMasters],
        } satisfies OutlookCalendarCursor,
        hasMore: true,
        progress: { phase: "bootstrap", processed: result.page.documents.length },
      };
    }

    const nextLink = page["@odata.nextLink"];
    const deltaLink = page["@odata.deltaLink"];

    if (nextLink) {
      resume = { calendarId, link: nextLink };
    } else {
      resume = undefined;
      if (deltaLink) calendarLinks[calendarId] = deltaLink;
      pending = pending.slice(1);
    }

    const ids = result.page.records.map((r) => String(r.id));
    // Added under this calendar as its pages arrive, and covered only when its
    // delta link does — the point at which the calendar has been read in full.
    // A calendar still mid-pagination holds ids and is vouched for by nothing.
    withSnapshot((enumeration) => {
      enumeration.add(calendarId, ids);
      if (!nextLink && deltaLink) enumeration.cover(calendarId);
    });
    const nextMasters = enumeratedMasters
      ? [...new Set([...enumeratedMasters, ...result.mastersThisPage])]
      : undefined;

    log.info(
      `Calendar "${calendarName ?? calendarId}": ${result.page.documents.length} events, -${result.page.deletedExternalIds.length} (${pending.length} calendars left)`,
    );

    return {
      ...result.page,
      cursor: {
        calendarLinks,
        pendingCalendars: pending,
        ...(resume ? { resumeLink: resume.link } : {}),
        windowStart,
        windowRefreshAfter,
        ...(snapshotCalendars ? { snapshotCalendars } : {}),
        ...(snapshotLedger ? { snapshot: snapshotLedger } : {}),
        ...(nextMasters ? { enumeratedMasters: nextMasters } : {}),
        knownMasters: [...knownMasters],
      } satisfies OutlookCalendarCursor,
      hasMore: true,
      // A cycle that is walking every calendar in full is a bootstrap; one
      // following delta links is reporting changes.
      progress: {
        phase: snapshotLedger ? "bootstrap" : "incremental",
        processed: result.page.documents.length,
      },
    };
  }

  /**
   * A page that carries no events, only a cursor — what a recovery branch
   * returns. Every such branch produces the same empty document/row/tombstone
   * quartet, so they say only what is different: the cursor, and whether the
   * cycle continues.
   */
  private emptyPage(cursor: OutlookCalendarCursor, hasMore: boolean): CalendarPage {
    return {
      documents: [],
      records: [],
      deletedExternalIds: [],
      deletedIds: [],
      cursor,
      hasMore,
    };
  }

  /**
   * Whether the event is still relevant under the configured `dataCutoff`.
   *
   * The cutoff bounds an event by *when it occurs*, not when it was created —
   * the same rule Google Calendar applies. Creation time is the wrong axis for
   * a calendar: a standup authored three years ago still has occurrences this
   * week, and `calendarView` hands them back with the series' original
   * `createdDateTime`. Filtering on that would drop every occurrence of every
   * long-standing series the moment a retention window is configured.
   *
   * `calendarView`'s server-side `startDateTime` already bounds the walk, so
   * this is the client-side backstop: keep an event whose occurrence ends at or
   * after the cutoff (falling back to start, then to keeping it when neither
   * end is parseable).
   */
  private occursAfterCutoff(event: GraphEvent): boolean {
    if (!this.dataCutoff) return true;
    const occurrence = graphDateTimeToIso(event.end) ?? graphDateTimeToIso(event.start);
    if (!occurrence) return true;
    return new Date(occurrence).getTime() >= this.dataCutoff.getTime();
  }

  /**
   * Turn one page of one calendar's events into documents and rows.
   *
   * Split out from the queue orchestration above so each reads as one job:
   * this decides what a page of events means, that decides which page to ask
   * for next.
   */
  private async processCalendarPage(
    page: CalendarDeltaResponse,
    calendarId: string,
    calendarName: string | undefined,
    knownMasters: Set<string>,
    opts: { enumerating: boolean; ownedByAccount: boolean },
  ): Promise<{
    page: Omit<CalendarPage, "cursor" | "hasMore">;
    mastersThisPage: string[];
    deletedSeries: number;
  }> {
    const documents: DocumentInput[] = [];
    const records: Record<string, unknown>[] = [];
    const deletedExternalIds: string[] = [];
    const deletedIds: string[] = [];
    const mastersThisPage: string[] = [];

    // Event ids are unique within a calendar, not across them, so everything
    // that keys on an event — the document, the row, the remembered series —
    // is namespaced by the calendar it came from.
    const key = (eventId: string) => `${calendarId}:${eventId}`;

    // Masters are needed before their occurrences can be read, and Graph
    // guarantees no ordering within a page. Writing them through to the cache
    // also carries a master across a page boundary, and keeps one cycle from
    // hydrating a series out of two different snapshots of its master.
    for (const event of page.value) {
      // A tombstone is `{id, "@removed"}` and nothing else. Reading a `type`
      // off one would poison the cache with an empty event and re-add the very
      // id whose removal this pass exists to notice.
      if (!event.id || event["@removed"]) continue;
      if (event.type === "seriesMaster") {
        this.masterCache.set(key(event.id), event);
        knownMasters.add(key(event.id));
        mastersThisPage.push(key(event.id));
      }
      // An occurrence names its series whether or not the master is in the
      // window — and for a standing meeting created years ago it never is.
      if (event.seriesMasterId) {
        knownMasters.add(key(event.seriesMasterId));
        mastersThisPage.push(key(event.seriesMasterId));
      }
    }

    let deletedSeries = 0;
    let droppedByCutoff = 0;
    let hydrated = 0;
    let unhydrated = 0;

    for (const raw of page.value) {
      if (!raw.id) continue;
      if (raw.type === "seriesMaster") {
        // A master is the template for its occurrences, not an event in its own
        // right: `calendarView` expands the series, so emitting the master too
        // duplicates whichever occurrence shares its start.
        //
        // Retracted only while enumerating. A tombstone costs a source-stats
        // recompute and reports a deletion whether or not anything matched, and
        // a change feed re-sends a master only when the series was edited — so
        // tombstoning there would charge that price on every edit to remove a
        // document that is no longer created anyway.
        if (opts.enumerating) {
          deletedExternalIds.push(key(raw.id));
          deletedIds.push(key(raw.id));
        }
        continue;
      }

      let event = raw;
      if (needsHydration(raw)) {
        const master = await this.fetchSeriesMaster(calendarId, raw.seriesMasterId!);
        if (master) {
          event = hydrateFromMaster(raw, master);
          hydrated++;
        } else {
          unhydrated++;
        }
      }

      // `@removed` tombstones and explicitly cancelled events both delete the
      // co-emitted document (mirrors Google Calendar's `status === "cancelled"`).
      if (event["@removed"] || event.isCancelled) {
        deletedExternalIds.push(key(event.id));
        deletedIds.push(key(event.id));
        if (knownMasters.delete(key(event.id))) deletedSeries++;
        continue;
      }
      if (!this.occursAfterCutoff(event)) {
        // Bounding by occurrence means an event can LEAVE the window: reschedule
        // a 2025 meeting into 2019 and it stops qualifying. Dropping it silently
        // would strand the document already indexed at the old time, so a cutoff
        // drop retracts both halves exactly as a cancellation does.
        deletedExternalIds.push(key(event.id));
        deletedIds.push(key(event.id));
        droppedByCutoff++;
        continue;
      }

      const doc = this.normalizeEvent(event, calendarId, calendarName, opts.ownedByAccount);
      if (doc) documents.push(doc);
      const row = this.eventToRow(event, calendarId, calendarName, opts.ownedByAccount);
      if (row) records.push(row);
    }

    if (droppedByCutoff > 0) {
      log.info(`Filtered ${droppedByCutoff} events occurring before the cutoff`);
    }
    if (hydrated > 0) {
      log.info(`Recurring occurrences: ${hydrated} filled in from their series master`);
    }
    if (unhydrated > 0) {
      // Each becomes a document with a time and nothing else, so it is a
      // data-quality result the operator should see rather than an aside.
      log.warn(`${unhydrated} recurring occurrences could not reach their series master`);
    }

    return {
      page: { documents, records, deletedExternalIds, deletedIds },
      mastersThisPage,
      deletedSeries,
    };
  }

  /**
   * Fetch a series master the current page did not carry.
   *
   * A standing weekly meeting created years ago has its master outside the
   * bounded `calendarView` window, so its occurrences arrive with a
   * `seriesMasterId` pointing at an event the enumeration never sends — which
   * is the ordinary case for exactly the series a user cares most about.
   *
   * Memoized until the next full enumeration, so a page carrying fifty
   * occurrences of one series costs one request rather than fifty, and a steady
   * incremental tick that reports no occurrences costs none. A series-specific
   * failure — the master deleted, or not visible — is not fatal: the occurrence
   * is still emitted with the times it has, which beats dropping it. A failure
   * of the connection itself propagates instead.
   */
  private async fetchSeriesMaster(
    calendarId: string,
    seriesMasterId: string,
  ): Promise<GraphEvent | null> {
    const cacheKey = `${calendarId}:${seriesMasterId}`;
    const cached = this.masterCache.get(cacheKey);
    if (cached !== undefined) return cached;
    try {
      let master: GraphEvent;
      try {
        master = await this.graph.get<GraphEvent>(
          `/me/events/${encodeURIComponent(seriesMasterId)}`,
        );
      } catch (error) {
        if (isTransientSyncError(error) || error instanceof AuthError) throw error;
        // `/me/events` addresses the account's own mailbox, so a master on a
        // calendar shared in from another one is not there. The calendar-scoped
        // route reaches it. Second rather than first because the mailbox route
        // is the one that works for every calendar the account owns, which is
        // the overwhelming majority.
        master = await this.graph.get<GraphEvent>(
          `/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(seriesMasterId)}`,
        );
      }
      this.masterCache.set(cacheKey, master);
      return master;
    } catch (error) {
      // A dead token and a throttled gateway are conditions of the sync, not
      // facts about this series. Swallowing them would both hide the failure
      // from the collector — which decides `needs-auth` from what escapes — and
      // cache a miss that survives the re-authorization meant to fix it.
      if (isTransientSyncError(error) || error instanceof AuthError) throw error;
      if (error instanceof DeltaExpiredError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(`Could not read series master ${seriesMasterId}: ${msg}`);
      // Remembered as a miss so one unreadable series does not re-ask for every
      // occurrence on the page. The cache is cleared whenever a cycle starts a
      // full enumeration, so a series that becomes readable again recovers
      // without a restart.
      this.masterCache.set(cacheKey, null);
      return null;
    }
  }

  private normalizeEvent(
    event: GraphEvent,
    calendarId: string,
    calendarName: string | undefined,
    ownedByAccount: boolean,
  ): DocumentInput | null {
    if (!event.id) return null;

    const startIso = graphDateTimeToIso(event.start);
    const endIso = graphDateTimeToIso(event.end);
    const recurrence = formatRecurrence(event.recurrence);
    const location = event.location?.displayName;
    const joinUrl = event.onlineMeeting?.joinUrl;

    const attendeeNames = (event.attendees ?? [])
      .map((a) => a.emailAddress?.name ?? a.emailAddress?.address ?? "")
      .filter(Boolean);

    let body = "";
    if (event.body?.content) {
      body =
        event.body.contentType === "html" ? htmlToMarkdown(event.body.content) : event.body.content;
    } else if (event.bodyPreview) {
      body = event.bodyPreview;
    }

    const content = [
      `# ${event.subject || "(no title)"}`,
      "",
      `**When:** ${startIso ?? ""} → ${endIso ?? ""}`,
      recurrence ? `**Recurrence:** ${recurrence}` : "",
      location ? `**Location:** ${location}` : "",
      attendeeNames.length > 0 ? `**Attendees:** ${attendeeNames.join(", ")}` : "",
      joinUrl ? `**Meeting link:** ${joinUrl}` : "",
      "",
      body ? "---\n\n" + body : "",
    ]
      .filter(Boolean)
      .join("\n");

    const contentHash = computeContentHash(content);

    const sourceDate = event.createdDateTime
      ? new Date(event.createdDateTime).toISOString()
      : (startIso ?? new Date().toISOString());
    const updatedDate = event.lastModifiedDateTime
      ? new Date(event.lastModifiedDateTime).toISOString()
      : sourceDate;

    const people: PersonMention[] = [];
    const seenEmails = new Set<string>();

    const organizerEmail = event.organizer?.emailAddress?.address;
    if (organizerEmail) {
      seenEmails.add(organizerEmail.toLowerCase());
      // Outlook names the organizer of the account's own events with an opaque
      // `outlook_…@outlook.com` alias rather than the address its owner uses,
      // so the address alone resolves to somebody who is not the user.
      // `isSelf` says who this is directly: the resolver routes it to the
      // canonical self whatever aliases already exist, where joining the two
      // addresses would only merge them on a corpus where neither is known yet.
      // The alias is still carried, so the document records what Graph said.
      people.push({
        role: "author",
        name: event.organizer?.emailAddress?.name ?? undefined,
        emails: [organizerEmail],
        ...(ownedByAccount && event.isOrganizer ? { isSelf: true } : {}),
      });
    }

    for (const attendee of event.attendees ?? []) {
      const email = attendee.emailAddress?.address;
      if (!email) continue;
      const emailLower = email.toLowerCase();
      if (seenEmails.has(emailLower)) continue;
      seenEmails.add(emailLower);
      people.push({
        role: "attendee",
        name: attendee.emailAddress?.name ?? undefined,
        emails: [email],
      });
    }

    if (body) {
      for (const email of extractEmailsFromText(body)) {
        if (seenEmails.has(email.toLowerCase())) continue;
        seenEmails.add(email.toLowerCase());
        people.push({ role: "mentioned", emails: [email] });
      }
      for (const phone of extractPhonesFromText(body)) {
        people.push({ role: "mentioned", phones: [phone], allowPersonCreation: false });
      }
    }

    return {
      providerId: this.providerId,
      sourceId: this.id,
      externalId: `${calendarId}:${event.id}`,
      // The calendar this event lives in. A cycle that could not read every
      // calendar claims the ones it did by name, and a claim only reaches
      // documents that say which calendar they are in.
      partitionKey: calendarId,
      title: event.subject || "(no title)",
      content,
      contentHash,
      metadata: {
        // No `appUrl`. Outlook's `ms-outlook://` scheme is registered on iOS
        // but addresses no item: every path form opens the app on the inbox,
        // discarding which event was tapped. `sourceUrl` opens the event in a
        // browser, which is less slick and actually arrives — the same reason
        // Gmail declares no `appUrl` for a scheme that can only compose.
        sourceUrl: event.webLink ?? undefined,
        documentType: "event",
        people,
        tags: event.categories ?? [],
        extra: {
          location,
          status: event.isCancelled ? "cancelled" : "confirmed",
          // Availability, not lifecycle: a free placeholder and a booked
          // meeting are both confirmed events, and this is what separates them.
          showAs: showAsOf(event) ?? undefined,
          start: startIso,
          end: endIso,
          // Graph anchors an all-day event at midnight UTC rather than
          // converting local midnight, so the calendar date survives the trip
          // and needs no correction here.
          allDay: !!event.isAllDay,
          // RFC 5545 UID from Microsoft Graph (`iCalUId`). The standard
          // identifier shared by every system that exposes this event
          // (including ICS attachments delivered by email). Stored under the
          // same `iCalUID` key the Google Calendar source uses so the link
          // extractor resolves `calendar-event` cross-source links from
          // email-attached invites — see #266.
          iCalUID: event.iCalUId ?? undefined,
          // Names the series an occurrence belongs to, so a reader can tell a
          // one-off apart from one instance of a standing meeting.
          seriesMasterId: event.seriesMasterId ?? undefined,
          calendarId,
          calendarName,
        },
      },
      sourceCreatedAt: sourceDate,
      sourceUpdatedAt: updatedDate,
    };
  }

  /**
   * Build the `outlook_calendar_events` row for an event — the structured twin
   * of `normalizeEvent`, keyed `calendarId:eventId` exactly as the document is
   * so the doc↔row `same-entity` edge is 1:1. Derives the analytical columns
   * the document body can't aggregate: duration, attendee count, RSVP.
   */
  private eventToRow(
    event: GraphEvent,
    calendarId: string,
    calendarName: string | undefined,
    ownedByAccount: boolean,
  ): Record<string, unknown> | null {
    if (!event.id) return null;

    const startIso = graphDateTimeToIso(event.start);
    const endIso = graphDateTimeToIso(event.end);

    // Duration only makes sense for timed events with both ends parseable;
    // all-day and open-ended events leave it null.
    let durationMinutes: number | null = null;
    if (!event.isAllDay && startIso && endIso) {
      const startMs = new Date(startIso).getTime();
      const endMs = new Date(endIso).getTime();
      if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs) {
        durationMinutes = (endMs - startMs) / 60000;
      }
    }

    const attendeeEmails = new Set<string>();
    for (const a of event.attendees ?? []) {
      const email = a.emailAddress?.address;
      if (email) attendeeEmails.add(email.toLowerCase());
    }
    const attendeeCount = attendeeEmails.size > 0 ? attendeeEmails.size : null;

    return {
      id: `${calendarId}:${event.id}`,
      source_account: this.accountId,
      calendar_id: calendarId,
      calendar_name: calendarName ?? null,
      event_id: event.id,
      ical_uid: event.iCalUId ?? null,
      title: event.subject ?? null,
      start_time: startIso ?? null,
      end_time: endIso ?? null,
      duration_minutes: durationMinutes,
      all_day: !!event.isAllDay,
      recurring: isRecurring(event),
      // Series masters never reach this point — they are filtered out as
      // templates — so every row built here is a concrete occurrence or a
      // single event, each with a time of its own to place.
      //
      // The timeline is an index of bookings. A `free` block is the opposite of
      // one — time the calendar is explicitly not claiming — so it stays a
      // searchable document and an analytics row without becoming an
      // appointment on the timeline. Everything else, including a tentative
      // hold and an out-of-office day, does occupy the time it names.
      temporal_projection_eligible: showAsOf(event) !== "free",
      organizer_email: event.organizer?.emailAddress?.address ?? null,
      attendee_count: attendeeCount,
      // Graph reports `responseStatus` against the calendar's owner, like
      // `isOrganizer`. On a calendar shared in from another mailbox it is that
      // person's RSVP, so recording it under a column that means "the account's
      // RSVP" would answer "how many meetings did I decline" with somebody
      // else's answer. Left null there rather than quietly wrong.
      response_status: ownedByAccount ? (event.responseStatus?.response ?? null) : null,
      location: event.location?.displayName ?? null,
      status: event.isCancelled ? "cancelled" : "confirmed",
      show_as: showAsOf(event),
    };
  }
}
