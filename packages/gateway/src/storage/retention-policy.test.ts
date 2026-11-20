// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import {
  isBeforeRetentionCutoff,
  isCanonicalRetentionDate,
  retentionCutoff,
} from "./retention-policy.js";

it("only sets a rolling cutoff for explicitly configured source identities", () => {
  const now = Date.UTC(2031, 0, 31);
  const policies = [{ sourceId: "example:one", maxAgeDays: 30 }];
  expect(retentionCutoff(undefined, "example:one", now)).toBeNull();
  expect(retentionCutoff(policies, "example:two", now)).toBeNull();
  expect(retentionCutoff(policies, "example:one", now)).toBe("2031-01-01T00:00:00.000Z");
  expect(retentionCutoff(policies, "example:one", now + 86400000)).toBe("2031-01-02T00:00:00.000Z");
});

it("only ages canonical UTC dates and preserves ambiguous or offset timestamps", () => {
  const cutoff = "2031-01-01T00:00:00.000Z";
  for (const value of [
    "2000-01-01T00:00:00Z",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:00:00.123Z",
  ]) {
    expect(isCanonicalRetentionDate(value)).toBe(true);
    expect(isBeforeRetentionCutoff(value, cutoff)).toBe(true);
  }
  for (const value of [
    "2000-unknown",
    "2000-01-01",
    "2000-01-01T00:00:00+02:00",
    "2000-02-30T00:00:00Z",
    "unknown",
    "",
  ]) {
    expect(isCanonicalRetentionDate(value)).toBe(false);
    expect(isBeforeRetentionCutoff(value, cutoff)).toBe(false);
  }
  expect(isBeforeRetentionCutoff(cutoff, cutoff)).toBe(false);
  expect(isBeforeRetentionCutoff("2032-01-01T00:00:00Z", cutoff)).toBe(false);
});
