// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../db.js";
import { AnalyticsDb } from "../../analytics-db.js";
import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import { insertTemporalAnnotation } from "../temporal-annotations/storage.js";
import { replaceDocumentTemporalProjections } from "../temporal-projections/document-storage.js";
import { TemporalQueryInputError, TemporalQueryService } from "./temporal-query-service.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

const calendarSchema: AnalyticsTableSchema = {
  tableName: "synthetic_calendar_events",
  displayName: "Synthetic calendar events",
  description: "Invented calendar rows for temporal federation tests",
  columns: [
    { name: "id", type: "VARCHAR", description: "Stable id" },
    { name: "title", type: "VARCHAR", description: "Title" },
    { name: "start_time", type: "TIMESTAMPTZ", description: "Start" },
    { name: "end_time", type: "TIMESTAMPTZ", description: "Exclusive end" },
    { name: "all_day", type: "BOOLEAN", description: "All day" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "start_time",
  record: { titleColumns: ["title"], keyColumns: ["start_time", "end_time"] },
  boundDocument: { externalIdColumns: ["id"] },
  temporalProjection: {
    slot: "calendar",
    start: "$semanticTime",
    end: "end_time",
    label: "title",
    // A calendar row's nature follows its all-day-ness, the way the shipped
    // calendar providers declare it: a timed booking is an appointment, an
    // all-day entry is an event.
    kind: { from: "all_day", map: { true: "event" }, default: "appointment" },
    modality: "scheduled",
    status: "active",
    allDay: "all_day",
  },
};

describe("TemporalQueryService", () => {
  let sqlitePath: string;
  let duckPath: string;
  let db: ReturnType<typeof createDatabase>;
  let analytics: AnalyticsDb;
  let service: TemporalQueryService;
  let emailDocumentId: string;
  let calendarDocumentId: string;
  let emailProjectionId: string;

  beforeEach(async () => {
    sqlitePath = `/tmp/omnesis-test-${randomUUID()}.db`;
    duckPath = `/tmp/omnesis-test-${randomUUID()}.duckdb`;
    db = createDatabase(sqlitePath);
    analytics = new AnalyticsDb(duckPath);
    await analytics.open();
    service = new TemporalQueryService(db, analytics);

    const email: DocumentInput = {
      providerId: "synthetic" as DocumentInput["providerId"],
      sourceId: "gmail:test@example.com" as DocumentInput["sourceId"],
      externalId: "message-1",
      title: "Submit studio outline",
      content: "An invented structured deadline.",
      contentHash: "email-hash-1",
      metadata: { dueAt: "2026-07-23" },
      sourceCreatedAt: "2026-07-20T10:00:00.000Z",
      sourceUpdatedAt: "2026-07-20T10:00:00.000Z",
    };
    upsertDocuments(db, [email]);
    emailDocumentId = (
      db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
        .get(email.externalId) as { id: string }
    ).id;
    replaceDocumentTemporalProjections(
      db,
      email,
      [
        {
          slot: "due",
          start: "dueAt",
          kind: "deadline",
          modality: "scheduled",
        },
      ],
      "2026-07-20T10:00:00.000Z",
    );
    emailProjectionId = (
      db
        .prepare<
          [string],
          { id: string }
        >("SELECT id FROM document_temporal_projections WHERE document_id = ?")
        .get(emailDocumentId) as { id: string }
    ).id;
    db.prepare(
      `INSERT INTO sync_state (source_id, last_synced_at) VALUES (?, ?)
       ON CONFLICT(source_id, device_id) DO UPDATE SET last_synced_at = excluded.last_synced_at`,
    ).run("gmail:test@example.com", "2026-07-20T10:00:00.000Z");
    db.prepare(
      `INSERT INTO document_temporal_projection_sources
         (source_id, slots_json, last_materialized_at, last_sync_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      "gmail:test@example.com",
      '["due"]',
      "2026-07-20T10:00:00.000Z",
      "2026-07-20T10:00:00.000Z",
    );

    await analytics.ingestPage({
      tableName: calendarSchema.tableName,
      schema: calendarSchema,
      sourceId: "google-calendar:test@example.com",
      records: [
        {
          id: "event-1",
          title: "Riverside design review",
          start_time: "2026-07-23T09:00:00.000Z",
          end_time: "2026-07-23T10:00:00.000Z",
          all_day: false,
        },
      ],
    });
    const calendarDocument: DocumentInput = {
      providerId: "synthetic" as DocumentInput["providerId"],
      sourceId: "google-calendar:test@example.com" as DocumentInput["sourceId"],
      externalId: "event-1",
      title: "Riverside design review",
      content: "An invented calendar event.",
      contentHash: "calendar-hash-1",
      metadata: {},
      sourceCreatedAt: "2026-07-22T19:00:00.000Z",
      sourceUpdatedAt: "2026-07-22T19:00:00.000Z",
    };
    upsertDocuments(db, [calendarDocument]);
    calendarDocumentId = (
      db
        .prepare<
          [string, string],
          { id: string }
        >("SELECT id FROM documents WHERE source_id = ? AND external_id = ?")
        .get(calendarDocument.sourceId, calendarDocument.externalId) as { id: string }
    ).id;
    db.prepare("INSERT INTO sync_state (source_id, last_synced_at) VALUES (?, ?)").run(
      "google-calendar:test@example.com",
      "2026-07-22T19:00:00.000Z",
    );

    insertTemporalAnnotation(
      db,
      {
        id: "ta_interpretation",
        intervalStartMs: Date.parse("2026-07-23T09:00:00.000Z"),
        intervalEndMs: Date.parse("2026-07-23T10:00:00.000Z"),
        precision: "range",
        canonical: "2026-07-23T09:00:00.000Z .. 2026-07-23T10:00:00.000Z",
        sentence: "The review resolves the outline dependency.",
        kind: "event",
        documentIds: [emailDocumentId],
        projectionIds: [emailProjectionId],
        createdByRun: "run_synthetic",
      },
      Date.parse("2026-07-22T20:00:00.000Z"),
    );
  });

  it("marks items anchored vs spanning, and summarises both across the window", async () => {
    // A range far wider than the window: it merely spans the queried days.
    insertTemporalAnnotation(
      db,
      {
        id: "ta_spanning",
        intervalStartMs: Date.parse("2026-07-01T00:00:00.000Z"),
        intervalEndMs: Date.parse("2026-08-31T23:59:59.999Z"),
        precision: "range",
        canonical: "2026-07-01 .. 2026-08-31",
        sentence: "Studio residency block over the whole summer.",
        kind: "episode",
        documentIds: [],
        createdByRun: "run_synthetic",
      },
      Date.parse("2026-07-01T00:00:00.000Z"),
    );

    const day = await service.query({
      from: "2026-07-23",
      to: "2026-07-24",
      timeZone: "UTC",
    });
    const spanning = day.items.find((i) => i.id === "ta_spanning");
    const anchored = day.items.find((i) => i.id === "ta_interpretation");
    expect(spanning?.anchored).toBe(false);
    expect(anchored?.anchored).toBe(true);
    // The fixture projections' dates also land inside the day, so of the
    // matches only the residency block merely spans.
    expect(day.summary).toEqual({ anchored: 3, spanning: 1 });

    // A window that contains one of the long range's own boundaries counts
    // it anchored there.
    const start = await service.query({
      from: "2026-06-30",
      to: "2026-07-02",
      timeZone: "UTC",
    });
    expect(start.items.find((i) => i.id === "ta_spanning")?.anchored).toBe(true);
  });

  it("rejects an execution-specific broad window before reading projections", async () => {
    await expect(
      service.query(
        {
          from: "2024-01-01",
          to: "2026-01-01",
          timeZone: "UTC",
          limit: 1,
        },
        { maxWindowMs: 366 * 24 * 60 * 60 * 1000 },
      ),
    ).rejects.toThrow("window exceeds");
  });

  afterEach(async () => {
    await analytics.close();
    db.close();
    cleanup(sqlitePath);
    cleanup(duckPath);
  });

  it("federates both projection stores with annotations and coverage", async () => {
    const result = await service.query({
      from: "2026-07-23",
      timeZone: "Europe/London",
      limit: 10,
    });

    expect(result.items.map((item) => item.origin).sort()).toEqual([
      "annotation",
      "projection",
      "projection",
    ]);
    expect(result.items.find((item) => item.id.startsWith("tp_"))).toBeDefined();
    expect(result.items.find((item) => item.id === "ta_interpretation")?.annotation).toMatchObject({
      documentIds: [emailDocumentId],
      projectionIds: [emailProjectionId],
      createdByRun: "run_synthetic",
      revision: 1,
    });
    expect(result.window).toEqual({
      start: "2026-07-22T23:00:00.000Z",
      endExclusive: "2026-07-23T23:00:00.000Z",
      timeZone: "Europe/London",
    });
    expect(result.coverage.annotations).toEqual({ selective: true });
    expect(result.coverage.projectionSources.map((row) => row.sourceId).sort()).toEqual([
      "gmail:test@example.com",
      "google-calendar:test@example.com",
    ]);
  });

  it("applies origin/document filters across both physical stores", async () => {
    const projections = await service.query({
      from: "2026-07-23",
      timeZone: "UTC",
      origins: ["projection"],
      documentIds: [emailDocumentId],
    });
    expect(projections.items).toHaveLength(1);
    expect(projections.items[0]).toMatchObject({
      origin: "projection",
      kind: "deadline",
    });

    const annotations = await service.query({
      from: "2026-07-23",
      timeZone: "UTC",
      origins: ["annotation"],
      entityIds: [emailDocumentId],
    });
    expect(annotations.items.map((item) => item.id)).toEqual(["ta_interpretation"]);
  });

  it("includes cancelled projections by default but honours an explicit active filter", async () => {
    const cancelled: DocumentInput = {
      providerId: "synthetic" as DocumentInput["providerId"],
      sourceId: "things:local" as DocumentInput["sourceId"],
      externalId: "cancelled-task",
      title: "Retired studio errand",
      content: "Invented cancelled task.",
      contentHash: "cancelled-task-hash",
      metadata: { dueAt: "2026-07-23", status: "canceled" },
      sourceCreatedAt: "2026-07-20T10:00:00.000Z",
      sourceUpdatedAt: "2026-07-20T10:00:00.000Z",
    };
    upsertDocuments(db, [cancelled]);
    replaceDocumentTemporalProjections(
      db,
      cancelled,
      [
        {
          slot: "due",
          start: "dueAt",
          kind: "deadline",
          modality: "asserted",
          status: {
            from: "status",
            map: { canceled: "cancelled" },
            default: "active",
          },
        },
      ],
      "2026-07-20T10:00:00.000Z",
    );

    const unfiltered = await service.query({
      from: "2026-07-23",
      timeZone: "UTC",
      origins: ["projection"],
    });
    expect(
      unfiltered.items.some(
        (item) => item.projection?.sourceId === "things:local" && item.status === "cancelled",
      ),
    ).toBe(true);

    const activeOnly = await service.query({
      from: "2026-07-23",
      timeZone: "UTC",
      origins: ["projection"],
      statuses: ["active"],
    });
    expect(activeOnly.items.some((item) => item.projection?.sourceId === "things:local")).toBe(
      false,
    );
  });

  it("paginates deterministically and rejects cursor reuse with different filters", async () => {
    const first = await service.query({
      from: "2026-07-23",
      timeZone: "UTC",
      limit: 1,
    });
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await service.query({
      from: "2026-07-23",
      timeZone: "UTC",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(first.items[0].id);

    await expect(
      service.query({
        from: "2026-07-23",
        timeZone: "Europe/Paris",
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toBeInstanceOf(TemporalQueryInputError);
  });

  it("defines a live, best-effort page walk when an item moves after the cursor", async () => {
    const firstStart = Date.parse("2026-07-24T08:00:00.000Z");
    const secondStart = Date.parse("2026-07-24T09:00:00.000Z");
    for (const [id, start] of [
      ["ta_live_first", firstStart],
      ["ta_live_second", secondStart],
    ] as const) {
      insertTemporalAnnotation(
        db,
        {
          id,
          intervalStartMs: start,
          intervalEndMs: start,
          precision: "instant",
          sentence: `Invented live item ${id}`,
          kind: "event",
          documentIds: [],
          personIds: [],
          loopIds: [],
          projectionIds: [],
          createdByRun: "run_live_pagination",
        },
        start,
      );
    }

    const query = {
      from: "2026-07-24",
      timeZone: "UTC",
      origins: ["annotation"] as const,
      limit: 1,
    };
    const first = await service.query(query);
    expect(first.items.map((item) => item.id)).toEqual(["ta_live_first"]);

    // Cursors are positions in the current ordering, not cross-store snapshots.
    // Moving an already-returned row beyond that position makes it visible
    // again. Accumulating clients de-duplicate ids while retaining the fresh row.
    const movedStart = Date.parse("2026-07-24T10:00:00.000Z");
    db.prepare(
      `UPDATE temporal_annotations
       SET interval_start_ms = ?, interval_end_ms = ?, updated_at = ?, revision = revision + 1
       WHERE id = 'ta_live_first'`,
    ).run(movedStart, movedStart, movedStart);

    const second = await service.query({ ...query, cursor: first.nextCursor });
    expect(second.items.map((item) => item.id)).toEqual(["ta_live_second"]);
    const third = await service.query({ ...query, cursor: second.nextCursor });
    expect(third.items.map((item) => item.id)).toEqual(["ta_live_first"]);
    expect(third.items[0]?.annotation?.revision).toBe(2);
  });

  it("marks a query the caller can fix, and only that", async () => {
    // The boundary classifies on the type, so what carries the type is the
    // contract: a window the caller cannot have meant is theirs to fix, while
    // the same resolver run over stored bounds is not.
    await expect(
      service.query({ from: "2026-07-23", timeZone: "Mars/Olympus" }),
    ).rejects.toBeInstanceOf(TemporalQueryInputError);
    await expect(
      service.query({ from: "not-a-date", timeZone: "Europe/Paris" }),
    ).rejects.toBeInstanceOf(TemporalQueryInputError);
  });

  it.each(["Europe/London", "Pacific/Kiritimati"])(
    "paginates all-day projections on normalized keys in %s",
    async (timeZone) => {
      for (let index = 2; index <= 5; index += 1) {
        const document: DocumentInput = {
          providerId: "synthetic" as DocumentInput["providerId"],
          sourceId: "gmail:test@example.com" as DocumentInput["sourceId"],
          externalId: `message-${index}`,
          title: `Submit invented outline ${index}`,
          content: "An invented structured deadline.",
          contentHash: `email-hash-${index}`,
          metadata: { dueAt: "2026-07-23" },
          sourceCreatedAt: "2026-07-20T10:00:00.000Z",
          sourceUpdatedAt: "2026-07-20T10:00:00.000Z",
        };
        upsertDocuments(db, [document]);
        replaceDocumentTemporalProjections(
          db,
          document,
          [
            {
              slot: "due",
              start: "dueAt",
              kind: "deadline",
              modality: "scheduled",
            },
          ],
          "2026-07-20T10:00:00.000Z",
        );
      }

      const query = {
        from: "2026-07-23",
        timeZone,
        origins: ["projection"] as const,
        sourceIds: ["gmail:test@example.com"],
      };
      const expected = await service.query({ ...query, limit: 100 });
      expect(expected.items).toHaveLength(5);

      const pagedIds: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await service.query({ ...query, limit: 1, cursor });
        pagedIds.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor);

      expect(pagedIds).toEqual(expected.items.map((item) => item.id));
      expect(new Set(pagedIds).size).toBe(pagedIds.length);
    },
  );

  it("entity ids return a projection together with annotations explicitly linked to it", async () => {
    const result = await service.query({
      from: "2026-07-23",
      timeZone: "UTC",
      entityIds: [emailProjectionId],
    });

    expect(result.items.map((item) => [item.id, item.origin])).toEqual([
      [emailProjectionId, "projection"],
      ["ta_interpretation", "annotation"],
    ]);
  });

  it("resolves document entity ids into both projection stores", async () => {
    const documentProjection = await service.query({
      from: "2026-07-23",
      timeZone: "UTC",
      origins: ["projection"],
      entityIds: [emailDocumentId],
    });
    expect(documentProjection.items.map((item) => item.id)).toEqual([emailProjectionId]);

    const analyticsProjection = await service.query({
      from: "2026-07-23",
      timeZone: "UTC",
      origins: ["projection"],
      entityIds: [calendarDocumentId],
    });
    expect(analyticsProjection.items).toHaveLength(1);
    expect(analyticsProjection.items[0]).toMatchObject({
      origin: "projection",
      kind: "appointment",
      projection: {
        sourceId: "google-calendar:test@example.com",
        documentId: calendarDocumentId,
        documentExternalId: "event-1",
      },
    });
  });

  it("federates rows whose kind is mapped from their own values", async () => {
    await analytics.ingestPage({
      tableName: calendarSchema.tableName,
      schema: calendarSchema,
      sourceId: "google-calendar:test@example.com",
      records: [
        {
          id: "event-2",
          title: "Studio closure",
          start_time: "2026-07-23",
          end_time: "2026-07-24",
          all_day: true,
        },
      ],
    });

    const result = await service.query({
      from: "2026-07-23",
      timeZone: "UTC",
      origins: ["projection"],
      sourceIds: ["google-calendar:test@example.com"],
    });

    expect(result.items.map((item) => [item.label, item.kind, item.allDay])).toEqual([
      ["Studio closure", "event", true],
      ["Riverside design review", "appointment", false],
    ]);
  });

  it("keeps an all-day row whose local midnight does not exist in the requested zone", async () => {
    // Chile springs forward AT midnight, so 2026-09-06 has no 00:00 there and
    // re-anchoring an all-day row to that zone cannot succeed. Re-anchoring is
    // a refinement; the row's stored bounds are already usable. Losing this
    // row would be bad enough — but the resolve runs inside a map over the
    // whole result set, so a throw would take every unrelated row with it and
    // the caller would get nothing for the window at all.
    await analytics.ingestPage({
      tableName: calendarSchema.tableName,
      schema: calendarSchema,
      sourceId: "google-calendar:test@example.com",
      records: [
        {
          id: "event-dst",
          title: "Spring-forward all-day",
          start_time: "2026-09-06",
          end_time: "2026-09-07",
          all_day: true,
        },
      ],
    });

    const result = await service.query({
      from: "2026-09-06",
      to: "2026-09-07",
      timeZone: "America/Santiago",
      origins: ["projection"],
      sourceIds: ["google-calendar:test@example.com"],
    });

    expect(result.items.map((item) => item.label)).toContain("Spring-forward all-day");
  });

  it("interprets coarse annotations in the requested time zone", async () => {
    insertTemporalAnnotation(
      db,
      {
        id: "ta_local_day",
        intervalStartMs: Date.parse("2026-07-23T00:00:00.000Z"),
        intervalEndMs: Date.parse("2026-07-24T00:00:00.000Z") - 1,
        precision: "day",
        canonical: "2026-07-23",
        sentence: "An invented local-day reminder.",
        kind: "reminder",
        documentIds: [],
        createdByRun: "run_local_day",
      },
      Date.parse("2026-07-20T10:00:00.000Z"),
    );

    const previousDay = await service.query({
      from: "2026-07-22",
      timeZone: "America/Los_Angeles",
      origins: ["annotation"],
      entityIds: ["ta_local_day"],
    });
    expect(previousDay.items).toEqual([]);

    const localDay = await service.query({
      from: "2026-07-23",
      timeZone: "America/Los_Angeles",
      origins: ["annotation"],
      entityIds: ["ta_local_day"],
    });
    expect(localDay.items).toEqual([
      expect.objectContaining({
        id: "ta_local_day",
        start: "2026-07-23T07:00:00.000Z",
        endExclusive: "2026-07-24T07:00:00.000Z",
        allDay: true,
      }),
    ]);
  });

  it("uses the serialized event fallback when filtering kindless annotations", async () => {
    insertTemporalAnnotation(
      db,
      {
        id: "ta_kindless",
        intervalStartMs: Date.parse("2026-07-23T12:00:00.000Z"),
        intervalEndMs: Date.parse("2026-07-23T12:00:00.000Z"),
        precision: "instant",
        canonical: "2026-07-23T12:00:00.000Z",
        sentence: "An invented unclassified event.",
        kind: null,
        documentIds: [],
        createdByRun: "run_kindless",
      },
      Date.parse("2026-07-20T10:00:00.000Z"),
    );

    const result = await service.query({
      from: "2026-07-23",
      timeZone: "UTC",
      origins: ["annotation"],
      kinds: ["event"],
      entityIds: ["ta_kindless"],
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        id: "ta_kindless",
        kind: "event",
      }),
    ]);
  });
});
