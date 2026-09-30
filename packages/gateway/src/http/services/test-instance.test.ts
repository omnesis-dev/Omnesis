// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { readTestInstance } from "./test-instance.js";

describe("test instance identity", () => {
  test("requires an explicit test-instance marker, independently of synthetic mode", () => {
    for (const marker of [undefined, "0", "true"]) {
      expect(
        readTestInstance({
          OMNESIS_TEST_INSTANCE: marker,
          OMNESIS_SYNTHETIC: "1",
          OMNESIS_TEST_SESSION: "Codex: navigation",
        }),
      ).toBeNull();
    }
  });

  test("identifies unlabeled and real-source test instances", () => {
    expect(readTestInstance({ OMNESIS_TEST_INSTANCE: "1" })).toEqual({});
    expect(
      readTestInstance({
        OMNESIS_TEST_INSTANCE: "1",
        OMNESIS_SYNTHETIC: "0",
        OMNESIS_TEST_SESSION: " Claude: navigation ",
        OMNESIS_TEST_PURPOSE: "Try navigation",
      }),
    ).toEqual({
      session: "Claude: navigation",
      purpose: "Try navigation",
    });
  });

  test("omits invalid labels without losing the test marker or valid sibling label", () => {
    for (const invalid of [" ", "x".repeat(201), "bad\u0000label", "bad\nlabel"]) {
      expect(
        readTestInstance({
          OMNESIS_TEST_INSTANCE: "1",
          OMNESIS_TEST_SESSION: invalid,
          OMNESIS_TEST_PURPOSE: "Try navigation",
        }),
      ).toEqual({ purpose: "Try navigation" });
    }
    expect(
      readTestInstance({ OMNESIS_TEST_INSTANCE: "1", OMNESIS_TEST_PURPOSE: "x".repeat(1001) }),
    ).toEqual({});
    expect(
      readTestInstance({ OMNESIS_TEST_INSTANCE: "1", OMNESIS_TEST_SESSION: "🧭".repeat(200) })
        ?.session,
    ).toBe("🧭".repeat(200));
  });
});
