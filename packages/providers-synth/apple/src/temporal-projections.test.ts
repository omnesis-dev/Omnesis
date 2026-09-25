// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { impairedIds } from "@omnesis/providers-synth-common";
import { rowsFor, writesFor } from "@omnesis/source-sdk/testing";
import {
  loadCalendarEvents,
  loadReminders,
  mapCalendarEventRecord,
  mapReminder,
} from "./fixtures.js";
import synthApple from "./index.js";
import type { MappedProjectionField } from "@omnesis/source-sdk";

const calendarSource = synthApple.sources.find((source) => source.id === "apple-calendar")!;
const calendarProjection = calendarSource.analyticsSchemas?.[0]?.temporalProjection;
const calendarTable = calendarSource.analyticsSchemas![0]!.tableName;
const remindersSource = synthApple.sources.find((source) => source.id === "apple-reminders")!;

/**
 * Resolve a projection field against one row the way the gateway's derivation
 * does: a bare vocabulary value is a constant, and a mapped field reads a
 * column, falling back to its declared default for any value the map does not
 * name. Lets this test assert that synthetic rows drive the *production* spec
 * to the same fact a real Apple Calendar row would.
 */
function resolveProjected<T extends string>(
  field: MappedProjectionField<T, string>,
  row: Record<string, unknown>,
): T {
  if (typeof field === "string") return field;
  const raw = row[field.from];
  const mapped = raw === null || raw === undefined ? undefined : field.map[String(raw)];
  return mapped ?? field.default;
}

describe("synthetic Apple Calendar temporal projections", () => {
  it("maps timed and all-day occurrences with production-equivalent semantics", () => {
    const entries = loadCalendarEvents();
    const timed = mapCalendarEventRecord(entries[0]!);
    const allDayEntry = entries.find((entry) => entry.allDay)!;
    const allDay = mapCalendarEventRecord(allDayEntry);

    expect(timed).toMatchObject({
      id: entries[0]!.externalId,
      all_day: false,
      temporal_projection_eligible: true,
      status: "confirmed",
    });
    expect(timed.duration_minutes).toBe(45);
    expect(allDay).toMatchObject({
      id: allDayEntry.externalId,
      all_day: true,
      duration_minutes: null,
      temporal_projection_eligible: true,
    });
  });

  it("projects a timed row as an appointment and an all-day row as an event", () => {
    const spec = calendarProjection!;
    const entries = loadCalendarEvents();
    const timed = mapCalendarEventRecord(entries.find((entry) => !entry.allDay)!);
    const allDay = mapCalendarEventRecord(entries.find((entry) => entry.allDay)!);

    // A timed entry is a booking with a counterparty; an all-day entry is an
    // observance or whole-day block.
    expect(resolveProjected(spec.kind, timed)).toBe("appointment");
    expect(resolveProjected(spec.kind, allDay)).toBe("event");
    expect(resolveProjected(spec.modality, timed)).toBe("scheduled");
    expect(resolveProjected(spec.status!, timed)).toBe("active");
    expect(resolveProjected(spec.status!, { ...timed, status: "cancelled" })).toBe("cancelled");
    // An unfamiliar provider status degrades to the declared default rather
    // than dropping the fact.
    expect(resolveProjected(spec.status!, { ...timed, status: "needs-action" })).toBe("active");
  });

  it("paginates the hybrid snapshot and emits matching row/document identities", async () => {
    expect(calendarProjection).toMatchObject({
      slot: "calendar",
      start: "$semanticTime",
      end: "end_time",
      label: "title",
      modality: "scheduled",
      allDay: "all_day",
      eligibility: "temporal_projection_eligible",
      correlationKeys: ["ical_uid"],
    });
    const instance = await calendarSource.create!(
      {
        accountId: "john.smith@icloud.example",
        sourceId: SourceId("apple-calendar:john.smith@icloud.example"),
        providerId: ProviderId("apple:john.smith@icloud.example"),
      },
      {},
    );

    let cursor = null;
    let pages = 0;
    let finalSnapshot: string[] | undefined;
    let hasMore = true;
    while (hasMore) {
      const result = await instance.syncStructured!(cursor);
      pages += 1;
      const rows = rowsFor(result, calendarTable);
      expect(rows).toHaveLength(result.documents?.length ?? -1);
      for (const [index, row] of rows.entries()) {
        expect(row.id).toBe(result.documents?.[index]?.externalId);
        expect(row.temporal_projection_eligible).toBe(true);
      }
      const presentIds = writesFor(result, calendarTable)[0]?.presentIds;
      if (result.hasMore) {
        expect(result.presentExternalIds).toBeUndefined();
        expect(presentIds).toBeUndefined();
      } else {
        finalSnapshot = presentIds;
        expect(result.presentExternalIds).toEqual(presentIds);
      }
      cursor = result.cursor;
      hasMore = result.hasMore;
    }

    expect(pages).toBeGreaterThan(1);
    expect(finalSnapshot).toEqual(loadCalendarEvents().map((entry) => entry.externalId));
  });
});

