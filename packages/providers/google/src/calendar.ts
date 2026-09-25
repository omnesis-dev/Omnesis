// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { google, type calendar_v3 } from "googleapis";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
import {
  createLogger,
  computeContentHash,
  extractEmailsFromText,
  extractPhonesFromText,
} from "@omnesis/core";
import { makeCursorValidator, tableWrites, SnapshotEnumeration } from "@omnesis/source-sdk";
import { SourceId, ProviderId } from "@omnesis/types";
import { CALENDAR_MAX_RESULTS } from "./constants.js";
import { mapGoogleApiError } from "./api-error.js";
import { GOOGLE_CALENDAR_EVENTS_TABLE, googleCalendarEventsSchema } from "./calendar-schema.js";
import type {
  SyncCursor,
  SyncResult,
  SyncProgress,
  StructuredSyncResult,
  TableWrite,
} from "@omnesis/source-sdk";
import type { DocumentInput, PersonMention, SyncIssue } from "@omnesis/types";

const log = createLogger("source:calendar");

const WINDOW_PAST_YEARS = 1;
const WINDOW_FUTURE_YEARS = 1;
const WINDOW_REFRESH_DAYS = 30;

/** iOS deep link for a Google Calendar event via the app's custom scheme. */
export function googleCalendarAppUrl(htmlLink: string | null | undefined): string | undefined {
  if (!htmlLink) return undefined;
  const match = htmlLink.match(/[?&]eid=([^&]+)/);
  if (!match) return undefined;
  return `googlecalendar://event?eid=${match[1]}`;
}

export interface CalendarSyncCursor extends SyncCursor {
  /** Map of calendarId -> syncToken for per-calendar sync. Persists across cycles. */
  calendarSyncTokens?: Record<string, string>;
  /**
   * Calendars left to process in the current sync cycle (FIFO). Set on the
   * first call of a cycle; emptied as each calendar finishes draining.
   * `undefined` means the previous cycle finished and the next call starts
   * a fresh one.
   */
  pendingCalendars?: string[];
  /** When set, the head of `pendingCalendars` is mid-paginate at this token. */
  resumePageToken?: string;
  /**
   * Documents ingested so far in the current cycle. Reset to 0 when a new
   * cycle starts. Surfaced via `SyncProgress.processed` so the UI doesn't
   * sit at 0 across multi-calendar bootstraps.
   */
  processedThisCycle?: number;
  /** Bounds used for occurrence expansion on the current token generation. */
  windowStart?: string;
  windowEnd?: string;
  /** Periodically roll the bounded window so its future edge advances. */
  windowRefreshAfter?: string;
  /**
   * Whether this token generation was minted with `singleEvents:true`
   * occurrence expansion. Always present on a resumed cursor — the host's
   * state migration stamps it onto a value written before expansion existed
   * — so `sync` reads it directly rather than inferring the generation from
   * which other fields happen to be set.
   */
  occurrenceExpansion?: boolean;
  /**
   * Full bounded-snapshot reconciliation state. Present only while every
   * calendar is being re-enumerated for a new occurrence window.
   */
  snapshotPresentIds?: string[];
  /**
   * Set when a calendar left `pendingCalendars` without having been walked —
   * it vanished from the calendar list part-way through the cycle. The
   * accumulated enumeration is then missing every event that calendar holds,
   * which is indistinguishable from those events having been deleted.
   *
   * Lives on the cursor because a cycle spans several `sync()` calls: a
   * calendar that disappears on the first call has to still be suppressing the
   * snapshot when the last call would publish it.
   */
  snapshotIncomplete?: boolean;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object") return false;
  for (const value of Object.values(v as Record<string, unknown>)) {
    if (typeof value !== "string") return false;
  }
  return true;
}

