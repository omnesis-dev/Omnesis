// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { SourceId, ProviderId } from "@omnesis/types";
import { rowsFor } from "@omnesis/source-sdk/testing";
import realStrava from "@omnesis/provider-strava";
import syntheticStrava from "./index.js";

describe("synthetic Strava account ownership", () => {
  const source = syntheticStrava.sources.find((entry) => entry.id === "strava-activities")!;

  test.each(["7001001", "7001002"])(
    "both tables belong to the created account %s",
    async (accountId) => {
      const instance = await source.create(
        {
          accountId,
          sourceId: SourceId(`strava-activities:${accountId}`),
          providerId: ProviderId(`strava:${accountId}`),
        },
        {},
      );
      const result = await instance.syncStructured!(null);
      const realSchemas = realStrava.sources.find(
        (entry) => entry.id === source.id,
      )!.analyticsSchemas!;
      for (const schema of instance.analyticsSchemas!) {
        expect(schema).toEqual(realSchemas.find((entry) => entry.tableName === schema.tableName));
        const records = rowsFor(result, schema.tableName);
        expect(records.length).toBeGreaterThan(0);
        for (const record of records)
          expect(record[schema.sharedDiscriminatorColumn!]).toBe(Number(accountId));
      }
      expect(result.documents!.length).toBeGreaterThan(0);
      expect(
        result.documents!.every(
          (document) => document.sourceId === `strava-activities:${accountId}`,
        ),
      ).toBe(true);
    },
  );

  test.each(["athlete_example", "", "0", "1.5", "9007199254740993"])(
    "rejects a nonrepresentable synthetic account %s",
    async (accountId) => {
      await expect(
        source.create(
          {
            accountId,
            sourceId: SourceId("strava-activities:fixture"),
            providerId: ProviderId("strava:fixture"),
          },
          {},
        ),
      ).rejects.toThrow("numeric athlete account");
    },
  );
});
