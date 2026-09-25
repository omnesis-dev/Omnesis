// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import {
  deriveRecordCitationFields,
  deriveRecordTitle,
  REDACTED_VALUE,
  validateRecordCitationContract,
  type AnalyticsTableSchema,
} from "./structured-source.js";

function tableWith(overrides: Partial<AnalyticsTableSchema>): AnalyticsTableSchema {
  return {
    tableName: "demo_records",
    displayName: "Demo Records",
    description: "A fictional demo table",
    columns: [
      { name: "id", type: "VARCHAR", description: "id" },
      { name: "merchant", type: "VARCHAR", description: "merchant", nullable: true },
      { name: "amount", type: "DECIMAL(18,4)", description: "amount", nullable: true },
      { name: "occurred_at", type: "TIMESTAMPTZ", description: "when it happened", nullable: true },
    ],
    primaryKey: ["id"],
    semanticTimeColumn: "occurred_at",
    record: { titleColumns: ["merchant"], keyColumns: ["merchant", "amount", "occurred_at"] },
    ...overrides,
  };
}

describe("deriveRecordTitle", () => {
  it("joins titleColumns when no template", () => {
    const spec = { titleColumns: ["merchant", "amount"], keyColumns: ["merchant"] };
    expect(deriveRecordTitle(spec, { merchant: "Stellar Sound", amount: "42.00" })).toBe(
      "Stellar Sound · 42.00",
    );
  });

  it("skips null/empty values when joining", () => {
    const spec = { titleColumns: ["merchant", "amount"], keyColumns: ["merchant"] };
    expect(deriveRecordTitle(spec, { merchant: "Studio Northstar", amount: null })).toBe(
      "Studio Northstar",
    );
  });

  it("substitutes a titleTemplate", () => {
    const spec = {
      titleColumns: ["merchant", "amount"],
      titleTemplate: "{merchant} — {amount}",
      keyColumns: ["merchant"],
    };
    expect(deriveRecordTitle(spec, { merchant: "Riverside Estate", amount: "7.50" })).toBe(
      "Riverside Estate — 7.50",
    );
  });

  it("renders null template values as empty and trims", () => {
    const spec = {
      titleColumns: ["merchant"],
      titleTemplate: "{merchant}",
      keyColumns: ["merchant"],
    };
    expect(deriveRecordTitle(spec, { merchant: null })).toBe("");
  });

  it("returns empty string when nothing resolves", () => {
    const spec = { titleColumns: ["merchant"], keyColumns: ["merchant"] };
    expect(deriveRecordTitle(spec, {})).toBe("");
  });
});

