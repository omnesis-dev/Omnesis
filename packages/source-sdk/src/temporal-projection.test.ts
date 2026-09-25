// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  RETIRED_TEMPORAL_KINDS,
  TEMPORAL_KINDS,
  TEMPORAL_MODALITIES,
} from "@omnesis/types/temporal-vocabulary";
import {
  normalizeProjectionSpecFields,
  normalizeSchemaProjectionFields,
  type AnalyticsTableSchema,
  type DocumentTemporalProjectionSpec,
  validateDocumentTemporalProjectionContracts,
  validateTemporalProjectionContracts,
} from "./structured-source.js";

function schemaWith(
  temporalProjection: AnalyticsTableSchema["temporalProjection"],
  eligibilityType: "BOOLEAN" | "VARCHAR" = "BOOLEAN",
): AnalyticsTableSchema {
  return {
    tableName: "calendar_events",
    displayName: "Calendar events",
    description: "Synthetic calendar events",
    columns: [
      { name: "id", type: "VARCHAR", description: "Stable id" },
      { name: "title", type: "VARCHAR", description: "Title" },
      { name: "start_time", type: "TIMESTAMPTZ", description: "Start" },
      { name: "end_time", type: "TIMESTAMPTZ", description: "End" },
      { name: "all_day", type: "BOOLEAN", description: "All day" },
      {
        name: "projection_eligible",
        type: eligibilityType,
        description: "Whether this row is an occurrence",
      },
      { name: "status", type: "VARCHAR", description: "Provider status" },
    ],
    primaryKey: ["id"],
    semanticTimeColumn: "start_time",
    record: { titleColumns: ["title"], keyColumns: ["start_time"] },
    temporalProjection,
  };
}

/**
 * A calendar table's projection: an all-day row states an `event`, a timed row
 * an `appointment`, and the provider's own lifecycle string maps onto the
 * status vocabulary.
 */
const projection: NonNullable<AnalyticsTableSchema["temporalProjection"]> = {
  slot: "calendar",
  start: "$semanticTime",
  end: "end_time",
  label: "title",
  kind: { from: "all_day", map: { true: "event" }, default: "appointment" },
  modality: "scheduled",
  allDay: "all_day",
  eligibility: "projection_eligible",
  status: { from: "status", map: { cancelled: "cancelled" }, default: "active" },
};

