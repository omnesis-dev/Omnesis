// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { validateConfig } from "./config-schema.js";
import { CONFIG_DEFAULTS } from "./config-defaults.js";

function errors(config: unknown): string[] {
  const result = validateConfig(config);
  return result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`);
}

/** The top of the scale each threshold is on. */
const SCALES: Record<keyof typeof CONFIG_DEFAULTS.brain.thresholds, number> = {
  worthGate: 3,
  discovery: 1,
  impact: 1,
  reviewNow: 1,
  reviewDormant: 1,
  recordBelongs: 3,
  documentRecordValue: 3,
  personRecordValue: 3,
  personWithdrawal: 3,
  profileDistillation: 3,
  wikiRepair: 3,
  outcomeIntegrity: 3,
  outcomeDeadline: 3,
  sameTask: 2,
  taskNoteNew: 2,
  taskAdopt: 2,
  taskWithhold: 2,
};

describe("validateConfig — decision thresholds", () => {
  test("accepts every Brain threshold at either end of its scale", () => {
    for (const [key, max] of Object.entries(SCALES)) {
      // Both ends of the scale; the pairs that must stay ordered keep their partner beside them.
      for (const value of [0, max]) {
        const thresholds: Record<string, number> = { [key]: value };
        if (key === "reviewDormant") thresholds.reviewNow = 1;
        if (key === "reviewNow") thresholds.reviewDormant = 0;
        if (key === "taskWithhold") thresholds.taskAdopt = 2;
        if (key === "taskAdopt") thresholds.taskWithhold = 0;
        expect(errors({ brain: { thresholds } }), `${key}=${value}`).toEqual([]);
      }
    }
  });

  test("refuses a threshold off its question's scale, or one that is not a number", () => {
    for (const [key, max] of Object.entries(SCALES)) {
      expect(errors({ brain: { thresholds: { [key]: max + 0.01 } } }), key).not.toEqual([]);
      expect(errors({ brain: { thresholds: { [key]: -0.01 } } }), key).not.toEqual([]);
      expect(errors({ brain: { thresholds: { [key]: "high" } } }), key).not.toEqual([]);
    }
    expect(errors({ brain: { thresholds: { unknownGate: 1 } } })).not.toEqual([]);
  });

  test("refuses review and suggestion cuts that cross, against the defaults too", () => {
    expect(errors({ brain: { thresholds: { reviewDormant: 0.8 } } })).toEqual([
      expect.stringContaining("dormant review threshold must not exceed"),
    ]);
    expect(errors({ brain: { thresholds: { reviewNow: 0.2, reviewDormant: 0.1 } } })).toEqual([]);
    expect(errors({ brain: { thresholds: { taskWithhold: 1.6 } } })).toEqual([
      expect.stringContaining("withhold threshold must not exceed the adopt threshold"),
    ]);
    expect(errors({ brain: { thresholds: { taskAdopt: 0.4 } } })).not.toEqual([]);
  });

  test("bounds the mention worth threshold to the worth scale", () => {
    expect(errors({ enrichment: { dates: { worthThreshold: 2.2 } } })).toEqual([]);
    expect(errors({ enrichment: { dates: { worthThreshold: 3.5 } } })).not.toEqual([]);
  });

  test("names a display default, tuned on Jev, for every threshold", () => {
    expect(Object.keys(CONFIG_DEFAULTS.brain.thresholds).sort()).toEqual(
      Object.keys(SCALES).sort(),
    );
    expect(CONFIG_DEFAULTS.brain.thresholds.worthGate).toBe(1.08);
    expect(CONFIG_DEFAULTS.enrichment.dates.worthThreshold).toBe(1.08);
  });
});
