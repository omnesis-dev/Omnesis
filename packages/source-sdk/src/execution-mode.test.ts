// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Who runs a source.
 *
 * The interesting cases are the migration ones. This declaration replaces a
 * boolean that asked the same question, and a source that has not moved must
 * get the answer it had — otherwise a source nothing drives starts being
 * driven, or one that should be driven silently stops.
 */

import { describe, expect, test } from "vitest";
import { executionModeOf, isDrivenByHost } from "./execution-mode.js";

describe("what a source is unless it says otherwise", () => {
  test("a source that declares nothing is driven by the host", () => {
    // The default has to be the common case, or every ordinary source would
    // need a line saying it is ordinary.
    expect(executionModeOf({})).toBe("pull");
    expect(executionModeOf(undefined)).toBe("pull");
    expect(isDrivenByHost({})).toBe(true);
  });

  test("a declared mode is taken at its word", () => {
    expect(executionModeOf({ execution: "external" })).toBe("external");
    expect(isDrivenByHost({ execution: "external" })).toBe(false);
    expect(executionModeOf({ execution: "pull" })).toBe("pull");
  });
});

describe("a source that has not migrated keeps the answer it had", () => {
  test("the boolean it replaces is still read", () => {
    expect(executionModeOf({ pushBased: true })).toBe("external");
    expect(isDrivenByHost({ pushBased: true })).toBe(false);
  });

  test("the boolean set false means the same as not setting it", () => {
    expect(executionModeOf({ pushBased: false })).toBe("pull");
  });

  test("a declared mode wins over the boolean, in both directions", () => {
    // Both are present during the migration, and a source that has stated the
    // new one has stated its intent. Reading the old one second would let a
    // stale flag override a deliberate declaration.
    expect(executionModeOf({ execution: "pull", pushBased: true })).toBe("pull");
    expect(executionModeOf({ execution: "external", pushBased: false })).toBe("external");
  });
});
