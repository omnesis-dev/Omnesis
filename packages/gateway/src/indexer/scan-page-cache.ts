// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

/** Page cache for a query that reads every chunk once. */
const SCAN_CACHE_KIB = 16 * 1024;

/**
 * Bound the connection's page cache while a query reads every chunk, and
 * restore it afterwards. A full scan touches each page once, so a large cache
 * buys it nothing — but keeps what it read: on an encrypted index every page
 * is decrypted into the cache, the indexer connection's 1 GiB of it would stay
 * full of chunk pages, and memory SQLite frees is not given back to the system.
 */
export function shrinkPageCacheForScan(db: Database.Database): () => void {
  const previous = db.pragma("cache_size", { simple: true }) as number;
  db.pragma(`cache_size = -${SCAN_CACHE_KIB}`);
  return () => {
    db.pragma(`cache_size = ${previous}`);
  };
}

/** Run one full-scan query under {@link shrinkPageCacheForScan}. */
export function withScanPageCache<T>(db: Database.Database, scan: () => T): T {
  const restore = shrinkPageCacheForScan(db);
  try {
    return scan();
  } finally {
    restore();
  }
}
