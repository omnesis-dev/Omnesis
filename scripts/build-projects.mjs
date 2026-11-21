#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// `npm run build`: `tsc --build` over every TypeScript project the root
// tsconfig references, sized to the heap it runs with and the machine's memory.
// The image build's runtime compile (`scripts/runtime/stage-runtime.mjs`)
// builds its projects through the same policy.
//
// A single `tsc --build` over many projects keeps what it has loaded for the
// projects it already built while it builds the next, so its heap climbs with
// each project: the runtime closure alone needs about 3 GB of it, and the whole
// solution more. Built one per compiler process instead, in the order
// `tsc --build` itself would build them, each process finds the projects it
// references already built and reads only their declaration output, so it holds
// one project's program and the peak is the largest single project, the
// gateway's, under 2 GB. That takes longer, since each process parses its
// dependencies' declarations again, so the single process is kept where it has
// room: a machine with memory to spare and a heap well above what the whole
// solution needs. Either way the output is the same: the same tsconfigs build
// with the same options, and a project an earlier process built is up to date
// and is not built again.
//
// The machine's memory is read by the build heap policy's own reader
// (`packages/cli/src/update/build-heap.ts`); the heap is the one this process
// was started with, which the compiler processes it starts inherit through
// NODE_OPTIONS. Arguments (e.g. `--verbose`, `--force`) run a single
// `tsc --build` over the solution with them, since a flag such as `--force`
// would otherwise rebuild every project's references again in each process.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import { nodeMemoryProbe, usableMemoryMb } from "../packages/cli/src/update/build-heap.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/**
 * From this much usable memory the whole solution builds in one process. A
 * machine sold with 16 GB reports about 15.5 GiB, and keeps the single process.
 */
export const SINGLE_PROCESS_MIN_MB = 14 * 1024;

/**
 * From this heap the whole solution builds in one process. Below it, a single
 * process can run out of heap, and the build heap policy's floor
 * (`build-heap.ts`) is far below it; at or above it, the single process keeps
 * a wide margin. The policy gives at least this much to every machine with
 * SINGLE_PROCESS_MIN_MB of memory, so only a heap set smaller by hand, such as
 * the image build's floor, moves such a machine to one project at a time.
 */
export const SINGLE_PROCESS_MIN_HEAP_MB = 6 * 1024;

/**
 * Whether to build one project per process: unless the machine has memory to
 * spare and the compiler a heap the whole build fits in with room.
 */
export function buildOneProjectAtATime(memoryMb, heapMb) {
  return (
    memoryMb === null || memoryMb < SINGLE_PROCESS_MIN_MB || heapMb < SINGLE_PROCESS_MIN_HEAP_MB
  );
}

/** The heap, in MiB, of this process and so of the compiler processes it starts. */
export function compilerHeapMb() {
  return Math.floor(getHeapStatistics().heap_size_limit / (1024 * 1024));
}

/** Whether this machine and heap call for one project per process. */
export function buildOneProjectAtATimeHere() {
  return buildOneProjectAtATime(usableMemoryMb(nodeMemoryProbe), compilerHeapMb());
}

/**
 * Every project the given projects build, dependencies first, as `tsc --build`
 * orders them, relative to the root. A project is a tsconfig or the directory
 * holding one, relative to the root or absolute.
 */
export function buildOrder(root = ROOT, projects = ["tsconfig.json"]) {
  const ts = require("typescript");
  const host = ts.createSolutionBuilderHost(ts.sys);
  const roots = projects.map((project) => resolve(root, project));
  const order = ts.createSolutionBuilder(host, roots, {}).getBuildOrder();
  // A cycle in the references is reported in place of an order.
  if (!Array.isArray(order)) {
    throw new Error("the project references contain a cycle; run `tsc --build` to see it");
  }
  return order.map((project) => relative(root, project));
}

/**
 * Build the projects: in one `compile` call over all of them, or, one project
 * at a time, in one call per project of their build order. `compile` runs
 * `tsc --build` over the projects it is given in a compiler process of its own.
 */
export function buildProjects(projects, { oneAtATime, compile, root = ROOT }) {
  if (!oneAtATime) {
    compile(projects);
    return;
  }
  for (const project of buildOrder(root, projects)) compile([project]);
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
  if (args.length > 0) {
    tscBuild(tsc, ["tsconfig.json", ...args]);
    return;
  }
  buildProjects(["tsconfig.json"], {
    oneAtATime: buildOneProjectAtATimeHere(),
    compile: (projects) => tscBuild(tsc, projects),
  });
}

if (import.meta.main) main();