export function isCalendarSyncCursor(v: unknown): v is CalendarSyncCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (c.calendarSyncTokens !== undefined && !isStringRecord(c.calendarSyncTokens)) return false;
  if (c.pendingCalendars !== undefined) {
    if (!Array.isArray(c.pendingCalendars)) return false;
    if (!c.pendingCalendars.every((x) => typeof x === "string")) return false;
  }
  if (c.resumePageToken !== undefined && typeof c.resumePageToken !== "string") return false;
  if (c.processedThisCycle !== undefined && typeof c.processedThisCycle !== "number") return false;
  const windowValues = ["windowStart", "windowEnd", "windowRefreshAfter"].map((key) => c[key]);
  if (windowValues.some((value) => value !== undefined)) {
    if (
      windowValues.some((value) => typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    ) {
      return false;
    }
  }
  if (c.occurrenceExpansion !== undefined && typeof c.occurrenceExpansion !== "boolean") {
    return false;
  }
  if (
    c.snapshotPresentIds !== undefined &&
    (!Array.isArray(c.snapshotPresentIds) ||
      !c.snapshotPresentIds.every((value) => typeof value === "string"))
  ) {
    return false;
  }
  if (c.snapshotIncomplete !== undefined && typeof c.snapshotIncomplete !== "boolean") return false;
  return true;
}

const validateCalendarSyncCursor = makeCursorValidator(isCalendarSyncCursor);

/** One sync page, carrying both representations so `sync` and `syncStructured`
 * format the same fetch without a second API round-trip. */
interface CalendarPage {
  documents: DocumentInput[];
  records: Record<string, unknown>[];
  deletedExternalIds: string[];
  deletedIds: string[];
  presentIds?: string[];
  // The base `SyncCursor` (index-signature) type so both result wrappers can
  // assign it; the literals are still validated `satisfies CalendarSyncCursor`.
  cursor: SyncCursor;
  hasMore: boolean;
  progress?: SyncProgress;
  issues?: SyncIssue[];
}

/**
 * Google Calendar source.
 * Fetches calendar events, normalizing each into a Document AND a
 * `google_calendar_events` analytics row (hybrid source).
 */
export class GoogleCalendarSource {
  readonly id: SourceId;
  readonly providerId: ProviderId;

  private calendar: calendar_v3.Calendar;
  private dataCutoff?: Date;
  private readonly accountId: string;

  constructor(auth: OAuth2Client, accountId?: string, dataCutoff?: string) {
    this.calendar = google.calendar({ version: "v3", auth });
    this.accountId = accountId ?? "local";
    this.id = SourceId(accountId ? `google-calendar:${accountId}` : "google-calendar");
    this.providerId = ProviderId(accountId ? `google:${accountId}` : "google");
    if (dataCutoff) {
      this.dataCutoff = new Date(dataCutoff);
      log.info(`Data cutoff: ${dataCutoff}`);
    }
  }

  /** Document-only view of a sync page (kept for callers/tests on the
   * unstructured contract). Delegates to `syncPage`. */
  async sync(cursor: SyncCursor | null): Promise<SyncResult> {
    // One typed boundary. The mapper returns an existing `SyncError`
    // unchanged, so the paths that already classify themselves are
    // unaffected; this is what stops an unclassified SDK throw — a transport
    // failure above all — reaching the collector as kind `unknown` with a
    // message that names neither the API nor the request.
    const page = await this.syncPage(cursor).catch((error: unknown) => {
      throw mapGoogleApiError(error);
    });
    return {
      documents: page.documents,
      deletedExternalIds: page.deletedExternalIds,
      cursor: page.cursor,
      hasMore: page.hasMore,
      progress: page.progress,
      issues: page.issues,
    };
  }

  /**
   * Hybrid view of a sync page: the same documents PLUS one
   * `google_calendar_events` row per event. Cancelled events are
   * tombstoned on the document side via `deletedExternalIds`; the runner now
   * forwards those in the structured branch too.
   */
  async syncStructured(cursor: SyncCursor | null): Promise<StructuredSyncResult> {
    const page = await this.syncPage(cursor);
    const write: TableWrite = {
      tableName: GOOGLE_CALENDAR_EVENTS_TABLE,
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
      cursor: page.cursor,
      hasMore: page.hasMore,
      progress: page.progress,
      issues: page.issues,
    };
  }

