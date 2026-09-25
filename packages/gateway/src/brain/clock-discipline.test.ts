// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The clock-discipline gate: the brain subsystem's convention that no
 * decision path reads the wall clock on its own is what makes virtual
 * replay (the backtest mirror's `OMNESIS_BRIEFS_VIRTUAL_CLOCK=1` mode)
 * trustworthy. This test enforces the convention mechanically: every
 * bare `Date.now()` under `brain/**` must sit on the explicit
 * whitelist below — a new one either threads the injected clock or is
 * consciously whitelisted (wall-clock-by-design sites like log
 * rate-limiters), in this file, in the same change.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const BRAIN_ROOT = join(fileURLToPath(import.meta.url), "..");

/**
 * Wall-clock-by-design sites, path => reason. Counts are not pinned —
 * only WHICH files may contain a bare `Date.now()` at all.
 */
const WHITELIST: Record<string, string> = {
  "storage/types.ts": "systemClock itself — the one sanctioned wall-clock read",
  "virtual-clock.ts": "createMutableClock's default initial instant",
  "feature-gate.ts": "the documented fallback when no clock is injected (rq.clock ?? Date.now)",
  "storage/open-loops.ts": "retireLoop's `opts.now ??` fallback for direct callers",
  "waker/event-handler.ts": "log rate-limiter in warnDropped — deliberately wall time",
  "interactive-loop-port.ts":
    "serves the live interactive agent (not the replay-driven Cognition Steward); times a real search for the tool-call card's durationMs, like the sibling agent ports",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("brain clock discipline", () => {
  test("bare Date.now() appears only in whitelisted files", () => {
    const offenders: string[] = [];
    for (const file of walk(BRAIN_ROOT)) {
      const rel = relative(BRAIN_ROOT, file);
      if (!readFileSync(file, "utf8").includes("Date.now()")) continue;
      if (!(rel in WHITELIST)) offenders.push(rel);
    }
    expect(
      offenders,
      "bare Date.now() outside the whitelist — thread the injected clock " +
        "(or whitelist the site here with a reason) so virtual replay stays trustworthy",
    ).toEqual([]);
  });

  test("the whitelist carries no stale entries", () => {
    for (const rel of Object.keys(WHITELIST)) {
      const content = readFileSync(join(BRAIN_ROOT, rel), "utf8");
      expect(content.includes("Date.now()"), `${rel} no longer reads Date.now()`).toBe(true);
    }
  });
});
