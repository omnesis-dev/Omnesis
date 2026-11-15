// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LexicalIndexService } from "./lexical-index-service.js";
import type { LexicalIndexData, LexicalIndexSource } from "./lexical-index-data.js";
import type { LexicalIndexBuild } from "../workers/lexical-index-build.js";

function fakeData(docCount: number, changeSeq: number, version = 0): LexicalIndexData {
  return {
    version,
    tokenize: "porter unicode61 remove_diacritics 2",
    docCount,
    changeSeq,
    avgLength: 10,
    rowids: new Uint32Array(0),
    lengthNorm: new Float64Array(0),
    termBytes: new Uint8Array(0),
    termStart: new Uint32Array(1),
    postingStart: new Uint32Array(1),
    postingDoc: new Uint32Array(0),
    postingFreq: new Uint16Array(0),
  };
}

function scriptedBuilds(results: Array<LexicalIndexData | Error>) {
  const started: number[] = [];
  const sources: LexicalIndexSource[] = [];
  const build = (source: LexicalIndexSource): LexicalIndexBuild => {
    started.push(Date.now());
    sources.push(source);
    const next = results.shift() ?? new Error("no more builds scripted");
    const done =
      next instanceof Error ? Promise.reject(next) : Promise.resolve({ data: next, ms: 1 });
    done.catch(() => {});
    return { done, terminate: async () => {} };
  };
  return { build, started, sources };
}

describe("LexicalIndexService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("publishes the first build and rebuilds once the corpus has grown enough", async () => {
    const published: number[] = [];
    let newer = 0;
    const { build, started } = scriptedBuilds([fakeData(1000, 1000), fakeData(1030, 1030)]);
    const service = new LexicalIndexService({
      build,
      switchVersion: async () => true,
      activeVersion: () => 0,
      countChanges: () => newer,
      publish: (d) => published.push(d.docCount),
      changeFraction: 0.02,
      checkIntervalMs: 1000,
    });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toEqual([1000]);

    newer = 10; // 1% growth: not yet
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toHaveLength(1);

    newer = 30; // 3% growth: rebuild
    await vi.advanceTimersByTimeAsync(1000);
    expect(published).toEqual([1000, 1030]);
    await service.stop();
  });

  test("rebuilds an index past its maximum age even without growth", async () => {
    const published: number[] = [];
    const { build } = scriptedBuilds([fakeData(5, 5), fakeData(5, 5)]);
    const service = new LexicalIndexService({
      build,
      switchVersion: async () => true,
      activeVersion: () => 0,
      countChanges: () => 0,
      publish: (d) => published.push(d.docCount),
      maxAgeMs: 5000,
      checkIntervalMs: 1000,
    });
    service.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(published).toHaveLength(2);
    await service.stop();
  });

  test("a failed build publishes nothing and the next check retries", async () => {
    const published: number[] = [];
    const { build, started } = scriptedBuilds([new Error("disk went away"), fakeData(7, 7)]);
    const service = new LexicalIndexService({
      build,
      switchVersion: async () => true,
      activeVersion: () => 0,
      countChanges: () => 0,
      publish: (d) => published.push(d.docCount),
      checkIntervalMs: 1000,
    });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toHaveLength(2);
    expect(published).toEqual([7]);
    await service.stop();
  });

  test("a stop while a build runs terminates it and publishes nothing", async () => {
    const published: number[] = [];
    let terminated = false;
    let finish!: (v: { data: LexicalIndexData; ms: number }) => void;
    const service = new LexicalIndexService({
      build: () => ({
        done: new Promise((resolve) => (finish = resolve)),
        terminate: async () => {
          terminated = true;
        },
      }),
      switchVersion: async () => true,
      activeVersion: () => 0,
      countChanges: () => 0,
      publish: (d) => published.push(d.docCount),
    });
    service.start();
    await service.stop();
    finish({ data: fakeData(3, 3), ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(terminated).toBe(true);
    expect(published).toEqual([]);
  });

  test("never runs two builds at once", async () => {
    let builds = 0;
    const service = new LexicalIndexService({
      build: () => {
        builds++;
        return { done: new Promise(() => {}), terminate: async () => {} };
      },
      switchVersion: async () => true,
      activeVersion: () => 0,
      countChanges: () => 1_000_000,
      publish: () => {},
      checkIntervalMs: 1000,
    });
    service.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(builds).toBe(1);
    await service.stop();
  });

  test("a change count that fails is logged and later checks continue", async () => {
    const published: number[] = [];
    let calls = 0;
    const { build } = scriptedBuilds([fakeData(100, 1), fakeData(100, 2)]);
    const service = new LexicalIndexService({
      build,
      switchVersion: async () => true,
      activeVersion: () => 0,
      countChanges: () => {
        calls++;
        if (calls === 1) throw new Error("database is locked");
        return 50;
      },
      publish: (d) => published.push(d.changeSeq),
      checkIntervalMs: 1000,
    });
    service.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);
    expect(published).toEqual([1, 2]);
    await service.stop();
  });

  test("failed builds back off exponentially", async () => {
    const { build, started } = scriptedBuilds([
      new Error("first"),
      new Error("second"),
      new Error("third"),
    ]);
    const service = new LexicalIndexService({
      build,
      switchVersion: async () => true,
      activeVersion: () => 0,
      countChanges: () => 0,
      publish: () => {},
      checkIntervalMs: 1000,
    });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); // retry after one interval
    expect(started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000); // backing off: two intervals now
    expect(started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toHaveLength(3);
    await service.stop();
  });
});