  analyticsSchemas = [googleCalendarEventsSchema];

  private newWindow(now = new Date()): {
    windowStart: string;
    windowEnd: string;
    windowRefreshAfter: string;
  } {
    const start = this.dataCutoff ? new Date(this.dataCutoff) : new Date(now);
    if (!this.dataCutoff) start.setUTCFullYear(start.getUTCFullYear() - WINDOW_PAST_YEARS);
    const end = new Date(now);
    end.setUTCFullYear(end.getUTCFullYear() + WINDOW_FUTURE_YEARS);
    const refresh = new Date(now);
    refresh.setUTCDate(refresh.getUTCDate() + WINDOW_REFRESH_DAYS);
    return {
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      windowRefreshAfter: refresh.toISOString(),
    };
  }

  private async syncPage(cursor: SyncCursor | null): Promise<CalendarPage> {
    const state = validateCalendarSyncCursor(cursor) ?? {};
    const calendarSyncTokens: Record<string, string> = {
      ...(state.calendarSyncTokens ?? {}),
    };
    // A cursor written before occurrence expansion landed must keep using the
    // exact parameters that minted its sync/page tokens: clearing those
    // tokens merely because projection support was deployed would
    // re-enumerate the existing bounded calendar and backfill projections.
    // `cursor === null` is a source that has never run (or was explicitly
    // reset), which always opts into expansion; a resumed cursor carries its
    // own generation's answer in `occurrenceExpansion`, stamped by the host's
    // state migration onto any value old enough to predate the field.
    const expandsOccurrences = cursor === null || state.occurrenceExpansion === true;
    let window =
      state.windowStart && state.windowEnd && state.windowRefreshAfter
        ? {
            windowStart: state.windowStart,
            windowEnd: state.windowEnd,
            windowRefreshAfter: state.windowRefreshAfter,
          }
        : this.newWindow();
    let snapshotPresentIds: string[] | undefined = expandsOccurrences
      ? state.snapshotPresentIds
      : undefined;

    // Always resolve the calendar list so a new calendar mid-cycle gets picked
    // up on the next cycle's pendingCalendars refresh, and a removed calendar
    // doesn't keep a stale entry alive.
    //
    // Followed to the last page rather than taken as one round-trip: the list
    // is what "everything" means for the snapshot below, and Google pages it at
    // 100 entries. A first page mistaken for the whole list would drop every
    // calendar past it from `pending`, finish the cycle, and reconcile against
    // an enumeration missing all of their events.
    const calendars: Array<calendar_v3.Schema$CalendarListEntry & { id: string }> = [];
    let calendarListPageToken: string | undefined;
    do {
      const calendarsRes = await this.calendar.calendarList.list(
        calendarListPageToken ? { pageToken: calendarListPageToken } : {},
      );
      for (const c of calendarsRes.data.items ?? []) {
        if (typeof c.id === "string") {
          calendars.push(c as calendar_v3.Schema$CalendarListEntry & { id: string });
        }
      }
      calendarListPageToken = calendarsRes.data.nextPageToken ?? undefined;
    } while (calendarListPageToken);

    // An account always owns at least its primary calendar, so an empty list is
    // a failed read wearing the shape of an emptied account — a transient error
    // Google answered with 200, a scope narrowed by a re-consent, an account
    // still provisioning. Reconciling against it would delete every event this
    // source has ever stored, so the enumeration is not allowed to vouch for
    // anything.
    const calendarListIsPlausible = calendars.length > 0;
    if (!calendarListIsPlausible) {
      log.warn(
        "Calendar list came back empty — withholding the snapshot rather than reconciling to " +
          "an empty account. No deletions detected this cycle.",
      );
    }

    // Refresh `pendingCalendars` at the start of every fresh cycle. Calendars
    // are processed FIFO; one (calendar, page) per `sync()` call so a
    // transient API failure halfway through a busy mailbox loses at most
    // one page of work, not the entire cycle's progress.
    let pending = state.pendingCalendars ? [...state.pendingCalendars] : null;
    let cycleProcessed = state.processedThisCycle ?? 0;
    if (pending === null) {
      const refreshAt = new Date(window.windowRefreshAfter).getTime();
      if (expandsOccurrences && Number.isFinite(refreshAt) && refreshAt <= Date.now()) {
        // A sync token is scoped to the bootstrap query's fixed bounds.
        // Periodically abandon that generation so the future edge advances.
        for (const id of Object.keys(calendarSyncTokens)) delete calendarSyncTokens[id];
        window = this.newWindow();
        snapshotPresentIds = [];
        log.info(`Calendar occurrence window rolled through ${window.windowEnd}`);
      }
      if (expandsOccurrences && Object.keys(calendarSyncTokens).length === 0) {
        snapshotPresentIds ??= [];
      }
      pending = calendars.map((c) => c.id);
      cycleProcessed = 0;
      log.debug(`Sync cycle start: ${pending.length} calendars to process`);
    }

    // Drop calendar IDs no longer in the calendar list (deleted between cycles).
    //
    // A calendar dropped here was queued for this cycle and never walked, so
    // the accumulated enumeration holds none of its events. Whether it was
    // deleted or merely missing from one listing is not knowable from here, and
    // the two differ by that calendar's entire contents — so the drop
    // suppresses the snapshot for the rest of the cycle. The next cycle queues
    // whatever the list then contains and reconciles normally, which is how a
    // genuine deletion still lands.
    const liveIds = new Set(calendars.map((c) => c.id));
    const droppedCalendars = pending.filter((id) => !liveIds.has(id));
    pending = pending.filter((id) => liveIds.has(id));
    let snapshotIncomplete = state.snapshotIncomplete ?? false;
    if (droppedCalendars.length > 0) {
      snapshotIncomplete = true;
      log.warn(
        `${droppedCalendars.length} calendar(s) left the calendar list mid-cycle ` +
          `(${droppedCalendars.join(", ")}) — withholding the occurrence snapshot, since the ` +
          `enumeration holds none of their events.`,
      );
    }
    // All-or-nothing, where the Outlook calendar narrows the same assertion to
    // the calendars it could read. What this source vouches for is the
    // `google_calendar_events` table, not the document corpus — the documents
    // are removed by the delta stream's own cancellation tombstones and are
    // never snapshot-reconciled. Analytics rows have no per-partition form:
    // `presentIds` is whole-table, and the absence ledger behind it records no
    // partition per row. So a calendar that leaves the list mid-cycle withholds
    // the whole table's reconcile until the next clean cycle, and narrowing it
    // is a change to the analytics contract rather than to this source.
    const mayVouch = calendarListIsPlausible && !snapshotIncomplete;
    const assessment = new SnapshotEnumeration(["calendars"]);
    if (!calendarListIsPlausible)
      assessment.gap("calendars", "Google returned an empty calendar list");
    else if (snapshotIncomplete)
      // Two conditions carry `snapshotIncomplete` into this page: a calendar
      // that left the list before its events were read, and a cycle that has
      // simply not finished walking. Only the first is a disappearance, and
      // telling the operator to restore access for the second sends them
      // looking for a fault that is not there.
      assessment.gap(
        "calendars",
        droppedCalendars.length > 0
          ? "a calendar left the calendar list before its events were read"
          : "an earlier page of this cycle could not account for every calendar",
      );
    else assessment.cover("calendars", []);
    const issue = assessment.withheldIssue();
    // A completed cycle states its verdict either way; only a page that has not
    // finished reassessing leaves it unsaid. Withholding the verdict from a
    // clean complete cycle is how a warning outlives its cause: an incremental
    // tick accumulates no occurrence ids, so it had nothing to vouch with and
    // said nothing at all, and the gateway kept a `snapshot-withheld` from a
    // cycle long finished with no way for the operator to clear it.
    const verdict = issue ? [issue] : [];
    const issues = snapshotPresentIds !== undefined || !mayVouch ? verdict : undefined;

    if (pending.length === 0) {
      log.debug("Sync cycle complete");
      return {
        documents: [],
        records: [],
        deletedExternalIds: [],
        deletedIds: [],
        ...(snapshotPresentIds && mayVouch
          ? { presentIds: [...new Set(snapshotPresentIds)].sort() }
          : {}),
        cursor: {
          calendarSyncTokens,
          occurrenceExpansion: expandsOccurrences,
          ...(expandsOccurrences ? window : {}),
        } satisfies CalendarSyncCursor,
        hasMore: false,
        // The cycle is over, so the assessment above is its final word and is
        // stated either way. Leaving it unsaid keeps a withheld-snapshot
        // warning raised by an earlier cycle alive after its cause is gone:
        // the operator goes on being told a calendar could not be enumerated
        // long after every calendar was read, and nothing they can do clears
        // it. An incremental cycle with no occurrences to vouch for is the
        // ordinary case that hit this.
        issues: issue ? [issue] : [],
      };
    }

    const calendarId = pending[0];
    const cal = calendars.find((c) => c.id === calendarId)!;
    const existingSyncToken = calendarSyncTokens[calendarId];
    const resumePageToken = state.resumePageToken;
    const documents: DocumentInput[] = [];
    const records: Record<string, unknown>[] = [];
    const deletedExternalIds: string[] = [];
    const deletedIds: string[] = [];

    log.debug(
      `Calendar "${cal.summary}": ${
        resumePageToken
          ? "resume (pageToken)"
          : existingSyncToken
            ? "incremental (syncToken)"
            : "bootstrap"
      }`,
    );

    try {
      // Expand recurring series into concrete occurrences/exceptions. Google
      // returns stable event ids for those instances, so each projected row is
      // a real interval rather than a series master pinned to its first start.
      const params: calendar_v3.Params$Resource$Events$List = {
        calendarId,
        maxResults: CALENDAR_MAX_RESULTS,
        showDeleted: true,
        ...(expandsOccurrences ? { singleEvents: true } : {}),
      };

      if (resumePageToken) {
        // Mid-paginate resume — `pageToken` carries the original syncToken
        // or timeMin context server-side, so we don't re-send those.
        params.pageToken = resumePageToken;
      } else if (existingSyncToken) {
        // Incremental sync — syncToken is mutually exclusive with timeMin
        // per the Google API contract; the cutoff filter below catches any
        // pre-cutoff events that come back through the delta stream.
        params.syncToken = existingSyncToken;
      } else if (expandsOccurrences) {
        // Occurrence expansion must be bounded. The token preserves these
        // bounds; `windowRefreshAfter` periodically starts a new generation.
        params.timeMin = window.windowStart;
        params.timeMax = window.windowEnd;
      } else if (this.dataCutoff) {
        // Preserve the pre-expansion bootstrap contract for a legacy token
        // generation. This path intentionally emits no full snapshot.
        params.timeMin = this.dataCutoff.toISOString();
      } else {
        const oneYearAgo = new Date();
        oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - WINDOW_PAST_YEARS);
        params.timeMin = oneYearAgo.toISOString();
      }

      const res = await this.calendar.events.list(params);
      const events = res.data.items ?? [];

      let droppedByCutoff = 0;
      for (const event of events) {
        if (!event.id) continue;
        if (event.status === "cancelled") {
          log.debug(`Cancelled event: ${calendarId}:${event.id}`);
          const id = `${calendarId}:${event.id}`;
          deletedExternalIds.push(id);
          deletedIds.push(id);
          continue;
        }
        // Cutoff is about event relevance (when it occurs), not when it was
        // created. A weekly series created years ago still matters if it keeps
        // recurring, and an old-but-future single event is still upcoming.
        // Filtering on creation time would silently drop both. A legacy token
        // generation can still return series masters, so those remain
        // conservatively eligible; expanded generations return concrete
        // occurrences whose end can be compared directly.
        if (!this.occursAfterCutoff(event)) {
          droppedByCutoff++;
          continue;
        }
        const doc = this.normalizeEvent(event, cal);
        if (doc) documents.push(doc);
        const row = this.eventToRow(event, cal);
        if (row) {
          records.push(row);
          snapshotPresentIds?.push(String(row.id));
        }
      }
      if (droppedByCutoff > 0) {
        log.info(`Filtered ${droppedByCutoff} events older than cutoff, kept ${documents.length}`);
      }

      const nextPageToken = res.data.nextPageToken ?? undefined;
      let nextResumePageToken = resumePageToken;
      let nextPending = pending;

      if (nextPageToken) {
        // More pages of the same calendar — keep it at the front and resume
        // from `nextPageToken` on the next sync() call.
        nextResumePageToken = nextPageToken;
        log.debug(`More pages remain for "${cal.summary}"; will resume`);
      } else {
        // Calendar fully drained for this cycle.
        if (res.data.nextSyncToken) {
          calendarSyncTokens[calendarId] = res.data.nextSyncToken;
          log.debug(`Captured syncToken for "${cal.summary}"`);
        } else {
          log.debug(`No nextSyncToken returned for "${cal.summary}"`);
        }
        nextResumePageToken = undefined;
        nextPending = pending.slice(1);
      }

      const cycleComplete = nextPending.length === 0 && !nextResumePageToken;
      const newCycleProcessed = cycleProcessed + documents.length;

      log.info(
        `Calendar "${cal.summary}" page: ${documents.length} docs, -${deletedExternalIds.length} (${nextPending.length} calendars left, resume: ${!!nextResumePageToken})`,
      );

      return {
        documents,
        records,
        deletedExternalIds,
        deletedIds,
        ...(cycleComplete && snapshotPresentIds && mayVouch
          ? { presentIds: [...new Set(snapshotPresentIds)].sort() }
          : {}),
        cursor: {
          calendarSyncTokens,
          pendingCalendars: cycleComplete ? undefined : nextPending,
          resumePageToken: nextResumePageToken,
          processedThisCycle: cycleComplete ? undefined : newCycleProcessed,
          // Carried while the cycle runs, cleared when it ends: the next cycle
          // re-queues from a fresh calendar list and starts its own accounting.
          ...(!cycleComplete && snapshotIncomplete ? { snapshotIncomplete: true } : {}),
          occurrenceExpansion: expandsOccurrences,
          ...(expandsOccurrences ? window : {}),
          ...(!cycleComplete && snapshotPresentIds
            ? { snapshotPresentIds: [...new Set(snapshotPresentIds)] }
            : {}),
        } satisfies CalendarSyncCursor,
        hasMore: !cycleComplete,
        // Only a finished cycle has a verdict to give. A page in the middle of
        // a multi-calendar walk is withholding by construction — the walk has
        // not reached the rest yet — and publishing that as an issue raises
        // "deletion detection is incomplete" on every routine sync, then
        // retracts it seconds later. The operator sees a fault that is really
        // just work in progress.
        issues: cycleComplete ? verdict : undefined,
        progress: {
          phase: existingSyncToken && !resumePageToken ? "incremental" : "bootstrap",
          processed: newCycleProcessed,
        },
      };
    } catch (error: unknown) {
      // syncToken expired — drop the calendar's stored token so the next
      // cycle picks it up as a bootstrap. Skip past it for now.
      if ((error as { code?: number } | undefined)?.code === 410) {
        log.warn(`Sync token expired for calendar "${cal.summary}", will re-bootstrap`);
        delete calendarSyncTokens[calendarId];
        const nextPending = pending.slice(1);
        const cycleComplete = nextPending.length === 0;
        return {
          documents: [],
          records: [],
          deletedExternalIds: [],
          deletedIds: [],
          cursor: {
            calendarSyncTokens,
            pendingCalendars: cycleComplete ? undefined : nextPending,
            resumePageToken: undefined,
            processedThisCycle: cycleComplete ? undefined : cycleProcessed,
            occurrenceExpansion: expandsOccurrences,
            ...(!cycleComplete && expandsOccurrences ? { snapshotIncomplete: true } : {}),
            ...(expandsOccurrences ? window : {}),
            // A failed calendar makes this generation incomplete. Do not
            // reconcile from a partial snapshot; the next periodic window
            // roll will attempt a fresh complete generation.
          } satisfies CalendarSyncCursor,
          hasMore: !cycleComplete,
          issues: !cycleComplete
            ? undefined
            : expandsOccurrences
              ? [
                  new SnapshotEnumeration(["calendars"])
                    .gap("calendars", "a calendar sync token expired before enumeration completed")
                    .withheldIssue()!,
                ]
              : [],
        };
      }
      throw mapGoogleApiError(error);
    }
  }

  /**
   * Whether an event is still relevant under the configured `dataCutoff`.
   *
   * The cutoff bounds an event by *when it occurs*, not when it was created.
   * Returns true (keep) when no cutoff is set. Recurring masters are always
   * kept — without expanding the RRULE we can't prove their last occurrence
   * predates the cutoff, and the server-side `timeMin` already excludes series
   * with no occurrence in-window. Single events are kept when their occurrence
   * ends at/after the cutoff (falling back to start, then to the raw value when
   * neither is parseable).
   */
  private occursAfterCutoff(event: calendar_v3.Schema$Event): boolean {
    if (!this.dataCutoff) return true;
    if (event.recurrence && event.recurrence.length > 0) return true;
    const occurrence =
      event.end?.dateTime ?? event.end?.date ?? event.start?.dateTime ?? event.start?.date;
    if (!occurrence) return true;
    const occurrenceMs = new Date(occurrence).getTime();
    if (Number.isNaN(occurrenceMs)) return true;
    return occurrenceMs >= this.dataCutoff.getTime();
  }

  private normalizeEvent(
    event: calendar_v3.Schema$Event,
    calendar: calendar_v3.Schema$CalendarListEntry,
  ): DocumentInput | null {
    if (!event.id) return null;

    const start = event.start?.dateTime ?? event.start?.date ?? "";
    const end = event.end?.dateTime ?? event.end?.date ?? "";
    const attendees = (event.attendees ?? [])
      .map((a) => a.displayName ?? a.email ?? "")
      .filter(Boolean);

    // Format recurrence rules (e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"])
    const recurrence = event.recurrence?.join(", ");

    const content = [
      `# ${event.summary ?? "(no title)"}`,
      "",
      `**Calendar:** ${calendar.summary ?? ""}`,
      `**When:** ${start} → ${end}`,
      recurrence ? `**Recurrence:** ${recurrence}` : "",
      event.location ? `**Location:** ${event.location}` : "",
      attendees.length > 0 ? `**Attendees:** ${attendees.join(", ")}` : "",
      event.conferenceData?.entryPoints?.[0]?.uri
        ? `**Meeting link:** ${event.conferenceData.entryPoints[0].uri}`
        : "",
      "",
      event.description ? "---\n\n" + event.description : "",
    ]
      .filter(Boolean)
      .join("\n");

    const contentHash = computeContentHash(content);

    const sourceDate = event.created
      ? new Date(event.created).toISOString()
      : new Date().toISOString();
    const updatedDate = event.updated ? new Date(event.updated).toISOString() : sourceDate;

    // Build people array
    const people: PersonMention[] = [];
    const seenEmails = new Set<string>();

    if (event.organizer?.email) {
      seenEmails.add(event.organizer.email.toLowerCase());
      people.push({
        role: "author",
        name: event.organizer.displayName ?? undefined,
        emails: [event.organizer.email],
      });
    }

    for (const attendee of event.attendees ?? []) {
      if (!attendee.email) continue;
      const emailLower = attendee.email.toLowerCase();
      if (seenEmails.has(emailLower)) continue;
      seenEmails.add(emailLower);
      people.push({
        role: "attendee",
        name: attendee.displayName ?? undefined,
        emails: [attendee.email],
      });
    }

    // Extract emails/phones from description
    if (event.description) {
      const descEmails = extractEmailsFromText(event.description);
      for (const email of descEmails) {
        if (seenEmails.has(email.toLowerCase())) continue;
        seenEmails.add(email.toLowerCase());
        people.push({ role: "mentioned", emails: [email] });
      }
      const descPhones = extractPhonesFromText(event.description);
      for (const phone of descPhones) {
        people.push({ role: "mentioned", phones: [phone], allowPersonCreation: false });
      }
    }

    return {
      providerId: this.providerId,
      sourceId: this.id,
      externalId: `${calendar.id}:${event.id}`,
      title: event.summary ?? "(no title)",
      content,
      contentHash,
      metadata: {
        sourceUrl: event.htmlLink ?? undefined,
        appUrl: googleCalendarAppUrl(event.htmlLink),
        documentType: "event",
        people,
        tags: [],
        extra: {
          calendarId: calendar.id,
          calendarName: calendar.summary,
          location: event.location,
          status: event.status,
          start,
          end,
          // RFC 5545 UID from the Google Calendar API. The standard
          // identifier shared by every system that exposes this event
          // (including ICS attachments delivered by email). Stored so the
          // link extractor can resolve `calendar-event` cross-source links
          // from email-attached invites
          iCalUID: event.iCalUID ?? undefined,
        },
      },
      sourceCreatedAt: sourceDate,
      sourceUpdatedAt: updatedDate,
    };
  }

  /**
   * Build the `google_calendar_events` row for an event — the structured twin
   * of `normalizeEvent`, keyed on the same `calendarId:eventId` so the doc↔row
   * `same-entity` edge is 1:1. Derives the analytical columns the
   * document body can't aggregate: duration, attendee count, self RSVP.
   * Returns null for an event with no id (no stable key).
   */
  private eventToRow(
    event: calendar_v3.Schema$Event,
    calendar: calendar_v3.Schema$CalendarListEntry,
  ): Record<string, unknown> | null {
    if (!event.id) return null;

    // All-day events carry `date` (no `dateTime`); timed events carry `dateTime`.
    const allDay = !event.start?.dateTime && !!event.start?.date;
    const startRaw = event.start?.dateTime ?? event.start?.date ?? null;
    const endRaw = event.end?.dateTime ?? event.end?.date ?? null;

    // Duration only makes sense for timed events with both ends parseable;
    // all-day and open-ended events leave it null.
    let durationMinutes: number | null = null;
    if (!allDay && event.start?.dateTime && event.end?.dateTime) {
      const startMs = new Date(event.start.dateTime).getTime();
      const endMs = new Date(event.end.dateTime).getTime();
      if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs) {
        durationMinutes = (endMs - startMs) / 60000;
      }
    }

    // Distinct attendees by lowercased email.
    const attendeeEmails = new Set<string>();
    for (const a of event.attendees ?? []) {
      if (a.email) attendeeEmails.add(a.email.toLowerCase());
    }
    const attendeeCount = attendeeEmails.size > 0 ? attendeeEmails.size : null;

    // The viewer's own RSVP — the attendee flagged `self`. Organizer-only
    // events have no attendee row, so it stays null.
    const selfResponse = (event.attendees ?? []).find((a) => a.self)?.responseStatus ?? null;

    return {
      id: `${calendar.id}:${event.id}`,
      source_account: this.accountId,
      calendar_id: calendar.id ?? null,
      calendar_name: calendar.summary ?? null,
      event_id: event.id,
      ical_uid: event.iCalUID ?? null,
      title: event.summary ?? null,
      start_time: startRaw,
      end_time: endRaw,
      duration_minutes: durationMinutes,
      all_day: allDay,
      recurring: (event.recurrence?.length ?? 0) > 0 || !!event.recurringEventId,
      temporal_projection_eligible: (event.recurrence?.length ?? 0) === 0,
      organizer_email: event.organizer?.email ?? null,
      attendee_count: attendeeCount,
      response_status: selfResponse,
      location: event.location ?? null,
      status: event.status ?? null,
    };
  }
}
