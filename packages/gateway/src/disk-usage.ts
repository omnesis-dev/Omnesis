// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's on-disk footprint, broken down by what holds it.
 *
 * Each store is counted with the sidecars its engine keeps beside it (SQLite's
 * `-wal`/`-shm`/`-journal`, DuckDB's `.wal` and spill/extension directories,
 * the search index's usearch graphs), the config-dir directories with a known
 * owner are counted whole, and everything else under the config dir is
 * `other`. A store moved out of the config dir with an `OMNESIS_*_PATH`
 * override is still counted, under its own name.
 *
 * Measuring walks tens of thousands of files on a mature install, so it never
 * runs on a request: {@link DiskUsageMonitor} answers from the last finished
 * measurement and starts a fresh one in the background once that ages out.
 */

import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createLogger } from "@omnesis/core";
import { USEARCH_FILE_NAME } from "./indexer/db.js";
import type { DiskUsageSnapshot, DiskUsageStore } from "@omnesis/core/doctor";

const log = createLogger("gateway").child("disk-usage");

const SQLITE_SIDECARS = ["", "-wal", "-shm", "-journal"];
const DUCKDB_SIDECARS = ["", ".wal", ".tmp", ".extensions"];
const NOTHING: ReadonlySet<string> = new Set();

/** Where each part of the footprint lives, resolved the way the gateway resolved it. */
export interface DiskUsageLayout {
  configDir: string;
  dbPath: string;
  indexDbPath: string;
  analyticsDbPath: string;
  watchDbPath: string;
  transcriptsDir: string;
  conversationsDir: string;
  modelsDir: string;
  backupsDir: string;
}

interface Part {
  id: string;
  label: string;
  /** Absolute paths claimed whole; a directory is counted recursively. */
  paths: string[];
  /** Entries of the config dir claimed by name, for files with generated names. */
  configDirNames?: RegExp;
}

function withSuffixes(path: string, suffixes: readonly string[]): string[] {
  return suffixes.map((suffix) => `${path}${suffix}`);
}

/** Display order, which is also claim order: a path belongs to the first part naming it. */
function partsFor(layout: DiskUsageLayout): Part[] {
  return [
    {
      id: "documents",
      label: "Main database",
      paths: withSuffixes(layout.dbPath, SQLITE_SIDECARS),
    },
    {
      id: "index",
      label: "Search index",
      paths: withSuffixes(layout.indexDbPath, SQLITE_SIDECARS),
      configDirNames: USEARCH_FILE_NAME,
    },
    {
      id: "analytics",
      label: "Analytics",
      paths: withSuffixes(layout.analyticsDbPath, DUCKDB_SIDECARS),
    },
    { id: "watch", label: "Watches", paths: withSuffixes(layout.watchDbPath, SQLITE_SIDECARS) },
    { id: "transcripts", label: "Agent transcripts", paths: [layout.transcriptsDir] },
    { id: "conversations", label: "Conversations", paths: [layout.conversationsDir] },
    { id: "models", label: "Models", paths: [layout.modelsDir] },
    { id: "backups", label: "Backups", paths: [layout.backupsDir] },
  ];
}

/**
 * Sum the regular files at and under `root`, skipping anything in `exclude`
 * and any inode already counted, so a hard link or a store claimed by an
 * earlier part is never counted twice.
 *
 * The root itself is resolved, so a config dir or `models/` that is a symlink
 * is measured where it points. Below the root, symlinks are not followed and
 * the walk stays on the root's filesystem, so a share mounted inside the
 * config dir is neither counted nor able to stall the measurement.
 */
async function sizeOf(
  root: string,
  exclude: ReadonlySet<string>,
  seen: Set<string>,
): Promise<number> {
  if (exclude.has(root)) return 0;
  let resolved: string;
  try {
    resolved = await realpath(root);
  } catch {
    return 0; // absent
  }
  let dev: number;
  try {
    dev = (await lstat(resolved)).dev;
  } catch {
    return 0;
  }
  return walk(resolved, dev, exclude, seen);
}

