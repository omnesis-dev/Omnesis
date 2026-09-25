// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";
import { bulkUpsertLegacySourcesBody, bulkUpsertSourcesBody, patchSourceBody } from "./admin.js";

describe("PATCH source mode schema", () => {
  test("accepts an explicit supported mode", () => {
    expect(patchSourceBody.parse({ multiDeviceMode: "partitioned" })).toEqual({
      multiDeviceMode: "partitioned",
    });
  });

  test("rejects an unknown mode instead of stripping it into a successful no-op", () => {
    expect(patchSourceBody.safeParse({ multiDeviceMode: "fanout" }).success).toBe(false);
  });
});

describe("bulk source registration schemas", () => {
  const source = { type: "visits-synth", accountId: "fictional-account" };

  test("the legacy endpoint rejects member-local config instead of silently dropping it", () => {
    expect(
      bulkUpsertLegacySourcesBody.safeParse({
        sources: [{ ...source, memberConfig: { params: { sessionsPath: "/srv/example" } } }],
      }).success,
    ).toBe(false);
  });

  test("the versioned endpoint accepts member-local config", () => {
    expect(
      bulkUpsertSourcesBody.safeParse({
        sources: [{ ...source, memberConfig: { params: { sessionsPath: "/srv/example" } } }],
      }).success,
    ).toBe(true);
  });

  test("the legacy endpoint keeps accepting and stripping unrelated future fields", () => {
    expect(
      bulkUpsertLegacySourcesBody.parse({
        sources: [{ ...source, futureExtension: "fictional-value" }],
      }),
    ).toEqual({
      sources: [{ ...source, id: undefined, config: undefined, enabled: undefined }],
    });
  });
});
