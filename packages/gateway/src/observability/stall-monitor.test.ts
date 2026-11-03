// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The stall monitor end to end on a real watchdog thread: this test's own
 * thread is blocked by a busy loop, and the stall has to come back named.
 *
 * Nothing asserts how fast anything is. A blocked loop can only be measured
 * as longer than it was under load, never shorter, so durations are checked
 * against a floor well below the busy time, and every wait polls for the
 * outcome with a generous deadline.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorkerEntry } from "@omnesis/core";
import { afterEach, describe, expect, test } from "vitest";

import { listProfileSummaries, type ProfileSummary } from "./flight-recorder.js";
import { withActivity } from "./main-activity.js";
import { StallMonitor } from "./stall-monitor.js";
import type { StallReport } from "./stall-report.js";
import type { StallSettings } from "./stall-settings.js";

const WATCHDOG = resolveWorkerEntry(
  "../workers/stall-watchdog-worker.ts",
  import.meta.url,
  "../workers/register-tsx.mjs",
);
const CODE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Hold this thread for `ms` of wall time. */
function spin(ms: number): number {
  const end = performance.now() + ms;
  let x = 0;
  while (performance.now() < end) x += Math.sqrt(x + 1);
  return x;
}

/** A frame with a name of its own, for the profile to find. */
function spinForStallTest(ms: number): number {
  return spin(ms);
}

/** Another, for the snapshot of an unmarked stall to find. */
function unmarkedStallForTest(ms: number): number {
  return spin(ms);
}

/** The first of two back-to-back activities, for a snapshot to land in. */
function firstOfTwoForStallTest(ms: number): number {
  return spin(ms);
}