describe("synthetic reminder temporal projections", () => {
  it("uses the production descriptor and emits projectable due/status metadata", () => {
    expect(remindersSource.documentTemporalProjections).toEqual([
      {
        slot: "due",
        start: "dueAt",
        kind: "deadline",
        modality: "asserted",
        status: {
          from: "status",
          map: { open: "active", completed: "completed" },
          default: "active",
        },
      },
    ]);

    const entries = loadReminders();
    const open = entries.find((entry) => !entry.completed && entry.dueAt)!;
    const completed = entries.find((entry) => entry.completed && entry.dueAt)!;
    const ctx = {
      sourceId: SourceId("apple-reminders:john.smith@icloud.example"),
      providerId: ProviderId("apple:john.smith@icloud.example"),
    };
    expect(mapReminder(open, ctx).metadata).toMatchObject({
      dueAt: open.dueAt,
      status: "open",
    });
    expect(mapReminder(completed, ctx).metadata).toMatchObject({
      dueAt: completed.dueAt,
      status: "completed",
    });
  });
});

describe("apple-calendar synth — the impairment reaches both planes", () => {
  const SOURCE = "apple-calendar:john.smith@icloud.example";
  const ENV = "OMNESIS_SYNTH_READ_IMPAIRMENT";

  async function makeInstance() {
    return calendarSource.create!(
      {
        accountId: "john.smith@icloud.example",
        sourceId: SourceId(SOURCE),
        providerId: ProviderId("apple:john.smith@icloud.example"),
      },
      {},
    );
  }

  /** Drain every page, returning the final page's two snapshot planes. */
  async function drain(): Promise<{
    presentExternalIds?: string[];
    presentIds?: string[];
    documentIds: string[];
  }> {
    const instance = await makeInstance();
    let cursor = null;
    let hasMore = true;
    const documentIds: string[] = [];
    let last: { presentExternalIds?: string[]; presentIds?: string[] } = {};
    while (hasMore) {
      const result = await instance.syncStructured!(cursor);
      for (const doc of result.documents ?? []) documentIds.push(doc.externalId);
      last = {
        presentExternalIds: result.presentExternalIds,
        presentIds: writesFor(result, calendarTable)[0]?.presentIds,
      };
      cursor = result.cursor;
      hasMore = result.hasMore;
    }
    return { ...last, documentIds };
  }

  afterEach(() => {
    delete process.env[ENV];
  });

  it("is the one fixture that drives the document plane and the analytics plane together", async () => {
    // This twin emits `presentExternalIds` and `presentIds` from a single page,
    // which is what makes it the only place a test can exercise document
    // reconciliation and analytics-row reconciliation from one impairment.
    // Both planes must come from the same enumeration or they can disagree.
    const healthy = await drain();
    expect(healthy.presentIds).toEqual(healthy.presentExternalIds);
    expect(healthy.presentExternalIds).toEqual(
      loadCalendarEvents().map((entry) => entry.externalId),
    );
  });

  it("withholds BOTH planes when the read is degraded", async () => {
    process.env[ENV] = `${SOURCE}:degraded:2`;
    const degraded = await drain();

    // Withholding one plane and not the other would delete the analytics rows
    // of the very documents the other plane just declined to delete.
    expect(degraded.presentExternalIds).toBeUndefined();
    expect(degraded.presentIds).toBeUndefined();
  });

  it("shrinks BOTH planes to the same ids when the records are genuinely gone", async () => {
    process.env[ENV] = `${SOURCE}:deleted:2`;
    const deleted = await drain();
    const vanished = impairedIds(SOURCE);
    const all = loadCalendarEvents().map((entry) => entry.externalId);

    expect(vanished).toHaveLength(2);
    expect(deleted.presentExternalIds).toEqual(all.filter((id) => !vanished.includes(id)));
    expect(deleted.presentIds).toEqual(deleted.presentExternalIds);
    // And the documents the source did emit match what it vouched for.
    expect(deleted.documentIds).toEqual(deleted.presentExternalIds);
  });
});
