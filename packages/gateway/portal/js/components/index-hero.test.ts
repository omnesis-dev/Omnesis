// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  // @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
  migrationReadout,
  // @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
  diskUsageReadout,
} from "./index-hero.js";

// Status two-readout (epic #1011): the portal must render the gateway's neutral
// `indexVersions` payload so that a graceful embedder swap shows as a separate
// upgrade-in-flight while the active index keeps reading complete. These assert
// the rendering helper picks the right framing and never produces NaN/broken %.

describe("migrationReadout", () => {
  test("returns null when no rebuild is in flight", () => {
    expect(migrationReadout(undefined)).toBeNull();
    expect(migrationReadout(null)).toBeNull();
    expect(migrationReadout({ active: { embedModel: "model-a", embedDim: 768 }, building: null })).toBeNull();
  });

  test("graceful migration (active present) frames as upgrade-in-flight, search stays live", () => {
    const r = migrationReadout({
      active: { version: 1, embedModel: "embed-classic", embedDim: 768 },
      building: { version: 2, embedModel: "embed-next", embedDim: 1024, docsBuilt: 4200, docsTotal: 10000, percent: 42 },
    });
    expect(r.kind).toBe("migration");
    expect(r.model).toBe("embed-next");
    expect(r.activeModel).toBe("embed-classic");
    expect(r.percent).toBe(42);
    expect(r.docsBuilt).toBe(4200);
    expect(r.docsTotal).toBe(10000);
  });

  test("first build / hard cutover (no active) frames as limited-until-complete", () => {
    const r = migrationReadout({
      active: null,
      building: { version: 1, embedModel: "embed-fresh", embedDim: 512, docsBuilt: 100, docsTotal: 500, percent: 20 },
    });
    expect(r.kind).toBe("build");
    expect(r.activeModel).toBeNull();
    expect(r.model).toBe("embed-fresh");
    expect(r.percent).toBe(20);
  });

  test("docsTotal of 0 produces 0% and no NaN/Infinity", () => {
    const r = migrationReadout({
      active: { version: 1, embedModel: "a", embedDim: 8 },
      building: { version: 2, embedModel: "b", embedDim: 8, docsBuilt: 0, docsTotal: 0, percent: 0 },
    });
    expect(r.percent).toBe(0);
    expect(Number.isFinite(r.percent)).toBe(true);
    expect(r.docsTotal).toBe(0);
  });

  test("clamps a malformed/older payload defensively", () => {
    const r = migrationReadout({
      active: { version: 1, embedModel: "a", embedDim: 8 },
      building: { version: 2, embedModel: "b", embedDim: 8, docsBuilt: Number.NaN, docsTotal: -5, percent: 250 },
    });
    expect(r.percent).toBe(100);
    expect(r.docsBuilt).toBe(0);
    expect(r.docsTotal).toBe(0);
  });

  test("falls back to a label when the building model name is missing", () => {
    const r = migrationReadout({ active: null, building: { version: 1, percent: 5, docsBuilt: 1, docsTotal: 20 } });
    expect(r.model).toBe("the new model");
  });
});

// The "on disk" stat reads the gateway's whole footprint when it has one and
// the main database size from a gateway that predates `diskUsage`.
describe("diskUsageReadout", () => {
  const usage = {
    totalBytes: 3000,
    measuredAt: "2026-06-04T10:00:00.000Z",
    stores: [
      { id: "documents", label: "Main database", bytes: 1000 },
      { id: "index", label: "Search index", bytes: 2000 },
    ],
  };

  test("prefers the whole footprint and its breakdown", () => {
    expect(diskUsageReadout({ dbSizeBytes: 1000, diskUsage: usage })).toEqual({
      totalBytes: 3000,
      stores: usage.stores,
    });
  });

  test("falls back to the main database with no breakdown on an older gateway", () => {
    expect(diskUsageReadout({ dbSizeBytes: 1000 })).toEqual({ totalBytes: 1000, stores: [] });
    expect(diskUsageReadout({ dbSizeBytes: 1000, diskUsage: null })).toEqual({
      totalBytes: 1000,
      stores: [],
    });
  });

  test("is null when neither size is known", () => {
    expect(diskUsageReadout({ dbSizeBytes: null, diskUsage: null })).toBeNull();
    expect(diskUsageReadout(undefined)).toBeNull();
  });

  test("drops malformed and empty rows", () => {
    const readout = diskUsageReadout({
      diskUsage: {
        totalBytes: 10,
        stores: [null, { id: "x", label: "X", bytes: "big" }, { id: "y", label: "Y", bytes: 0 }, { id: "z", label: "Z", bytes: 10 }],
      },
    });
    expect(readout.stores).toEqual([{ id: "z", label: "Z", bytes: 10 }]);
  });
});
