// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The corpus reads behind a recording's suggestions, against a real database:
// who a calendar event invited, and the events a recording overlaps through
// the time index.

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createFreshTestDatabase } from "../testing/fresh-database.js";
import { calendarEventsFrom, type TemporalWindowReader } from "./calendar.js";
import { eventAttendees } from "./suggestion-reads.js";
import type { TemporalItem, TemporalQueryInput } from "@omnesis/core";
import type Database from "better-sqlite3";

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `omnesis-test-${randomUUID()}.db`);
  db = createFreshTestDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function person(id: string, name: string, extra: { self?: boolean } = {}) {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at, is_self)
     VALUES (?, ?, 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01', ?)`,
  ).run(id, name, extra.self ? 1 : 0);
}

function eventDocument(id: string, people: Array<[string, string]>) {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'google', 'google-calendar', ?, 'Event', 'body', 'hash-' || ?, '{"documentType":"event"}', '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01')`,
  ).run(id, id, id);
  for (const [personId, role] of people) {
    db.prepare(`INSERT INTO document_people (document_id, person_id, role) VALUES (?, ?, ?)`).run(
      id,
      personId,
      role,
    );
  }
}

describe("eventAttendees", () => {
  test("attendees and the organizer, without the owner or anyone merely mentioned", () => {
    person("p-me", "Robin V.", { self: true });
    person("p-priya", "Priya S.");
    person("p-jamie", "Jamie R.");
    person("p-zoe", "Zoe P.");
    eventDocument("doc-1", [
      ["p-me", "attendee"],
      ["p-priya", "attendee"],
      ["p-jamie", "author"],
      ["p-zoe", "mentioned"],
    ]);
    expect(eventAttendees(db, "doc-1")).toEqual([
      { personId: "p-jamie", name: "Jamie R." },
      { personId: "p-priya", name: "Priya S." },
    ]);
  });
});

describe("calendarEventsFrom", () => {
  function item(overrides: Partial<TemporalItem> = {}): TemporalItem {
    return {
      id: randomUUID(),
      origin: "projection",
      start: "2026-03-02T09:00:00.000Z",
      endExclusive: "2026-03-02T10:00:00.000Z",
      precision: "instant",
      allDay: false,
      label: "Weekly sync",
      kind: "appointment",
      modality: "scheduled",
      status: "active",
      projection: {
        sourceId: "google-calendar",
        slot: "calendar",
        documentId: "doc-1",
        projectedAt: "2026-03-01",
        revision: "r1",
      },
      ...overrides,
    };
  }

  test("asks the time index for scheduled appointments in the window and adds who was invited", async () => {
    person("p-priya", "Priya S.");
    eventDocument("doc-1", [["p-priya", "attendee"]]);
    const asked: TemporalQueryInput[] = [];
    const reader: TemporalWindowReader = {
      query: async (input) => {
        asked.push(input);
        return {
          items: [
            item(),
            // The same event projected twice, an all-day block, a day-long
            // block and an entry with no document: none is a meeting to offer.
            item({ id: "again" }),
            item({ allDay: true, projection: { ...item().projection!, documentId: "doc-2" } }),
            item({
              endExclusive: "2026-03-03T09:00:00.000Z",
              projection: { ...item().projection!, documentId: "doc-3" },
            }),
            item({ projection: { ...item().projection!, documentId: undefined } }),
          ],
        };
      },
    };
    const events = await calendarEventsFrom(db, () => reader)(
      "2026-03-02T09:10:00.000Z",
      "2026-03-02T09:40:00.000Z",
    );
    expect(asked).toEqual([
      expect.objectContaining({
        from: "2026-03-02T09:10:00.000Z",
        to: "2026-03-02T09:40:00.000Z",
        origins: ["projection"],
        kinds: ["appointment"],
        modalities: ["scheduled"],
        statuses: ["active"],
      }),
    ]);
    expect(events).toEqual([
      {
        documentId: "doc-1",
        title: "Weekly sync",
        start: "2026-03-02T09:00:00.000Z",
        end: "2026-03-02T10:00:00.000Z",
        attendees: [{ personId: "p-priya", name: "Priya S." }],
      },
    ]);
  });
});
