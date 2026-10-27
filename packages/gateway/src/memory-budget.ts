// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's memory budget: how much resident memory the process may use.
 *
 * Resolved once at boot, in precedence order: the `gateway.memoryLimitMb`
 * knob (or `OMNESIS_MEMORY_LIMIT_MB`), the cgroup limit of the container or
 * service the gateway runs in, the host's physical memory. Defaults that would
 * otherwise read the host's memory derive from it, and the indexer checks it
 * before holding the HNSW graph in memory: the graph is the one consumer that
 * grows with the whole corpus, so it is the one that is admitted, and shed,
 * against the budget (see the indexer worker's `ensureGraphMemory`).
 *
 * Only anonymous memory counts against the budget. The search readers map the
 * graph file, and file-backed pages are reclaimed by the kernel before it
 * kills anything; the writer's loaded graph, SQLite page caches and V8 heaps
 * are not.
 */

import { readFileSync } from "node:fs";
import { totalmem } from "node:os";

export type MemoryBudgetSource = "config" | "cgroup" | "host";

export interface MemoryBudget {
  bytes: number;
  source: MemoryBudgetSource;
}

/** Reads a small text file, or null when it is absent or unreadable. */
export type ReadText = (path: string) => string | null;

const readText: ReadText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** A cgroup v1 "unlimited" is a page-rounded LONG_MAX; anything this large is no limit. */
const UNLIMITED_FLOOR = 2 ** 52;

function parseLimit(raw: string | null): number | null {
  const value = raw?.trim();
  if (!value || value === "max") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < UNLIMITED_FLOOR ? n : null;
}

/**
 * The tightest memory limit of the cgroup this process runs in, or null when
 * there is none (or this is not Linux).
 *
 * cgroup v2: walks from the process's own cgroup (`/proc/self/cgroup`, the
 * `0::<path>` line) up to the root, because a limit on any ancestor applies —
 * a systemd unit's `MemoryMax=` sits below the root, while inside a container
 * the namespace root is the container itself. cgroup v1: the memory
 * controller's `memory.limit_in_bytes`.
 */
export function readCgroupMemoryLimit(read: ReadText = readText): number | null {
  const self = read("/proc/self/cgroup");
  const v2Path = self
    ?.split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3)
    .trim();
  if (v2Path !== undefined) {
    let tightest: number | null = null;
    let dir = v2Path.startsWith("/") ? v2Path : `/${v2Path}`;
    for (;;) {
      const limit = parseLimit(read(`/sys/fs/cgroup${dir === "/" ? "" : dir}/memory.max`));
      if (limit !== null && (tightest === null || limit < tightest)) tightest = limit;
      if (dir === "/") break;
      dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
    }
    if (tightest !== null) return tightest;
  }
  return parseLimit(read("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
}

export function resolveMemoryBudget(
  opts: { limitMb?: number; read?: ReadText; hostBytes?: number } = {},
): MemoryBudget {
  if (opts.limitMb !== undefined && opts.limitMb > 0) {
    return { bytes: opts.limitMb * MIB, source: "config" };
  }
  const host = opts.hostBytes ?? totalmem();
  const cgroup = readCgroupMemoryLimit(opts.read);
  if (cgroup !== null && cgroup < host) return { bytes: cgroup, source: "cgroup" };
  return { bytes: host, source: "host" };
}

function statusField(text: string | null, key: string): number | null {
  const match = text ? new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text) : null;
  return match ? Number(match[1]) * 1024 : null;
}

/**
 * How much more anonymous memory the process can take before it reaches its
 * budget or the host runs out, whichever comes first. Process-wide, so it
 * answers the same from any thread. The host term matters when the budget is
 * derived and other services share the host: there `MemAvailable` is the only
 * signal that they are using it. A configured budget is the operator's word for
 * what the gateway may use, so it is not second-guessed by the host figure. Off
 * Linux there is no anonymous figure, so the whole resident set counts, and no
 * reliable host figure.
 */
export function memoryHeadroom(budget: MemoryBudget, read: ReadText = readText): number {
  const used = statusField(read("/proc/self/status"), "RssAnon") ?? process.memoryUsage().rss;
  const toBudget = budget.bytes - used;
  if (budget.source === "config") return toBudget;
  const available = statusField(read("/proc/meminfo"), "MemAvailable");
  return available === null ? toBudget : Math.min(toBudget, available);
}

/**
 * Anonymous memory a writable HNSW graph of `vectors` vectors at `dim`
 * float32 dimensions takes: the vectors, their links (connectivity 16 adds
 * about 200 bytes a vector), and what the allocator keeps. A graph built in
 * this process measures about 1.35 times its file; one loaded from a complete
 * file about 1.05 times.
 */
export function estimateHnswGraphBytes(
  vectors: number,
  dim: number,
  how: "build" | "load" = "build",
): number {
  return Math.ceil(vectors * (dim * 4 + 256) * (how === "load" ? 1.1 : 1.4));
}

/**
 * Memory the rest of the gateway may still grow into after the graph is
 * admitted — page caches filling, the keyword index, analytics queries. A
 * graph is admitted only if this much headroom remains with it in memory.
 * A fifth of the budget, between 512 MiB and 4 GiB: what the rest grows into
 * is bounded by its own caches, not by the size of the host.
 */
export function graphAdmissionReserve(budget: MemoryBudget): number {
  return Math.max(512 * MIB, Math.min(Math.floor(budget.bytes * 0.2), 4 * GIB));
}

/**
 * Headroom below which the graph is shed: a twentieth of the budget, between
 * 256 MiB and 1 GiB. Below the admission reserve at every budget, so a graph
 * admitted at boot is not shed by the next ordinary allocation.
 */
export function graphShedFloor(budget: MemoryBudget): number {
  return Math.max(256 * MIB, Math.min(Math.floor(budget.bytes * 0.05), GIB));
}

export function formatMemory(bytes: number): string {
  const gib = bytes / (1024 * MIB);
  return gib >= 1 ? `${gib.toFixed(1)} GiB` : `${Math.round(bytes / MIB)} MiB`;
}

export function describeMemoryBudget(budget: MemoryBudget): string {
  const origin =
    budget.source === "config"
      ? "gateway.memoryLimitMb"
      : budget.source === "cgroup"
        ? "container memory limit"
        : "host memory";
  return `${formatMemory(budget.bytes)} (${origin})`;
}
