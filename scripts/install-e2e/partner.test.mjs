// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { partnerState, waitForPartner } from "./partner.mjs";

const job = (name, status, conclusion = null) => ({ name, status, conclusion });
const PARTNER = "T1 tailnet collector";

/** A fake clock and a job listing that changes over time. */
function scripted(steps) {
  let t = 0;
  let i = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    list: async () => {
      const step = steps[Math.min(i++, steps.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

describe("partnerState", () => {
  it("finds the partner by name prefix among the run's jobs", () => {
    const jobs = [
      job("T1 tailnet gateway (ubuntu-24.04)", "in_progress"),
      job("T1 tailnet collector (macos-15)", "queued"),
      job("T2 tailnet collector (macos-14)", "in_progress"),
    ];
    expect(partnerState(jobs, PARTNER)).toMatchObject({
      state: "waiting",
      job: { name: "T1 tailnet collector (macos-15)" },
    });
    expect(partnerState(jobs, "T2 tailnet collector")).toMatchObject({ state: "running" });
    expect(partnerState(jobs, "T3")).toEqual({ state: "absent" });
  });

  it("treats every pre-runner status as waiting and completed as ended", () => {
    for (const status of ["queued", "waiting", "pending", "requested"]) {
      expect(partnerState([job("T1 tailnet collector (x)", status)], PARTNER).state).toBe(
        "waiting",
      );
    }
    expect(
      partnerState([job("T1 tailnet collector (x)", "completed", "cancelled")], PARTNER).state,
    ).toBe("ended");
  });
});

describe("waitForPartner", () => {
  it("waits through a long queue until the partner runs", async () => {
    const queued = [job("T1 tailnet collector (macos-15)", "queued")];
    const clock = scripted([
      queued,
      queued,
      queued,
      [job("T1 tailnet collector (macos-15)", "in_progress")],
    ]);
    const lines = [];
    const result = await waitForPartner(PARTNER, {
      ...clock,
      timeoutMs: 4 * 3600_000,
      intervalMs: 3600_000,
      log: (l) => lines.push(l),
    });
    expect(result.state).toBe("running");
    expect(clock.now()).toBe(3 * 3600_000);
    // One line per change, not per poll.
    expect(lines).toEqual(['partner "T1 tailnet collector": waiting (queued)']);
  });

  it("returns at once when the partner already ended", async () => {
    const clock = scripted([[job("T1 tailnet collector (macos-15)", "completed", "failure")]]);
    const result = await waitForPartner(PARTNER, { ...clock, timeoutMs: 3600_000 });
    expect(result).toMatchObject({ state: "ended", job: { conclusion: "failure" } });
    expect(clock.now()).toBe(0);
  });

  it("gives up at the deadline with the partner still queued", async () => {
    const clock = scripted([[job("T1 tailnet collector (macos-15)", "queued")]]);
    const result = await waitForPartner(PARTNER, {
      ...clock,
      timeoutMs: 90_000,
      intervalMs: 30_000,
    });
    expect(result).toMatchObject({ state: "waiting", timedOut: true });
    expect(clock.now()).toBe(90_000);
  });

  it("retries a failed read of the API instead of judging the partner by it", async () => {
    const clock = scripted([
      new Error("HTTP 502"),
      [job("T1 tailnet collector (macos-15)", "in_progress")],
    ]);
    const lines = [];
    const result = await waitForPartner(PARTNER, {
      ...clock,
      timeoutMs: 3600_000,
      log: (l) => lines.push(l),
    });
    expect(result.state).toBe("running");
    expect(lines[0]).toMatch(/unknown — HTTP 502/);
  });
});
