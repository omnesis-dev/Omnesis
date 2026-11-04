// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Registry — verify register / snapshot behave as advertised, including
 * the "one bad observe() doesn't poison the snapshot" property and that
 * jobs are observed only when a snapshot is asked for.
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

  it("an empty registry has an empty snapshot", () => {
    const r = new BackgroundJobsRegistry({ log: createLogger("test") });
    const snap = r.snapshot();
    expect(snap.jobs).toEqual([]);
    expect(snap.generatedAt).toBeDefined();
  });

  it("a snapshot has a row per registered job", () => {
    const r = new BackgroundJobsRegistry({ log: createLogger("test") });
    r.register(makeJob("a", () => goodObservation));
    r.register(makeJob("b", () => goodObservation, "graph"));
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
    const snap = r.snapshot();
    expect(snap.jobs).toHaveLength(2);
    const bad = snap.jobs.find((j) => j.id === "bad");
    expect(bad?.observation.state).toBe("unknown");
    expect(bad?.observation.progress).toEqual({ kind: "stateless" });
    const good = snap.jobs.find((j) => j.id === "good");
    expect(good?.observation.state).toBe("running");
  });

  it("observes nothing until a snapshot is asked for", () => {
    const r = new BackgroundJobsRegistry({ log: createLogger("test") });
    let calls = 0;
    r.register(
      makeJob("x", () => {
        calls += 1;
        return goodObservation;
      }),
    );
    vi.advanceTimersByTime(60_000);
    expect(calls).toBe(0);
    expect(r.snapshot().jobs).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("serves one snapshot while it is fresh and observes again once it is older than maxAgeMs", () => {
    const r = new BackgroundJobsRegistry({ log: createLogger("test"), maxAgeMs: 100 });
    let ticks = 0;
    r.register(
      makeJob("x", () => {
        ticks += 1;
        return { ...goodObservation, ticksLastHour: ticks };
      }),
    );
    const first = r.snapshot();
    vi.advanceTimersByTime(99);
    expect(r.snapshot()).toBe(first);
    vi.advanceTimersByTime(1);
    const second = r.snapshot();
    expect(second).not.toBe(first);
    expect(second.jobs[0].observation.ticksLastHour).toBe(2);
    expect(Date.parse(second.generatedAt) - Date.parse(first.generatedAt)).toBe(100);
  });

  it("a job registered after a snapshot appears in the next one", () => {
    const r = new BackgroundJobsRegistry({ log: createLogger("test"), maxAgeMs: 100 });
    r.register(makeJob("a", () => goodObservation));
    expect(r.snapshot().jobs.map((j) => j.id)).toEqual(["a"]);
    r.register(makeJob("b", () => goodObservation));
    expect(r.snapshot().jobs.map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("observes again when the clock steps back", () => {
    let now = 1_000_000;
    const r = new BackgroundJobsRegistry({ log: createLogger("test"), now: () => now });
    let calls = 0;
    r.register(
      makeJob("x", () => {
        calls += 1;
        return goodObservation;
      }),
    );
    r.snapshot();
    now -= 60_000;
    r.snapshot();
    expect(calls).toBe(2);
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
