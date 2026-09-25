// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import {
  validateAnalyticsSchemasReserveLeadingUnderscore,
  validateAnalyticsOwnership,
  type AnalyticsTableSchema,
} from "./structured-source.js";

function schema(tableName: string): AnalyticsTableSchema {
  return {
    tableName,
    displayName: tableName,
    description: "fixture",
    columns: [{ name: "id", type: "VARCHAR", description: "id" }],
    primaryKey: ["id"],
    semanticTimeColumn: null,
    record: { titleColumns: ["id"], keyColumns: ["id"] },
  };
}

describe("validateAnalyticsSchemasReserveLeadingUnderscore", () => {
  test("accepts ordinary source tables", () => {
    expect(() =>
      validateAnalyticsSchemasReserveLeadingUnderscore([schema("health_metrics")], "test"),
    ).not.toThrow();
  });

  test("rejects the gateway bookkeeping namespace", () => {
    for (const tableName of ["_analytics_catalog", "_temporal_projections", "_anything"]) {
      expect(() =>
        validateAnalyticsSchemasReserveLeadingUnderscore([schema(tableName)], "test"),
      ).toThrow(/reserved leading-underscore/);
    }
  });
});

describe("validateAnalyticsOwnership", () => {
  function ownedSchemas(): AnalyticsTableSchema[] {
    const parent = schema("parents");
    parent.columns.push({ name: "account", type: "VARCHAR", description: "Owner" });
    parent.sharedDiscriminatorColumn = "account";
    const child = schema("children");
    child.columns.push({ name: "account", type: "VARCHAR", description: "Owner" });
    child.sharedDiscriminatorColumn = "account";
    child.sharedDiscriminatorParent = { table: "parents", column: "id", parentColumn: "id" };
    return [parent, child];
  }

  test("accepts one-hop same-source ownership and ordinary unshared schemas", () => {
    expect(() => validateAnalyticsOwnership(ownedSchemas(), "test")).not.toThrow();
    expect(() => validateAnalyticsOwnership([schema("ordinary")], "test")).not.toThrow();
  });

  test.each([
    [
      "missing owner",
      (p: AnalyticsTableSchema, _c: AnalyticsTableSchema) => {
        p.sharedDiscriminatorColumn = "missing";
      },
    ],
    [
      "undeclared parent",
      (_p: AnalyticsTableSchema, c: AnalyticsTableSchema) => {
        c.sharedDiscriminatorParent!.table = "outside";
      },
    ],
    [
      "nonunique parent",
      (p: AnalyticsTableSchema, _c: AnalyticsTableSchema) => {
        p.primaryKey = ["id", "account"];
      },
    ],
    [
      "join type mismatch",
      (_p: AnalyticsTableSchema, c: AnalyticsTableSchema) => {
        c.columns[0]!.type = "BIGINT";
      },
    ],
    [
      "owner type mismatch",
      (_p: AnalyticsTableSchema, c: AnalyticsTableSchema) => {
        c.columns[1]!.type = "BIGINT";
      },
    ],
    [
      "self reference",
      (_p: AnalyticsTableSchema, c: AnalyticsTableSchema) => {
        c.sharedDiscriminatorParent!.table = "children";
      },
    ],
    [
      "multi-hop",
      (p: AnalyticsTableSchema, c: AnalyticsTableSchema) => {
        p.sharedDiscriminatorParent = c.sharedDiscriminatorParent;
      },
    ],
    [
      "missing join column",
      (_p: AnalyticsTableSchema, c: AnalyticsTableSchema) => {
        c.sharedDiscriminatorParent!.column = "absent";
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const schemas = ownedSchemas();
    mutate(schemas[0]!, schemas[1]!);
    expect(() => validateAnalyticsOwnership(schemas, "test")).toThrow(/sharedDiscriminator/);
  });
});
