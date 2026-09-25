// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
import {
  getSourcePriorDefaults,
  resetSourcePriorDefaults,
  setSourcePriorDefaults,
} from "./source-prior-defaults.js";

describe("source-prior-defaults registry", () => {
  afterEach(() => {
    // Tests below mutate the collector-declared layer; reset so they
    // don't leak into the next test or into pipeline tests that read
    // the live registry.
    resetSourcePriorDefaults();
  });

  test("returns the built-in `web` downweight when no collector push has happened", () => {
    // `web` is gateway-hosted, so the gateway seeds its downweight itself.
    const defaults = getSourcePriorDefaults();
    expect(defaults.web).toBe(-0.04);
  });

  test("setSourcePriorDefaults installs the collector layer on top of the built-in", () => {
    setSourcePriorDefaults([
      { sourceIdPrefix: "browser-history", weight: -0.04 },
      { sourceIdPrefix: "gmail", weight: 0.05 },
    ]);
    const defaults = getSourcePriorDefaults();
    expect(defaults["browser-history"]).toBe(-0.04);
    expect(defaults.gmail).toBe(0.05);
    expect(defaults.web).toBe(-0.04); // built-in preserved
  });

  test("re-pushing fully replaces the previous collector entries", () => {
    setSourcePriorDefaults([{ sourceIdPrefix: "browser-history", weight: -0.04 }]);
    setSourcePriorDefaults([{ sourceIdPrefix: "gmail", weight: 0.05 }]);
    const defaults = getSourcePriorDefaults();
    expect(defaults).not.toHaveProperty("browser-history");
    expect(defaults.gmail).toBe(0.05);
    expect(defaults.web).toBe(-0.04); // built-in still there
  });

  test("a configured `web` (or omnesis.json) can override the built-in for the same prefix", () => {
    setSourcePriorDefaults([{ sourceIdPrefix: "web", weight: -0.1 }]);
    expect(getSourcePriorDefaults().web).toBe(-0.1);
  });

  test("empty entries array clears the collector layer, leaving the built-in", () => {
    setSourcePriorDefaults([{ sourceIdPrefix: "gmail", weight: 0.05 }]);
    setSourcePriorDefaults([]);
    const defaults = getSourcePriorDefaults();
    expect(defaults).not.toHaveProperty("gmail");
    expect(defaults.web).toBe(-0.04);
  });
});
