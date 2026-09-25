// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { inlineImage } from "./image.js";

const B64 = "iVBORw0KGgo"; // pretend base64

describe("inlineImage", () => {
  test("disabled → empty string (graceful degradation)", () => {
    expect(inlineImage(B64, { enabled: false })).toBe("");
  });

  test("iTerm2 OSC 1337 shape", () => {
    const out = inlineImage(B64, { enabled: true, widthCells: 2, heightCells: 1 });
    expect(out).toBe(
      "\x1b]1337;File=inline=1;width=2;height=1;preserveAspectRatio=1:iVBORw0KGgo\x07",
    );
  });

  test("default cell dimensions 2x1", () => {
    const out = inlineImage(B64, { enabled: true });
    expect(out).toContain("width=2");
    expect(out).toContain("height=1");
  });

  test("custom cell dimensions honored", () => {
    const out = inlineImage(B64, { enabled: true, widthCells: 4, heightCells: 2 });
    expect(out).toContain("width=4;height=2");
  });
});
