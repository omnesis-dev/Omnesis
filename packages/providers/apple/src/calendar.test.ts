// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { setDefaultPhoneRegion } from "@omnesis/core";
import { rowsFor, tablesWritten, writesFor } from "@omnesis/source-sdk/testing";
type Db = Database.Database;
import { SourceId, ProviderId } from "@omnesis/types";
import { AppleProvider } from "./provider.js";
import { AppleCalendarSource } from "./calendar.js";
import { appleCalendarDocumentProfile } from "./document-profiles.js";
import { validateAppleCalendarSyncCursor } from "./types.js";
import { coreDataToISO } from "./epoch.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Core Data timestamps (seconds since 2001-01-01 UTC)
const TS_2024_03_08 = 731548800; // 2024-03-08 00:00:00 UTC
const TS_2024_03_09 = TS_2024_03_08 + 86400;
const HOUR = 3600;
// Subscribed-feed rows carry a constant pre-2001 (negative Core Data)
// last_modified sentinel — observed verbatim on real databases.
const SENTINEL_LAST_MODIFIED = -781142400;

/**
 * Create a test SQLite database mimicking the Calendar.sqlitedb schema
 * (subset of the real columns the source reads). `Identity` has no explicit
 * ROWID column in the real schema — declared the same way here.
 */
function createTestDb(dbPath: string): Db {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE Store (
      ROWID INTEGER PRIMARY KEY,
      name TEXT,
      type INTEGER,
      disabled INTEGER
    );

    CREATE TABLE Calendar (
      ROWID INTEGER PRIMARY KEY,
      store_id INTEGER,
      title TEXT,
      self_identity_email TEXT,
      owner_identity_email TEXT,
      UUID TEXT
    );

    CREATE TABLE CalendarItem (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      summary TEXT,
      location_id INTEGER,
      description TEXT,
      start_date REAL,
      start_tz TEXT,
      end_date REAL,
      end_tz TEXT,
      all_day INTEGER DEFAULT 0,
      calendar_id INTEGER,
      orig_item_id INTEGER DEFAULT 0,
      orig_date REAL,
      organizer_id INTEGER DEFAULT 0,
      self_attendee_id INTEGER DEFAULT 0,
      status INTEGER DEFAULT 0,
      url TEXT,
      last_modified REAL,
      hidden INTEGER DEFAULT 0,
      has_recurrences INTEGER DEFAULT 0,
      has_attendees INTEGER DEFAULT 0,
      UUID TEXT,
      entity_type INTEGER DEFAULT 2,
      creation_date REAL,
      conference_url TEXT,
      conference_url_detected TEXT,
      unique_identifier TEXT,
      junk_status INTEGER DEFAULT 0,
      phantom_master INTEGER DEFAULT 0
    );

    CREATE TABLE Participant (
      ROWID INTEGER PRIMARY KEY,
      entity_type INTEGER,
      owner_id INTEGER,
      identity_id INTEGER DEFAULT 0,
      email TEXT,
      phone_number TEXT,
      is_self INTEGER DEFAULT 0,
      status INTEGER DEFAULT 0,
      role INTEGER DEFAULT 0,
      UUID TEXT
    );

    CREATE TABLE Identity (
      display_name TEXT,
      address TEXT,
      first_name TEXT,
      last_name TEXT,
      UNIQUE (display_name, address, first_name, last_name)
    );

    CREATE TABLE Recurrence (
      ROWID INTEGER PRIMARY KEY,
      owner_id INTEGER,
      frequency INTEGER,
      interval INTEGER,
      count INTEGER,
      end_date REAL,
      specifier TEXT,
      by_month_months INTEGER
    );

    CREATE TABLE Location (
      ROWID INTEGER PRIMARY KEY,
      title TEXT,
      address TEXT,
      item_owner_id INTEGER
    );
  `);

  return db;
}

function insertStore(db: Db, opts: { rowid: number; name: string; type: number }) {
  db.prepare(`INSERT INTO Store (ROWID, name, type, disabled) VALUES (?, ?, ?, 0)`).run(
    opts.rowid,
    opts.name,
    opts.type,
  );
}

function insertCalendar(db: Db, opts: { rowid: number; storeId: number; title: string }) {
  db.prepare(`INSERT INTO Calendar (ROWID, store_id, title, UUID) VALUES (?, ?, ?, ?)`).run(
    opts.rowid,
    opts.storeId,
    opts.title,
    `cal-uuid-${opts.rowid}`,
  );
}

function insertEvent(
  db: Db,
  opts: {
    pk: number;
    summary?: string | null;
    description?: string | null;
    startDate?: number | null;
    startTz?: string | null;
    endDate?: number | null;
    endTz?: string | null;
    allDay?: boolean;
    calendarId?: number;
    origItemId?: number;
    organizerId?: number;
    url?: string | null;
    conferenceUrl?: string | null;
    lastModified?: number | null;
    hidden?: boolean;
    hasRecurrences?: boolean;
    uuid?: string;
    creationDate?: number | null;
    iCalUid?: string | null;
    locationId?: number | null;
    /** Calendar's own status code: 1 confirmed, 2 tentative, 3 cancelled. */
    status?: number;
  },
) {
  db.prepare(
    `INSERT INTO CalendarItem
     (ROWID, summary, description, start_date, start_tz, end_date, end_tz, all_day,
      calendar_id, orig_item_id, organizer_id, url, conference_url, last_modified,
      hidden, has_recurrences, UUID, entity_type, creation_date, unique_identifier,
      location_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?)`,
  ).run(
    opts.pk,
    opts.summary === undefined ? `Event ${opts.pk}` : opts.summary,
    opts.description ?? null,
    opts.startDate === undefined ? TS_2024_03_08 + 10 * HOUR : opts.startDate,
    opts.startTz ?? null,
    opts.endDate === undefined ? TS_2024_03_08 + 11 * HOUR : opts.endDate,
    opts.endTz ?? null,
    opts.allDay ? 1 : 0,
    opts.calendarId ?? 1,
    opts.origItemId ?? 0,
    opts.organizerId ?? 0,
    opts.url ?? null,
    opts.conferenceUrl ?? null,
    opts.lastModified === undefined ? TS_2024_03_08 : opts.lastModified,
    opts.hidden ? 1 : 0,
    opts.hasRecurrences ? 1 : 0,
    opts.uuid ?? `event-uuid-${opts.pk}`,
    opts.creationDate === undefined ? TS_2024_03_08 : opts.creationDate,
    opts.iCalUid === undefined ? `ical-uid-${opts.pk}@example.com` : opts.iCalUid,
    opts.locationId ?? null,
    opts.status ?? 0,
  );
}

/** Insert an Identity row and return its implicit rowid. */
function insertIdentity(
  db: Db,
  opts: { displayName?: string | null; address?: string | null },
): number {
  const result = db
    .prepare(`INSERT INTO Identity (display_name, address) VALUES (?, ?)`)
    .run(opts.displayName ?? null, opts.address ?? null);
  return Number(result.lastInsertRowid);
}

/** Insert a Participant row and return its ROWID. */
function insertParticipant(
  db: Db,
  opts: {
    ownerId: number;
    email?: string | null;
    phone?: string | null;
    identityId?: number;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO Participant (owner_id, email, phone_number, identity_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run(opts.ownerId, opts.email ?? null, opts.phone ?? null, opts.identityId ?? 0);
  return Number(result.lastInsertRowid);
}

function insertRecurrence(
  db: Db,
  opts: {
    ownerId: number;
    frequency: number;
    interval?: number;
    count?: number | null;
    endDate?: number | null;
  },
) {
  db.prepare(
    `INSERT INTO Recurrence (owner_id, frequency, interval, count, end_date)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.ownerId, opts.frequency, opts.interval ?? 1, opts.count ?? null, opts.endDate ?? null);
}

