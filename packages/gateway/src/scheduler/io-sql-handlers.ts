// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The io op that runs the operator's own SQL (`POST /sql`).
 *
 * The io worker passes these a read-only connection to `omnesis.db` that no
 * other op shares, rather than the handle `ioHandlers` read through. Arbitrary
 * SQL can change the connection it runs on — a `PRAGMA mmap_size` or
 * `busy_timeout` assignment returns a row, so it executes — and the shared
 * handle keeps temporary storage in memory, where a large sort or grouping
 * over the corpus would grow the gateway's memory instead of a temporary file.
 * Names share the `io.` namespace and the same `IoOps` task table.
 */

import { readSqliteQuery, type SqliteQueryRequest } from "../sqlite-catalog.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export const ioSqlHandlers = {
  "io.sqliteQuery": (db: Db, request: SqliteQueryRequest) => readSqliteQuery(db, request),
} as const;

export type IoSqlHandlers = typeof ioSqlHandlers;
