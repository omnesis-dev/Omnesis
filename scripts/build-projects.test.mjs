// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNodeOptions } from "../packages/cli/src/update/build-heap.ts";
import {
  SINGLE_PROCESS_MIN_HEAP_MB,
  SINGLE_PROCESS_MIN_MB,
  buildOneProjectAtATime,
  buildOrder,
  buildProjects,
  exitStatus,
} from "./build-projects.mjs";

/** The heap the build heap policy gives a machine with this much memory. */
const policyHeapMb = (memoryMb) =>
  Number(/max-old-space-size=([0-9]+)/u.exec(buildNodeOptions(memoryMb, undefined))[1]);

describe("build-projects", () => {
  it("builds dependencies before the projects that reference them", () => {
    const order = buildOrder();
    const at = (project) => order.indexOf(join(project, "tsconfig.json"));
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
    const heap = 8192;
    expect(buildOneProjectAtATime(7 * 1024, heap)).toBe(true);
    expect(buildOneProjectAtATime(8 * 1024, heap)).toBe(true);
    expect(buildOneProjectAtATime(SINGLE_PROCESS_MIN_MB - 1, heap)).toBe(true);
    expect(buildOneProjectAtATime(null, heap)).toBe(true);
    // What a 16 GB machine reports on Linux.
    expect(buildOneProjectAtATime(15_987, heap)).toBe(false);
    expect(buildOneProjectAtATime(128 * 1024, heap)).toBe(false);
  });

  it("builds one project at a time with a heap too small for the single process", () => {
    // The image build's heap on a large builder, or an operator's own setting.
    expect(buildOneProjectAtATime(128 * 1024, policyHeapMb(1))).toBe(true);
    expect(buildOneProjectAtATime(128 * 1024, SINGLE_PROCESS_MIN_HEAP_MB - 1)).toBe(true);
    expect(buildOneProjectAtATime(128 * 1024, SINGLE_PROCESS_MIN_HEAP_MB)).toBe(false);
  });

  it("keeps the single process wherever the policy sizes the heap for a large machine", () => {
    for (const memoryMb of [SINGLE_PROCESS_MIN_MB, 15_987, 32 * 1024, 128 * 1024]) {
      expect(buildOneProjectAtATime(memoryMb, policyHeapMb(memoryMb)), `${memoryMb}`).toBe(false);
    }
  });

  it("builds every project of the order in a process of its own, or all in one", () => {
    const one = [];
    buildProjects(["tsconfig.json"], { oneAtATime: false, compile: (p) => one.push(p) });
    expect(one).toEqual([["tsconfig.json"]]);

    const each = [];
    buildProjects(["tsconfig.json"], { oneAtATime: true, compile: (p) => each.push(p) });
    expect(each).toEqual(buildOrder().map((project) => [project]));
  });

  it("reports a compiler killed by a signal the way a shell does", () => {
    expect(exitStatus({ status: null, signal: "SIGKILL" })).toBe(137);
    expect(exitStatus({ status: null, signal: "SIGTERM" })).toBe(143);
    expect(exitStatus({ status: 2, signal: null })).toBe(2);
    expect(exitStatus({ status: null, signal: null })).toBe(1);
  });
});