describe("LexicalIndexService.prepareSwitch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("builds the new version's in-memory index first, then switches, then publishes it", async () => {
    const events: string[] = [];
    const { build, sources } = scriptedBuilds([fakeData(10, 10, 0), fakeData(10, 12, 1)]);
    const service = new LexicalIndexService({
      build,
      switchVersion: async (version) => {
        events.push(`switch ${version}`);
        return true;
      },
      activeVersion: () => 0,
      countChanges: () => 0,
      publish: (d) => events.push(`publish ${d.version}`),
      checkIntervalMs: 1000,
    });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await service.prepareSwitch(1);
    expect(sources).toEqual(["active", "building"]);
    expect(events).toEqual(["publish 0", "switch 1", "publish 1"]);
    await service.stop();
  });

  test("publishes nothing when the rebuild was superseded before its switch", async () => {
    const published: number[] = [];
    const { build } = scriptedBuilds([fakeData(10, 10, 0), fakeData(10, 12, 1)]);
    const service = new LexicalIndexService({
      build,
      switchVersion: async () => false,
      activeVersion: () => 0,
      countChanges: () => 0,
      publish: (d) => published.push(d.version),
      checkIntervalMs: 1000,
    });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await service.prepareSwitch(1);
    expect(published).toEqual([0]);
    await service.stop();
  });

  test("keeps the current index when the switch fails, and retries on the next report", async () => {
    const published: number[] = [];
    let attempts = 0;
    const { build } = scriptedBuilds([
      fakeData(10, 10, 0),
      fakeData(10, 12, 1),
      fakeData(10, 13, 1),
    ]);
    const service = new LexicalIndexService({
      build,
      switchVersion: async () => {
        attempts++;
        if (attempts === 1) throw new Error("worker restarting");
        return true;
      },
      activeVersion: () => 0,
      countChanges: () => 0,
      publish: (d) => published.push(d.version),
      checkIntervalMs: 1000,
    });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await service.prepareSwitch(1);
    expect(published).toEqual([0]);
    await service.prepareSwitch(1);
    expect(published).toEqual([0, 1]);
    await service.stop();
  });

  test("switches without the new in-memory index after repeated build failures", async () => {
    const events: string[] = [];
    const { build } = scriptedBuilds([
      fakeData(10, 10, 0),
      new Error("out of memory"),
      new Error("out of memory"),
      new Error("out of memory"),
      fakeData(10, 20, 1),
    ]);
    const service = new LexicalIndexService({
      build,
      switchVersion: async (version) => {
        events.push(`switch ${version}`);
        return true;
      },
      activeVersion: () => 0,
      countChanges: () => 0,
      publish: (d) => events.push(`publish ${d.version}`),
      checkIntervalMs: 1000,
    });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await service.prepareSwitch(1);
    await service.prepareSwitch(1);
    expect(events).toEqual(["publish 0"]);
    await service.prepareSwitch(1);
    await vi.advanceTimersByTimeAsync(0);
    // Switched without it; the regular build of the new active index follows.
    expect(events).toEqual(["publish 0", "switch 1", "publish 1"]);
    await service.stop();
  });

  test("a report that arrives while a switch is being prepared is dropped", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const builds: LexicalIndexSource[] = [];
    const service = new LexicalIndexService({
      build: (source) => {
        builds.push(source);
        const done = gate.then(() => ({
          data: fakeData(10, 10, source === "active" ? 0 : 1),
          ms: 1,
        }));
        return { done, terminate: async () => {} };
      },
      switchVersion: async () => true,
      activeVersion: () => 0,
      countChanges: () => 0,
      publish: () => {},
      checkIntervalMs: 1000,
    });
    const first = service.prepareSwitch(1);
    await service.prepareSwitch(1);
    expect(builds).toEqual(["building"]);
    release();
    await first;
    await service.stop();
  });

  test("ignores a report for a version that is already active", async () => {
    const { build, sources } = scriptedBuilds([fakeData(10, 10, 1)]);
    const service = new LexicalIndexService({
      build,
      switchVersion: async () => true,
      activeVersion: () => 1,
      countChanges: () => 0,
      publish: () => {},
      checkIntervalMs: 1000,
    });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await service.prepareSwitch(1);
    expect(sources).toEqual(["active"]);
    await service.stop();
  });

  test("counts failed builds per version, so a new version gets every attempt", async () => {
    const events: string[] = [];
    const { build } = scriptedBuilds([
      fakeData(10, 10, 0),
      new Error("no building full-text index"),
      new Error("no building full-text index"),
      new Error("worker exited"),
      fakeData(10, 20, 2),
    ]);
    const service = new LexicalIndexService({
      build,
      switchVersion: async (version) => {
        events.push(`switch ${version}`);
        return true;
      },
      activeVersion: () => 0,
      countChanges: () => 0,
      publish: (d) => events.push(`publish ${d.version}`),
      checkIntervalMs: 1000,
    });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await service.prepareSwitch(1);
    await service.prepareSwitch(1);
    // Version 2's first failure is its first, not the third in a row.
    await service.prepareSwitch(2);
    expect(events).toEqual(["publish 0"]);
    await service.prepareSwitch(2);
    expect(events).toEqual(["publish 0", "switch 2", "publish 2"]);
    await service.stop();
  });

  test("builds the active version's index when a switch it lost track of went through", async () => {
    let active = 0;
    const published: number[] = [];
    const { build, sources } = scriptedBuilds([
      fakeData(10, 10, 0),
      fakeData(10, 12, 1),
      fakeData(10, 13, 1),
    ]);
    const service = new LexicalIndexService({
      build,
      switchVersion: async () => {
        // The switch completes, but the request times out before saying so.
        active = 1;
        throw new Error("keyword-index switch timed out");
      },
      activeVersion: () => active,
      countChanges: () => 0,
      publish: (d) => published.push(d.version),
      checkIntervalMs: 1000,
    });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await service.prepareSwitch(1);
    expect(published).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sources).toEqual(["active", "building", "active"]);
    expect(published).toEqual([0, 1]);
    await service.stop();
  });
});
