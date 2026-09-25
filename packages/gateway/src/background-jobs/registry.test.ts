// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Registry — verify register / refresh / snapshot / dispose behave as
 * advertised, including the "one bad observe() doesn't poison the
 * snapshot" property.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { createLogger } from "@omnesis/core";
import { BackgroundJobsRegistry } from "./registry.js";
import type { BackgroundJob, JobObservation } from "./types.js";

function makeJob(
  id: string,
  observe: () => JobObservation,
  category: BackgroundJob["category"] = "infra",
): BackgroundJob {
  return {
    id,
    displayName: id,
    description: `desc for ${id}`,
    category,
    cadence: { mode: "periodic", intervalMs: 1000 },
    observe,
  };
}

const goodObservation: JobObservation = {
  state: "running",
  inFlight: false,
  ticksLastHour: 5,
  avgTickMs: 12,
  p99TickMs: 30,
  progress: { kind: "stateless" },
};

describe("BackgroundJobsRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("starts with an empty snapshot before refresh", () => {
    const r = new BackgroundJobsRegistry({ log: createLogger("test") });
    const snap = r.snapshot();
    expect(snap.jobs).toEqual([]);
    expect(snap.generatedAt).toBeDefined();
  });

  it("register + refresh produces a snapshot row per job", () => {
    const r = new BackgroundJobsRegistry({ log: createLogger("test") });
    r.register(makeJob("a", () => goodObservation));
    r.register(makeJob("b", () => goodObservation, "graph"));
    r.refresh();
    const snap = r.snapshot();
    expect(snap.jobs).toHaveLength(2);
    expect(snap.jobs[0].id).toBe("a");
    expect(snap.jobs[0].category).toBe("infra");
    expect(snap.jobs[1].id).toBe("b");
    expect(snap.jobs[1].category).toBe("graph");
  });

  it("registerAll registers many", () => {
    const r = new BackgroundJobsRegistry({ log: createLogger("test") });
    r.registerAll([
      makeJob("a", () => goodObservation),
      makeJob("b", () => goodObservation),
      makeJob("c", () => goodObservation),
    ]);
    r.refresh();
    expect(r.snapshot().jobs).toHaveLength(3);
  });

  it("re-registering an id replaces the previous job and warns", () => {
    const r = new BackgroundJobsRegistry({ log: createLogger("test") });
    let calls = 0;
    r.register(
      makeJob("x", () => {
        calls += 1;
        return { ...goodObservation, ticksLastHour: 1 };
      }),
    );
    r.register(
      makeJob("x", () => {
        return { ...goodObservation, ticksLastHour: 99 };
      }),
    );
    r.refresh();
    const snap = r.snapshot();
    expect(snap.jobs).toHaveLength(1);
    expect(snap.jobs[0].observation.ticksLastHour).toBe(99);
    // first observe() never invoked because it was replaced
    expect(calls).toBe(0);
  });

  it("a thrown observe() yields a fallback row but doesn't poison the snapshot", () => {
    const r = new BackgroundJobsRegistry({ log: createLogger("test") });
    r.register(makeJob("good", () => goodObservation));
    r.register(
      makeJob("bad", () => {
        throw new Error("boom");
      }),
    );
    r.refresh();
    const snap = r.snapshot();
    expect(snap.jobs).toHaveLength(2);
    const bad = snap.jobs.find((j) => j.id === "bad");
    expect(bad?.observation.state).toBe("unknown");
    expect(bad?.observation.progress).toEqual({ kind: "stateless" });
    const good = snap.jobs.find((j) => j.id === "good");
    expect(good?.observation.state).toBe("running");
  });

  it("start() refreshes immediately and on the configured interval", () => {
    const r = new BackgroundJobsRegistry({
      log: createLogger("test"),
      refreshIntervalMs: 100,
    });
    let calls = 0;
    r.register(
      makeJob("x", () => {
        calls += 1;
        return goodObservation;
      }),
    );
    r.start();
    expect(calls).toBe(1); // refreshed on start
    vi.advanceTimersByTime(100);
    expect(calls).toBe(2);
    vi.advanceTimersByTime(250);
    expect(calls).toBe(4); // 200, 300 ticks
    r.dispose();
  });

  it("dispose() stops the timer", () => {
    const r = new BackgroundJobsRegistry({
      log: createLogger("test"),
      refreshIntervalMs: 100,
    });
    let calls = 0;
    r.register(
      makeJob("x", () => {
        calls += 1;
        return goodObservation;
      }),
    );
    r.start();
    expect(calls).toBe(1);
    r.dispose();
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(1); // no further ticks
  });

  it("get(id) returns the registered job; unknown id is undefined", () => {
    const r = new BackgroundJobsRegistry({ log: createLogger("test") });
    const job = makeJob("findme", () => goodObservation);
    r.register(job);
    expect(r.get("findme")).toBe(job);
    expect(r.get("nope")).toBeUndefined();
  });

  it("list() returns insertion order", () => {
    const r = new BackgroundJobsRegistry({ log: createLogger("test") });
    r.register(makeJob("z", () => goodObservation));
    r.register(makeJob("a", () => goodObservation));
    r.register(makeJob("m", () => goodObservation));
    expect(r.list().map((j) => j.id)).toEqual(["z", "a", "m"]);
  });
});
