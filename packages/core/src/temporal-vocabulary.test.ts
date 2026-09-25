// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The temporal vocabulary and interval algebra are declared in
 * `@omnesis/types` and reach `@omnesis/core` through a re-export shim, so that
 * the projection and annotation producers can share them without a dependency
 * cycle between the two packages.
 *
 * A re-export can typecheck and still fail at runtime — a wrong subpath in the
 * package's `exports` map, or a `export type` where a value was meant, both
 * satisfy `tsc` and then resolve to `undefined` when something actually calls
 * them. These assertions are deliberately about resolution, not behaviour:
 * behaviour is covered where the modules are declared.
 */

import { describe, expect, it } from "vitest";
import * as core from "@omnesis/core";

describe("the core barrel re-exports the temporal substrate as values", () => {
  it("resolves the vocabulary", () => {
    expect(Array.isArray(core.TEMPORAL_KINDS)).toBe(true);
    expect(core.TEMPORAL_KINDS.length).toBeGreaterThan(0);
    expect(core.canonicalTemporalKind).toBeTypeOf("function");
    expect(core.temporalVocabularyCheck).toBeTypeOf("function");
  });

  it("resolves the interval algebra", () => {
    expect(core.canonicalizeInterval).toBeTypeOf("function");
    expect(core.intervalOverlapsWindow).toBeTypeOf("function");
    expect(core.isCalendarDay).toBeTypeOf("function");
    expect(core.MAX_TIME_ZONE_SHIFT_MS).toBeTypeOf("number");
  });

  it("agrees with the declaring package", async () => {
    const types = await import("@omnesis/types/temporal-vocabulary");
    expect([...core.TEMPORAL_KINDS]).toEqual([...types.TEMPORAL_KINDS]);
  });
});
