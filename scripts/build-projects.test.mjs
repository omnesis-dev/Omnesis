// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  SINGLE_PROCESS_MIN_MB,
  buildOneProjectAtATime,
  buildOrder,
  exitStatus,
} from "./build-projects.mjs";

describe("build-projects", () => {
  it("builds dependencies before the projects that reference them", () => {
    const order = buildOrder();
    const at = (project) => order.indexOf(`${project}/tsconfig.json`);
    for (const project of ["packages/types", "packages/core", "packages/gateway", "packages/cli"]) {
      expect(at(project), project).toBeGreaterThanOrEqual(0);
    }
    expect(at("packages/types")).toBeLessThan(at("packages/core"));
    expect(at("packages/core")).toBeLessThan(at("packages/gateway"));
    expect(at("packages/gateway")).toBeLessThan(at("packages/cli"));
    expect(new Set(order).size).toBe(order.length);
    expect(order.at(-1)).toBe("tsconfig.json");
  });

  it("builds one project at a time below 14 GiB, or when the memory is unknown", () => {
    expect(buildOneProjectAtATime(7 * 1024)).toBe(true);
    expect(buildOneProjectAtATime(8 * 1024)).toBe(true);
    expect(buildOneProjectAtATime(SINGLE_PROCESS_MIN_MB - 1)).toBe(true);
    expect(buildOneProjectAtATime(null)).toBe(true);
    // What a 16 GB machine reports on Linux.
    expect(buildOneProjectAtATime(15_987)).toBe(false);
    expect(buildOneProjectAtATime(128 * 1024)).toBe(false);
  });

  it("reports a compiler killed by a signal the way a shell does", () => {
    expect(exitStatus({ status: null, signal: "SIGKILL" })).toBe(137);
    expect(exitStatus({ status: null, signal: "SIGTERM" })).toBe(143);
    expect(exitStatus({ status: 2, signal: null })).toBe(2);
    expect(exitStatus({ status: null, signal: null })).toBe(1);
  });
});
