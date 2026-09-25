// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Structural test for the record-citation contract (#757).
 *
 * Enumerates every in-tree source descriptor and asserts that each one whose
 * `analyticsSchemas` is non-empty declares, on every table:
 *   - `semanticTimeColumn` — a real column name OR explicit `null` (timeless);
 *   - a `record` display spec (titleColumns + keyColumns) whose columns exist.
 *
 * This is the "Sources declare the contract" success criterion. It runs
 * `validateRecordCitationContract` — the same validator the SDK runs at
 * `defineSource` time and the gateway runs at the `ensureTable` boundary — so
 * the test's oracle is the contract itself, not a hand-maintained inventory.
 *
 * Notion is the one dynamic-schema source: it declares `analyticsSchemas: []`
 * statically and builds its real schema per-database at sync time, so it is
 * (correctly) skipped here; its declaration is exercised by the Notion
 * schema-mapper tests + the gateway's `ensureTable` validation.
 */

import { describe, test, expect } from "vitest";
import { validateRecordCitationContract } from "@omnesis/source-sdk";

describe("record-citation contract: every structured source declares it (#757)", () => {
  test("all descriptors with analyticsSchemas declare semanticTimeColumn + record spec", async () => {
    const { allDescriptors } = await import("./source-descriptors.js");
    expect(allDescriptors.length).toBeGreaterThan(0);

    const structured = allDescriptors.filter(
      (d) => d.analyticsSchemas && d.analyticsSchemas.length > 0,
    );
    // At least the in-tree structured sources should be present.
    expect(structured.length).toBeGreaterThan(0);

    for (const descriptor of structured) {
      // Throws with a descriptive message if any table omits the declarations
      // or names a column that doesn't exist.
      expect(() =>
        validateRecordCitationContract(
          descriptor.analyticsSchemas ?? [],
          `source '${descriptor.id}'`,
        ),
      ).not.toThrow();

      // Belt-and-braces: assert the fields are actually present (a missing
      // `semanticTimeColumn` key would be `undefined`, which the validator
      // would catch — but assert explicitly so a regression reads clearly).
      for (const schema of descriptor.analyticsSchemas ?? []) {
        expect(
          schema.semanticTimeColumn === null || typeof schema.semanticTimeColumn === "string",
          `${descriptor.id}/${schema.tableName}: semanticTimeColumn must be a column name or explicit null`,
        ).toBe(true);
        expect(
          schema.record?.titleColumns?.length,
          `${descriptor.id}/${schema.tableName}: record.titleColumns must be non-empty`,
        ).toBeGreaterThan(0);
        expect(
          schema.record?.keyColumns?.length,
          `${descriptor.id}/${schema.tableName}: record.keyColumns must be non-empty`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
