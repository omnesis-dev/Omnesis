// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { resolveMoveTarget } from "./move.js";

const collectors = [
  { id: "dev-1", name: "collector-alpha", kind: "collector" },
  { id: "dev-2", name: "collector-beta", kind: "collector" },
];

describe("resolveMoveTarget", () => {
  test("resolves by exact device id", () => {
    const res = resolveMoveTarget(collectors, "dev-2");
    expect("target" in res && res.target.name).toBe("collector-beta");
  });

  test("resolves by exact device name", () => {
    const res = resolveMoveTarget(collectors, "collector-alpha");
    expect("target" in res && res.target.id).toBe("dev-1");
  });

  test("unknown flag returns an error listing the paired collectors", () => {
    const res = resolveMoveTarget(collectors, "collector-gamma");
    expect("error" in res && res.error).toContain("collector-gamma");
    expect("error" in res && res.error).toContain("collector-alpha, collector-beta");
  });

  test("no collectors paired reads as (none)", () => {
    const res = resolveMoveTarget([], "anything");
    expect("error" in res && res.error).toContain("(none)");
  });
});
