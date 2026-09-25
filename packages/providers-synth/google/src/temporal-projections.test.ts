// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  DOCUMENT_PROJECTION_FIELDS,
  type MappedProjectionField,
  type TemporalProjectionSpec,
} from "@omnesis/source-sdk";
import realGoogle from "@omnesis/provider-google";
import { rowsFor, writesFor } from "@omnesis/source-sdk/testing";
import { loadEmails, loadEvents, mapEmail, mapEventRecord, type EventEntry } from "./fixtures.js";
import synthGoogle from "./index.js";

/**
 * Resolve a projection field the way the gateway's derivation does: a bare
 * vocabulary value is constant, a mapped field reads its ref off the record and
 * falls back to the declared default when the raw value has no mapping.
 *
 * Asserting through the declared map (rather than a literal expectation) is
 * what ties a fixture row's raw column values to the fact it will project.
 */
function resolveMapped<T extends string>(
  field: MappedProjectionField<T, string>,
  record: Record<string, unknown>,
): T {
  if (typeof field === "string") return field;
  const raw = record[field.from];
  return (raw === null || raw === undefined ? undefined : field.map[String(raw)]) ?? field.default;
}

function calendarProjection(): TemporalProjectionSpec<string> {
  const calendar = synthGoogle.sources.find((source) => source.id === "google-calendar");
  const spec = calendar?.analyticsSchemas?.[0]?.temporalProjection;
  if (!spec) throw new Error("synthetic google-calendar declares no temporal projection");
  return spec;
}

describe("synthetic Google temporal projection fixtures", () => {
  it("retains Gmail's declaration and emits typed scheduled/deadline metadata", () => {
    const gmail = synthGoogle.sources.find((source) => source.id === "gmail");
    const real = realGoogle.sources.find((source) => source.id === "gmail");
    // The synthetic source wraps the real descriptor: its projection declaration
    // must be the one the production source ships, not a fixture-only copy.
    expect(gmail?.documentTemporalProjections).toEqual(real?.documentTemporalProjections);
    expect(gmail?.documentTemporalProjections).toEqual([
      expect.objectContaining({
        slot: "scheduled",
        start: "scheduledAt",
        end: "endsAt",
        timeZone: "timeZone",
        kind: "event",
        modality: "asserted",
      }),
      expect.objectContaining({
        slot: "due",
        start: "dueAt",
        kind: "deadline",
        modality: "asserted",
      }),
    ]);
    // Every ref a document projection reads must be a projectable document
    // field; the fixture mapper below has to populate exactly those.
    for (const spec of gmail?.documentTemporalProjections ?? []) {
      for (const ref of [spec.start, spec.end, spec.label, spec.timeZone, spec.sourceUpdatedAt]) {
        if (ref !== undefined) expect(DOCUMENT_PROJECTION_FIELDS).toContain(ref);
      }
    }

    const entries = loadEmails();
    const scheduled = mapEmail(entries[0]!, {
      sourceId: SourceId("gmail:john.smith@example.com"),
      providerId: ProviderId("google:john.smith@example.com"),
    });
    const due = mapEmail(entries[1]!, {
      sourceId: SourceId("gmail:john.smith@example.com"),
      providerId: ProviderId("google:john.smith@example.com"),
    });
    const both = mapEmail(entries[2]!, {
      sourceId: SourceId("gmail:john.smith@example.com"),
      providerId: ProviderId("google:john.smith@example.com"),
    });

    expect(
      Array.isArray(scheduled)
        ? scheduled[0]?.metadata.scheduledAt
        : scheduled.metadata.scheduledAt,
    ).toBe("2025-09-01T17:00:00Z");
    expect(Array.isArray(due) ? due[0]?.metadata.dueAt : due.metadata.dueAt).toBe(
      "2025-09-07T23:59:00Z",
    );
    const bothParent = Array.isArray(both) ? both[0]! : both;
    expect(bothParent.metadata).toMatchObject({
      scheduledAt: "2025-09-03T18:00:00Z",
      dueAt: "2025-09-05T17:00:00Z",
    });
  });

  it("maps concrete calendar fixtures to projection-eligible bound rows", () => {
    const entry = loadEvents()[0]!;
    const row = mapEventRecord(entry, "john.smith@example.com");
    expect(row).toMatchObject({
      id: entry.externalId,
      source_account: "john.smith@example.com",
      event_id: entry.externalId,
      title: entry.title,
      start_time: entry.startTime,
      end_time: entry.endTime,
      all_day: false,
      temporal_projection_eligible: true,
      status: "confirmed",
    });
    expect(row.duration_minutes).toBe(60);

    // A timed booking is an appointment; the all-day branch is covered below.
    const spec = calendarProjection();
    expect(resolveMapped(spec.kind, row)).toBe("appointment");
    expect(resolveMapped(spec.status ?? "active", row)).toBe("active");
  });

  it("maps an all-day cancelled master onto the columns the projection reads", () => {
    const master: EventEntry = {
      ...loadEvents()[0]!,
      externalId: "synth-gcal-all-day-master",
      allDay: true,
      recurring: true,
      temporalProjectionEligible: false,
      status: "cancelled",
    };
    const row = mapEventRecord(master, "john.smith@example.com");
    expect(row).toMatchObject({
      all_day: true,
      recurring: true,
      temporal_projection_eligible: false,
      status: "cancelled",
    });
    // An all-day row carries no timed duration.
    expect(row.duration_minutes).toBeNull();

    const spec = calendarProjection();
    expect(resolveMapped(spec.kind, row)).toBe("event");
    expect(resolveMapped(spec.status ?? "active", row)).toBe("cancelled");
    // The eligibility gate is a plain boolean column the derivation reads.
    expect(spec.eligibility && row[spec.eligibility]).toBe(false);
  });

  it("paginates the hybrid calendar snapshot and binds every row to its document", async () => {
    const calendar = synthGoogle.sources.find((source) => source.id === "google-calendar");
    expect(calendar?.analyticsSchemas?.[0]?.temporalProjection).toMatchObject({
      slot: "calendar",
      start: "$semanticTime",
      end: "end_time",
      label: "title",
      modality: "scheduled",
      allDay: "all_day",
      eligibility: "temporal_projection_eligible",
      correlationKeys: ["ical_uid"],
    });
    const instance = await calendar!.create(
      {
        accountId: "john.smith@example.com",
        sourceId: SourceId("google-calendar:john.smith@example.com"),
        providerId: ProviderId("google:john.smith@example.com"),
      },
      {},
    );

    const calendarTable = calendar!.analyticsSchemas![0]!.tableName;
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
        expect(row.source_account).toBe("john.smith@example.com");
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
    expect(finalSnapshot).toEqual(loadEvents().map((entry) => entry.externalId));
  });
});
