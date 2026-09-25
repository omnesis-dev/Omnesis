// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The portal's copy of the source-id split.
 *
 * It exists because the portal is served as static files and imports nothing
 * from the workspace, so the rule cannot be shared with `@omnesis/types`. The
 * cases below are the ones that make the two copies checkable against each
 * other by reading: the first-colon split, an account that contains the
 * separator, and the two malformed shapes where a careless copy diverges.
 */

import { describe, expect, test } from "vitest";
// @ts-expect-error — portal modules are plain JS with no type declarations.
import { sourceAccountOf, sourceTypeOf } from "./source-id.js";

describe("splitting a source id", () => {
  test("a qualified id splits at the first colon", () => {
    expect(sourceTypeOf("gmail:someone@example.com")).toBe("gmail");
    expect(sourceAccountOf("gmail:someone@example.com")).toBe("someone@example.com");
  });

  test("an account id may itself contain the separator", () => {
    expect(sourceTypeOf("gmail:a:b")).toBe("gmail");
    expect(sourceAccountOf("gmail:a:b")).toBe("a:b");
  });

  test("an id naming no account has no account half", () => {
    expect(sourceTypeOf("things")).toBe("things");
    expect(sourceAccountOf("things")).toBe("");
  });

  test("a trailing colon names no account", () => {
    expect(sourceTypeOf("gmail:")).toBe("gmail");
    expect(sourceAccountOf("gmail:")).toBe("");
  });

  test("an id with no usable type half answers with itself", () => {
    expect(sourceTypeOf(":account")).toBe(":account");
    expect(sourceAccountOf(":account")).toBe("");
  });

  test("a non-string is empty, not a throw — these run inside render loops", () => {
    for (const value of [undefined, null, 42, {}]) {
      expect(sourceTypeOf(value)).toBe("");
      expect(sourceAccountOf(value)).toBe("");
    }
  });
});
