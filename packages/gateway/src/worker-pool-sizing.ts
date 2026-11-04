// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Default sizes of the gateway's worker pools for the machine it runs on.
 *
 * Every worker thread is its own V8 isolate, and each one loads its own copy of
 * the gateway's module graph before it does any work: on an empty source
 * install an io worker holds about 230 MiB resident, a cpu or search worker
 * about 165 MiB, and a search worker adds about 130 MiB more once it has built
 * the date recognizer. At the sizes a workstation wants (six io workers, three
 * search workers) the pools alone take about 3 GiB, which a machine with 8 GB
 * of memory cannot keep resident beside the operating system, the collector
 * and the CLI. The kernel then compresses or pages out the gateway's own
 * memory, and every thread, the event loop included, stops for seconds at a
 * time on the faults.
 *
 * So the pools scale with the gateway's memory budget (`memory-budget.ts`:
 * `gateway.memoryLimitMb`, else the container's limit, else the host's memory)
 * and reach their full sizes from 16 GB:
 *
 * - io: one worker per 2.5 GiB, between 2 and 6. Two is the floor because one
 *   slot is reserved for interactive reads (`gateway.ioReservedUserSlots`).
 * - search: one worker per 5 GiB, between 1 and 3.
 * - cpu: half the cores less two, at least two, capped at one worker per
 *   4 GiB and at least one. The cpu pool is bursty background batch compute
 *   (near-dup signing, chunking, link extraction); kept to about half the
 *   cores, a saturated pool still leaves cores for the io pool, the writer,
 *   and the main and indexer threads that serve interactive search.
 *
 * An explicit `gateway.ioConcurrency`, `gateway.searchWorker.concurrency` or
 * `gateway.cpuConcurrency` (or its environment variable) replaces the default.
 */

const GIB = 1024 ** 3;

export const IO_POOL_MAX = 6;
export const SEARCH_POOL_MAX = 3;

export interface PoolHost {
  /** The gateway's memory budget in bytes. */
  memoryBytes: number;
  /** CPU cores the process may use (`os.availableParallelism()`). */
  cores: number;
}

export interface WorkerPoolSizes {
  io: number;
  search: number;
  cpu: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function defaultWorkerPoolSizes(host: PoolHost): WorkerPoolSizes {
  const gib = host.memoryBytes / GIB;
  const cpuByCores = Math.max(2, Math.floor(host.cores / 2) - 2);
  return {
    io: clamp(Math.floor(gib / 2.5), 2, IO_POOL_MAX),
    search: clamp(Math.floor(gib / 5), 1, SEARCH_POOL_MAX),
    cpu: Math.max(1, Math.min(cpuByCores, Math.floor(gib / 4))),
  };
}
