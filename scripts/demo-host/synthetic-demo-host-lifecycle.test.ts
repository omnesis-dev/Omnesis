// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { retainDemoHost, waitForDemoGraph } from "./synthetic-demo-host-lifecycle.js";

function snapshot(remaining: number, at: number, overrides: Record<string, unknown> = {}) {
  return {
    jobs: [
      {
        id: "backfill.derivationSla.links",
        observation: {
          state: "idle",
          inFlight: false,
          progress: { kind: "queue", remaining, groundTruthAt: at },
          ...overrides,
        },
      },
      {
        id: "backfill.linkBatch",
        observation: {
          state: "running",
          inFlight: false,
          progress: { kind: "queue", remaining: 0 },
        },
      },
    ],
  };
}

describe("demo host graph lifecycle", () => {
  it("retains the host through backlog and stale zero scans until authoritative post-sync completion", async () => {
    let now = 100;
    const observations = [snapshot(27_707, 100), snapshot(0, 99), snapshot(0, 110)];
    const refresh = vi.fn(async () => {}),
      report = vi.fn();
    await waitForDemoGraph({
      readJobs: async () => observations.shift(),
      after: 100,
      timeoutMs: 100,
      pollMs: 5,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      refresh,
      report,
    });
    expect(now).toBe(110);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0][0]).toContain("pending=27707");
  });

  it.each([
    { state: "unknown" },
    { state: "disabled" },
    { state: "erroring" },
    { inFlight: true },
    { progress: { kind: "queue", remaining: 0 } },
    { progress: { kind: "queue", remaining: 0, groundTruthAt: 1000 } },
  ])("fails truthfully on unusable zero observations %j", async (overrides) => {
    let now = 100;
    await expect(
      waitForDemoGraph({
        readJobs: async () => snapshot(0, 100, overrides),
        after: 100,
        timeoutMs: 10,
        pollMs: 5,
        clock: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toThrow("timed out");
  });

  it("does not accept a zero throughput counter without the authoritative observer", async () => {
    let now = 100;
    await expect(
      waitForDemoGraph({
        readJobs: async () => ({ jobs: [snapshot(0, 100).jobs[1]] }),
        after: 100,
        timeoutMs: 5,
        pollMs: 5,
        clock: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toThrow("pending=unknown");
  });

  it("rejects malformed API state and does not suppress HTTP failures", async () => {
    await expect(waitForDemoGraph({ readJobs: async () => ({}), after: 0 })).rejects.toThrow(
      "Invalid demo",
    );
    await expect(
      waitForDemoGraph({
        readJobs: async () => {
          throw new Error("HTTP 403");
        },
        after: 0,
      }),
    ).rejects.toThrow("HTTP 403");
  });

  it("aborts the graph wait without another API call", async () => {
    const controller = new AbortController(),
      readJobs = vi.fn(async () => snapshot(10, 100));
    controller.abort();
    await expect(
      waitForDemoGraph({ readJobs, after: 100, signal: controller.signal }),
    ).rejects.toThrow();
    expect(readJobs).not.toHaveBeenCalled();
  });

  it("resident mode refreshes declarations until stop and exits without retaining a timer", async () => {
    const controller = new AbortController();
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length === 2) controller.abort();
    });
    await retainDemoHost({ signal: controller.signal, refresh, pollMs: 1 });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
