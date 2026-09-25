// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  normalizeAnalyticsColumnType,
  normalizeAnalyticsSchemaColumnTypes,
  validateAnalyticsSchemaColumnTypes,
  type AnalyticsTableSchema,
} from "./structured-source.js";

const schema: AnalyticsTableSchema = {
  tableName: "demo_records",
  displayName: "Demo Records",
  description: "Fictional analytics rows",
  columns: [
    { name: "id", type: "VARCHAR", description: "Row id" },
    { name: "amount", type: "DECIMAL(18,4)", description: "Amount", nullable: true },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["id"], keyColumns: ["id", "amount"] },
};

describe("analytics column type normalization", () => {
  it("normalizes accepted aliases and bounded DECIMAL forms", () => {
    expect(normalizeAnalyticsColumnType(" text ", "test")).toBe("VARCHAR");
    expect(normalizeAnalyticsColumnType("timestamp with time zone", "test")).toBe("TIMESTAMPTZ");
    expect(normalizeAnalyticsColumnType("decimal(18, 4)", "test")).toBe("DECIMAL(18,4)");
  });

  it("rejects arbitrary SQL fragments", () => {
    expect(() =>
      normalizeAnalyticsColumnType("VARCHAR); DROP TABLE demo_records; --", "test"),
    ).toThrow(/unsupported analytics column type/);
  });

  it("rejects out-of-range DECIMAL declarations", () => {
    expect(() => normalizeAnalyticsColumnType("DECIMAL(39,2)", "test")).toThrow(
      /precision must be between 1 and 38/,
    );
    expect(() => normalizeAnalyticsColumnType("DECIMAL(4,8)", "test")).toThrow(
      /scale must be between 0 and precision/,
    );
  });

  it("normalizes a schema without mutating the caller's object", () => {
    const normalized = normalizeAnalyticsSchemaColumnTypes(
      {
        ...schema,
        columns: [
          schema.columns[0],
          { name: "notes", type: "TEXT", description: "Notes", nullable: true },
        ],
      },
      "test",
    );

    expect(normalized.columns[1]).toMatchObject({ name: "notes", type: "VARCHAR" });
    expect(schema.columns).toHaveLength(2);
  });

  it("accepts only an explicit true dynamic-column opt-in", () => {
    expect(
      normalizeAnalyticsSchemaColumnTypes({ ...schema, dynamicColumns: true }, "test")
        .dynamicColumns,
    ).toBe(true);
    expect(() =>
      normalizeAnalyticsSchemaColumnTypes({ ...schema, dynamicColumns: "yes" }, "test"),
    ).toThrow(/dynamicColumns must be true/);
  });

  it("validates every schema in a descriptor", () => {
    expect(() => validateAnalyticsSchemaColumnTypes([schema], "test")).not.toThrow();
    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [{ name: "id", type: "JSON); DROP TABLE demo_records; --" }],
          },
        ],
        "test",
      ),
    ).toThrow(/unsupported analytics column type/);
  });

  it("validates bounded source-owned categorical values", () => {
    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "status",
                type: "VARCHAR",
                description: "Fictional row status",
                allowedValues: ["ready", "paused"],
              },
            ],
          },
        ],
        "test",
      ),
    ).not.toThrow();

    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "activity_type",
                type: "VARCHAR",
                description: "Extensible fictional activity vocabulary",
                canonicalValues: ["running", "cycling"],
                valueAliases: {
                  running: ["run", "jogging"],
                  cycling: ["bike ride"],
                },
                categoricalRole: "selector",
              },
            ],
          },
        ],
        "test",
      ),
    ).not.toThrow();
    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "activity_type",
                type: "VARCHAR",
                description: "Extensible fictional activity vocabulary",
                canonicalValues: ["running"],
                valueAliases: { cycling: ["bike ride"] },
              },
            ],
          },
        ],
        "test",
      ),
    ).toThrow(/valueAliases key 'cycling' is not in the source-owned vocabulary/);
    for (const valueAliases of [
      { running: [] },
      { running: Array.from({ length: 9 }, (_, index) => `alias ${index}`) },
      { running: ["run", "run"] },
      { running: ["x".repeat(121)] },
    ]) {
      expect(() =>
        validateAnalyticsSchemaColumnTypes(
          [
            {
              ...schema,
              columns: [
                {
                  name: "activity_type",
                  type: "VARCHAR",
                  description: "Extensible fictional activity vocabulary",
                  canonicalValues: ["running"],
                  valueAliases,
                },
              ],
            },
          ],
          "test",
        ),
      ).toThrow(/valueAliases/);
    }
    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "amount",
                type: "DOUBLE",
                description: "Fictional amount",
                valueAliases: { high: ["large"] },
              },
            ],
          },
        ],
        "test",
      ),
    ).toThrow(/valueAliases must be an object on a VARCHAR column/);
    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "activity_type",
                type: "VARCHAR",
                description: "Fictional activity",
                categoricalRole: "series",
              },
            ],
          },
        ],
        "test",
      ),
    ).toThrow(/categoricalRole requires allowedValues or canonicalValues/);
    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "amount",
                type: "DOUBLE",
                description: "Fictional amount",
                allowedValues: ["high"],
                categoricalRole: "selector",
              },
            ],
          },
        ],
        "test",
      ),
    ).toThrow(/allowedValues is only valid for VARCHAR/);
    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "amount",
                type: "DOUBLE",
                description: "Fictional amount",
                allowedValues: ["large"],
              },
            ],
          },
        ],
        "test",
      ),
    ).toThrow(/allowedValues is only valid for VARCHAR/);
    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "status",
                type: "VARCHAR",
                description: "Fictional row status",
                allowedValues: ["ready", "ready"],
              },
            ],
          },
        ],
        "test",
      ),
    ).toThrow(/allowedValues entries must be unique/);
    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "status",
                type: "VARCHAR",
                description: "Fictional row status",
                allowedValues: ["ready"],
                canonicalValues: ["paused"],
              },
            ],
          },
        ],
        "test",
      ),
    ).toThrow(/allowedValues and canonicalValues are mutually exclusive/);
    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "activity_type",
                type: "VARCHAR",
                description: "Fictional activity",
                canonicalValues: ["bike_ride", "cycling"],
                valueAliases: { cycling: ["bike ride"] },
              },
            ],
          },
        ],
        "test",
      ),
    ).toThrow(/ambiguous between 'bike_ride' and 'cycling'/);
    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "status",
                type: "VARCHAR",
                description: "Fictional row status",
                allowedValues: ["ready"],
                valueAliases: { ready: [" paused"] },
              },
            ],
          },
        ],
        "test",
      ),
    ).toThrow(/aliases must be 1 to 120 characters/);
    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "series_a",
                type: "VARCHAR",
                description: "First fictional series",
                allowedValues: ["alpha"],
                categoricalRole: "series",
              },
              {
                name: "series_b",
                type: "VARCHAR",
                description: "Second fictional series",
                allowedValues: ["beta"],
                categoricalRole: "series",
              },
            ],
          },
        ],
        "test",
      ),
    ).toThrow(/at most one categorical series column/);
    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "status",
                type: "VARCHAR",
                description: "Fictional row status",
                allowedValues: ["ready"],
                categoricalRole: "invalid" as "series",
              },
            ],
          },
        ],
        "test",
      ),
    ).toThrow(/categoricalRole must be 'series' or 'selector'/);

    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "activity_type",
                type: "VARCHAR",
                description: "Extensible fictional activity vocabulary",
                canonicalValues: ["running", "cycling"],
              },
            ],
          },
        ],
        "test",
      ),
    ).not.toThrow();
    expect(() =>
      validateAnalyticsSchemaColumnTypes(
        [
          {
            ...schema,
            columns: [
              {
                name: "amount",
                type: "DOUBLE",
                description: "Fictional amount",
                canonicalValues: ["large"],
              },
            ],
          },
        ],
        "test",
      ),
    ).toThrow(/canonicalValues is only valid for VARCHAR/);

    for (const invalidValues of [
      [],
      Array.from({ length: 129 }, (_, index) => `value_${index}`),
      [""],
      ["x".repeat(121)],
      [42] as unknown as string[],
    ]) {
      expect(() =>
        validateAnalyticsSchemaColumnTypes(
          [
            {
              ...schema,
              columns: [
                {
                  name: "status",
                  type: "VARCHAR",
                  description: "Fictional row status",
                  allowedValues: invalidValues,
                },
              ],
            },
          ],
          "test",
        ),
      ).toThrow(/allowedValues/);
    }
  });
});