function insertLocation(
  db: Db,
  opts: { rowid: number; title?: string | null; address?: string | null },
) {
  db.prepare(`INSERT INTO Location (ROWID, title, address) VALUES (?, ?, ?)`).run(
    opts.rowid,
    opts.title ?? null,
    opts.address ?? null,
  );
}

describe("AppleCalendarSource", () => {
  let tmpDir: string;
  let dbPath: string;
  let testDb: Db;
  let provider: AppleProvider;
  let source: AppleCalendarSource;

  function makeProvider(accountId: string): AppleProvider {
    return new AppleProvider({
      notesDbPath: join(tmpDir, "nonexistent-notes"),
      remindersDirPath: join(tmpDir, "nonexistent-reminders"),
      imessageDbPath: join(tmpDir, "nonexistent-imessage"),
      contactsDirPath: join(tmpDir, "nonexistent-contacts"),
      calendarDbPath: dbPath,
      callLogDbPath: join(tmpDir, "nonexistent-call-log"),
      voicemailDbPath: join(tmpDir, "nonexistent-voicemail"),
      accountId,
    });
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "apple-calendar-test-"));
    dbPath = join(tmpDir, "Calendar.sqlitedb");
    testDb = createTestDb(dbPath);

    // Default world: one iCloud store with one calendar.
    insertStore(testDb, { rowid: 1, name: "iCloud", type: 2 });
    insertCalendar(testDb, { rowid: 1, storeId: 1, title: "Personal" });

    provider = makeProvider("test@icloud.com");
    await provider.initialize();
    await provider.authenticate();
    source = new AppleCalendarSource(provider, {
      sourceId: "apple-calendar:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
  });

  afterEach(async () => {
    testDb.close();
    await provider.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("has correct id and providerId", () => {
    expect(source.id).toBe(SourceId("apple-calendar:test@icloud.com"));
    expect(source.providerId).toBe(ProviderId("apple:test@icloud.com"));
  });

  test("exposes the DB and its WAL as watchPaths", () => {
    expect(source.watchPaths).toEqual([dbPath, `${dbPath}-wal`]);
  });

  test("returns empty result when no events", async () => {
    const result = await source.sync(null);
    expect(result.documents).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  test("syncs a single event", async () => {
    insertEvent(testDb, {
      pk: 1,
      summary: "Quarterly Budget Review",
      description: "Bring the projections deck.",
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);

    const doc = result.documents[0];
    expect(doc.externalId).toBe("event-uuid-1");
    expect(doc.title).toBe("Quarterly Budget Review");
    expect(doc.content).toContain("# Quarterly Budget Review");
    expect(doc.content).toContain("**Calendar:** Personal (iCloud)");
    expect(doc.content).toContain("**When:**");
    expect(doc.content).toContain("Bring the projections deck.");
    expect(doc.metadata.documentType).toBe("event");
    expect(doc.metadata.sourceUrl).toBe("ical://ekevent/event-uuid-1");
    expect(doc.metadata.extra?.iCalUID).toBe("ical-uid-1@example.com");
    expect(doc.metadata.extra?.calendarName).toBe("Personal");
    expect(doc.sourceCreatedAt).toBe(coreDataToISO(TS_2024_03_08));
    expect(doc.sourceUpdatedAt).toBe(coreDataToISO(TS_2024_03_08));
    expect(result.hasMore).toBe(false);
  });

  test("syncStructured emits an apple_calendar_events row keyed on the UUID", async () => {
    insertEvent(testDb, { pk: 1, summary: "Quarterly Budget Review" });

    const result = await source.syncStructured(null);
    expect(tablesWritten(result)).toEqual(["apple_calendar_events"]);
    const records = rowsFor(result, "apple_calendar_events");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "event-uuid-1",
      ical_uid: "ical-uid-1@example.com",
      title: "Quarterly Budget Review",
      duration_minutes: 60,
      all_day: false,
      recurring: false,
      temporal_projection_eligible: true,
      response_status: null,
    });
    // The row id equals the co-emitted document's externalId (the boundDocument edge).
    expect(records[0].id).toBe(result.documents?.[0]?.externalId);
    expect(writesFor(result, "apple_calendar_events")[0]?.presentIds).toEqual(["event-uuid-1"]);
    expect(source.analyticsSchemas[0].temporalProjection?.eligibility).toBe(
      "temporal_projection_eligible",
    );
  });

  test("suppresses unexpanded recurring masters but permits detached occurrences", async () => {
    insertEvent(testDb, { pk: 1, hasRecurrences: true });
    insertRecurrence(testDb, { ownerId: 1, frequency: 2 });
    insertEvent(testDb, { pk: 2, origItemId: 1 });

    const result = await source.syncStructured(null);
    const records = rowsFor(result, "apple_calendar_events");
    const master = records.find((row) => row.id === "event-uuid-1");
    const detached = records.find((row) => row.id === "event-uuid-2");
    expect(master?.temporal_projection_eligible).toBe(false);
    expect(detached?.temporal_projection_eligible).toBe(true);
  });

  test("all-day event row: all_day true, duration null", async () => {
    insertEvent(testDb, {
      pk: 2,
      allDay: true,
      startDate: TS_2024_03_08,
      endDate: TS_2024_03_08 + 24 * HOUR,
    });
    const result = await source.syncStructured(null);
    expect(rowsFor(result, "apple_calendar_events")[0]).toMatchObject({
      all_day: true,
      duration_minutes: null,
    });
  });

  test("incremental sync picks up a modified event", async () => {
    insertEvent(testDb, { pk: 1, lastModified: TS_2024_03_08 });
    insertEvent(testDb, { pk: 2, lastModified: TS_2024_03_08 });

    const first = await source.sync(null);
    expect(first.documents).toHaveLength(2);

    testDb
      .prepare(`UPDATE CalendarItem SET last_modified = ?, summary = ? WHERE ROWID = 1`)
      .run(TS_2024_03_09, "Renamed Event");

    const second = await source.sync(first.cursor);
    expect(second.documents).toHaveLength(1);
    expect(second.documents[0].title).toBe("Renamed Event");
  });

  test("no-op incremental cycle emits no documents and no snapshot", async () => {
    insertEvent(testDb, { pk: 1 });

    const first = await source.sync(null);
    expect(first.presentExternalIds).toEqual(["event-uuid-1"]);

    const second = await source.sync(first.cursor);
    expect(second.documents).toHaveLength(0);
    // Snapshot signature unchanged — full enumeration skipped.
    expect(second.presentExternalIds).toBeUndefined();
  });

  test("paginates beyond PAGE_SIZE", async () => {
    for (let i = 1; i <= 101; i++) {
      insertEvent(testDb, { pk: i, lastModified: TS_2024_03_08 + i });
    }

    const page1 = await source.sync(null);
    expect(page1.documents).toHaveLength(100);
    expect(page1.hasMore).toBe(true);
    // No snapshot mid-bootstrap — emitting one would delete unpaged events.
    expect(page1.presentExternalIds).toBeUndefined();

    const page2 = await source.sync(page1.cursor);
    expect(page2.documents).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.presentExternalIds).toHaveLength(101);

    const ids = new Set([...page1.documents, ...page2.documents].map((d) => d.externalId));
    expect(ids.size).toBe(101);
  });

  test("paginates a run of events sharing one last_modified timestamp", async () => {
    for (let i = 1; i <= 101; i++) {
      insertEvent(testDb, { pk: i, lastModified: TS_2024_03_08 });
    }

    const page1 = await source.sync(null);
    expect(page1.documents).toHaveLength(100);
    expect(page1.hasMore).toBe(true);

    const page2 = await source.sync(page1.cursor);
    expect(page2.documents).toHaveLength(1);
    expect(page2.hasMore).toBe(false);

    const ids = new Set([...page1.documents, ...page2.documents].map((d) => d.externalId));
    expect(ids.size).toBe(101);
  });

  test("physically deleted events disappear via snapshot reconciliation", async () => {
    insertEvent(testDb, { pk: 1 });
    insertEvent(testDb, { pk: 2 });

    const first = await source.sync(null);
    expect(first.presentExternalIds).toHaveLength(2);

    // Calendar.app deletes rows physically — no tombstone to observe.
    testDb.prepare(`DELETE FROM CalendarItem WHERE ROWID = 1`).run();

    const second = await source.sync(first.cursor);
    expect(second.documents).toHaveLength(0);
    expect(second.deletedExternalIds).toEqual([]);
    expect(second.presentExternalIds).toEqual(["event-uuid-2"]);
  });

  test("hidden events are excluded from documents and snapshot", async () => {
    insertEvent(testDb, { pk: 1 });
    insertEvent(testDb, { pk: 2, hidden: true });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].externalId).toBe("event-uuid-1");
    expect(result.presentExternalIds).toEqual(["event-uuid-1"]);
  });

  test("excludes the Reminders-mirror store (type 6)", async () => {
    insertStore(testDb, { rowid: 6, name: "Reminders", type: 6 });
    insertCalendar(testDb, { rowid: 60, storeId: 6, title: "Scheduled Reminders" });
    insertEvent(testDb, { pk: 1 });
    insertEvent(testDb, { pk: 2, calendarId: 60, summary: "Mirrored reminder" });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].externalId).toBe("event-uuid-1");
    expect(result.presentExternalIds).toEqual(["event-uuid-1"]);
  });

  test("excludes derived calendars (store type 5)", async () => {
    insertStore(testDb, { rowid: 5, name: "Other", type: 5 });
    insertCalendar(testDb, { rowid: 50, storeId: 5, title: "Found in Mail" });
    insertEvent(testDb, { pk: 1 });
    insertEvent(testDb, { pk: 2, calendarId: 50, summary: "Mail-derived event" });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].externalId).toBe("event-uuid-1");
  });

  test("renders all-day events date-only", async () => {
    insertEvent(testDb, {
      pk: 1,
      summary: "Company Offsite",
      allDay: true,
      startDate: TS_2024_03_08,
      endDate: TS_2024_03_09,
    });

    const result = await source.sync(null);
    const doc = result.documents[0];
    expect(doc.content).toContain("**When:** 2024-03-08 → 2024-03-09");
    expect(doc.metadata.extra?.allDay).toBe(true);
    expect(doc.metadata.extra?.start).toBe("2024-03-08");
    expect(doc.metadata.extra?.end).toBe("2024-03-09");
  });

  test("renders timed events with a timezone hint", async () => {
    insertEvent(testDb, {
      pk: 1,
      startTz: "Europe/London",
      endTz: "Europe/London",
    });

    const result = await source.sync(null);
    const doc = result.documents[0];
    expect(doc.content).toContain("(Europe/London)");
    expect(doc.metadata.extra?.startTimeZone).toBe("Europe/London");
    // The timezone hint is content-only — extra carries the bare ISO value.
    expect(doc.metadata.extra?.start).toBe(coreDataToISO(TS_2024_03_08 + 10 * HOUR));
  });

  test("renders floating times without a timezone hint", async () => {
    insertEvent(testDb, { pk: 1, startTz: "_float", endTz: "_float" });

    const result = await source.sync(null);
    const doc = result.documents[0];
    expect(doc.content).not.toContain("_float");
    expect(doc.metadata.extra?.startTimeZone).toBeUndefined();
  });

  test("renders recurrence rules human-readably", async () => {
    insertEvent(testDb, { pk: 1, hasRecurrences: true });
    insertRecurrence(testDb, { ownerId: 1, frequency: 4 });
    insertEvent(testDb, { pk: 2, hasRecurrences: true });
    insertRecurrence(testDb, {
      ownerId: 2,
      frequency: 2,
      interval: 2,
      endDate: TS_2024_03_09,
    });
    insertEvent(testDb, { pk: 3, hasRecurrences: true });
    insertRecurrence(testDb, { ownerId: 3, frequency: 1, count: 6 });
    // Unknown frequency value — must degrade, not crash.
    insertEvent(testDb, { pk: 4, hasRecurrences: true });
    insertRecurrence(testDb, { ownerId: 4, frequency: 9 });

    const result = await source.sync(null);
    const byId = new Map(result.documents.map((d) => [d.externalId, d]));
    expect(byId.get("event-uuid-1")?.content).toContain("**Recurrence:** Repeats yearly");
    expect(byId.get("event-uuid-2")?.content).toContain(
      "**Recurrence:** Repeats every 2 weeks until 2024-03-09",
    );
    expect(byId.get("event-uuid-3")?.content).toContain("**Recurrence:** Repeats daily, 6 times");
    expect(byId.get("event-uuid-4")?.content).toContain("**Recurrence:** Repeats");
  });

  test("detached occurrences are their own documents", async () => {
    insertEvent(testDb, { pk: 1, summary: "Weekly Sync", hasRecurrences: true });
    insertRecurrence(testDb, { ownerId: 1, frequency: 2 });
    insertEvent(testDb, {
      pk: 2,
      summary: "Weekly Sync (moved)",
      origItemId: 1,
      uuid: "detached-uuid-2",
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(2);
    const detached = result.documents.find((d) => d.externalId === "detached-uuid-2");
    expect(detached?.metadata.extra?.isDetachedOccurrence).toBe(true);
    const master = result.documents.find((d) => d.externalId === "event-uuid-1");
    expect(master?.metadata.extra?.isDetachedOccurrence).toBeUndefined();
  });

  // The declared profile is what subscription compilation reads when it turns
  // "when a tentative event lands on my Personal calendar" into a document
  // predicate, so each declared role and path has to be something a synced
  // event really carries. The final assertion re-lists the declared paths, so
  // adding one without proving the normalizer emits it fails here.
  test("emits every person role and metadata field the document profile declares", async () => {
    insertLocation(testDb, { rowid: 1, title: "Studio Northstar" });
    insertEvent(testDb, {
      pk: 1,
      summary: "Site walkthrough",
      description: "Loop in sarah.mendez@example.org before we go.",
      allDay: true,
      locationId: 1,
      conferenceUrl: "https://meet.example.com/walkthrough",
      hasRecurrences: true,
      status: 2,
    });
    const organizerIdentity = insertIdentity(testDb, {
      displayName: "Maya Reeves",
      address: "mailto:maya.reeves@example.com",
    });
    const organizerId = insertParticipant(testDb, { ownerId: 1, identityId: organizerIdentity });
    testDb.prepare(`UPDATE CalendarItem SET organizer_id = ? WHERE ROWID = 1`).run(organizerId);
    insertParticipant(testDb, { ownerId: 1, email: "jamie.lopez@example.com" });
    insertRecurrence(testDb, { ownerId: 1, frequency: 2 });

    const [doc] = (await source.sync(null)).documents;

    expect(appleCalendarDocumentProfile.documentTypes).toContain(doc.metadata.documentType);
    expect(new Set(doc.metadata.people?.map((p) => p.role))).toEqual(
      new Set(appleCalendarDocumentProfile.personRoles),
    );
    expect(doc.metadata.extra?.calendarName).toBe("Personal");
    expect(doc.metadata.extra?.location).toBe("Studio Northstar");
    expect(doc.metadata.extra?.status).toBe("tentative");
    expect(doc.metadata.extra?.allDay).toBe(true);
    expect(doc.metadata.extra?.conferenceUrl).toBe("https://meet.example.com/walkthrough");
    expect(doc.metadata.extra?.recurrence).toBeTruthy();
    // Apple closes the status vocabulary, so the declaration does too — a
    // spelling the normalizer emits but the declaration omits would compile
    // conditions that never match.
    expect(
      appleCalendarDocumentProfile.metadataFields?.find((f) => f.path === "extra.status")
        ?.allowedValues,
    ).toContain(doc.metadata.extra?.status);
    // Every event carries an empty tag array, so `tags` is deliberately absent
    // from the declaration.
    expect(doc.metadata.tags).toEqual([]);
    expect(appleCalendarDocumentProfile.metadataFields?.map((f) => f.path)).toEqual([
      "extra.calendarName",
      "extra.location",
      "extra.status",
      "extra.allDay",
      "extra.conferenceUrl",
      "extra.recurrence",
    ]);
  });

  test("extracts the organizer via Participant and Identity", async () => {
    insertEvent(testDb, { pk: 1 });
    const identityId = insertIdentity(testDb, {
      displayName: "Maya Reeves",
      address: "mailto:maya.reeves@example.com",
    });
    const participantId = insertParticipant(testDb, { ownerId: 1, identityId });
    testDb.prepare(`UPDATE CalendarItem SET organizer_id = ? WHERE ROWID = 1`).run(participantId);

    const result = await source.sync(null);
    const people = result.documents[0].metadata.people ?? [];
    const author = people.find((p) => p.role === "author");
    // Participant.email is NULL — the mailto: identity address is the fallback.
    expect(author?.emails).toEqual(["maya.reeves@example.com"]);
    expect(author?.name).toBe("Maya Reeves");
    // The organizer's participant row must not be duplicated as an attendee.
    expect(people.filter((p) => p.emails?.includes("maya.reeves@example.com"))).toHaveLength(1);
  });

  test("an attendee phone is read in the region the collector reported, not a guessed one", async () => {
    // The gateway canonicalises an email on the way in and passes a phone
    // through verbatim, so normalising here is the only chance. But a bare
    // national number is a *valid* number in more than one country, and
    // guessing the wrong one does not produce a useless alias — it produces a
    // confident one belonging to somebody else, which merges the participant
    // into the wrong person. Same digits below, two regions, two identities.
    insertEvent(testDb, { pk: 1, summary: "Design Review" });
    insertParticipant(testDb, { ownerId: 1, phone: "201 555 0123" });

    const phonesFor = async (phoneRegion?: string) => {
      const s = new AppleCalendarSource(provider, {
        sourceId: "apple-calendar:test@icloud.com",
        providerId: "apple:test@icloud.com",
        ...(phoneRegion ? { phoneRegion } : {}),
      });
      const people = (await s.sync(null)).documents[0].metadata.people ?? [];
      return people.filter((p) => p.role === "attendee").flatMap((p) => p.phones ?? []);
    };

    expect(await phonesFor("GB")).toEqual(["+442015550123"]);
    expect(await phonesFor("US")).toEqual(["+12015550123"]);
  });

  test("a number that will not parse is not stored as an identity at all", async () => {
    insertEvent(testDb, { pk: 1, summary: "Design Review" });
    insertParticipant(testDb, { ownerId: 1, phone: "not a number" });

    const attendees = ((await source.sync(null)).documents[0].metadata.people ?? []).filter(
      (p) => p.role === "attendee",
    );
    // Every other Apple surface drops it rather than storing a value that can
    // only ever fail to match.
    for (const a of attendees) expect(a.phones ?? []).toEqual([]);
  });

  test("maps attendees to people mentions with dedupe", async () => {
    insertEvent(testDb, { pk: 1, summary: "Design Review" });
    const jamieId = insertIdentity(testDb, {
      displayName: "Jamie Lopez",
      address: "mailto:jamie.lopez@example.com",
    });
    insertParticipant(testDb, {
      ownerId: 1,
      email: "jamie.lopez@example.com",
      identityId: jamieId,
    });
    insertParticipant(testDb, { ownerId: 1, email: "david.lin@example.org" });
    // Duplicate email differing only in case — must collapse.
    insertParticipant(testDb, { ownerId: 1, email: "David.Lin@example.org" });

    const result = await source.sync(null);
    const doc = result.documents[0];
    const attendees = (doc.metadata.people ?? []).filter((p) => p.role === "attendee");
    expect(attendees).toHaveLength(2);
    expect(attendees[0].name).toBe("Jamie Lopez");
    expect(doc.content).toContain("**Attendees:** Jamie Lopez, david.lin@example.org");
  });

  test("stamps the source account email as author when no organizer", async () => {
    insertEvent(testDb, { pk: 1 });

    const result = await source.sync(null);
    const people = result.documents[0].metadata.people ?? [];
    expect(people).toContainEqual({
      role: "author",
      emails: ["test@icloud.com"],
      phones: [],
    });
  });

  test("indexes subscribed-feed events stamped with the negative last_modified sentinel", async () => {
    // The real-world subscribed-feed shape: creation_date NULL,
    // last_modified at a constant pre-2001 sentinel. A cursor that
    // assumes 0 is below every modification key skips all of these.
    insertStore(testDb, { rowid: 4, name: "Subscribed Calendars", type: 4 });
    insertCalendar(testDb, { rowid: 40, storeId: 4, title: "National Holidays" });
    insertEvent(testDb, {
      pk: 1,
      calendarId: 40,
      summary: "Spring Bank Holiday",
      allDay: true,
      creationDate: null,
      lastModified: SENTINEL_LAST_MODIFIED,
    });
    insertEvent(testDb, { pk: 2, summary: "Regular event" });

    const result = await source.sync(null);
    const ids = result.documents.map((d) => d.externalId).sort();
    expect(ids).toEqual(["event-uuid-1", "event-uuid-2"]);
    expect(result.presentExternalIds?.sort()).toEqual(["event-uuid-1", "event-uuid-2"]);
  });

  test("paginates a bootstrap where every event carries the sentinel key", async () => {
    for (let i = 1; i <= 101; i++) {
      insertEvent(testDb, { pk: i, lastModified: SENTINEL_LAST_MODIFIED, creationDate: null });
    }

    const page1 = await source.sync(null);
    expect(page1.documents).toHaveLength(100);
    expect(page1.hasMore).toBe(true);

    const page2 = await source.sync(page1.cursor);
    expect(page2.documents).toHaveLength(1);
    expect(page2.hasMore).toBe(false);

    const ids = new Set([...page1.documents, ...page2.documents].map((d) => d.externalId));
    expect(ids.size).toBe(101);
  });

  test("picks up rows that appear after bootstrap with a past modification key", async () => {
    insertEvent(testDb, { pk: 1 });
    const first = await source.sync(null);
    expect(first.documents).toHaveLength(1);

    // A newly subscribed feed (or CalDAV import) lands rows whose
    // last_modified predates the watermark — the insertion high-water
    // mark on ROWID is what sweeps them.
    insertStore(testDb, { rowid: 4, name: "Subscribed Calendars", type: 4 });
    insertCalendar(testDb, { rowid: 40, storeId: 4, title: "National Holidays" });
    insertEvent(testDb, {
      pk: 2,
      calendarId: 40,
      summary: "Midsummer Day",
      allDay: true,
      creationDate: null,
      lastModified: SENTINEL_LAST_MODIFIED,
    });

    const second = await source.sync(first.cursor);
    expect(second.documents.map((d) => d.externalId)).toEqual(["event-uuid-2"]);
    expect(second.presentExternalIds?.sort()).toEqual(["event-uuid-1", "event-uuid-2"]);
  });

  test("detects an equal-count feed swap of sentinel-stamped rows", async () => {
    insertStore(testDb, { rowid: 4, name: "Subscribed Calendars", type: 4 });
    insertCalendar(testDb, { rowid: 40, storeId: 4, title: "Fixture Feed" });
    insertEvent(testDb, {
      pk: 1,
      calendarId: 40,
      creationDate: null,
      lastModified: SENTINEL_LAST_MODIFIED,
    });
    insertEvent(testDb, {
      pk: 2,
      calendarId: 40,
      creationDate: null,
      lastModified: SENTINEL_LAST_MODIFIED,
    });

    const first = await source.sync(null);
    expect(first.presentExternalIds).toHaveLength(2);

    // Feed refresh: one row replaced by a new one — same count, same
    // sentinel modification key. Only the AUTOINCREMENT ROWID moves, so
    // the signature must carry it for the swap to be visible.
    testDb.prepare(`DELETE FROM CalendarItem WHERE ROWID = 2`).run();
    insertEvent(testDb, {
      pk: 3,
      calendarId: 40,
      summary: "Replacement fixture",
      creationDate: null,
      lastModified: SENTINEL_LAST_MODIFIED,
      uuid: "event-uuid-3",
    });

    const second = await source.sync(first.cursor);
    expect(second.documents.map((d) => d.externalId)).toEqual(["event-uuid-3"]);
    expect(second.presentExternalIds?.sort()).toEqual(["event-uuid-1", "event-uuid-3"]);
  });

  test("rows inserted mid-cycle are excluded from the cycle and swept by the next one", async () => {
    for (let i = 1; i <= 150; i++) {
      insertEvent(testDb, { pk: i, lastModified: TS_2024_03_08 + i });
    }

    const page1 = await source.sync(null);
    expect(page1.documents).toHaveLength(100);
    expect(page1.hasMore).toBe(true);

    // Calendar.app writes between pages: one row lands BEHIND the page
    // position (subscribed-feed sentinel key) and one AHEAD of it. The
    // ROWID ceiling pinned at cycle start excludes both from the in-flight
    // cycle; the promoted high-water mark sweeps both next cycle.
    insertStore(testDb, { rowid: 4, name: "Subscribed Calendars", type: 4 });
    insertCalendar(testDb, { rowid: 40, storeId: 4, title: "National Holidays" });
    insertEvent(testDb, {
      pk: 151,
      calendarId: 40,
      creationDate: null,
      lastModified: SENTINEL_LAST_MODIFIED,
    });
    insertEvent(testDb, { pk: 152, lastModified: TS_2024_03_09 });

    const page2 = await source.sync(page1.cursor);
    expect(page2.hasMore).toBe(false);
    const cycleIds = new Set([...page1.documents, ...page2.documents].map((d) => d.externalId));
    expect(cycleIds.size).toBe(150);
    expect(cycleIds.has("event-uuid-151")).toBe(false);
    expect(cycleIds.has("event-uuid-152")).toBe(false);

    const next = await source.sync(page2.cursor);
    expect(next.documents.map((d) => d.externalId).sort()).toEqual([
      "event-uuid-151",
      "event-uuid-152",
    ]);
  });

  test("multi-page incremental cycle pages with pinned watermarks", async () => {
    for (let i = 1; i <= 120; i++) {
      insertEvent(testDb, { pk: i, lastModified: TS_2024_03_08 + i });
    }
    const b1 = await source.sync(null);
    const b2 = await source.sync(b1.cursor);
    expect(b2.hasMore).toBe(false);

    // 101 of the 120 events change — the incremental cycle itself must page.
    testDb
      .prepare(`UPDATE CalendarItem SET last_modified = ? + ROWID WHERE ROWID <= 101`)
      .run(TS_2024_03_09);

    const inc1 = await source.sync(b2.cursor);
    expect(inc1.documents).toHaveLength(100);
    expect(inc1.hasMore).toBe(true);
    expect(inc1.progress).toEqual({ phase: "incremental", processed: 100, total: 101 });

    const inc2 = await source.sync(inc1.cursor);
    expect(inc2.documents).toHaveLength(1);
    expect(inc2.hasMore).toBe(false);
    expect(inc2.progress).toEqual({ phase: "incremental", processed: 1, total: 101 });

    const ids = new Set([...inc1.documents, ...inc2.documents].map((d) => d.externalId));
    expect(ids.size).toBe(101);
  });

  test("an in-place edit stamped with a past last_modified heals via the drift rescan", async () => {
    insertEvent(testDb, { pk: 1, summary: "Original title", lastModified: TS_2024_03_08 });
    insertEvent(testDb, { pk: 2, lastModified: TS_2024_03_08 + 200 });

    const first = await source.sync(null);
    expect(first.documents).toHaveLength(2);

    // The edit's stamp lands BELOW the watermark (e.g. CalDAV copying a
    // server-side LAST-MODIFIED that trails it) — invisible to the
    // membership clause, only the signature's key-sum component moves.
    testDb
      .prepare(`UPDATE CalendarItem SET last_modified = ?, summary = ? WHERE ROWID = 1`)
      .run(TS_2024_03_08 + 100, "Edited title");

    const second = await source.sync(first.cursor);
    expect(second.documents).toHaveLength(0);
    // Drift detected: the engine is told to come back immediately…
    expect(second.hasMore).toBe(true);

    // …and the rescan cycle re-emits the filtered set with fresh content.
    const third = await source.sync(second.cursor);
    expect(third.hasMore).toBe(false);
    const edited = third.documents.find((d) => d.externalId === "event-uuid-1");
    expect(edited?.title).toBe("Edited title");

    // The rescan settles: the following cycle is a true no-op.
    const fourth = await source.sync(third.cursor);
    expect(fourth.documents).toHaveLength(0);
    expect(fourth.hasMore).toBe(false);
  });

  test("a rebuilt database (ROWID sequence reset) triggers a full re-bootstrap", async () => {
    for (let i = 1; i <= 5; i++) {
      insertEvent(testDb, { pk: i, lastModified: TS_2024_03_08 + i });
    }
    const first = await source.sync(null);
    expect(first.documents).toHaveLength(5);

    // macOS rebuilds Calendar.sqlitedb on corruption or account re-add:
    // rows are replaced and the AUTOINCREMENT sequence restarts.
    testDb.prepare(`DELETE FROM CalendarItem`).run();
    testDb.prepare(`UPDATE sqlite_sequence SET seq = 0 WHERE name = 'CalendarItem'`).run();
    for (let i = 1; i <= 3; i++) {
      insertEvent(testDb, {
        pk: i,
        uuid: `rebuilt-uuid-${i}`,
        lastModified: TS_2024_03_08 + i,
      });
    }

    const second = await source.sync(first.cursor);
    expect(second.documents.map((d) => d.externalId).sort()).toEqual([
      "rebuilt-uuid-1",
      "rebuilt-uuid-2",
      "rebuilt-uuid-3",
    ]);
    expect(second.presentExternalIds?.sort()).toEqual([
      "rebuilt-uuid-1",
      "rebuilt-uuid-2",
      "rebuilt-uuid-3",
    ]);
  });

  test("DB unavailable: sync is a no-op that preserves the cursor and emits no snapshot", async () => {
    insertEvent(testDb, { pk: 1 });
    const first = await source.sync(null);

    // Point the calendar helper at a path that doesn't exist.
    const missing = new AppleProvider({
      notesDbPath: join(tmpDir, "nonexistent-notes"),
      remindersDirPath: join(tmpDir, "nonexistent-reminders"),
      imessageDbPath: join(tmpDir, "nonexistent-imessage"),
      contactsDirPath: join(tmpDir, "nonexistent-contacts"),
      calendarDbPath: join(tmpDir, "nonexistent-calendar"),
      callLogDbPath: join(tmpDir, "nonexistent-call-log"),
      voicemailDbPath: join(tmpDir, "nonexistent-voicemail"),
      accountId: "test@icloud.com",
    });
    await missing.initialize();
    await missing.authenticate();
    const missingSource = new AppleCalendarSource(missing, {
      sourceId: "apple-calendar:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });

    const result = await missingSource.sync(first.cursor);
    expect(result.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
    expect((await source.sync(result.cursor)).issues).toEqual([]);
    expect((await missingSource.syncStructured(first.cursor)).issues).toEqual(result.issues);
    expect(result.documents).toHaveLength(0);
    // An empty snapshot here would mass-delete every indexed event the
    // moment the DB is briefly unavailable — it must stay undefined.
    expect(result.presentExternalIds).toBeUndefined();
    expect(result.cursor).toEqual(first.cursor);
    expect(result.hasMore).toBe(false);
    await missing.disconnect();
  });

  test("does not stamp authorship on subscribed-feed events", async () => {
    insertStore(testDb, { rowid: 4, name: "Subscribed Calendars", type: 4 });
    insertCalendar(testDb, { rowid: 40, storeId: 4, title: "National Holidays" });
    insertEvent(testDb, { pk: 1, calendarId: 40, summary: "Spring Bank Holiday", allDay: true });

    const result = await source.sync(null);
    const people = result.documents[0].metadata.people ?? [];
    expect(people.find((p) => p.role === "author")).toBeUndefined();
  });

  test("does not stamp authorship for a non-email account id", async () => {
    const localProvider = makeProvider("local");
    await localProvider.initialize();
    await localProvider.authenticate();
    const localSource = new AppleCalendarSource(localProvider, {
      sourceId: "apple-calendar:local",
      providerId: "apple:local",
    });
    insertEvent(testDb, { pk: 1 });

    const result = await localSource.sync(null);
    const people = result.documents[0].metadata.people ?? [];
    expect(people.find((p) => p.role === "author")).toBeUndefined();
    await localProvider.disconnect();
  });

  test("extracts emails and phones mentioned in the description", async () => {
    // Pin the default region: the US national number in the fixture does not
    // parse under the runtime-locale fallback on a non-US machine.
    setDefaultPhoneRegion("US");
    try {
      insertEvent(testDb, {
        pk: 1,
        description: "Coordinate with sarah.mendez@example.com or call (212) 555-0123.",
      });

      const result = await source.sync(null);
      const people = result.documents[0].metadata.people ?? [];
      const mentioned = people.filter((p) => p.role === "mentioned");
      expect(mentioned.some((p) => p.emails?.includes("sarah.mendez@example.com"))).toBe(true);
      expect(mentioned.some((p) => (p.phones?.length ?? 0) > 0)).toBe(true);
    } finally {
      setDefaultPhoneRegion(undefined);
    }
  });

  test("renders location and meeting link", async () => {
    insertLocation(testDb, { rowid: 1, title: "Studio Northstar" });
    insertEvent(testDb, {
      pk: 1,
      locationId: 1,
      conferenceUrl: "https://meet.example.com/abc",
    });

    const result = await source.sync(null);
    const doc = result.documents[0];
    expect(doc.content).toContain("**Location:** Studio Northstar");
    expect(doc.content).toContain("**Meeting link:** https://meet.example.com/abc");
    expect(doc.metadata.extra?.location).toBe("Studio Northstar");
    expect(doc.metadata.extra?.conferenceUrl).toBe("https://meet.example.com/abc");
  });

  test("dataCutoff excludes past single events but keeps recurring masters", async () => {
    const cutoffSource = new AppleCalendarSource(provider, {
      sourceId: "apple-calendar:test@icloud.com",
      providerId: "apple:test@icloud.com",
      dataCutoff: coreDataToISO(TS_2024_03_09),
    });

    // Ends before the cutoff — excluded.
    insertEvent(testDb, {
      pk: 1,
      startDate: TS_2024_03_08,
      endDate: TS_2024_03_08 + HOUR,
    });
    // Ends after the cutoff — kept.
    insertEvent(testDb, {
      pk: 2,
      startDate: TS_2024_03_09 + HOUR,
      endDate: TS_2024_03_09 + 2 * HOUR,
    });
    // Recurring master with a past start — always kept.
    insertEvent(testDb, {
      pk: 3,
      startDate: TS_2024_03_08,
      endDate: TS_2024_03_08 + HOUR,
      hasRecurrences: true,
    });
    insertRecurrence(testDb, { ownerId: 3, frequency: 2 });

    const result = await cutoffSource.sync(null);
    const ids = result.documents.map((d) => d.externalId).sort();
    expect(ids).toEqual(["event-uuid-2", "event-uuid-3"]);
    expect(result.progress?.total).toBe(2);
    // Snapshot must agree with the cutoff filter — otherwise reconciliation
    // would resurrect or delete the wrong documents.
    expect(result.presentExternalIds?.sort()).toEqual(["event-uuid-2", "event-uuid-3"]);
  });

  test("falls back to start date when creation_date is NULL", async () => {
    insertEvent(testDb, {
      pk: 1,
      creationDate: null,
      startDate: TS_2024_03_08 + 10 * HOUR,
    });

    const result = await source.sync(null);
    expect(result.documents[0].sourceCreatedAt).toBe(coreDataToISO(TS_2024_03_08 + 10 * HOUR));
  });

  test("reports progress with a stable total across pages", async () => {
    for (let i = 1; i <= 101; i++) {
      insertEvent(testDb, { pk: i, lastModified: TS_2024_03_08 + i });
    }

    const page1 = await source.sync(null);
    expect(page1.progress).toEqual({ phase: "bootstrap", processed: 100, total: 101 });

    const page2 = await source.sync(page1.cursor);
    expect(page2.progress).toEqual({ phase: "bootstrap", processed: 1, total: 101 });
  });

  test("untitled events get a placeholder title", async () => {
    insertEvent(testDb, { pk: 1, summary: null });

    const result = await source.sync(null);
    expect(result.documents[0].title).toBe("(no title)");
  });

  test("cursor validator round-trips produced cursors and rejects junk", async () => {
    insertEvent(testDb, { pk: 1 });
    const result = await source.sync(null);

    expect(validateAppleCalendarSyncCursor(result.cursor)).not.toBeNull();
    // A cursor missing every optional field is still valid.
    expect(validateAppleCalendarSyncCursor({ lastModifiedTimestamp: 123 })).not.toBeNull();
    expect(validateAppleCalendarSyncCursor({ lastModifiedTimestamp: "123" })).toBeNull();
    expect(validateAppleCalendarSyncCursor({})).toBeNull();
  });
});
