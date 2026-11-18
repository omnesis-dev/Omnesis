// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The summariser over a profile built by hand, so every number it should
 * produce is known in advance: which runs count as long, how self and total
 * time add up, and that what it keeps names code and nothing else.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

import { displayPath, summarizeProfile, type CpuProfile } from "./profile-summary.js";

const FIXTURE_ROOT = join(tmpdir(), "profile summary fixture");
const ROOT = join(FIXTURE_ROOT, "checkout");
const EXTERNAL_DIRECTORY = join(FIXTURE_ROOT, "elsewhere", "private");
const INSTALL_ROOT = join(FIXTURE_ROOT, "app", "node_modules");

/**
 * (root)
 * ├── (idle)
 * └── handleTick        packages/gateway/src/tick.ts:10
 *     └── scanEverything   packages/gateway/src/scan.ts:20
 *         ├── parseRows       node_modules/some-lib/index.js:5
 *         └── readElsewhere   elsewhere/private/helper.js:1
 */
function profileFrom(timeline: Array<[nodeId: number, samples: number]>): CpuProfile {
  const frame = (functionName: string, url: string, lineNumber: number) => ({
    functionName,
    url,
    lineNumber,
  });
  const samples: number[] = [];
  for (const [id, n] of timeline) for (let i = 0; i < n; i++) samples.push(id);
  return {
    nodes: [
      { id: 1, callFrame: frame("(root)", "", -1), children: [2, 3] },
      { id: 2, callFrame: frame("(idle)", "", -1) },
      {
        id: 3,
        callFrame: frame(
          "handleTick",
          pathToFileURL(join(ROOT, "packages/gateway/src/tick.ts")).href,
          9,
        ),
        children: [4],
      },
      {
        id: 4,
        callFrame: frame(
          "scanEverything",
          pathToFileURL(join(ROOT, "packages/gateway/src/scan.ts")).href,
          19,
        ),
        children: [5, 6],
      },
      {
        id: 5,
        callFrame: frame(
          "parseRows",
          pathToFileURL(join(ROOT, "node_modules/some-lib/index.js")).href,
          4,
        ),
      },
      {
        id: 6,
        callFrame: frame(
          "readElsewhere",
          pathToFileURL(join(EXTERNAL_DIRECTORY, "helper.js")).href,
          0,
        ),
      },
    ],
    startTime: 0,
    // The first sample at the start, then one per millisecond; the last lasts 1 ms too.
    endTime: samples.length * 1_000,
    samples,
    timeDeltas: samples.map((_, i) => (i === 0 ? 0 : 1_000)),
  };
}

describe("summarizeProfile", () => {
  const profile = profileFrom([
    [2, 20], // idle
    [4, 300], // a 300 ms run, all in scanEverything
    [2, 10],
    [3, 40], // a 40 ms run: ordinary work, below the long-run floor
    [2, 10],
    [5, 150], // a 200 ms run: 150 ms in the library, 50 ms elsewhere
    [6, 50],
    [2, 20],
  ]);
  const summary = summarizeProfile(profile, { minRunMs: 100, codeRoot: ROOT });

  test("keeps only the long busy runs, in the order they happened", () => {
    expect(summary.profiledMs).toBe(600);
    expect(summary.busyMs).toBe(540);
    expect(summary.longRunMs).toBe(500);
    expect(summary.longRuns.map((r) => [r.offsetMs, r.durationMs])).toEqual([
      [20, 300],
      [380, 200],
    ]);
    expect(summary.longRuns[0]!.hotStack.map((f) => f.functionName)).toEqual([
      "scanEverything",
      "handleTick",
    ]);
    expect(summary.longRuns[0]!.hottestCode).toEqual({
      functionName: "scanEverything",
      file: "packages/gateway/src/scan.ts",
      line: 20,
    });
    expect(summary.longRuns[1]!.topSelf.map((f) => [f.functionName, f.selfMs])).toEqual([
      ["parseRows", 150],
      ["readElsewhere", 50],
    ]);
  });

  test("names where in the code the hottest stack was, past library frames", () => {
    // The hottest leaf overall is scanEverything itself; in the second run it
    // is a library frame, whose nearest code-root caller is named instead.
    expect(summary.hottestCode?.functionName).toBe("scanEverything");
    expect(summary.longRuns[1]!.hottestCode?.functionName).toBe("scanEverything");
  });

  test("ranks frames by self time, and the code root's frames by total time", () => {
    expect(summary.bySelf.map((f) => [f.functionName, f.selfMs])).toEqual([
      ["scanEverything", 300],
      ["parseRows", 150],
      ["readElsewhere", 50],
    ]);
    // handleTick's own 40 ms was a short run, so it is not counted at all.
    expect(summary.byTotal.map((f) => [f.functionName, f.file, f.line, f.totalMs])).toEqual([
      ["scanEverything", "packages/gateway/src/scan.ts", 20, 500],
      ["handleTick", "packages/gateway/src/tick.ts", 10, 500],
    ]);
    expect(summary.topStacks[0]).toEqual({
      selfMs: 300,
      frames: [
        { functionName: "scanEverything", file: "packages/gateway/src/scan.ts", line: 20 },
        { functionName: "handleTick", file: "packages/gateway/src/tick.ts", line: 10 },
      ],
    });
  });

  test("stores no absolute path from the machine it ran on", () => {
    const json = JSON.stringify(summary);
    for (const path of [ROOT, EXTERNAL_DIRECTORY]) {
      expect(json).not.toContain(path);
      expect(json).not.toContain(JSON.stringify(path).slice(1, -1));
    }
    expect(json).toContain('"file":"node_modules/some-lib/index.js"');
    expect(json).toContain('"file":"helper.js"');
  });

  test("summarises an idle or empty capture as nothing", () => {
    const idle = summarizeProfile(profileFrom([[2, 100]]), { minRunMs: 100, codeRoot: ROOT });
    expect(idle).toMatchObject({
      busyMs: 0,
      longRunMs: 0,
      longRuns: [],
      bySelf: [],
      topStacks: [],
    });
    const empty = summarizeProfile(profileFrom([]), { minRunMs: 100, codeRoot: ROOT });
    expect(empty.longRuns).toEqual([]);
  });
});

describe("displayPath", () => {
  test("keeps code locations and drops everything else about the path", () => {
    expect(displayPath(pathToFileURL(join(ROOT, "packages/core/src/a.ts")).href, ROOT)).toEqual({
      file: "packages/core/src/a.ts",
      inRoot: true,
    });
    expect(displayPath(join(ROOT, "node_modules/x/y.js"), ROOT)).toEqual({
      file: "node_modules/x/y.js",
      inRoot: false,
    });
    // An npm install: the gateway itself lives under node_modules.
    expect(displayPath(join(INSTALL_ROOT, "@omnesis/gateway/dist/a.js"), INSTALL_ROOT)).toEqual({
      file: "node_modules/@omnesis/gateway/dist/a.js",
      inRoot: true,
    });
    expect(displayPath(join(INSTALL_ROOT, "hono/dist/compose.js"), INSTALL_ROOT)).toEqual({
      file: "node_modules/hono/dist/compose.js",
      inRoot: false,
    });
    expect(displayPath("node:internal/timers", ROOT).file).toBe("node:internal/timers");
    expect(displayPath(pathToFileURL(join(EXTERNAL_DIRECTORY, "name.js")).href, ROOT).file).toBe(
      "name.js",
    );
    expect(displayPath("data:text/javascript,doSomething()", ROOT).file).toBe("data:");
    expect(displayPath("", ROOT).file).toBe("");
  });
});
