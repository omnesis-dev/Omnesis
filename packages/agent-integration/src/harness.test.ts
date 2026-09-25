// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { harnessClientName } from "./harness.js";

describe("harnessClientName", () => {
  test("each harness registers under its own product name", () => {
    expect(harnessClientName("openclaw")).toBe("OpenClaw");
    expect(harnessClientName("hermes")).toBe("Hermes");
    expect(harnessClientName("openclaw")).not.toBe(harnessClientName("hermes"));
  });
});