describe("validateRecordCitationContract", () => {
  it("accepts a column-named semanticTimeColumn", () => {
    expect(() => validateRecordCitationContract([tableWith({})], "test")).not.toThrow();
  });

  it("accepts explicit null semanticTimeColumn (timeless table)", () => {
    expect(() =>
      validateRecordCitationContract([tableWith({ semanticTimeColumn: null })], "test"),
    ).not.toThrow();
  });

  it("rejects a semanticTimeColumn naming a missing column", () => {
    expect(() =>
      validateRecordCitationContract([tableWith({ semanticTimeColumn: "nope" })], "test"),
    ).toThrow(/semanticTimeColumn 'nope' is not a declared column/);
  });

  it("rejects a semanticTimeColumn typed TIMESTAMP", () => {
    // A timezone-less anchor would let the reading host's zone decide where
    // the record lands on a timeline.
    expect(() =>
      validateRecordCitationContract(
        [
          tableWith({
            columns: [
              { name: "id", type: "VARCHAR", description: "id" },
              { name: "merchant", type: "VARCHAR", description: "merchant", nullable: true },
              { name: "amount", type: "DECIMAL(18,4)", description: "amount", nullable: true },
              { name: "occurred_at", type: "TIMESTAMP", description: "when", nullable: true },
            ],
          }),
        ],
        "test",
      ),
    ).toThrow(/semanticTimeColumn 'occurred_at' must be DATE or TIMESTAMPTZ \(got TIMESTAMP\)/);
  });

  it("accepts a DATE anchor", () => {
    expect(() =>
      validateRecordCitationContract(
        [
          tableWith({
            columns: [
              { name: "id", type: "VARCHAR", description: "id" },
              { name: "merchant", type: "VARCHAR", description: "merchant", nullable: true },
              { name: "amount", type: "DECIMAL(18,4)", description: "amount", nullable: true },
              { name: "occurred_at", type: "DATE", description: "when", nullable: true },
            ],
          }),
        ],
        "test",
      ),
    ).not.toThrow();
  });

  it("accepts a TIMESTAMPTZ anchor", () => {
    expect(() => validateRecordCitationContract([tableWith({})], "test")).not.toThrow();
  });

  it("does not type-check the anchor when semanticTimeColumn is explicitly null", () => {
    // A TIMESTAMP column is legal on a timeless table — it just isn't the
    // anchor, so nothing reads it as a point in time.
    expect(() =>
      validateRecordCitationContract(
        [
          tableWith({
            semanticTimeColumn: null,
            columns: [
              { name: "id", type: "VARCHAR", description: "id" },
              { name: "merchant", type: "VARCHAR", description: "merchant", nullable: true },
              { name: "amount", type: "DECIMAL(18,4)", description: "amount", nullable: true },
              { name: "occurred_at", type: "TIMESTAMP", description: "when", nullable: true },
            ],
          }),
        ],
        "test",
      ),
    ).not.toThrow();
  });

  it("rejects a missing record spec", () => {
    expect(() =>
      validateRecordCitationContract(
        [tableWith({ record: undefined as unknown as AnalyticsTableSchema["record"] })],
        "test",
      ),
    ).toThrow(/must declare a record display spec/);
  });

  it("rejects empty titleColumns", () => {
    expect(() =>
      validateRecordCitationContract(
        [tableWith({ record: { titleColumns: [], keyColumns: ["merchant"] } })],
        "test",
      ),
    ).toThrow(/titleColumns must be non-empty/);
  });

  it("rejects record columns that do not exist", () => {
    expect(() =>
      validateRecordCitationContract(
        [tableWith({ record: { titleColumns: ["ghost"], keyColumns: ["merchant"] } })],
        "test",
      ),
    ).toThrow(/references column 'ghost' which is not declared/);
  });

  it("rejects a titleTemplate placeholder absent from titleColumns", () => {
    expect(() =>
      validateRecordCitationContract(
        [
          tableWith({
            record: {
              titleColumns: ["merchant"],
              titleTemplate: "{merchant} {amount}",
              keyColumns: ["merchant"],
            },
          }),
        ],
        "test",
      ),
    ).toThrow(/references '\{amount\}' which is not listed in titleColumns/);
  });

  describe("requireRecord: false (gateway ingest boundary, clients without record citations)", () => {
    it("accepts a schema that omits the record spec entirely", () => {
      expect(() =>
        validateRecordCitationContract(
          [tableWith({ record: undefined as unknown as AnalyticsTableSchema["record"] })],
          "test",
          { requireRecord: false },
        ),
      ).not.toThrow();
    });

    it("accepts a schema that omits semanticTimeColumn (undefined → timeless)", () => {
      expect(() =>
        validateRecordCitationContract(
          [
            tableWith({
              semanticTimeColumn:
                undefined as unknown as AnalyticsTableSchema["semanticTimeColumn"],
              record: undefined as unknown as AnalyticsTableSchema["record"],
            }),
          ],
          "test",
          { requireRecord: false },
        ),
      ).not.toThrow();
    });

    it("still rejects a present-but-malformed record spec", () => {
      expect(() =>
        validateRecordCitationContract(
          [tableWith({ record: { titleColumns: ["ghost"], keyColumns: ["merchant"] } })],
          "test",
          { requireRecord: false },
        ),
      ).toThrow(/references column 'ghost' which is not declared/);
    });

    it("still rejects a present semanticTimeColumn naming a missing column", () => {
      expect(() =>
        validateRecordCitationContract([tableWith({ semanticTimeColumn: "nope" })], "test", {
          requireRecord: false,
        }),
      ).toThrow(/semanticTimeColumn 'nope' is not a declared column/);
    });
  });
});