async function walk(
  path: string,
  dev: number,
  exclude: ReadonlySet<string>,
  seen: Set<string>,
): Promise<number> {
  if (exclude.has(path)) return 0;
  let st;
  try {
    st = await lstat(path);
  } catch {
    return 0; // vanished mid-walk
  }
  if (st.dev !== dev) return 0;
  if (st.isDirectory()) {
    let names: string[];
    try {
      names = await readdir(path);
    } catch {
      return 0;
    }
    let total = 0;
    for (const name of names) total += await walk(join(path, name), dev, exclude, seen);
    return total;
  }
  if (!st.isFile()) return 0;
  const key = `${st.dev}:${st.ino}`;
  if (seen.has(key)) return 0;
  seen.add(key);
  return st.size;
}

/**
 * A path with its directory resolved but its last component kept, so it names
 * the entry a walk of the real config dir meets — a symlinked `models/` stays
 * the link, which the walk then skips as claimed.
 */
async function canonical(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return join(await realpath(dirname(absolute)), basename(absolute));
  } catch {
    return absolute;
  }
}

/** Measure the footprint once. Missing paths count as zero; the walk never throws. */
export async function measureDiskUsage(
  layout: DiskUsageLayout,
  now: () => Date = () => new Date(),
): Promise<DiskUsageSnapshot> {
  const configDir = await realpath(layout.configDir).catch(() => resolve(layout.configDir));
  const parts = await Promise.all(
    partsFor(layout).map(async (part) => ({
      ...part,
      paths: await Promise.all(part.paths.map(canonical)),
    })),
  );

  let configDirEntries: string[] = [];
  try {
    configDirEntries = await readdir(configDir);
  } catch {
    // No config dir: only stores placed elsewhere can contribute.
  }
  for (const part of parts) {
    if (!part.configDirNames) continue;
    for (const name of configDirEntries) {
      if (part.configDirNames.test(name)) part.paths.push(join(configDir, name));
    }
  }

  const claimed = new Set(parts.flatMap((part) => part.paths));
  const seen = new Set<string>();
  const stores: DiskUsageStore[] = [];
  for (const part of parts) {
    let bytes = 0;
    for (const path of new Set(part.paths)) bytes += await sizeOf(path, NOTHING, seen);
    if (bytes > 0) stores.push({ id: part.id, label: part.label, bytes });
  }

  // Everything else in the config dir. Claimed paths are skipped rather than
  // relying on `seen` alone, so the walk never descends into models/ or backups/.
  const other = await sizeOf(configDir, claimed, seen);
  if (other > 0) stores.push({ id: "other", label: "Other", bytes: other });

  return {
    totalBytes: stores.reduce((sum, store) => sum + store.bytes, 0),
    measuredAt: now().toISOString(),
    stores,
  };
}

/** Default age after which a read starts a new measurement; sizes move slowly. */
const DISK_USAGE_MAX_AGE_MS = 10 * 60_000;

/**
 * Serves the last finished measurement and keeps it fresh without ever making
 * a caller wait: a read that finds it older than `maxAgeMs` starts one new
 * measurement in the background (never two at once) and still answers with
 * what it has. Null only before the first measurement finishes.
 */
export class DiskUsageMonitor {
  private last: DiskUsageSnapshot | null = null;
  /** When the last measurement settled, successfully or not; null before the first. */
  private lastAt: number | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly maxAgeMs: number;
  private readonly clock: () => number;

  constructor(
    private readonly measure: () => Promise<DiskUsageSnapshot>,
    opts: { maxAgeMs?: number; clock?: () => number } = {},
  ) {
    this.maxAgeMs = opts.maxAgeMs ?? DISK_USAGE_MAX_AGE_MS;
    this.clock = opts.clock ?? Date.now;
  }

  snapshot(): DiskUsageSnapshot | null {
    if (this.lastAt === null || this.clock() - this.lastAt >= this.maxAgeMs) void this.refresh();
    return this.last;
  }

  /** Start a measurement unless one is running; resolves when the running one settles. */
  refresh(): Promise<void> {
    this.inFlight ??= Promise.resolve()
      .then(this.measure)
      .then((snapshot) => {
        this.last = snapshot;
        this.lastAt = this.clock();
      })
      .catch((err: unknown) => {
        this.lastAt = this.clock();
        log.warn(
          `Disk usage measurement failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
