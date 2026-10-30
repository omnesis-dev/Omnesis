// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;

/**
 * Make every `db.transaction(fn)` on this handle begin with `BEGIN IMMEDIATE`.
 *
 * A deferred transaction takes the write lock only at its first write. Under
 * WAL, when another connection holds the write lock or commits after the
 * transaction's first read and before that write, SQLite fails it at once with
 * SQLITE_BUSY or SQLITE_BUSY_SNAPSHOT ("database is locked"): `busy_timeout`
 * cannot help, because the busy handler is not consulted for a lock upgrade and
 * waiting never makes a stale snapshot current. An immediate transaction takes
 * the write lock at BEGIN, where `busy_timeout` applies, so another writer is
 * waited out instead of failing a read-then-write operation.
 *
 * Only for a writable handle whose transactions all write: a read-only
 * transaction on it would hold the write lock for its duration. A transaction
 * opened inside another still uses a savepoint, and the `.deferred` /
 * `.exclusive` variants stay available on the returned function.
 */
export function useImmediateTransactions(db: Db): void {
  const transaction = db.transaction.bind(db);
  // Each variant better-sqlite3 returns carries all the others as properties,
  // so the immediate one is a complete transaction function.
  db.transaction = ((fn) => transaction(fn).immediate) as Db["transaction"];
}
