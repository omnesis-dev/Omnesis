// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { buildDailyDigests } from "./digest.js";

describe("buildDailyDigests", () => {
  const records = [
    {
      id: "com.chrome:2026-06-10",
      bundle_id: "com.chrome",
      app_name: "Chrome",
      date: "2026-06-10",
      total_seconds: 7800,
      session_count: 12,
    },
    {
      id: "com.slack:2026-06-10",
      bundle_id: "com.slack",
      app_name: "Slack",
      date: "2026-06-10",
      total_seconds: 3600,
      session_count: 1,
    },
    {
      id: "com.chrome:2026-06-11",
      bundle_id: "com.chrome",
      app_name: "Chrome",
      date: "2026-06-11",
      total_seconds: 600,
      session_count: 2,
    },
  ];

  it("builds one searchable digest document per date, apps sorted by usage", () => {
    const docs = buildDailyDigests(
      records,
      ProviderId("screen-time"),
      SourceId("screen-time:local"),
    );
    expect(docs).toHaveLength(2);

    const d10 = docs.find((d) => d.externalId === "screen-time-day:2026-06-10")!;
    expect(d10.title).toBe("Screen Time — 2026-06-10");
    // 7800s = 2h 10m (Chrome, listed first); 3600s = 1h (Slack).
    expect(d10.content).toContain("# Screen Time — 2026-06-10");
    expect(d10.content).toContain("**Total:** 3h 10m across 2 apps");
    expect(d10.content).toContain("- Chrome: 2h 10m (12 sessions)");
    expect(d10.content).toContain("- Slack: 1h (1 session)");
    expect(d10.content.indexOf("Chrome")).toBeLessThan(d10.content.indexOf("Slack"));
    expect(d10.metadata.documentType).toBe("summary");
    // A continuously-rewritten per-day digest: the generic marker routes it to
    // the background agent's daily batch instead of a real-time wake per rewrite.
    expect(d10.metadata.rollingAggregate).toBe(true);
    expect(d10.metadata.extra?.date).toBe("2026-06-10");
  });

  it("is empty for no records", () => {
    expect(buildDailyDigests([], ProviderId("screen-time"), SourceId("screen-time:local"))).toEqual(
      [],
    );
  });
});
