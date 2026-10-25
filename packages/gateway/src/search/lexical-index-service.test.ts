// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LexicalIndexService } from "./lexical-index-service.js";
import type { LexicalIndexData } from "./lexical-index-data.js";
import type { HostMemory } from "./lexical-index-memory.js";
import type { LexicalIndexBuild } from "../workers/lexical-index-build.js";

function fakeData(docCount: number, changeSeq: number): LexicalIndexData {
  return {
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

const GB = 1e9;
const plenty = { availableBytes: 64 * GB, totalBytes: 128 * GB };
/** A small corpus on a host with room to spare. */
const roomy = {
  corpusStats: () => ({ chunks: 1000, tokens: 100_000, maxRowid: 1000 }),
  rankers: 1,
  hostMemory: () => plenty,
};

function scriptedBuilds(results: Array<LexicalIndexData | Error>) {
  const started: number[] = [];
  const build = (): LexicalIndexBuild => {
    started.push(Date.now());
    const next = results.shift() ?? new Error("no more builds scripted");
    const done =
      next instanceof Error ? Promise.reject(next) : Promise.resolve({ data: next, ms: 1 });
    done.catch(() => {});
    return { done, terminate: async () => {} };
  };
  return { build, started };
}

describe("LexicalIndexService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("publishes the first build and rebuilds once the corpus has grown enough", async () => {
    const published: number[] = [];
    let newer = 0;
    const { build, started } = scriptedBuilds([fakeData(1000, 1000), fakeData(1030, 1030)]);
    const service = new LexicalIndexService({
      ...roomy,
      build,
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
      ...roomy,
      build,
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
      ...roomy,
      build,
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
      ...roomy,
      build: () => ({
        done: new Promise((resolve) => (finish = resolve)),
        terminate: async () => {
          terminated = true;
        },
      }),
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
      ...roomy,
      build: () => {
        builds++;
        return { done: new Promise(() => {}), terminate: async () => {} };
      },
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
      ...roomy,
      build,
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
      ...roomy,
      build,
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

  describe("memory check", () => {
    /** Too little memory for even the build's fixed working memory. */
    const tight: HostMemory = { availableBytes: 100 * 1024 * 1024, totalBytes: 128 * GB };
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());
    const skipWarnings = () =>
      warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes("would need about")).length;

    test("skips a build that would not fit, warns once, and builds once memory frees up", async () => {
      let memory = tight;
      const published: number[] = [];
      const { build, started } = scriptedBuilds([fakeData(1000, 1)]);
      const service = new LexicalIndexService({
        ...roomy,
        hostMemory: () => memory,
        build,
        countChanges: () => 0,
        publish: (d) => published.push(d.docCount),
        checkIntervalMs: 1000,
      });
      expect(service.status()).toMatchObject({ state: "pending", inMemory: false });
      service.start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(started).toHaveLength(0);
      const status = service.status();
      expect(status).toMatchObject({ state: "too-large", inMemory: false });
      expect(status.neededBytes).toBeGreaterThan(tight.availableBytes / 2);
      expect(status.message).toContain("ranks from the on-disk index");
      expect(status.message).toContain("search.bm25.memoryIndexIgnoreMemoryCheck");
      expect(skipWarnings()).toBe(1);

      memory = plenty;
      await vi.advanceTimersByTimeAsync(1000);
      expect(started).toHaveLength(1);
      expect(published).toEqual([1000]);
      expect(service.status()).toMatchObject({ state: "ready", inMemory: true });
      await service.stop();
    });

    test("keeps serving the current index when a rebuild would not fit", async () => {
      let memory = plenty;
      const published: number[] = [];
      const { build, started } = scriptedBuilds([fakeData(1000, 1), fakeData(1000, 2)]);
      const service = new LexicalIndexService({
        ...roomy,
        hostMemory: () => memory,
        build,
        countChanges: () => 0,
        publish: (d) => published.push(d.changeSeq),
        maxAgeMs: 2000,
        checkIntervalMs: 1000,
      });
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(published).toEqual([1]);

      memory = tight;
      await vi.advanceTimersByTimeAsync(5000);
      expect(started).toHaveLength(1);
      expect(published).toEqual([1]);
      expect(service.status()).toMatchObject({ state: "too-large", inMemory: true });
      expect(service.status().message).toContain("without rebuilding it");
      expect(skipWarnings()).toBe(1);
      await service.stop();
    });

    test("builds anyway when the operator ignores the memory check", async () => {
      const published: number[] = [];
      const { build } = scriptedBuilds([fakeData(1000, 1)]);
      const service = new LexicalIndexService({
        ...roomy,
        hostMemory: () => tight,
        ignoreMemoryCheck: () => true,
        build,
        countChanges: () => 0,
        publish: (d) => published.push(d.docCount),
      });
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(published).toEqual([1000]);
      expect(service.status().state).toBe("ready");
      await service.stop();
    });

    test("a memory check that cannot read the corpus lets the build run", async () => {
      const published: number[] = [];
      const { build } = scriptedBuilds([fakeData(1000, 1)]);
      const service = new LexicalIndexService({
        ...roomy,
        corpusStats: () => {
          throw new Error("no such table: chunks_fts_data");
        },
        build,
        countChanges: () => 0,
        publish: (d) => published.push(d.docCount),
      });
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(published).toEqual([1000]);
      await service.stop();
    });

    test("a failed build reports failed until a retry publishes", async () => {
      const { build } = scriptedBuilds([new Error("disk went away"), fakeData(7, 7)]);
      const service = new LexicalIndexService({
        ...roomy,
        build,
        countChanges: () => 0,
        publish: () => {},
        checkIntervalMs: 1000,
      });
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.status()).toMatchObject({ state: "failed", inMemory: false });
      await vi.advanceTimersByTimeAsync(1000);
      expect(service.status()).toMatchObject({ state: "ready", inMemory: true });
      await service.stop();
    });
  });
});