async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the watchdog");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const dirs: string[] = [];
const monitors: StallMonitor[] = [];
afterEach(async () => {
  for (const m of monitors.splice(0)) await m.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function startMonitor(profile: StallSettings["profile"] = null): Promise<{
  monitor: StallMonitor;
  profileDir: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-stalls-"));
  dirs.push(dir);
  const profileDir = join(dir, "diagnostics", "stalls");
  const monitor = new StallMonitor({
    settings: { enabled: true, thresholdMs: 200, warnMs: 60_000, profile },
    workerEntry: WATCHDOG,
    profileDir,
    codeRoot: CODE_ROOT,
  });
  monitors.push(monitor);
  monitor.start();
  await monitor.ready;
  return { monitor, profileDir };
}

const read = (m: StallMonitor): Promise<StallReport> =>
  m.report({ windowMinutes: 10, minMs: 0, limit: 50 });

describe("StallMonitor", () => {
  test("names the activity a real stall was running in", async () => {
    const { monitor } = await startMonitor();
    withActivity("test.outer", () => withActivity("test.busy", () => spin(800)));

    const stall = await eventually(async () =>
      (await read(monitor)).recent.find((s) => s.activity === "test.busy"),
    );
    expect(stall).toMatchObject({
      attribution: "running",
      culprit: "test.busy",
      outer: "test.outer",
    });
    expect(stall.durationMs).toBeGreaterThanOrEqual(400);

    const report = await read(monitor);
    expect(report.enabled).toBe(true);
    expect(report.ranking.find((r) => r.culprit === "test.busy")).toMatchObject({ count: 1 });
  });

  test("names asynchronous work whose continuation stalled", async () => {
    const { monitor } = await startMonitor();
    await withActivity("test.async", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      spin(800);
    });

    const stall = await eventually(async () =>
      (await read(monitor)).recent.find((s) => s.culprit === "test.async"),
    );
    expect(stall).toMatchObject({
      activity: null,
      attribution: "in-flight",
      inFlight: ["test.async"],
    });
  });

  test("names the code of a stall no activity covers, from a snapshot taken while it lasts", async () => {
    const { monitor } = await startMonitor();
    unmarkedStallForTest(1_500);

    const stall = await eventually(async () =>
      (await read(monitor)).recent.find((s) => s.durationMs >= 1_000),
    );
    expect(stall).toMatchObject({ activity: null, codeActivity: null, attribution: "code" });
    expect(stall.stack.map((f) => f.functionName)).toContain("unmarkedStallForTest");
    expect(stall.code?.file).toMatch(/stall-monitor\.test\.ts$/);
    expect(stall.culprit).toMatch(/stall-monitor\.test\.ts:\d+\)$/);
    // The snapshot began while the stall lasted.
    expect(stall.codeSampledAfterMs).toBeGreaterThan(0);
    expect(stall.codeSampledAfterMs).toBeLessThan(stall.durationMs);
  });

  test("says which activity a snapshot sampled when the stall is named for another", async () => {
    const { monitor } = await startMonitor();
    // One gap, two activities back to back, as timers that fall due together
    // run: the snapshot lands in the first, the second holds most of the gap.
    withActivity("test.first", () => firstOfTwoForStallTest(3_000));
    withActivity("test.second", () => spin(6_000));

    const stall = await eventually(async () =>
      (await read(monitor)).recent.find((s) => s.durationMs >= 3_000),
    );
    expect(stall).toMatchObject({ activity: "test.second", attribution: "running" });
    // The code is the first activity's, and the record says so rather than
    // presenting it as where the second one was.
    expect(stall.stack.map((f) => f.functionName)).toContain("firstOfTwoForStallTest");
    expect(stall.codeActivity).toBe("test.first");
  });

  test("does not pin a stall in native code on the code that ran after it", async () => {
    const { monitor } = await startMonitor();
    // Blocked in native code: the profiler cannot start until it returns.
    execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 1500)"]);
    spinForStallTest(100);

    const stall = await eventually(async () =>
      (await read(monitor)).recent.find((s) => s.durationMs >= 1_000),
    );
    expect(stall).toMatchObject({
      code: null,
      codeSampledAfterMs: null,
      stack: [],
      attribution: "none",
    });
  });

  test(
    "profiles the main thread when stalls recur and keeps a summary of the code",
    { timeout: 60_000 },
    async () => {
      const { monitor, profileDir } = await startMonitor({
        minStallMs: 300,
        stallCount: 1,
        windowMs: 60_000,
        durationMs: 3_000,
        cooldownMs: 600_000,
        keep: 3,
      });
      // The stall that spends the budget; the capture starts after it.
      withActivity("test.trigger", () => spin(500));
      await eventually(async () => (await read(monitor)).capturing ?? undefined);
      // The capture's profiler starts once any snapshot of the trigger stall has
      // finished, so keep the loop busy in bursts until a summary is kept.
      const [summary] = await eventually<ProfileSummary[]>(async () => {
        withActivity("test.profiled", () => spinForStallTest(600));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const kept = await listProfileSummaries(profileDir);
        return kept.length > 0 ? kept : undefined;
      });
      expect(summary!.longRuns.length).toBeGreaterThan(0);
      expect(summary!.hottestCode?.file).toMatch(/stall-monitor\.test\.ts$/);
      const frames = summary!.topStacks.flatMap((s) => s.frames);
      expect(frames).toContainEqual(
        expect.objectContaining({
          functionName: "spinForStallTest",
          file: expect.stringMatching(/stall-monitor\.test\.ts$/),
        }),
      );
      for (const s of summary!.stalls) expect(s.profileId).toBe(summary!.id);
      expect(JSON.stringify(summary)).not.toContain(CODE_ROOT);
      expect(statSync(join(profileDir, `${summary!.id}.json`)).mode & 0o777).toBe(0o600);

      const report = await eventually(async () => {
        const r = await read(monitor);
        return r.capturing === null ? r : undefined;
      });
      expect(report.profiles.map((p) => p.id)).toEqual([summary!.id]);
      // The bursts the capture covered are recorded against it.
      expect(
        report.recent.some((s) => s.activity === "test.profiled" && s.profileId === summary!.id),
      ).toBe(true);
    },
  );

  test("does nothing when detection is off", async () => {
    const monitor = new StallMonitor({
      settings: { enabled: false, thresholdMs: 200, warnMs: 1_000, profile: null },
      workerEntry: WATCHDOG,
      profileDir: join(tmpdir(), "omnesis-stalls-absent"),
      codeRoot: CODE_ROOT,
    });
    monitors.push(monitor);
    monitor.start();
    const report = await read(monitor);
    expect(report).toMatchObject({ enabled: false, recent: [], profiles: [] });
  });
});
