// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi } from "vitest";
import {
  FeedProcessSupervisor,
  LAUNCH_BACKOFF_LADDER_MS,
  LAUNCH_FAILING_AFTER,
  LAUNCH_SETTLE_MS,
  LAUNCH_WINDOW_MS,
  LAUNCHES_PER_WINDOW,
} from "./feed-process-supervisor.js";
import { FreshnessProbe, PROBE_CACHE_TTL_MS } from "./freshness-probe.js";
import type { SourceFreshness } from "@omnesis/source-sdk";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const launchable: SourceFreshness = {
  quietPeriodMs: 1000,
  hint: "Open the app.",
  requiresProcess: {
    processName: "ExampleApp",
    launch: { macosBundleId: "org.example.app", failedHint: "The app keeps quitting." },
  },
};

const probeOnly: SourceFreshness = {
  quietPeriodMs: 1000,
  hint: "Open the app.",
  requiresProcess: { processName: "ExampleApp" },
};

/**
 * A host under test: a clock, a process table the launch stub populates, and
 * knobs for how the program behaves once opened. The probe is the real
 * `FreshnessProbe` over that table, so its cache is part of what is tested.
 */
function host(opts: { macos?: boolean } = {}) {
  let clock = 0;
  let running = false;
  let launchedAt = -Infinity;
  const behaviour = {
    /** Whether a launch leaves the program running at all. */
    staysUp: true,
    /** The program dies this long after a launch; `Infinity` for never. */
    diesAfterMs: Infinity,
    /** `open` itself fails — the app is not installed, say. */
    refused: false,
    /** The process table cannot be read. */
    probeThrows: false,
  };
  const launch = vi.fn((): Promise<void> => {
    if (behaviour.refused) return Promise.reject(new Error("Unable to find application"));
    running = behaviour.staysUp;
    launchedAt = clock;
    return Promise.resolve();
  });
  const isRunning = vi.fn((): Promise<boolean> => {
    if (behaviour.probeThrows) return Promise.reject(new Error("no pgrep"));
    if (running && clock - launchedAt >= behaviour.diesAfterMs) running = false;
    return Promise.resolve(running);
  });
  const probe = new FreshnessProbe(() => clock, isRunning);
  const supervisor = new FeedProcessSupervisor(probe, () => clock, launch, opts.macos ?? true);
  return {
    supervisor,
    launch,
    isRunning,
    behaviour,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
    },
    /** The operator opened it. */
    start() {
      running = true;
      launchedAt = clock;
    },
    /** The operator quit it, or it died. */
    quit() {
      running = false;
    },
  };
}

/** One sync's worth of time: enough for the probe cache to lapse. */
const NEXT_SYNC = PROBE_CACHE_TTL_MS + 1;

