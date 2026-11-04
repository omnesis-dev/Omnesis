#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// `npm run build`: `tsc --build` over every TypeScript project the root
// tsconfig references, sized to the machine's memory.
//
// A single `tsc --build` over the whole solution keeps what it has loaded for
// the projects it already built while it builds the next, so its memory climbs
// with each project to about 3.5 GB by the end. On a machine with less than
// 14 GiB, beside the operating system and a running collector, that is enough
// to push the build into swap or the kernel's memory compressor. There the
// projects are built one per compiler process, in the order `tsc --build`
// itself would build them: each finds the projects it references already built
// and reads only their declaration output, so a process holds one project's
// program and the peak is the largest single project, about 2 GB. It takes
// about twice as long, since each process parses its dependencies' declarations
// again, so a machine with memory to spare keeps the single process. Either way
// the output is the same: the same tsconfigs build with the same options, and a
// project an earlier process built is up to date and is not built again.
//
// The machine's memory is read by the build heap policy's own reader
// (`packages/cli/src/update/build-heap.ts`). Arguments (e.g. `--verbose`,
// `--force`) run a single `tsc --build` over the solution with them, since a
// flag such as `--force` would otherwise rebuild every project's references
// again in each process.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeMemoryProbe, usableMemoryMb } from "../packages/cli/src/update/build-heap.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/**
 * From this much usable memory the whole solution builds in one process. A
 * machine sold with 16 GB reports about 15.5 GiB, and keeps the single process.
 */
export const SINGLE_PROCESS_MIN_MB = 14 * 1024;

/** Whether to build one project per process: unless the machine has memory to spare. */
export function buildOneProjectAtATime(memoryMb) {
  return memoryMb === null || memoryMb < SINGLE_PROCESS_MIN_MB;
}

/** Every project of the solution, dependencies first, as `tsc --build` orders them. */
export function buildOrder(root = ROOT) {
  const ts = require("typescript");
  const host = ts.createSolutionBuilderHost(ts.sys);
  const order = ts.createSolutionBuilder(host, [join(root, "tsconfig.json")], {}).getBuildOrder();
  // A cycle in the references is reported in place of an order.
  if (!Array.isArray(order)) {
    throw new Error("the project references contain a cycle; run `tsc --build` to see it");
  }
  return order.map((project) => relative(root, project));
}

/**
 * The exit status that reports a compiler process's end: its own status, or
 * 128 plus the signal that killed it, the way a shell reports it, so a caller
 * still recognizes an out-of-memory kill.
 */
export function exitStatus({ status, signal }) {
  if (signal) return 128 + (constants.signals[signal] ?? 0);
  return status ?? 1;
}

function tscBuild(tsc, args) {
  const result = spawnSync(process.execPath, [tsc, "--build", ...args], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const how = result.signal ? `was killed by ${result.signal}` : `exited ${result.status}`;
    process.stderr.write(`build-projects: tsc --build ${args.join(" ")} ${how}\n`);
    process.exit(exitStatus(result));
  }
}

function main() {
  const tsc = require.resolve("typescript/bin/tsc");
  const args = process.argv.slice(2);
  if (args.length > 0 || !buildOneProjectAtATime(usableMemoryMb(nodeMemoryProbe))) {
    tscBuild(tsc, ["tsconfig.json", ...args]);
    return;
  }
  for (const project of buildOrder()) tscBuild(tsc, [project]);
}

if (import.meta.main) main();