describe("validateTemporalProjectionContracts", () => {
  it("accepts a fully declared analytics projection", () => {
    expect(() =>
      validateTemporalProjectionContracts([schemaWith(projection)], "test"),
    ).not.toThrow();
  });

  it("accepts every canonical kind and modality as a constant", () => {
    for (const kind of TEMPORAL_KINDS) {
      for (const modality of TEMPORAL_MODALITIES) {
        expect(() =>
          validateTemporalProjectionContracts(
            [schemaWith({ ...projection, kind, modality })],
            "test",
          ),
        ).not.toThrow();
      }
    }
  });

  it("rejects a retired kind spelling — a spec declares the canonical value", () => {
    for (const retired of Object.keys(RETIRED_TEMPORAL_KINDS)) {
      expect(() =>
        validateTemporalProjectionContracts(
          // Deliberately outside the canonical union: the spec surface is
          // storage-facing, so it accepts no alias.
          [schemaWith({ ...projection, kind: retired as never })],
          "test",
        ),
      ).toThrow(new RegExp(`unsupported kind '${retired}'`));
    }
  });

  it("rejects a start that is not the table's semantic time", () => {
    expect(() =>
      validateTemporalProjectionContracts(
        [schemaWith({ ...projection, start: "end_time" })],
        "test",
      ),
    ).toThrow(/start must be '\$semanticTime'/);
  });

  it("rejects a projection on a timeless table", () => {
    const schema = schemaWith(projection);
    schema.semanticTimeColumn = null;

    expect(() => validateTemporalProjectionContracts([schema], "test")).toThrow(
      /requires a non-null semanticTimeColumn/,
    );
  });

  it("rejects a slot that is not lower-snake", () => {
    expect(() =>
      validateTemporalProjectionContracts(
        [schemaWith({ ...projection, slot: "Calendar" })],
        "test",
      ),
    ).toThrow(/slot must match/);
  });

  it("rejects an unknown eligibility gate", () => {
    expect(() =>
      validateTemporalProjectionContracts(
        [schemaWith({ ...projection, eligibility: "missing" })],
        "test",
      ),
    ).toThrow(/eligibility references unknown column 'missing'/);
  });

  it("rejects a non-boolean eligibility gate", () => {
    expect(() =>
      validateTemporalProjectionContracts([schemaWith(projection, "VARCHAR")], "test"),
    ).toThrow(/eligibility column 'projection_eligible' must be BOOLEAN/);
  });

  it("rejects timezone-less TIMESTAMP facts even when a time-zone column is declared", () => {
    const schema = schemaWith({ ...projection, timeZone: "time_zone" });
    schema.columns = [
      ...schema.columns.map((column) =>
        column.name === "start_time" ? { ...column, type: "TIMESTAMP" as const } : column,
      ),
      { name: "time_zone", type: "VARCHAR", description: "IANA time zone" },
    ];

    expect(() => validateTemporalProjectionContracts([schema], "test")).toThrow(
      /timezone-less TIMESTAMP projection columns are not supported/,
    );
  });

  describe("mapped fields", () => {
    it("rejects a mapped kind reading an unknown column", () => {
      expect(() =>
        validateTemporalProjectionContracts(
          [
            schemaWith({
              ...projection,
              kind: { from: "missing", map: { true: "event" }, default: "appointment" },
            }),
          ],
          "test",
        ),
      ).toThrow(/kind\.from references unknown column 'missing'/);
    });

    it("rejects an empty map, which is a constant in disguise", () => {
      expect(() =>
        validateTemporalProjectionContracts(
          [
            schemaWith({
              ...projection,
              kind: { from: "all_day", map: {}, default: "appointment" },
            }),
          ],
          "test",
        ),
      ).toThrow(/kind map must not be empty/);
    });

    it("rejects a mapped value outside the vocabulary", () => {
      expect(() =>
        validateTemporalProjectionContracts(
          [
            schemaWith({
              ...projection,
              // Provider-shaped spelling that no vocabulary value matches.
              kind: { from: "all_day", map: { true: "meeting" as never }, default: "appointment" },
            }),
          ],
          "test",
        ),
      ).toThrow(/invalid kind map entry 'true'/);
    });

    it("rejects a default outside the vocabulary", () => {
      expect(() =>
        validateTemporalProjectionContracts(
          [
            schemaWith({
              ...projection,
              status: {
                from: "status",
                map: { cancelled: "cancelled" },
                default: "pending" as never,
              },
            }),
          ],
          "test",
        ),
      ).toThrow(/unsupported status default 'pending'/);
    });
  });
});