describe("deriveRecordCitationFields", () => {
  function sensitiveTable(): AnalyticsTableSchema {
    return tableWith({
      columns: [
        { name: "id", type: "VARCHAR", description: "Transaction id" },
        { name: "merchant", type: "VARCHAR", description: "Merchant", nullable: true },
        { name: "amount", type: "DECIMAL(18,4)", description: "Amount", nullable: true },
        { name: "token", type: "VARCHAR", description: "Auth token", sensitive: true },
        { name: "occurred_at", type: "TIMESTAMPTZ", description: "When", nullable: true },
      ],
      record: { titleColumns: ["merchant"], keyColumns: ["merchant", "amount", "token"] },
    });
  }

  it("derives title, key fields, and the declared semantic time", () => {
    const fields = deriveRecordCitationFields(sensitiveTable(), {
      id: "txn-1",
      merchant: "Stellar Sound",
      amount: "42.00",
      token: "secret-abc",
      occurred_at: "2026-05-23T10:00:00.000Z",
    });
    expect(fields.title).toBe("Stellar Sound");
    expect(fields.semanticTime).toBe("2026-05-23T10:00:00.000Z");
    expect(fields.keyFields).toEqual([
      { label: "Merchant", value: "Stellar Sound" },
      { label: "Amount", value: "42.00" },
      { label: "Auth token", value: REDACTED_VALUE },
    ]);
  });

  it("redacts sensitive columns in the snapshot and key fields", () => {
    const fields = deriveRecordCitationFields(sensitiveTable(), {
      id: "txn-1",
      merchant: "Studio Northstar",
      token: "secret-xyz",
      occurred_at: "2026-05-24T00:00:00.000Z",
    });
    expect(fields.redactedSnapshot.token).toBe(REDACTED_VALUE);
    expect(fields.redactedSnapshot.merchant).toBe("Studio Northstar");
    // The key field for the sensitive column is masked too.
    expect(fields.keyFields.find((f) => f.label === "Auth token")?.value).toBe(REDACTED_VALUE);
  });

  it("does not redact a null sensitive value (nothing to mask)", () => {
    const fields = deriveRecordCitationFields(sensitiveTable(), {
      id: "txn-1",
      merchant: "Riverside Estate",
      token: null,
      occurred_at: "2026-05-25T00:00:00.000Z",
    });
    expect(fields.redactedSnapshot.token).toBeNull();
  });

  it("returns null semanticTime for a timeless table", () => {
    const fields = deriveRecordCitationFields(tableWith({ semanticTimeColumn: null }), {
      id: "txn-1",
      merchant: "Stellar Sound",
      occurred_at: "2026-05-23T10:00:00.000Z",
    });
    expect(fields.semanticTime).toBeNull();
  });

  it("returns null semanticTime when the declared column is empty on this row", () => {
    const fields = deriveRecordCitationFields(sensitiveTable(), {
      id: "txn-1",
      merchant: "Stellar Sound",
      occurred_at: null,
    });
    expect(fields.semanticTime).toBeNull();
  });

  it("falls back to the display name when no title column resolves", () => {
    const fields = deriveRecordCitationFields(sensitiveTable(), {
      id: "txn-1",
      merchant: null,
      occurred_at: "2026-05-23T10:00:00.000Z",
    });
    expect(fields.title).toBe("Demo Records");
  });

  it("strips a trailing parenthetical from a key-field label", () => {
    const table = tableWith({
      columns: [
        { name: "id", type: "VARCHAR", description: "Id" },
        {
          name: "sport_type",
          type: "VARCHAR",
          description: "Strava sport type (Run, Ride, Swim, Walk, Hike, VirtualRide, etc.)",
        },
        { name: "occurred_at", type: "TIMESTAMPTZ", description: "When" },
      ],
      record: { titleColumns: ["sport_type"], keyColumns: ["sport_type"] },
    });
    const fields = deriveRecordCitationFields(table, { id: "1", sport_type: "Swim" });
    expect(fields.keyFields[0]).toEqual({ label: "Strava sport type", value: "Swim" });
  });

  it("collapses a zone-bearing semantic time to one canonical UTC instant", () => {
    const fields = deriveRecordCitationFields(sensitiveTable(), {
      id: "txn-1",
      merchant: "Stellar Sound",
      occurred_at: "2026-06-03 15:59:37+01",
    });
    expect(fields.semanticTime).toBe("2026-06-03T14:59:37.000Z");
  });

  it("gives one instant one spelling, whatever zone the database rendered it in", () => {
    // Consumers place record citations beside document timestamps — which are
    // UTC ISO — and some order them as strings. Two spellings of the same
    // instant would sort by their offset rather than by when they happened.
    const spellings = [
      "2026-06-03 15:59:37+01",
      "2026-06-03 14:59:37+00",
      "2026-06-03 09:59:37-05",
    ];
    const rendered = spellings.map(
      (occurred_at) =>
        deriveRecordCitationFields(sensitiveTable(), { id: "1", merchant: "X", occurred_at })
          .semanticTime,
    );
    expect(new Set(rendered).size).toBe(1);
    expect(rendered[0]).toBe("2026-06-03T14:59:37.000Z");
  });

  it("leaves a date-only or already-ISO semantic time unchanged", () => {
    const dateOnly = deriveRecordCitationFields(sensitiveTable(), {
      id: "1",
      merchant: "X",
      occurred_at: "2026-06-03",
    });
    expect(dateOnly.semanticTime).toBe("2026-06-03");
    const iso = deriveRecordCitationFields(sensitiveTable(), {
      id: "1",
      merchant: "X",
      occurred_at: "2026-06-03T15:59:37.000Z",
    });
    expect(iso.semanticTime).toBe("2026-06-03T15:59:37.000Z");
  });
});
