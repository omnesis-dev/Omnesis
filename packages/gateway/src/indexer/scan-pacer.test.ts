// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ScanPacer, type ScanPacingOptions } from "./scan-pacer.js";

const CALM = { userActive: false, walPendingFrames: 0 };
const FAST = { elapsedMs: 10, embedLimited: false };

function pacer(overrides: Partial<ScanPacingOptions> = {}): ScanPacer {
  return new ScanPacer({
    basePageSize: 10,
    baseSleepMs: 500,
    adaptive: true,
    maxPageSize: 1000,
    minSleepMs: 10,
    targetPageMs: 1000,
    maxEmbedDocs: 200,
    walPendingFramesLimit: 1000,
    maxWalSleepMs: 4000,
    ...overrides,
  });
}

describe("ScanPacer", () => {
  test("without catch-up every page keeps the configured size and pause", () => {
    const p = pacer({ adaptive: false });
    for (let i = 0; i < 5; i += 1) {
      expect(p.next()).toEqual({ pageSize: 10, embedDocs: 10 });
      expect(p.settle(FAST, CALM)).toBe(500);
    }
  });

  test("fast pages double up to the ceiling and the pause drops to the catch-up minimum", () => {
    const p = pacer();
    expect(p.next().pageSize).toBe(10);
    const sizes: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      expect(p.settle(FAST, CALM)).toBe(10);
      sizes.push(p.next().pageSize);
    }
    expect(sizes).toEqual([20, 40, 80, 160, 320, 640, 1000, 1000, 1000, 1000]);
    expect(p.current().pressure).toBe("none");
  });

  test("the embedding bound grows only on pages that reached it, and shrinks on slow pages", () => {
    const p = pacer();
    p.settle(FAST, CALM);
    expect(p.next().embedDocs).toBe(10);
    p.settle({ elapsedMs: 10, embedLimited: true }, CALM);
    expect(p.next().embedDocs).toBe(20);
    p.settle({ elapsedMs: 10, embedLimited: true }, CALM);
    expect(p.next().embedDocs).toBe(40);
    p.settle({ elapsedMs: 1500, embedLimited: true }, CALM);
    expect(p.next().embedDocs).toBe(20);
    const before = p.next().pageSize;
    p.settle({ elapsedMs: 2500, embedLimited: true }, CALM);
    expect(p.next().embedDocs).toBe(10);
    expect(p.next().pageSize).toBe(before / 2);
    for (let i = 0; i < 10; i += 1) p.settle({ elapsedMs: 5000, embedLimited: true }, CALM);
    expect(p.next()).toEqual({ pageSize: 10, embedDocs: 10 });
  });

  test("a page between half the target and the target leaves the sizing alone", () => {
    const p = pacer();
    p.settle(FAST, CALM);
    const sizing = p.next();
    p.settle({ elapsedMs: 700, embedLimited: true }, CALM);
    expect(p.next()).toEqual(sizing);
  });

  test("a user request in flight returns the scan to the configured pace at once", () => {
    const p = pacer();
    for (let i = 0; i < 6; i += 1) p.settle({ elapsedMs: 10, embedLimited: true }, CALM);
    expect(p.next().pageSize).toBeGreaterThan(10);
    expect(p.settle(FAST, { userActive: true, walPendingFrames: 0 })).toBe(500);
    expect(p.next()).toEqual({ pageSize: 10, embedDocs: 10 });
    expect(p.current()).toEqual({ pageSize: 10, sleepMs: 500, pressure: "user" });
    expect(p.settle(FAST, CALM)).toBe(10);
    expect(p.current().pressure).toBe("none");
  });

  test("a WAL no checkpoint can copy backs the scan off, doubling the pause up to its cap", () => {
    const p = pacer();
    for (let i = 0; i < 4; i += 1) p.settle(FAST, CALM);
    const held = { userActive: false, walPendingFrames: 5000 };
    expect(p.settle(FAST, held)).toBe(500);
    expect(p.next().pageSize).toBe(10);
    expect(p.settle(FAST, held)).toBe(1000);
    expect(p.settle(FAST, held)).toBe(2000);
    expect(p.settle(FAST, held)).toBe(4000);
    expect(p.settle(FAST, held)).toBe(4000);
    expect(p.current().pressure).toBe("wal");
    expect(p.settle(FAST, CALM)).toBe(10);
    expect(p.settle(FAST, held)).toBe(500);
  });

  test("the WAL limit outranks user activity", () => {
    const p = pacer();
    p.settle(FAST, { userActive: true, walPendingFrames: 5000 });
    expect(p.current().pressure).toBe("wal");
  });

  test("a configured page larger than the ceilings is never shrunk below itself", () => {
    const p = pacer({ basePageSize: 300, maxPageSize: 100, maxEmbedDocs: 50 });
    expect(p.next()).toEqual({ pageSize: 300, embedDocs: 300 });
    p.settle({ elapsedMs: 9000, embedLimited: true }, CALM);
    expect(p.next()).toEqual({ pageSize: 300, embedDocs: 300 });
  });
});
