// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { searchBody } from "./search.js";

describe("searchBody temporal fields", () => {
  it("accepts an IANA zone and a temporal override", () => {
    const parsed = searchBody.safeParse({
      text: "receipts last week",
      timeZone: "Europe/Paris",
      temporal: { enabled: true, weight: 1.5, referenceTime: "2026-07-01T09:00:00Z" },
    });
    expect(parsed.success).toBe(true);
  });

  it.each(["Mars/Olympus_Mons", "+05:00", ""])("rejects %j as a time zone", (timeZone) => {
    expect(searchBody.safeParse({ text: "q", timeZone }).success).toBe(false);
  });

  it.each([
    { weight: -1 },
    { weight: 11 },
    { referenceTime: "yesterday" },
    { enabled: "yes" },
    { strip: true },
  ])("rejects the temporal override %j", (temporal) => {
    expect(searchBody.safeParse({ text: "q", temporal }).success).toBe(false);
  });
});
