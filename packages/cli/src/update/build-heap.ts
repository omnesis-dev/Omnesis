// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The heap a workspace build gets. Node sizes its old-space heap from the
 * memory it believes it has and settles near 2 GB on a small or containerized
 * host — not enough for `tsc --build` across every project reference, which
 * then dies with a heap OOM on a machine that had memory to spare. The build
 * claims half of what the machine can really use instead, capped, never less
 * than the heap it needs to finish, and never overrides a value the operator
 * set themselves.
 *
 * This is the one statement of that policy. The installer's shell copy,
 * `build_node_options()` in scripts/install.sh, has to keep the same
 * arithmetic — a test runs the shell against the same table of memory sizes
 * and NODE_OPTIONS and compares — because the installer cannot import this
 * module before the checkout exists. How each side reads the machine's
 * memory is its own.
 */

import { readFileSync } from "node:fs";
import { totalmem } from "node:os";

/** Above this the build is capped: more heap buys nothing. */
const MAX_HEAP_MB = 8192;
/** The build does not finish with less; a smaller machine still gets this much and pages. */
const MIN_HEAP_MB = 3072;
/**
 * What a build needs beside its heap: the compiler's own memory outside the
 * heap, npm, the kernel. A machine with less than the heap plus this cannot
 * also keep a collector running through the build without the kernel killing
 * one of them — with the smallest heap, below about 5 GB.
 */
export const BUILD_HEADROOM_MB = 2048;
const MIB = 1024 * 1024;

/** Where the machine's memory is read from; injected so the policy is testable. */
export interface MemoryProbe {
  platform: string;
  /** Physical memory in bytes, as the OS reports it. */
  totalMemoryBytes(): number;
  /** A file's text, or null when it cannot be read. */
  readFile(path: string): string | null;
  env: NodeJS.ProcessEnv;
}

const CGROUP_LIMIT_FILES = [
  "/sys/fs/cgroup/memory.max",
  "/sys/fs/cgroup/memory/memory.limit_in_bytes",
];

/**
 * Total memory this machine will actually let a process use, in MiB. A
 * container's cgroup ceiling is the real limit and can be far below what the
 * OS reports, so the smaller of the two wins. Null when neither can be read.
 * `OMNESIS_BUILD_MEMORY_MB` states the number outright, for a test or an
 * operator on a machine that misreports itself.
 */
export function usableMemoryMb(probe: MemoryProbe): number | null {
  const stated = probe.env.OMNESIS_BUILD_MEMORY_MB;
  if (stated !== undefined && /^[0-9]+$/u.test(stated)) return Number(stated);
  let memoryMb: number | null = null;
  const bytes = probe.totalMemoryBytes();
  if (Number.isFinite(bytes) && bytes > 0) memoryMb = Math.floor(bytes / MIB);
  if (probe.platform !== "darwin") {
    for (const path of CGROUP_LIMIT_FILES) {
      const text = probe.readFile(path)?.trim();
      if (text === undefined || !/^[0-9]+$/u.test(text)) continue;
      const limitMb = Math.floor(Number(text) / MIB);
      if (limitMb > 0 && (memoryMb === null || limitMb < memoryMb)) memoryMb = limitMb;
    }
  }
  return memoryMb;
}

/**
 * NODE_OPTIONS for the build: the operator's own value when it already sizes
 * the heap or the memory is unknown, and otherwise the operator's value with
 * the sized heap appended.
 */
export function buildNodeOptions(memoryMb: number | null, existing: string | undefined): string {
  const current = existing ?? "";
  if (current.includes("max-old-space-size")) return current;
  if (memoryMb === null) return current;
  return `${current ? `${current} ` : ""}--max-old-space-size=${policyHeapMb(memoryMb)}`;
}

function policyHeapMb(memoryMb: number): number {
  return Math.max(MIN_HEAP_MB, Math.min(Math.floor(memoryMb / 2), MAX_HEAP_MB));
}

/**
 * Whether the build's heap and its headroom leave no room for a daemon on this
 * machine, so the update stops this account's collector while it builds. The
 * heap is the one the build runs with, an operator's own setting included.
 * Unknown memory is not treated as tight.
 */
export function buildMemoryTight(probe: MemoryProbe = nodeMemoryProbe): boolean {
  const memoryMb = usableMemoryMb(probe);
  if (memoryMb === null) return false;
  const stated = /max-old-space-size=([0-9]+)/u.exec(probe.env.NODE_OPTIONS ?? "");
  const heapMb = stated ? Number(stated[1]) : policyHeapMb(memoryMb);
  return memoryMb < heapMb + BUILD_HEADROOM_MB;
}

export const nodeMemoryProbe: MemoryProbe = {
  platform: process.platform,
  totalMemoryBytes: () => totalmem(),
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  env: process.env,
};

/**
 * The environment a build command runs with, on top of the process's own:
 * the sized NODE_OPTIONS, or nothing when the policy leaves it alone.
 */
export function buildHeapEnv(
  probe: MemoryProbe = nodeMemoryProbe,
): Record<string, string> | undefined {
  const value = buildNodeOptions(usableMemoryMb(probe), probe.env.NODE_OPTIONS);
  return value ? { NODE_OPTIONS: value } : undefined;
}
