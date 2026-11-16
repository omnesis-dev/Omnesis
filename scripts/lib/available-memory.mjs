// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Memory the host can give new test processes, measured the same way on every
 * platform the check runners size their worker pools for.
 *
 * On Linux, `process.availableMemory()` reads `MemAvailable`, which counts the
 * page cache the kernel drops under pressure. On macOS it returns only the
 * free page count: right after `npm ci` and a full typecheck, most memory sits
 * in the file cache, so it can report a few GiB on a machine with twice that to
 * spare, and the runner's pool shrinks by half or more depending on how much
 * the earlier steps happened to cache. Counting the cache macOS reclaims (its
 * file-backed and purgeable pages, as Activity Monitor's "Cached Files" does)
 * gives the Linux meaning there too.
 */
import { execFileSync } from "node:child_process";

export function parseVmStat(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (label) => Number(new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(text)?.[1]);
  const free = pages("Pages free");
  const fileBacked = pages("File-backed pages");
  const purgeable = pages("Pages purgeable");
  if (![pageSize, free, fileBacked, purgeable].every(Number.isFinite)) return null;
  return (free + fileBacked + purgeable) * pageSize;
}

function readVmStat() {
  try {
    return execFileSync("vm_stat", { encoding: "utf8", timeout: 5000 });
  } catch {
    return null;
  }
}

export function availableMemory({
  platform = process.platform,
  nodeAvailable = process.availableMemory(),
  vmStat = readVmStat,
} = {}) {
  if (platform !== "darwin") return nodeAvailable;
  const text = vmStat();
  const reclaimable = text ? parseVmStat(text) : null;
  return reclaimable === null ? nodeAvailable : Math.max(nodeAvailable, reclaimable);
}
