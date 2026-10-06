// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sourceFixtureClock } from "./fixture-clock.js";
import type { Universe } from "./universe.js";

const temporary: string[] = [];
const defaults = { snapshotDay: "2025-12-31", syncedAt: "2025-12-31T12:00:00.000Z" };
function universe(): Universe {
  const dir = mkdtempSync(join(tmpdir(), "fixture-clock-"));
  temporary.push(dir);
  return { dir, manifest: { name: "fictional", cast: "cast.json", devices: [], sources: [] } };
}
function writeClock(loaded: Universe, value: unknown): void {
  const dir = join(loaded.dir, "sources", "fictional-source");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "clock.json"), JSON.stringify(value));
}
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sourceFixtureClock", () => {
  it("retains legacy defaults and freezes the first read even when a file arrives later", () => {
    const loaded = universe();
    const clock = sourceFixtureClock("fictional-source", defaults, loaded);
    expect(clock).toEqual(defaults);
    expect(clock).not.toBe(defaults);
    expect(Object.isFrozen(clock)).toBe(true);
    writeClock(loaded, { snapshotDay: "2026-10-03", syncedAt: "2026-10-03T12:00:00Z" });
    expect(sourceFixtureClock("fictional-source", defaults, loaded)).toBe(clock);
  });

  it("loads declared clocks with explicit offsets and separates fresh universe namespaces", () => {
    const loaded = universe();
    const declared = { snapshotDay: "2028-02-29", syncedAt: "2028-02-29T23:59:59.123+01:00" };
    writeClock(loaded, declared);
    const clock = sourceFixtureClock("fictional-source", defaults, loaded);
    expect(clock).toEqual(declared);
    writeClock(loaded, defaults);
    expect(sourceFixtureClock("fictional-source", defaults, loaded)).toBe(clock);
    expect(sourceFixtureClock("fictional-source", defaults, { ...loaded })).toEqual(defaults);
    expect(sourceFixtureClock("fictional-source", defaults, universe())).toEqual(defaults);
  });

  it.each([
    null,
    [],
    {},
    { ...defaults, extra: true },
    { ...defaults, snapshotDay: "2026-02-29" },
    { ...defaults, snapshotDay: "2026-04-31" },
    { ...defaults, snapshotDay: "2026-1-01" },
    { ...defaults, syncedAt: "2026-02-30T12:00:00Z" },
    { ...defaults, syncedAt: "2026-10-03T24:00:00Z" },
    { ...defaults, syncedAt: "2026-10-03T12:60:00Z" },
    { ...defaults, syncedAt: "2026-10-03T12:00:00" },
    { ...defaults, syncedAt: "2026-10-03T12:00:00+24:00" },
  ])("rejects invalid declared boundaries: %j", (invalid) => {
    const loaded = universe();
    writeClock(loaded, invalid);
    expect(() => sourceFixtureClock("fictional-source", defaults, loaded)).toThrow();
  });

  it("rejects malformed files and source traversal instead of falling back", () => {
    const loaded = universe();
    writeClock(loaded, defaults);
    writeFileSync(join(loaded.dir, "sources", "fictional-source", "clock.json"), "{");
    expect(() => sourceFixtureClock("fictional-source", defaults, loaded)).toThrow("valid JSON");
    expect(() => sourceFixtureClock("../outside", defaults, loaded)).toThrow("source identifier");
  });
});
