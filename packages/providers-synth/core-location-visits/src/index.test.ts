// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  canonicalizeInterval,
  isTemporalKind,
  isTemporalModality,
  isTemporalStatus,
  ProviderId,
  SourceId,
} from "@omnesis/types";
import { validateTemporalProjectionContracts } from "@omnesis/source-sdk";
import { rowsFor, writesFor } from "@omnesis/source-sdk/testing";
import {
  loadLocationVisits,
  mapLocationVisitDocument,
  mapLocationVisitRecord,
} from "./fixtures.js";
import { LOCATION_VISITS_SCHEMA } from "./schema.js";
import source from "./index.js";

describe("synthetic Location Visits", () => {
  it("mirrors the native projection contract without projecting raw coordinates into prose", () => {
    expect(LOCATION_VISITS_SCHEMA).toMatchObject({
      tableName: "location_visits",
      semanticTimeColumn: "arrival_time",
      boundDocument: { externalIdColumns: ["id"] },
      temporalProjection: {
        slot: "visit",
        start: "$semanticTime",
        end: "departure_time",
        label: "place_name",
        kind: "visit",
        modality: "observed",
        status: "completed",
      },
    });
    const entry = loadLocationVisits()[0]!;
    const row = mapLocationVisitRecord(entry);
    const document = mapLocationVisitDocument(entry, {
      sourceId: SourceId("core-location-visits:ios-synth-johnsmith"),
      providerId: ProviderId("core-location-visits:ios-synth-johnsmith"),
    });
    expect(row.id).toBe(document.externalId);
    expect(row.duration_seconds).toBe(9_000);
    expect(document.content).toContain(entry.placeName);
    expect(document.content).not.toContain(String(entry.latitude));
    expect(document.content).not.toContain(String(entry.longitude));
  });

  it("declares only vocabulary values and satisfies the shared projection contract", () => {
    const projection = LOCATION_VISITS_SCHEMA.temporalProjection!;
    // A dwell has one nature, one mode of knowing, and one lifecycle state for
    // every row, so each of these is a constant rather than a per-row mapping.
    expect(isTemporalKind(projection.kind)).toBe(true);
    expect(isTemporalModality(projection.modality)).toBe(true);
    expect(isTemporalStatus(projection.status)).toBe(true);

    // The declaration must survive the same validator the gateway applies to the
    // native device schema this mirrors: `$semanticTime`-pinned start, declared
    // columns, and DATE/TIMESTAMPTZ bounds.
    expect(() =>
      validateTemporalProjectionContracts([LOCATION_VISITS_SCHEMA], "core-location-visits"),
    ).not.toThrow();
  });

  it("projects a dwell as an instant interval bounded by arrival and departure", () => {
    const entry = loadLocationVisits()[0]!;
    const row = mapLocationVisitRecord(entry);
    const interval = canonicalizeInterval({
      start: row[LOCATION_VISITS_SCHEMA.semanticTimeColumn!],
      end: row.departure_time,
    });

    expect(interval.precision).toBe("instant");
    expect(interval.allDay).toBe(false);
    expect(interval.startCanonical).toBe(new Date(entry.arrivalTime).toISOString());
    expect(interval.endCanonical).toBe(new Date(entry.departureTime).toISOString());
    // A visit always declares its departure, so its interval carries the real
    // dwell rather than collapsing to the empty interval of an endless fact.
    expect(interval.endExclusiveMs - interval.startMs).toBe(Number(row.duration_seconds) * 1_000);
  });

  it("paginates visits and publishes complete row/document snapshots only on the final page", async () => {
    const instance = await source.create!({
      accountId: "ios-synth-johnsmith",
      sourceId: SourceId("core-location-visits:ios-synth-johnsmith"),
      providerId: ProviderId("core-location-visits:ios-synth-johnsmith"),
    });

    const first = await instance.syncStructured!(null);
    expect(first.hasMore).toBe(true);
    const firstRows = rowsFor(first, LOCATION_VISITS_SCHEMA.tableName);
    expect(firstRows).toHaveLength(5);
    expect(writesFor(first, LOCATION_VISITS_SCHEMA.tableName)[0]?.presentIds).toBeUndefined();
    expect(first.presentExternalIds).toBeUndefined();
    expect(firstRows.every((row, index) => row.id === first.documents?.[index]?.externalId)).toBe(
      true,
    );

    const final = await instance.syncStructured!(first.cursor);
    expect(final.hasMore).toBe(false);
    expect(rowsFor(final, LOCATION_VISITS_SCHEMA.tableName)).toHaveLength(1);
    const expectedIds = loadLocationVisits().map((entry) => entry.id);
    expect(writesFor(final, LOCATION_VISITS_SCHEMA.tableName)[0]?.presentIds).toEqual(expectedIds);
    expect(final.presentExternalIds).toEqual(expectedIds);
  });
});
