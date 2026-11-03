// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { formatStallLine } from "./stall-monitor.js";
import { attributeStall, rankStalls, stallView } from "./stall-report.js";
import type { StallEvent } from "./stall-protocol.js";

function stall(overrides: Partial<StallEvent>): StallEvent {
  return {
    startedAt: Date.UTC(2026, 0, 1, 12, 0, 0),
    durationMs: 1_000,
    activity: null,
    outer: null,
    inFlight: [],
    code: null,
    codeActivity: null,
    stack: [],
    profileId: null,
    ...overrides,
  };
}

describe("attributeStall", () => {
  test("names the running activity first, a lone in-flight one second, else nothing", () => {
    expect(attributeStall(stall({ activity: "a", inFlight: ["b"] }), null)).toMatchObject({
      attribution: "running",
      culprit: "a",
    });
    expect(attributeStall(stall({ inFlight: ["b"] }), null)).toMatchObject({
      attribution: "in-flight",
      culprit: "b",
    });
    const code = { functionName: "scan", file: "packages/gateway/src/a.ts", line: 3 };
    expect(attributeStall(stall({ inFlight: ["b", "c"], code }), null)).toMatchObject({
      attribution: "code",
      culprit: "scan (packages/gateway/src/a.ts:3)",
    });
    expect(attributeStall(stall({ inFlight: ["b", "c"] }), null)).toMatchObject({
      attribution: "none",
      culprit: null,
    });
  });
});

describe("rankStalls", () => {
  test("groups by culprit and ranks by total blocked time", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const records = [
      attributeStall(stall({ activity: "often.short", durationMs: 300, startedAt: t0 }), null),
      attributeStall(stall({ activity: "often.short", durationMs: 400, startedAt: t0 + 10 }), null),
      attributeStall(stall({ activity: "often.short", durationMs: 500, startedAt: t0 + 20 }), null),
      attributeStall(stall({ activity: "rare.long", durationMs: 2_000, startedAt: t0 + 5 }), null),
      attributeStall(stall({ inFlight: ["x", "y"], durationMs: 250, startedAt: t0 + 30 }), null),
    ];
    const { summary, ranking } = rankStalls(records);
    expect(summary).toEqual({ count: 5, totalMs: 3_450, maxMs: 2_000 });
    expect(ranking).toEqual([
      {
        culprit: "rare.long",
        count: 1,
        totalMs: 2_000,
        maxMs: 2_000,
        lastSeenAt: new Date(t0 + 5).toISOString(),
      },
      {
        culprit: "often.short",
        count: 3,
        totalMs: 1_200,
        maxMs: 500,
        lastSeenAt: new Date(t0 + 20).toISOString(),
      },
      {
        culprit: null,
        count: 1,
        totalMs: 250,
        maxMs: 250,
        lastSeenAt: new Date(t0 + 30).toISOString(),
      },
    ]);
  });

  test("ranks nothing when there were no stalls", () => {
    expect(rankStalls([])).toEqual({ summary: { count: 0, totalMs: 0, maxMs: 0 }, ranking: [] });
  });

  test("serves a stall with an ISO start and without its ring key", () => {
    const view = stallView(attributeStall(stall({ activity: "a" }), null));
    expect(view.startedAt).toBe("2026-01-01T12:00:00.000Z");
    expect(view).not.toHaveProperty("ts");
  });
});

describe("formatStallLine", () => {
  const mem = { heapUsed: 2 * 1024 ** 3, rss: 3 * 1024 ** 3 };

  test("names the running activity and the one it was nested in", () => {
    const line = formatStallLine(
      attributeStall(stall({ durationMs: 2_200, activity: "knowledge.tick", outer: "GET /x" }), {
        count: 3,
        totalMs: 900,
        maxMs: 700,
        maxKind: "major",
      }),
      mem,
    );
    expect(line).toBe(
      "event loop stalled 2200ms in knowledge.tick (outer: GET /x); " +
        "gc=3 in 900ms, worst 700ms major; heap=2.00GiB rss=3.00GiB",
    );
  });

  test("leaves out an outer activity that is the activity itself", () => {
    const line = formatStallLine(attributeStall(stall({ activity: "a", outer: "a" }), null), mem);
    expect(line).toContain("stalled 1000ms in a; gc=none;");
  });

  test("says when only in-flight work could be named, and which capture covered it", () => {
    expect(formatStallLine(attributeStall(stall({ inFlight: ["task.x"] }), null), mem)).toContain(
      "with only task.x in flight",
    );
    const line = formatStallLine(
      attributeStall(stall({ inFlight: ["a", "b"], profileId: "profile-1" }), null),
      mem,
    );
    expect(line).toContain("outside any marked activity (in flight: a, b)");
    expect(line).toMatch(/; profiled in profile-1$/);
  });

  test("says where in the code the watchdog's snapshot found the stall", () => {
    const code = { functionName: "runQuery", file: "packages/gateway/src/sql.ts", line: 42 };
    expect(
      formatStallLine(attributeStall(stall({ inFlight: ["a", "b"], code }), null), mem),
    ).toContain(
      "stalled 1000ms at runQuery (packages/gateway/src/sql.ts:42) outside any marked activity (in flight: a, b);",
    );
    expect(
      formatStallLine(
        attributeStall(stall({ activity: "POST /sql", code, codeActivity: "POST /sql" }), null),
        mem,
      ),
    ).toContain("in POST /sql at runQuery (packages/gateway/src/sql.ts:42);");
  });

  test("says where a snapshot taken outside the stall's activity was sampled", () => {
    // Two timers that fall due together run back to back in one gap: most of
    // it in the second, with the snapshot taken while the first still ran.
    const code = { functionName: "listSources", file: "packages/gateway/src/s.ts", line: 15 };
    expect(
      formatStallLine(
        attributeStall(
          stall({
            activity: "backgroundJobs.refresh",
            code,
            codeActivity: "statusCache.refreshDb",
          }),
          null,
        ),
        mem,
      ),
    ).toContain(
      "in backgroundJobs.refresh at listSources (packages/gateway/src/s.ts:15) (sampled in statusCache.refreshDb);",
    );
    expect(
      formatStallLine(
        attributeStall(stall({ activity: "a", code, codeActivity: null }), null),
        mem,
      ),
    ).toContain(
      "in a at listSources (packages/gateway/src/s.ts:15) (sampled outside any marked activity);",
    );
    expect(
      formatStallLine(
        attributeStall(stall({ inFlight: ["x", "y"], code, codeActivity: "ws.message" }), null),
        mem,
      ),
    ).toContain(
      "at listSources (packages/gateway/src/s.ts:15) (sampled in ws.message) outside any marked activity",
    );
  });
});
