// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { isHiddenBrainSource } from "./system-sources.js";

afterEach(() => vi.unstubAllEnvs());

describe("isHiddenBrainSource", () => {
  test("hides the wiki and open-loop rows while experimental mode is off", () => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    vi.stubEnv("OMNESIS_SYNTHETIC", "0");
    expect(isHiddenBrainSource("brain-knowledge")).toBe(true);
    expect(isHiddenBrainSource("open-loops")).toBe(true);
    expect(isHiddenBrainSource("omnesis-notes")).toBe(false);
  });

  test("shows them with experimental mode on", () => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    expect(isHiddenBrainSource("brain-knowledge")).toBe(false);
    expect(isHiddenBrainSource("open-loops")).toBe(false);
  });
});
