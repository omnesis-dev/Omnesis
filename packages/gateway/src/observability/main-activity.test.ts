// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The activity marker is what the stall watchdog reads while the main thread
 * is stuck, so what matters is the shared memory as another thread would see
 * it: the right names at the right depth while work runs, and nothing left
 * behind once it has returned, thrown or settled.
 */

import { describe, expect, test } from "vitest";

import {
  activityName,
  activitySharedState,
  httpActivityName,
  MAX_ACTIVITY_NAMES,
  OVERFLOW_ACTIVITY,
  subscribeActivityNames,
  withActivity,
} from "./main-activity.js";
import { sampleActivity } from "./stall-protocol.js";

/** The activity as the watchdog would read it right now, by name. */
function seen(): { inner: string | null; outer: string | null; inFlight: string[] } {
  const s = sampleActivity(activitySharedState().slots);
  return {
    inner: activityName(s.inner),
    outer: activityName(s.outer),
    inFlight: s.inFlight.map((id) => activityName(id)!),
  };
}

describe("withActivity", () => {
  test("marks the innermost and outermost activity while nested work runs", () => {
    const during: ReturnType<typeof seen>[] = [];
    withActivity("outer.task", () => {
      during.push(seen());
      withActivity("inner.step", () => {
        during.push(seen());
      });
      during.push(seen());
    });
    expect(during).toEqual([
      { inner: "outer.task", outer: "outer.task", inFlight: [] },
      { inner: "inner.step", outer: "outer.task", inFlight: [] },
      { inner: "outer.task", outer: "outer.task", inFlight: [] },
    ]);
    expect(seen()).toEqual({ inner: null, outer: null, inFlight: [] });
  });

  test("returns what the work returns and restores the mark when it throws", () => {
    expect(withActivity("returns", () => 42)).toBe(42);
    expect(() =>
      withActivity("outer.task", () =>
        withActivity("throws", () => {
          throw new Error("boom");
        }),
      ),
    ).toThrow("boom");
    expect(seen()).toEqual({ inner: null, outer: null, inFlight: [] });
  });

  test("keeps an asynchronous activity in flight until its promise settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = async (): Promise<string> => {
      await gate;
      return "done";
    };
    const pending = withActivity("async.task", work);
    // Past its first await: no longer running, still in flight.
    expect(seen()).toEqual({ inner: null, outer: null, inFlight: ["async.task"] });
    release();
    expect(await pending).toBe("done");
    // The release reaction runs after the caller's; give it one turn.
    await Promise.resolve();
    expect(seen().inFlight).toEqual([]);
  });

  test("settles the same way as the work's promise, rejections included", async () => {
    await expect(withActivity("resolves", async () => 7)).resolves.toBe(7);
    const returned = withActivity("rejects", () => Promise.reject(new Error("nope")));
    expect(seen().inFlight).toEqual(["rejects"]);
    await expect(returned).rejects.toThrow("nope");
    expect(seen().inFlight).toEqual([]);
  });

  test("tells a subscriber each name once, and lists those already registered", () => {
    withActivity("known.before", () => undefined);
    const told: Array<[number, string]> = [];
    const existing = subscribeActivityNames((id, name) => told.push([id, name]));
    try {
      expect(existing.map(([, name]) => name)).toContain("known.before");
      withActivity("first.use", () => undefined);
      withActivity("first.use", () => undefined);
      expect(told.map(([, name]) => name)).toEqual(["first.use"]);
      expect(activityName(told[0]![0])).toBe("first.use");
    } finally {
      subscribeActivityNames(null);
    }
  });

  test("records names past the cap under one overflow name", () => {
    for (let i = 0; i < MAX_ACTIVITY_NAMES; i++) withActivity(`generated.${i}`, () => undefined);
    let inner: string | null = null;
    withActivity("one.too.many", () => {
      inner = seen().inner;
    });
    expect(inner).toBe(OVERFLOW_ACTIVITY);
  });
});

describe("httpActivityName", () => {
  test("names a request by method and route pattern", () => {
    expect(httpActivityName("GET", "/documents/:id")).toBe("GET /documents/:id");
    expect(httpActivityName("BREW", "/pot")).toBe("OTHER /pot");
    expect(httpActivityName("GET", "")).toBe("GET (unmatched)");
  });
});
