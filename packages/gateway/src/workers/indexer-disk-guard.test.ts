// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-cycle low-disk gate for the indexer worker. The pure
 * `shouldRunIndexCycle` decision: run when free disk meets the floor, skip
 * when it's below, and always run when the floor is disabled (≤0).
 */

import { describe, it, expect } from "vitest";
import { shouldRunIndexCycle } from "./indexer-disk-guard.js";

describe("shouldRunIndexCycle", () => {
  it("runs when free disk is above the floor", () => {
    const check = () => ({ ok: true, freeBytes: 10 * 1024 * 1024 * 1024 });
    const d = shouldRunIndexCycle("/idx/index.db", 500, check);
    expect(d.shouldRun).toBe(true);
    expect(d.freeBytes).toBe(10 * 1024 * 1024 * 1024);
  });

  it("skips when free disk is below the floor", () => {
    const check = () => ({ ok: false, freeBytes: 100 * 1024 * 1024 });
    const d = shouldRunIndexCycle("/idx/index.db", 500, check);
    expect(d.shouldRun).toBe(false);
    expect(d.freeBytes).toBe(100 * 1024 * 1024);
  });

  it("converts the MB floor to bytes for the check", () => {
    let seenMinBytes = -1;
    const check = (_p: string, minFreeBytes: number) => {
      seenMinBytes = minFreeBytes;
      return { ok: true, freeBytes: Infinity };
    };
    shouldRunIndexCycle("/idx/index.db", 500, check);
    expect(seenMinBytes).toBe(500 * 1024 * 1024);
  });

  it("always runs when the floor is disabled (≤0), without probing disk", () => {
    let probed = false;
    const check = () => {
      probed = true;
      return { ok: false, freeBytes: 0 };
    };
    const d = shouldRunIndexCycle("/idx/index.db", 0, check);
    expect(d.shouldRun).toBe(true);
    expect(d.freeBytes).toBe(Infinity);
    expect(probed).toBe(false);
  });
});