describe("FeedProcessSupervisor", () => {
  test("opens a declared program it finds not running, and reports it running", async () => {
    const h = host();
    const reading = await h.supervisor.observe(launchable);
    expect(h.launch).toHaveBeenCalledWith(launchable.requiresProcess?.launch);
    expect(reading).toEqual({ running: true, launchFailing: false });
  });

  test("never opens a program whose source declared no launch", async () => {
    const h = host();
    const reading = await h.supervisor.observe(probeOnly);
    expect(h.launch).not.toHaveBeenCalled();
    expect(reading).toEqual({ running: false, launchFailing: false });
  });

  test("never opens anything off macOS, and still reports the reading", async () => {
    const h = host({ macos: false });
    const reading = await h.supervisor.observe(launchable);
    expect(h.launch).not.toHaveBeenCalled();
    expect(reading).toEqual({ running: false, launchFailing: false });
  });

  test("leaves a running program alone", async () => {
    const h = host();
    h.start();
    const reading = await h.supervisor.observe(launchable);
    expect(h.launch).not.toHaveBeenCalled();
    expect(reading).toEqual({ running: true, launchFailing: false });
  });

  // An unknown reading is the probe saying it could not look. Opening a
  // program on that basis would be acting on a blind spot.
  test("does not open a program when the probe could not tell", async () => {
    const h = host();
    h.behaviour.probeThrows = true;
    const reading = await h.supervisor.observe(launchable);
    expect(h.launch).not.toHaveBeenCalled();
    expect(reading).toEqual({ running: undefined, launchFailing: false });
  });

  test("passes over a source with no freshness declaration", async () => {
    const h = host();
    expect(await h.supervisor.observe(undefined)).toEqual({
      running: undefined,
      launchFailing: false,
    });
    expect(h.launch).not.toHaveBeenCalled();
  });

  // Two sources fed by one program can be synced at the same time. The
  // record is written before the launch is awaited, so the second to arrive
  // finds it and waits instead of opening the program a second time.
  test("two sources observing at once open the program once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launch = vi.fn(() => gate);
    const probe = new FreshnessProbe(
      () => 0,
      () => Promise.resolve(false),
    );
    const supervisor = new FeedProcessSupervisor(probe, () => 0, launch, true);
    const sibling: SourceFreshness = { ...launchable, hint: "Open the app for the other one." };
    const both = Promise.all([supervisor.observe(launchable), supervisor.observe(sibling)]);
    release();
    await both;
    expect(launch).toHaveBeenCalledTimes(1);
  });

  describe("backing off", () => {
    // The central guarantee: a program that will not stay up is reopened on
    // the ladder's schedule, and the ladder's last rung holds.
    test("waits one rung longer after each launch that did not stay up, then holds at the cap", async () => {
      const h = host();
      h.behaviour.staysUp = false;
      const launchTimes: number[] = [];
      const horizon = 4 * 24 * HOUR;
      while (h.now() <= horizon) {
        const before = h.launch.mock.calls.length;
        await h.supervisor.observe(launchable);
        if (h.launch.mock.calls.length > before) launchTimes.push(h.now());
        h.advance(MINUTE);
      }
      const [first, ...rest] = launchTimes;
      expect(first).toBe(0);
      const gaps = rest.map((t, i) => t - launchTimes[i]);
      expect(gaps.slice(0, LAUNCH_BACKOFF_LADDER_MS.length)).toEqual(LAUNCH_BACKOFF_LADDER_MS);
      const cap = LAUNCH_BACKOFF_LADDER_MS[LAUNCH_BACKOFF_LADDER_MS.length - 1];
      for (const gap of gaps.slice(LAUNCH_BACKOFF_LADDER_MS.length)) expect(gap).toBe(cap);
      expect(gaps.length).toBeGreaterThan(LAUNCH_BACKOFF_LADDER_MS.length);
    });

    test("does not reopen a program within its wait even though every sync finds it down", async () => {
      const h = host();
      h.behaviour.staysUp = false;
      await h.supervisor.observe(launchable);
      for (let i = 0; i < 5; i++) {
        h.advance(NEXT_SYNC);
        expect(await h.supervisor.observe(launchable)).toEqual({
          running: false,
          launchFailing: false,
        });
      }
      expect(h.launch).toHaveBeenCalledTimes(1);
    });

    test("flags the launch as failing after repeated launches that did not stay up", async () => {
      const h = host();
      h.behaviour.staysUp = false;
      let reading = await h.supervisor.observe(launchable);
      for (let attempt = 1; attempt < LAUNCH_FAILING_AFTER; attempt++) {
        expect(reading.launchFailing).toBe(false);
        h.advance(LAUNCH_BACKOFF_LADDER_MS[attempt - 1]);
        reading = await h.supervisor.observe(launchable);
      }
      expect(h.launch).toHaveBeenCalledTimes(LAUNCH_FAILING_AFTER);
      expect(reading).toEqual({ running: false, launchFailing: true });
      // And it stays flagged while waiting for the next rung.
      h.advance(NEXT_SYNC);
      expect(await h.supervisor.observe(launchable)).toEqual({
        running: false,
        launchFailing: true,
      });
    });

    test("launches the OS refused climb the same ladder and reach the same flag", async () => {
      const h = host();
      h.behaviour.refused = true;
      let reading = await h.supervisor.observe(launchable);
      expect(reading).toEqual({ running: false, launchFailing: false });
      h.advance(NEXT_SYNC);
      await h.supervisor.observe(launchable);
      expect(h.launch).toHaveBeenCalledTimes(1);
      for (let attempt = 1; attempt < LAUNCH_FAILING_AFTER; attempt++) {
        h.advance(LAUNCH_BACKOFF_LADDER_MS[attempt - 1]);
        reading = await h.supervisor.observe(launchable);
      }
      expect(h.launch).toHaveBeenCalledTimes(LAUNCH_FAILING_AFTER);
      expect(reading).toEqual({ running: false, launchFailing: true });
    });

    // A launch whose program is up thirty seconds later has proven nothing. If
    // that reset the ladder, a program crashing shortly after every launch
    // would be reopened every sync, forever.
    test("a program seen up shortly after its launch does not reset the ladder", async () => {
      const h = host();
      await h.supervisor.observe(launchable);
      h.advance(NEXT_SYNC);
      expect((await h.supervisor.observe(launchable)).running).toBe(true);
      h.quit();
      h.advance(NEXT_SYNC);
      await h.supervisor.observe(launchable);
      expect(h.launch).toHaveBeenCalledTimes(1);
      h.advance(LAUNCH_BACKOFF_LADDER_MS[0]);
      await h.supervisor.observe(launchable);
      expect(h.launch).toHaveBeenCalledTimes(2);
    });

    // Distinguishable from "no reset" only from the second rung up: the first
    // rung is shorter than the settle window, so a single launch would be
    // reopened either way once it lapsed.
    test("a program that stayed up past the settle window earns a fresh ladder", async () => {
      const h = host();
      h.behaviour.staysUp = false;
      await h.supervisor.observe(launchable);
      h.advance(LAUNCH_BACKOFF_LADDER_MS[0]);
      h.behaviour.staysUp = true;
      await h.supervisor.observe(launchable);
      expect(h.launch).toHaveBeenCalledTimes(2);
      h.advance(LAUNCH_SETTLE_MS);
      expect((await h.supervisor.observe(launchable)).running).toBe(true);
      h.quit();
      h.advance(NEXT_SYNC);
      const reading = await h.supervisor.observe(launchable);
      expect(h.launch).toHaveBeenCalledTimes(3);
      expect(reading).toEqual({ running: true, launchFailing: false });
    });

    // A program that dies after settling is a fresh launch every time as far
    // as the ladder knows. The window cap is what bounds it.
    test("a program that keeps dying after settling is opened at most the window's worth a day", async () => {
      const h = host();
      h.behaviour.diesAfterMs = LAUNCH_SETTLE_MS + 10 * MINUTE;
      const launchTimes: number[] = [];
      let cappedReading: { running: boolean | undefined; launchFailing: boolean } | undefined;
      while (h.now() < 2 * LAUNCH_WINDOW_MS) {
        const before = h.launch.mock.calls.length;
        const reading = await h.supervisor.observe(launchable);
        if (h.launch.mock.calls.length > before) launchTimes.push(h.now());
        else if (reading.running === false && !cappedReading) cappedReading = reading;
        h.advance(5 * MINUTE);
      }
      const inFirstDay = launchTimes.filter((t) => t < LAUNCH_WINDOW_MS);
      expect(inFirstDay).toHaveLength(LAUNCHES_PER_WINDOW);
      expect(cappedReading).toEqual({ running: false, launchFailing: true });
      // The window rolls: launches resume once the earliest one ages out.
      expect(launchTimes.length).toBeGreaterThan(LAUNCHES_PER_WINDOW);
      expect(launchTimes.length).toBeLessThanOrEqual(2 * LAUNCHES_PER_WINDOW);
    });

    test("the ladder is per program, so two sources fed by one app share one launch", async () => {
      const h = host();
      h.behaviour.staysUp = false;
      const sibling: SourceFreshness = { ...launchable, hint: "Open the app for the other one." };
      await h.supervisor.observe(launchable);
      await h.supervisor.observe(sibling);
      h.advance(NEXT_SYNC);
      await h.supervisor.observe(sibling);
      expect(h.launch).toHaveBeenCalledTimes(1);
    });
  });
});
