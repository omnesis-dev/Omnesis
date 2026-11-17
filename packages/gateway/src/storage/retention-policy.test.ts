// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import { retentionCutoff } from "./retention-policy.js";

it("only sets a rolling cutoff for explicitly configured source identities", () => {
  const now = Date.UTC(2031, 0, 31);
  const policies = [{ sourceId: "example:one", maxAgeDays: 30 }];
  expect(retentionCutoff(undefined, "example:one", now)).toBeNull();
  expect(retentionCutoff(policies, "example:two", now)).toBeNull();
  expect(retentionCutoff(policies, "example:one", now)).toBe("2031-01-01T00:00:00.000Z");
  expect(retentionCutoff(policies, "example:one", now + 86400000)).toBe("2031-01-02T00:00:00.000Z");
});
