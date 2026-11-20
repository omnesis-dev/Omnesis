// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import { omnesisConfigSchema } from "./config-schema.js";
import { legacyStorageRetentionBindingsFromInput } from "./storage-retention-config.js";

it("keeps retention config limited to source and duration while accepting legacy input metadata", () => {
  const policy = { sourceId: "fictional-notes:one", maxAgeDays: 365 };
  const legacy = { gateway: { storage: { retention: [{ ...policy, sourceCreatedAt: 123 }] } } };
  expect(legacyStorageRetentionBindingsFromInput(legacy)).toEqual([
    { ...policy, sourceCreatedAt: 123 },
  ]);
  const parsed = omnesisConfigSchema.parse(legacy);
  expect(parsed.gateway?.storage?.retention).toEqual([policy]);
  expect(legacyStorageRetentionBindingsFromInput(parsed)).toEqual([]);
  expect(JSON.stringify(parsed)).not.toContain("sourceCreatedAt");
  expect(
    omnesisConfigSchema.safeParse({
      gateway: { storage: { retention: [{ ...policy, unexpected: true }] } },
    }).success,
  ).toBe(false);
});
