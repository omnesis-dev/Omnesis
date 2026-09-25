// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import Database from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { CALENDAR_UPDATE_OVERRIDE, calendarIdFor } from "@omnesis/provider-outlook-synth";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { getDocumentCount, getJson } from "./helpers.js";

/**
 * End-to-end coverage for the synthetic Outlook Calendar source — the
 * Microsoft-side sibling of Google Calendar, and a *hybrid* source: every event
 * lands as both a searchable document and an `outlook_calendar_events`
 * analytics row. The synth twin feeds canned Microsoft Graph `event` pages into
 * the REAL `OutlookCalendarSource`, so this exercises the production
 * `/me/calendars` → per-calendar `calendarView/delta` walk → normalize →
 * dual-push → gateway ingest path.
 *
 * What it proves that the unit tests cannot, because it needs a gateway: that
 * the two halves of the pair stay in lockstep through every mutation an
 * operator can make. An edit rewrites the document AND its row under the same
 * id; a cancellation retracts BOTH halves, while a series-master deletion marks
 * its stored occurrences absent on both planes; an untouched tick changes
 * nothing; and a 410 delta expiry recovers the whole calendar without
 * duplicating it. The fixture spreads its events over two calendars, so every
 * phase also covers the queue that visits them: a change on one must not
 * disturb the other, and the snapshot that reconciles deletions has to span
 * both or it deletes the calendar it did not enumerate.
 *
 * The twin honors four env switches that mutate the synthetic calendar between
 * sync ticks against one running gateway:
 *   OMNESIS_OUTLOOK_CALENDAR_SYNTH_UPDATE=<id>        — edits that event
 *   OMNESIS_OUTLOOK_CALENDAR_SYNTH_CANCEL=<id>        — marks it isCancelled
 *   OMNESIS_OUTLOOK_CALENDAR_SYNTH_REMOVE=<id>        — @removed tombstone
 *   OMNESIS_OUTLOOK_CALENDAR_SYNTH_EXPIRE_DELTA=1     — next deltaLink 410s
 *
 * Tests run in declared order (vitest is sequential within a file), each phase
 * building on the prior gateway state.
 */

const SOURCE_ID = "outlook-calendar:john.smith@example.com";
const TABLE = "outlook_calendar_events";

// Graph event ids, which is what the synth env switches name. Those ids
// are unique within a calendar and not across them, so everything downstream —
// document externalId, analytics row id — is keyed `<calendarId>:<eventId>`.
const EVT_VENDOR = "synth-outlook-cal-001";
const EVT_REVIEW = "synth-outlook-cal-002";
const EVT_OFFSITE = "synth-outlook-cal-003";

/** The account's calendars: the default one, and the fixture's second. */
const CAL_MAIN = calendarIdFor();
const CAL_PERSONAL = calendarIdFor("Personal");

/** The key an event is stored under. */
function key(eventId: string, calendarId = CAL_MAIN): string {
  return `${calendarId}:${eventId}`;
}

const K_VENDOR = key(EVT_VENDOR);
const K_REVIEW = key(EVT_REVIEW, CAL_PERSONAL);
// The offsite entry is a weekly series: `e2e-minimal` caps a source at three
// fixture entries, so the series is one of the three rather than a fourth.
// Its master is a template and never becomes a document — only its occurrences do.
const SERIES_MASTER = EVT_OFFSITE;
const SERIES_OCCURRENCES = [
  key(`${EVT_OFFSITE}-occ-1`),
  key(`${EVT_OFFSITE}-occ-2`),
  key(`${EVT_OFFSITE}-occ-3`),
];

interface RecentDoc {
  id: string;
  externalId: string;
  title: string;
  documentType: string;
}

interface FullDoc {
  id: string;
  content: string;
  metadata: string; // JSON string
}

function clearSynthEnv(): void {
  delete process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_UPDATE;
  delete process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_CANCEL;
  delete process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_REMOVE;
  delete process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_EXPIRE_DELTA;
}

