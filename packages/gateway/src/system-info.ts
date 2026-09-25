// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * System-spec snapshot — RAM, CPU, GPU/Metal availability, disk free
 * in the models directory. Surfaced via `GET /admin/system-info` so
 * the portal/CLI can:
 *   - Badge catalog entries that fit ("Recommended for your Mac"),
 *   - Disable entries that demand more RAM than is free,
 *   - Warn before a download if disk is tight.
 *
 * Cheap to compute (no syscalls beyond `os.*` and one `statfs`); gated
 * by the gateway's normal admin-scope auth.
 */

import os from "node:os";
import { statfsSync, existsSync, mkdirSync } from "node:fs";
import { createLogger } from "@omnesis/core";

const log = createLogger("gateway").child("system-info");

export interface SystemInfo {
  platform: NodeJS.Platform;
  arch: string;
  /** Marketing name of the CPU as reported by `os.cpus()[0].model`. */
  cpuModel: string;
  /** Number of logical cores. */
  cpuCount: number;
  /** Total RAM, gigabytes (1024^3). */
  totalRamGb: number;
  /** Free RAM at the time of the call. Snapshot, not a running average. */
  freeRamGb: number;
  /**
   * True when the host is an Apple Silicon Mac and `node-llama-cpp`
   * was compiled with Metal support. We pessimistically derive this
   * from `arch === "arm64" && platform === "darwin"` — it's accurate
   * for the supported install paths and avoids a llama.cpp probe call
   * that would force-load the library just to answer the question.
   */
  metalSupported: boolean;
  /** True when CUDA is plausibly available (linux + nvidia env). */
  cudaSupported: boolean;
  /** Resolved models directory. */
  modelsDir: string;
  /** Free disk space in the models directory, gigabytes. */
  modelsDirFreeGb: number;
}

const GB = 1024 * 1024 * 1024;

/** Cache lifetime for the system-info snapshot (ms). Free RAM and disk
 *  numbers shift slowly enough that a 5s window is fine for portal
 *  status displays; `os.cpus()` and `statfs` together cost a few ms
 *  per call — small but not free at portal poll cadence. */
const SYSTEM_INFO_CACHE_MS = 5_000;

let cached: { info: SystemInfo; ts: number; modelsDir: string } | null = null;

/**
 * One-time setup: ensure `modelsDir` exists so `statfsSync` doesn't
 * have to mkdir-on-first-call. Idempotent. Call from the gateway boot
 * path; `getSystemInfo` no longer mutates the filesystem.
 */
export function ensureModelsDir(modelsDir: string): void {
  if (existsSync(modelsDir)) return;
  try {
    mkdirSync(modelsDir, { recursive: true });
  } catch {
    /* best-effort — getSystemInfo's free-bytes probe falls back to 0 */
  }
}

/**
 * Memoized system-info snapshot. Refreshes at most every
 * `SYSTEM_INFO_CACHE_MS`. Pass a new `modelsDir` to force re-compute
 * (the cached snapshot is keyed on the dir).
 */
export function getSystemInfo(modelsDir: string): SystemInfo {
  const now = Date.now();
  if (cached && cached.modelsDir === modelsDir && now - cached.ts < SYSTEM_INFO_CACHE_MS) {
    return cached.info;
  }
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? "unknown";
  const platform = os.platform();
  const arch = os.arch();
  const info: SystemInfo = {
    platform,
    arch,
    cpuModel,
    cpuCount: cpus.length,
    totalRamGb: round(os.totalmem() / GB, 2),
    freeRamGb: round(os.freemem() / GB, 2),
    metalSupported: arch === "arm64" && platform === "darwin",
    // CUDA detection without forking nvidia-smi: we can't be authoritative
    // here, so report `true` only when the user has explicitly opted in via
    // env. This avoids false positives on linux laptops with integrated GPUs.
    cudaSupported: platform === "linux" && process.env.OMNESIS_GPU === "cuda",
    modelsDir,
    modelsDirFreeGb: round(probeFreeBytes(modelsDir) / GB, 2),
  };
  cached = { info, ts: now, modelsDir };
  return info;
}

/**
 * Bytes free for a non-root process on the filesystem containing `path`.
 *
 * On `statfs` failure (path removed mid-run, permission glitch, exotic FS)
 * returns `Infinity` and logs a warning — the caller treats a transient
 * probe failure as "plenty of space" so a flaky syscall never wedges a
 * write path. Callers that want a pessimistic display number (e.g. the
 * system-info snapshot, which shows free GB and gates downloads) should
 * clamp `Infinity` to a sentinel themselves.
 */
export function freeDiskBytes(path: string): number {
  try {
    const stat = statfsSync(path);
    // bsize is the fragment size; bavail is the count available to non-root.
    return Number(stat.bsize) * Number(stat.bavail);
  } catch (err) {
    log.warn(
      `statfs(${path}) failed: ${err instanceof Error ? err.message : String(err)} — treating disk as not-full`,
    );
    return Infinity;
  }
}

function probeFreeBytes(dir: string): number {
  // The display snapshot wants a concrete number even when statfs fails
  // (it renders free GB and gates model downloads). `freeDiskBytes`
  // returns Infinity on error for the write-guard callers; clamp that to
  // 0 here so the snapshot stays pessimistic.
  const bytes = freeDiskBytes(dir);
  return Number.isFinite(bytes) ? bytes : 0;
}

function round(n: number, decimals: number): number {
  const m = Math.pow(10, decimals);
  return Math.round(n * m) / m;
}
