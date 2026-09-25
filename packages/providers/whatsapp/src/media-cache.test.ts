// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { MediaByteCache } from "./media-cache.js";

const bytes = (n: number) => new Uint8Array(n);

describe("MediaByteCache", () => {
  test("take consumes once — a second take misses", () => {
    const c = new MediaByteCache({ maxEntries: 10, maxBytes: 1000, ttlMs: 10_000 });
    c.put("a", new Uint8Array([1, 2, 3]));
    expect(Array.from(c.take("a")!)).toEqual([1, 2, 3]);
    expect(c.take("a")).toBeUndefined();
    expect(c.size).toBe(0);
    expect(c.byteSize).toBe(0);
  });

  test("take drops (does not return) an entry past its TTL", () => {
    let now = 1000;
    const c = new MediaByteCache({ maxEntries: 10, maxBytes: 1000, ttlMs: 500 }, () => now);
    c.put("a", bytes(4));
    now = 1600; // 600ms later > 500ms ttl
    expect(c.take("a")).toBeUndefined();
    expect(c.size).toBe(0);
    expect(c.byteSize).toBe(0); // byte accounting stays correct on the expired-take path
  });

  test("evicts oldest first when the entry count is exceeded", () => {
    const c = new MediaByteCache({ maxEntries: 2, maxBytes: 10_000, ttlMs: 10_000 });
    c.put("a", bytes(1));
    c.put("b", bytes(1));
    c.put("c", bytes(1)); // pushes "a" out
    expect(c.has("a")).toBe(false);
    expect(c.has("b")).toBe(true);
    expect(c.has("c")).toBe(true);
    expect(c.size).toBe(2);
  });

  test("evicts oldest first when the total byte budget is exceeded", () => {
    const c = new MediaByteCache({ maxEntries: 100, maxBytes: 10, ttlMs: 10_000 });
    c.put("a", bytes(6));
    c.put("b", bytes(6)); // 12 > 10 → "a" evicted
    expect(c.has("a")).toBe(false);
    expect(c.has("b")).toBe(true);
    expect(c.byteSize).toBe(6);
  });

  test("re-putting a key replaces bytes without double-counting", () => {
    const c = new MediaByteCache({ maxEntries: 10, maxBytes: 1000, ttlMs: 10_000 });
    c.put("a", bytes(3));
    c.put("a", bytes(5));
    expect(c.size).toBe(1);
    expect(c.byteSize).toBe(5);
  });

  test("expired entries are swept on put, freeing budget for the new one", () => {
    let now = 0;
    const c = new MediaByteCache({ maxEntries: 10, maxBytes: 10, ttlMs: 100 }, () => now);
    c.put("old", bytes(8));
    now = 200; // "old" now expired
    c.put("new", bytes(8)); // sweep drops "old" first, so "new" fits
    expect(c.has("old")).toBe(false);
    expect(c.has("new")).toBe(true);
    expect(c.byteSize).toBe(8);
  });
});
