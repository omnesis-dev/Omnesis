// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseArgs } from "citty";
import { describe, expect, test } from "vitest";

import { renderStalls, stallsCommand, type StallsResponse } from "./stalls.js";

// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const report: StallsResponse = {
  enabled: true,
  thresholdMs: 250,
  windowMinutes: 60,
  minMs: 0,
  summary: { count: 3, totalMs: 6_500, maxMs: 4_000 },
  ranking: [
    {
      culprit: "index.cycle",
      count: 2,
      totalMs: 5_000,
      maxMs: 4_000,
      lastSeenAt: "2026-01-01T10:00:00.000Z",
    },
    {
      culprit: null,
      count: 1,
      totalMs: 1_500,
      maxMs: 1_500,
      lastSeenAt: "2026-01-01T09:00:00.000Z",
    },
  ],
  recent: [
    {
      startedAt: "2026-01-01T10:00:00.000Z",
      durationMs: 4_000,
      activity: "index.cycle",
      outer: "GET /status",
      inFlight: [],
      attribution: "running",
      culprit: "index.cycle",
      code: null,
    },
    {
      startedAt: "2026-01-01T09:30:00.000Z",
      durationMs: 2_000,
      activity: "backgroundJobs.refresh",
      outer: null,
      inFlight: [],
      attribution: "running",
      culprit: "backgroundJobs.refresh",
      code: { functionName: "listSources", file: "packages/gateway/src/s.ts", line: 15 },
      codeActivity: "statusCache.refreshDb",
    },
    {
      startedAt: "2026-01-01T09:00:00.000Z",
      durationMs: 1_500,
      activity: null,
      outer: null,
      inFlight: ["a", "b"],
      attribution: "none",
      culprit: null,
      code: null,
    },
    {
      startedAt: "2026-01-01T08:00:00.000Z",
      durationMs: 900,
      activity: null,
      outer: null,
      inFlight: ["a", "b"],
      attribution: "code",
      culprit: "runQuery (packages/gateway/src/sql.ts:42)",
      code: { functionName: "runQuery", file: "packages/gateway/src/sql.ts", line: 42 },
      codeActivity: "ws.message",
    },
  ],
  capturing: null,
  profiles: [
    {
      id: "profile-2026-01-01T10-01-00-000Z",
      capturedAt: "2026-01-01T10:01:00.000Z",
      reason: "3 stalls of at least 1000ms within 120s",
      longRunMs: 3_200,
      hottestCode: { functionName: "scanAll", file: "packages/gateway/src/scan.ts", line: 12 },
      topStacks: [
        {
          selfMs: 3_000,
          frames: [
            { functionName: "all", file: "", line: null },
            { functionName: "scanAll", file: "packages/gateway/src/scan.ts", line: 12 },
          ],
        },
      ],
    },
  ],
};

describe("omnesis stalls", () => {
  test("prints the ranking, the newest stalls and the profiles' hottest code", () => {
    const text = plain(renderStalls(report));
    expect(text).toContain("3 stalls, 6.5s blocked, worst 4.0s");
    expect(text).toMatch(/5\.0s\s+2×\s+worst\s+4\.0s\s+index\.cycle/);
    expect(text).toContain("(not attributed)");
    expect(text).toContain("index.cycle (in GET /status)");
    expect(text).toContain(
      "backgroundJobs.refresh at listSources (packages/gateway/src/s.ts:15) (sampled in statusCache.refreshDb)",
    );
    expect(text).toContain("not attributed; in flight: a, b");
    expect(text).toContain(
      "runQuery (packages/gateway/src/sql.ts:42) (sampled in ws.message) (in flight: a, b)",
    );
    expect(text).toContain("hottest code: scanAll (packages/gateway/src/scan.ts:12)");
    expect(text).toContain("at all\n");
  });

  test("says when a stall's snapshot began late in it", () => {
    const code = { functionName: "buildTools", file: "packages/agent/src/tools.ts", line: 7 };
    const text = plain(
      renderStalls({
        ...report,
        recent: [
          {
            startedAt: "2026-01-01T10:00:00.000Z",
            durationMs: 30_000,
            activity: null,
            outer: null,
            inFlight: [],
            attribution: "code",
            culprit: "buildTools (packages/agent/src/tools.ts:7)",
            code,
            codeSampledAfterMs: 21_300,
          },
        ],
      }),
    );
    expect(text).toContain("buildTools (packages/agent/src/tools.ts:7) (sampled 21.3s in)");
  });

  test("says when detection is off and nothing was recorded", () => {
    const text = plain(
      renderStalls({
        ...report,
        enabled: false,
        summary: { count: 0, totalMs: 0, maxMs: 0 },
        ranking: [],
        recent: [],
        profiles: [],
      }),
    );
    expect(text).toContain("not recording stalls");
    expect(text).toContain("None.");
    expect(text).toContain("None kept.");
  });

  test("parses its window and floor flags", async () => {
    const def = await (typeof stallsCommand.args === "function"
      ? stallsCommand.args()
      : stallsCommand.args);
    const parsed = parseArgs(["--window=15", "--min=1000"], def as Parameters<typeof parseArgs>[1]);
    expect(parsed).toMatchObject({ window: "15", min: "1000" });
  });
});
