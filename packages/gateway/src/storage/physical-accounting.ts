// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { openEncryptedSqlite } from "../sqlite-encryption.js";
import type { StorageTableUsage } from "./accounting.js";

export type AllocationStore = "documents" | "index";
export interface AllocationStoreOptions {
  path: string;
  keyHex?: string;
}
export interface StorageAllocationSnapshot {
  state: "running" | "ready" | "partial" | "unavailable" | "error";
  measuredAt: string | null;
  /** Last full scan, never the unfinished table or a partial scan disguised as complete. */
  tables: StorageTableUsage[] | null;
  /** Fully traversed Btrees from this attempt; the current Btree is excluded. */
  completed: StorageTableUsage[];
  scannedPages: number;
  /** Progress only: includes unfinished Btrees and must not be used as table allocation. */
  scannedBytes?: number;
  error: string | null;
}
export interface AllocationLimits {
  slicePages?: number;
  sliceMs?: number;
  betweenSliceMs?: number;
  maxSnapshotMs?: number;
  maxWalGrowthBytes?: number;
}
function walBytes(path: string): number {
  try {
    return statSync(`${path}-wal`).size;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

/**
 * Owned accounting connection only. SQLite dbstat cannot seek by page/path;
 * LIMIT-based queries would repeatedly traverse the preceding tree. Keep one
 * iterator, yield between bounded slices, and cap the lifetime/WAL growth of
 * its read snapshot. No ordinary read worker or active indexer owns this lock.
 * A native step may decode one Btree page and its overflow chains before JS
 * regains control; cancellation and caps are checked between these steps.
 */
export async function scanStorageAllocation(
  store: AllocationStoreOptions,
  limits: AllocationLimits,
  cancelled: () => boolean,
  progress: (snapshot: StorageAllocationSnapshot) => void,
  previous?: StorageAllocationSnapshot,
): Promise<StorageAllocationSnapshot> {
  const started = Date.now();
  const snapshot: StorageAllocationSnapshot = {
    state: "running",
    measuredAt: previous?.measuredAt ?? null,
    tables: previous?.tables ?? null,
    completed: [],
    scannedPages: 0,
    scannedBytes: 0,
    error: null,
  };
  // Match the live writer's SQLite library: separate SQLite builds do not
  // share process-level lock ownership even when the file is plaintext.
  const db: Database.Database = store.keyHex
    ? (openEncryptedSqlite(store.path, {
        readonly: true,
        fileMustExist: true,
        migratePlaintext: false,
        key: Buffer.from(store.keyHex, "hex"),
      }) as unknown as Database.Database)
    : new Database(store.path, { readonly: true, fileMustExist: true });
  let iterator: IterableIterator<{ name: string; pgsize: number }> | undefined;
  const publish = () => progress({ ...snapshot, completed: [...snapshot.completed] });
  try {
    db.pragma("query_only=ON");
    db.pragma("mmap_size=0");
    db.pragma("cache_size=-8192");
    db.pragma("busy_timeout=5000");
    const baselineWal = walBytes(store.path);
    iterator = db
      .prepare<[], { name: string; pgsize: number }>(
        "SELECT name,pgsize FROM dbstat ORDER BY name,path",
      )
      .iterate();
    let current: StorageTableUsage | undefined;
    let lastProgress = 0;
    for (;;) {
      const sliceStarted = Date.now();
      for (let n = 0; n < (limits.slicePages ?? 128); n++) {
        const reason = cancelled()
          ? "Allocation scan cancelled"
          : Date.now() - started >= (limits.maxSnapshotMs ?? 600000)
            ? "Allocation snapshot time limit reached"
            : n === 0 &&
                walBytes(store.path) - baselineWal > (limits.maxWalGrowthBytes ?? 64 * 1024 * 1024)
              ? "Allocation snapshot WAL growth limit reached"
              : null;
        if (reason) {
          snapshot.state = "partial";
          snapshot.error = reason;
          publish();
          return snapshot;
        }
        const row = iterator.next();
        if (row.done) {
          if (current) snapshot.completed.push(current);
          snapshot.state = "ready";
          snapshot.measuredAt = new Date().toISOString();
          snapshot.tables = [...snapshot.completed];
          publish();
          return snapshot;
        }
        if (current?.name !== row.value.name) {
          if (current) snapshot.completed.push(current);
          current = { name: row.value.name, bytes: 0 };
        }
        current.bytes += row.value.pgsize;
        snapshot.scannedPages++;
        snapshot.scannedBytes = (snapshot.scannedBytes ?? 0) + row.value.pgsize;
        if (Date.now() - sliceStarted >= (limits.sliceMs ?? 25)) break;
      }
      if (Date.now() - lastProgress >= 250) {
        publish();
        lastProgress = Date.now();
      }
      await delay(limits.betweenSliceMs ?? 5);
    }
  } catch (error) {
    const unavailable =
      error instanceof Error && /no such (table|module).*dbstat/i.test(error.message);
    snapshot.state = unavailable ? "unavailable" : "error";
    snapshot.error = unavailable
      ? "SQLite allocation statistics are unavailable"
      : "Allocation measurement failed";
    publish();
    return snapshot;
  } finally {
    try {
      iterator?.return?.();
    } finally {
      db.close();
    }
  }
}
