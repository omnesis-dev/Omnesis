// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { analyticsIngestBody } from "./analytics.js";

const baseSchema = {
  tableName: "demo_records",
  displayName: "Demo Records",
  description: "Fictional analytics rows",
  columns: [
    { name: "id", type: "VARCHAR", description: "Row id" },
    { name: "amount", type: "DECIMAL(18, 4)", description: "Amount", nullable: true },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["id"], keyColumns: ["id", "amount"] },
};

describe("analyticsIngestBody", () => {
  it.each([
    null,
    "parent",
    [],
    {},
    { table: "parent" },
    { table: "parent; DROP TABLE records", column: "id", parentColumn: "id" },
    { table: "demo_records", column: "id", parentColumn: "id" },
    { table: "parent", column: "missing", parentColumn: "id" },
    { table: "parent", column: "id", parentColumn: "id", extra: true },
  ])(
    "rejects malformed ownership relations at the HTTP boundary: %j",
    (sharedDiscriminatorParent) => {
      expect(
        analyticsIngestBody.safeParse({
          tableName: baseSchema.tableName,
          records: [],
          schema: { ...baseSchema, sharedDiscriminatorColumn: "id", sharedDiscriminatorParent },
        }).success,
      ).toBe(false);
    },
  );
  it.each([null, undefined, {}, [], ["a", "b"]])(
    "rejects structured or missing tuple-key values %j",
    (id) => {
      for (const field of ["presentKeys", "deletedKeys"]) {
        expect(
          analyticsIngestBody.safeParse({
            tableName: "demo_records",
            records: [],
            [field]: [{ id }],
          }).success,
        ).toBe(false);
      }
    },
  );
  it("normalizes runtime schema column types at the HTTP boundary", () => {
    const parsed = analyticsIngestBody.parse({
      tableName: "demo_records",
      records: [],
      schema: baseSchema,
    });

    expect(parsed.schema?.columns[1]?.type).toBe("DECIMAL(18,4)");
  });

  it("rejects schema column type fragments before they reach DuckDB DDL", () => {
    const parsed = analyticsIngestBody.safeParse({
      tableName: "demo_records",
      records: [],
      schema: {
        ...baseSchema,
        columns: [
          baseSchema.columns[0],
          {
            name: "payload",
            type: "VARCHAR); DROP TABLE _analytics_catalog; --",
            description: "Payload",
          },
        ],
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/unsupported analytics column type/);
    }
  });
});
