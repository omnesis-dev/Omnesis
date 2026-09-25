// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Low-disk write guard (#15). `hasFreeDiskSpace` is exercised against a real
 * path so the statfs seam is the production one — minFreeBytes=0 is always
 * ok, a huge minimum is never ok, and a statfs failure reads as ok (free =
 * Infinity) so a flaky syscall never wedges writes.
 */

import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { hasFreeDiskSpace } from "./disk-guard.js";
import { freeDiskBytes } from "./system-info.js";

describe("hasFreeDiskSpace", () => {
  it("is ok when minFreeBytes is 0 (any real volume has ≥0 free)", () => {
    const res = hasFreeDiskSpace(tmpdir(), 0);
    expect(res.ok).toBe(true);
    expect(res.freeBytes).toBeGreaterThanOrEqual(0);
  });

  it("is not ok when the minimum exceeds any plausible free space", () => {
    const res = hasFreeDiskSpace(tmpdir(), Number.MAX_SAFE_INTEGER);
    expect(res.ok).toBe(false);
    // Real volume → a finite, non-negative free figure below the absurd min.
    expect(res.freeBytes).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("treats a statfs failure as ok (free = Infinity) so writes aren't blocked", () => {
    // A path on a non-existent filesystem makes statfs throw; freeDiskBytes
    // returns Infinity, so even an absurd minimum is satisfied.
    const bogus = "/this/path/does/not/exist/anywhere-omnesis-15";
    expect(freeDiskBytes(bogus)).toBe(Infinity);
    const res = hasFreeDiskSpace(bogus, Number.MAX_SAFE_INTEGER);
    expect(res.ok).toBe(true);
    expect(res.freeBytes).toBe(Infinity);
  });
});