describe("validateDocumentTemporalProjectionContracts", () => {
  const spec: DocumentTemporalProjectionSpec = {
    slot: "booking",
    start: "scheduledAt",
    end: "endsAt",
    kind: "appointment",
    modality: "scheduled",
    status: "active",
    timeZone: "timeZone",
  };

  it("accepts a document projection over the typed metadata fields", () => {
    expect(() => validateDocumentTemporalProjectionContracts([spec], "test")).not.toThrow();
  });

  it("accepts the record's own semantic time as the start", () => {
    expect(() =>
      validateDocumentTemporalProjectionContracts(
        [{ ...spec, start: "$semanticTime", end: undefined }],
        "test",
      ),
    ).not.toThrow();
  });

  it("accepts a mapped source lifecycle status", () => {
    expect(() =>
      validateDocumentTemporalProjectionContracts(
        [
          {
            ...spec,
            status: {
              from: "status",
              map: { open: "active", completed: "completed", canceled: "cancelled" },
              default: "active",
            },
          },
        ],
        "test",
      ),
    ).not.toThrow();
  });

  it("rejects a field that is not projectable", () => {
    expect(() =>
      validateDocumentTemporalProjectionContracts([{ ...spec, label: "title" as never }], "test"),
    ).toThrow(/label references 'title', which is not a projectable document field/);
  });

  it("rejects a projectable field that carries no date", () => {
    expect(() =>
      validateDocumentTemporalProjectionContracts([{ ...spec, start: "timeZone" }], "test"),
    ).toThrow(/start field 'timeZone' does not carry a date/);
  });

  it("rejects lifecycle status as a temporal field", () => {
    expect(() =>
      validateDocumentTemporalProjectionContracts([{ ...spec, start: "status" }], "test"),
    ).toThrow(/start field 'status' does not carry a date/);
  });

  it("rejects an all-day gate, which documents infer from the date itself", () => {
    expect(() =>
      validateDocumentTemporalProjectionContracts([{ ...spec, allDay: "dueAt" }], "test"),
    ).toThrow(/allDay is not supported on documents \(got 'dueAt'\)/);
  });

  it("rejects an eligibility gate", () => {
    expect(() =>
      validateDocumentTemporalProjectionContracts([{ ...spec, eligibility: "dueAt" }], "test"),
    ).toThrow(/eligibility is not supported on documents \(got 'dueAt'\)/);
  });

  it("rejects two specs claiming the same slot", () => {
    expect(() =>
      validateDocumentTemporalProjectionContracts([spec, { ...spec, start: "dueAt" }], "test"),
    ).toThrow(/duplicate slot 'booking'/);
  });
});

describe("legacy projection field names from an installed client", () => {
  // A phone ships its own copy of this contract and upgrades on its own
  // schedule, so the gateway sees the older spelling long after the rename.
  // This is the exact spec an installed location-visits build sends.
  const shippedSpec = {
    slot: "visit",
    startColumn: "$semanticTime",
    endColumn: "departure_time",
    labelColumn: "place_name",
    kind: "calendar_event",
    modality: "observed",
    statusColumn: "state",
    statusMap: { done: "completed" },
    defaultStatus: "active",
    allDayColumn: "all_day",
    eligibilityColumn: "eligible",
    correlationKeyColumns: ["visit_id"],
  };

  it("rewrites every renamed field onto the current shape", () => {
    expect(normalizeProjectionSpecFields(shippedSpec)).toEqual({
      slot: "visit",
      start: "$semanticTime",
      end: "departure_time",
      label: "place_name",
      // A retired kind spelling resolves rather than failing the page.
      kind: "appointment",
      modality: "observed",
      status: { from: "state", map: { done: "completed" }, default: "active" },
      allDay: "all_day",
      eligibility: "eligible",
      correlationKeys: ["visit_id"],
    });
  });

  it("defaults a status with no declared fallback to active", () => {
    const { statusMap: _map, defaultStatus: _default, ...noFallback } = shippedSpec;
    const result = normalizeProjectionSpecFields(noFallback) as { status: { default: string } };
    expect(result.status.default).toBe("active");
  });

  it("leaves a spec already on the current names untouched", () => {
    const current = {
      slot: "visit",
      start: "$semanticTime",
      label: "place_name",
      kind: "visit",
      modality: "observed",
    };
    expect(normalizeProjectionSpecFields(current)).toEqual(current);
  });

  it("produces a spec the validator accepts", () => {
    const schema = normalizeSchemaProjectionFields({
      tableName: "location_visits",
      displayName: "Visits",
      description: "d",
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        { name: "arrival_time", type: "TIMESTAMPTZ", description: "start" },
        { name: "departure_time", type: "TIMESTAMPTZ", description: "end" },
        { name: "place_name", type: "VARCHAR", description: "label" },
        { name: "state", type: "VARCHAR", description: "state" },
        { name: "all_day", type: "BOOLEAN", description: "all day" },
        { name: "eligible", type: "BOOLEAN", description: "eligible" },
        { name: "visit_id", type: "VARCHAR", description: "correlation" },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: "arrival_time",
      record: { titleColumns: ["place_name"], keyColumns: ["place_name"] },
      temporalProjection: shippedSpec as never,
    });
    expect(() => validateTemporalProjectionContracts([schema], "wire")).not.toThrow();
  });
});