describe("Synthetic provider — Outlook Calendar (hybrid: documents + analytics rows)", () => {
  let harness: SyntheticE2EHarness;

  async function recentDocs(): Promise<RecentDoc[]> {
    const data = (await getJson(
      `${harness.gatewayUrl}/documents/recent/${encodeURIComponent(SOURCE_ID)}?limit=100`,
      harness.apiKey,
    )) as { documents: RecentDoc[] };
    return data.documents;
  }

  async function fullDoc(docId: string): Promise<FullDoc> {
    return (await getJson(
      `${harness.gatewayUrl}/documents/${encodeURIComponent(docId)}`,
      harness.apiKey,
    )) as FullDoc;
  }

  async function docByExternalId(externalId: string): Promise<FullDoc | undefined> {
    const match = (await recentDocs()).find((d) => d.externalId === externalId);
    return match ? fullDoc(match.id) : undefined;
  }

  async function sqlQuery(sql: string): Promise<{ columns: string[]; rows: unknown[][] }> {
    return (await harness.gatewayJson("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({ sql }),
    })) as { columns: string[]; rows: unknown[][] };
  }

  /** Row ids currently in the analytics table, sorted. */
  async function rowIds(): Promise<string[]> {
    const res = await sqlQuery(`SELECT id FROM ${TABLE} ORDER BY id`);
    return res.rows.map((r) => String(r[0]));
  }

  function documentAbsenceIds(): string[] {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<[string], { external_id: string }>(
          "SELECT external_id FROM document_absences WHERE source_id = ? ORDER BY external_id",
        )
        .all(SOURCE_ID)
        .map((row) => row.external_id);
    } finally {
      db.close();
    }
  }

  async function analyticsAbsenceIds(): Promise<string[]> {
    const result = await sqlQuery(
      "SELECT key_value FROM _analytics_absences " +
        `WHERE source_id = '${SOURCE_ID}' AND table_name = '${TABLE}' ORDER BY key_value`,
    );
    return result.rows.map((row) => String(row[0]));
  }

  async function searchTitles(q: string): Promise<string[]> {
    const res = (await harness.gatewayJson(
      `/documents/search?q=${encodeURIComponent(q)}&sources=${encodeURIComponent(SOURCE_ID)}&limit=20`,
    )) as { results?: Array<{ title: string }> };
    return (res.results ?? []).map((d) => d.title);
  }

  beforeAll(async () => {
    clearSynthEnv();
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.triggerSyncAndWait(SOURCE_ID, 60000);
    await harness.refreshSearchSnapshot();
  }, 240000);

  afterAll(async () => {
    clearSynthEnv();
    await harness.destroy();
  }, 15000);

  test("bootstrap ingests every fixture event as a document and an analytics row", async () => {
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(5);

    const docs = await recentDocs();
    // Two one-off events plus three occurrences of the weekly series. The
    // series MASTER is deliberately absent: `calendarView` expands the series,
    // so emitting the master too would duplicate an occurrence.
    expect(docs.map((d) => d.externalId).sort()).toEqual(
      [K_VENDOR, K_REVIEW, ...SERIES_OCCURRENCES].sort(),
    );
    expect(docs.every((d) => d.documentType === "event")).toBe(true);

    // The hybrid contract: one row per document, under the same key.
    expect(await rowIds()).toEqual([K_VENDOR, K_REVIEW, ...SERIES_OCCURRENCES].sort());
  });

  test("a source resync atomically wipes and fully rebuilds every hybrid store", async () => {
    const expectedIds = [K_VENDOR, K_REVIEW, ...SERIES_OCCURRENCES].sort();
    const projectionIds = async (): Promise<string[]> => {
      const result = await sqlQuery(
        `SELECT bound_document_external_id FROM _temporal_projections
         WHERE source_id = '${SOURCE_ID}' ORDER BY bound_document_external_id`,
      );
      return result.rows.map((row) => String(row[0]));
    };

    expect(await projectionIds()).toEqual(expectedIds);
    const reset = await harness.gatewayJson<{ ok: boolean; scope: string; deviceIds: string[] }>(
      `/admin/sources/${encodeURIComponent(SOURCE_ID)}/resync`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(reset).toEqual({
      ok: true,
      scope: "source",
      deviceIds: [],
      restarting: [],
      disabled: [],
      skipped: [],
    });
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(0);
    expect(await projectionIds()).toEqual([]);
    const emptyCatalog = (await harness.gatewayJson("/analytics/catalog")) as {
      tables: Array<{ tableName: string }>;
    };
    expect(emptyCatalog.tables.some((table) => table.tableName === TABLE)).toBe(false);

    await harness.triggerSyncAndWait(SOURCE_ID, 60_000);

    expect((await recentDocs()).map((doc) => doc.externalId).sort()).toEqual(expectedIds);
    expect(await rowIds()).toEqual(expectedIds);
    expect(await projectionIds()).toEqual(expectedIds);
    const state = await harness.getSyncState(SOURCE_ID);
    const cursor = state!.cursor as { calendarLinks?: Record<string, string> };
    expect(Object.keys(cursor.calendarLinks ?? {}).sort()).toEqual([CAL_MAIN, CAL_PERSONAL].sort());
  }, 120_000);

  test("each calendar's events are ingested and stamped with the calendar they came from", async () => {
    // `/me/calendarView` covers only the default calendar, so a second one is
    // reachable solely through its own `/me/calendars/{id}/calendarView`. If
    // the queue skipped it, its events would simply be missing here.
    const res = await sqlQuery(
      `SELECT id, calendar_id, calendar_name, event_id FROM ${TABLE} ORDER BY id`,
    );
    const byId = new Map(res.rows.map((r) => [String(r[0]), r]));

    expect(byId.get(K_VENDOR)?.[1]).toBe(CAL_MAIN);
    expect(byId.get(K_VENDOR)?.[2]).toBe("Calendar");
    expect(byId.get(K_REVIEW)?.[1]).toBe(CAL_PERSONAL);
    expect(byId.get(K_REVIEW)?.[2]).toBe("Personal");
    // The bare Graph id is kept alongside the namespaced key, so a deep link or
    // a support question can still be traced back to the event Graph knows.
    expect(byId.get(K_REVIEW)?.[3]).toBe(EVT_REVIEW);
    // Occurrences reach their row through the hydration path, which has to
    // carry the calendar too — it is the only path that reads an event the
    // enumeration did not fully describe.
    for (const occurrence of SERIES_OCCURRENCES) {
      expect(byId.get(occurrence)?.[1]).toBe(CAL_MAIN);
      expect(byId.get(occurrence)?.[2]).toBe("Calendar");
    }
  });

  test("events are searchable by their body, not just their subject", async () => {
    // A contiguous run from the fixture body — /documents/search is a substring
    // LIKE over `content`, so this proves the body was indexed.
    expect(await searchTitles("hotel block dates")).toContain("Offsite planning");
  });

  test("per-event metadata: webLink, time window, location, iCalUID, attendees", async () => {
    const doc = await docByExternalId(K_VENDOR);
    expect(doc).toBeDefined();
    const metadata = JSON.parse(doc!.metadata) as {
      documentType: string;
      sourceUrl?: string;
      tags?: string[];
      people?: Array<{ role: string; emails?: string[] }>;
      extra?: {
        location?: string;
        start?: string;
        end?: string;
        iCalUID?: string;
        status?: string;
      };
    };

    expect(metadata.documentType).toBe("event");
    expect(metadata.sourceUrl).toContain(`itemid=${EVT_VENDOR}`);
    expect(metadata.extra?.location).toBe("Mercury room");
    expect(metadata.extra?.start).toBe("2025-09-03T17:00:00.000Z");
    expect(metadata.extra?.end).toBe("2025-09-03T18:00:00.000Z");
    expect(metadata.extra?.status).toBe("confirmed");
    // The RFC 5545 UID is what lets an email-attached invite link to this event.
    expect(metadata.extra?.iCalUID).toBe("synth-ocal-uid-001");
    expect(metadata.tags).toEqual(["Vendors"]);
    // Organizer + attendees both reach the people graph.
    expect((metadata.people ?? []).some((p) => p.role === "author")).toBe(true);
    expect((metadata.people ?? []).some((p) => p.role === "attendee")).toBe(true);
  });

  test("the analytics row carries the columns the document body cannot aggregate", async () => {
    const res = await sqlQuery(
      `SELECT duration_minutes, attendee_count, all_day, recurring, status, organizer_email
       FROM ${TABLE} WHERE id = '${K_VENDOR}'`,
    );
    expect(res.rows).toHaveLength(1);
    const [duration, attendees, allDay, recurring, status, organizer] = res.rows[0]!;
    expect(Number(duration)).toBe(60);
    // Three distinct invitees, deduped by address.
    expect(Number(attendees)).toBe(3);
    expect(allDay).toBe(false);
    expect(recurring).toBe(false);
    expect(status).toBe("confirmed");
    expect(String(organizer)).toContain("@");
  });

  test("an unchanged incremental re-sync is idempotent — no duplicates, no drops", async () => {
    clearSynthEnv();
    await harness.triggerSyncAndWait(SOURCE_ID, 60000);

    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(5);
    expect(await rowIds()).toEqual([K_VENDOR, K_REVIEW, ...SERIES_OCCURRENCES].sort());

    // Both calendars have drained, so each holds its own delta link and the
    // next tick asks each of them for changes rather than re-enumerating.
    const state = await harness.getSyncState(SOURCE_ID);
    const cursor = state!.cursor as { calendarLinks?: Record<string, string> };
    expect(Object.keys(cursor.calendarLinks ?? {}).sort()).toEqual([CAL_MAIN, CAL_PERSONAL].sort());
  }, 120000);

  test("an edited event rewrites BOTH halves in place, under the same id", async () => {
    // Inherited: all five documents present, none yet mutated.
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(5);

    process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_UPDATE = EVT_VENDOR;
    try {
      await harness.triggerSyncAndWait(SOURCE_ID, 60000);
    } finally {
      clearSynthEnv();
    }
    await harness.refreshSearchSnapshot();

    // Same id, no new document — an edit must not fork the event in two.
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(5);

    const doc = await docByExternalId(K_VENDOR);
    expect(doc).toBeDefined();
    expect(doc!.content).toContain(CALENDAR_UPDATE_OVERRIDE.subject);
    expect(doc!.content).toContain(CALENDAR_UPDATE_OVERRIDE.body);
    const metadata = JSON.parse(doc!.metadata) as { extra?: { location?: string; start?: string } };
    expect(metadata.extra?.location).toBe(CALENDAR_UPDATE_OVERRIDE.location);

    // The row moved with it — a stale row here is the divergence this guards.
    // Compare the instant, not its rendering: DuckDB serializes a TIMESTAMP in
    // the gateway host's local zone, so a substring match on the wall clock
    // would pass or fail by machine.
    const res = await sqlQuery(
      `SELECT title, location, epoch_ms(start_time) FROM ${TABLE} WHERE id = '${K_VENDOR}'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]![0]).toBe(CALENDAR_UPDATE_OVERRIDE.subject);
    expect(res.rows[0]![1]).toBe(CALENDAR_UPDATE_OVERRIDE.location);
    expect(Number(res.rows[0]![2])).toBe(Date.parse(CALENDAR_UPDATE_OVERRIDE.startTime));
  }, 120000);

  test("a cancelled event retracts both the document and the row", async () => {
    // Inherited: five documents, the vendor sync edited by the prior phase.
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(5);

    process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_UPDATE = EVT_VENDOR; // keep the edit live
    process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_CANCEL = EVT_REVIEW;
    try {
      await harness.triggerSyncAndWait(SOURCE_ID, 60000);
    } finally {
      clearSynthEnv();
    }

    // The cancelled event lives on the second calendar, so this also proves the
    // incremental tick reached it — and that the default calendar's four
    // documents were left alone.
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(4);
    expect((await recentDocs()).map((d) => d.externalId)).not.toContain(K_REVIEW);
    expect(await rowIds()).toEqual([K_VENDOR, ...SERIES_OCCURRENCES].sort());
  }, 120000);

  test("a removed series marks its stored occurrences absent on both planes", async () => {
    // Inherited: the review event was cancelled away by the prior phase.
    expect(await rowIds()).toEqual([K_VENDOR, ...SERIES_OCCURRENCES].sort());

    process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_UPDATE = EVT_VENDOR;
    process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_CANCEL = EVT_REVIEW;
    process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_REMOVE = EVT_OFFSITE;
    try {
      await harness.triggerSyncAndWait(SOURCE_ID, 60000);
    } finally {
      clearSynthEnv();
    }

    // Graph announces a deleted series by tombstoning its MASTER alone and says
    // nothing about the occurrences. The master is not stored, so the tombstone
    // itself removes nothing. The re-enumeration's whole-source snapshot marks
    // the three now-missing occurrences absent; the post-boot grace deliberately
    // keeps them queryable until that evidence can mature.
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(4);
    expect((await recentDocs()).map((d) => d.externalId).sort()).toEqual(
      [K_VENDOR, ...SERIES_OCCURRENCES].sort(),
    );
    expect(await rowIds()).toEqual([K_VENDOR, ...SERIES_OCCURRENCES].sort());
    expect(documentAbsenceIds()).toEqual([...SERIES_OCCURRENCES].sort());
    expect(await analyticsAbsenceIds()).toEqual([...SERIES_OCCURRENCES].sort());
  }, 120000);

  test("an expired delta token (410) re-bootstraps the calendar without duplicating it", async () => {
    // The re-bootstrap restores the explicitly cancelled event and re-observes
    // the series occurrences, revoking their pending absences on both planes.
    // Assert the inherited state so this phase cannot pass vacuously alone.
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(4);
    expect(await rowIds()).toEqual([K_VENDOR, ...SERIES_OCCURRENCES].sort());
    expect(documentAbsenceIds()).toEqual([...SERIES_OCCURRENCES].sort());
    expect(await analyticsAbsenceIds()).toEqual([...SERIES_OCCURRENCES].sort());

    // Every switch is now clear, so the synthetic calendar is back to its full
    // three events. The 410 forces a fresh bounded enumeration, which must land
    // on exactly three — not six. The source answers the 410 with an empty page
    // and `hasMore`, so the collector drains the re-enumeration inside this one
    // sync cycle.
    process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_EXPIRE_DELTA = "1";
    try {
      await harness.triggerSyncAndWait(SOURCE_ID, 90000);
    } finally {
      clearSynthEnv();
    }
    await harness.refreshSearchSnapshot();

    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(5);
    expect((await recentDocs()).map((d) => d.externalId).sort()).toEqual(
      [K_VENDOR, K_REVIEW, ...SERIES_OCCURRENCES].sort(),
    );
    expect(await rowIds()).toEqual([K_VENDOR, K_REVIEW, ...SERIES_OCCURRENCES].sort());
    expect(documentAbsenceIds()).toEqual([]);
    expect(await analyticsAbsenceIds()).toEqual([]);

    // Recovery leaves every calendar back on its incremental stream.
    const state = await harness.getSyncState(SOURCE_ID);
    const cursor = state!.cursor as { calendarLinks?: Record<string, string> };
    expect(Object.keys(cursor.calendarLinks ?? {}).sort()).toEqual([CAL_MAIN, CAL_PERSONAL].sort());
  }, 180000);

  test("a recurring occurrence carries its series' details, and the master is not a document", async () => {
    const docs = await recentDocs();
    const occ = docs.find((d) => d.externalId === SERIES_OCCURRENCES[0]);
    expect(occ, "the first occurrence should be indexed").toBeDefined();

    // The synth twin serves occurrences the way Graph does: id, times, and a
    // seriesMasterId. Everything below had to come from the master.
    expect(occ!.title).toBe("Offsite planning");

    const full = await fullDoc(occ!.id);
    const metadata = JSON.parse(full.metadata) as {
      extra?: { location?: string; seriesMasterId?: string; iCalUID?: string };
      people?: Array<{ role: string }>;
    };
    expect(metadata.extra?.location).toBe("Online");
    expect(metadata.extra?.seriesMasterId).toBe(SERIES_MASTER);
    expect(metadata.extra?.iCalUID).toBe("synth-ocal-uid-003");
    expect((metadata.people ?? []).some((p) => p.role === "attendee")).toBe(true);
    expect(full.content).toContain("Lock the agenda for the September offsite");

    // Each occurrence keeps its own slot — a week apart, not the master's.
    const starts = await sqlQuery(
      `SELECT epoch_ms(start_time) FROM ${TABLE} WHERE id LIKE '${key(SERIES_MASTER)}-occ-%' ORDER BY start_time`,
    );
    const ms = starts.rows.map((r) => Number(r[0]));
    expect(ms).toHaveLength(3);
    expect(ms[1]! - ms[0]!).toBe(7 * 24 * 60 * 60 * 1000);
    expect(ms[2]! - ms[1]!).toBe(7 * 24 * 60 * 60 * 1000);

    // The master itself is a template, not an event.
    expect(docs.map((d) => d.externalId)).not.toContain(key(SERIES_MASTER));
    expect(await rowIds()).not.toContain(key(SERIES_MASTER));

    // And an occurrence is reachable by the body it inherited.
    await harness.refreshSearchSnapshot();
    expect(await searchTitles("Confirm hotel block dates")).toContain("Offsite planning");
  }, 120000);
});
