// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { validateBoundDocuments, type AnalyticsTableSchema } from "./structured-source.js";

function schema(over: Partial<AnalyticsTableSchema>): AnalyticsTableSchema {
  return {
    tableName: "t",
    displayName: "T",
    description: "d",
    columns: [
      { name: "id", type: "BIGINT", description: "" },
      { name: "distance_m", type: "DOUBLE", description: "" },
    ],
    primaryKey: ["id"],
    semanticTimeColumn: null,
    record: { titleColumns: ["id"], keyColumns: ["id"] },
    ...over,
  };
}

describe("validateBoundDocuments", () => {
  it("accepts a 1:1 single-column binding", () => {
    expect(() =>
      validateBoundDocuments([schema({ boundDocument: { externalIdColumns: ["id"] } })], "t"),
    ).not.toThrow();
  });

  it("accepts a composite binding split between externalId and source-discriminator columns", () => {
    const s = schema({
      columns: [
        { name: "source", type: "VARCHAR", description: "" },
        { name: "event_id", type: "VARCHAR", description: "" },
      ],
      primaryKey: ["source", "event_id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["event_id"], keyColumns: ["event_id", "source"] },
      boundDocument: { externalIdColumns: ["event_id"], sourceKeyColumns: ["source"] },
    });
    expect(() => validateBoundDocuments([s], "t")).not.toThrow();
  });

  it("rejects a binding referencing a column the table doesn't declare", () => {
    expect(() =>
      validateBoundDocuments([schema({ boundDocument: { externalIdColumns: ["nope"] } })], "ctx"),
    ).toThrow(/references column 'nope'/);
  });

  it("rejects a binding that doesn't reconstruct the full primary key", () => {
    // pk is composite but the binding only supplies one of the two columns →
    // the lookup would match many rows, not one.
    const s = schema({
      columns: [
        { name: "source", type: "VARCHAR", description: "" },
        { name: "event_id", type: "VARCHAR", description: "" },
      ],
      primaryKey: ["source", "event_id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["event_id"], keyColumns: ["event_id", "source"] },
      boundDocument: { externalIdColumns: ["event_id"] },
    });
    expect(() => validateBoundDocuments([s], "ctx")).toThrow(
      /must reconstruct the full primaryKey/,
    );
  });

  it("rejects an empty externalIdColumns", () => {
    expect(() =>
      validateBoundDocuments([schema({ boundDocument: { externalIdColumns: [] } })], "ctx"),
    ).toThrow(/non-empty externalIdColumns/);
  });

  it("ignores schemas without a boundDocument", () => {
    expect(() => validateBoundDocuments([schema({})], "t")).not.toThrow();
  });
});
