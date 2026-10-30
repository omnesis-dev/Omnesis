// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * mtcute's connection cache, `<stateDir>/mtcute.db`, on the provider's own
 * protected SQLite.
 *
 * mtcute keeps peers (with their access hashes), the update state (`pts`,
 * `qts`, per-channel pts) and reference messages here; without them a restart
 * could not catch up and every history walk would re-resolve every peer. Its
 * bundled `SqliteStorage` opens plain better-sqlite3, so it is never used:
 * this driver hands mtcute a database opened by `openProtectedDatabase`, which
 * applies the `telegram-store` key, the plaintext migration, quarantine of a
 * corrupt file, and the same pragmas as the archive.
 *
 * The file is disposable. The session string in the credential record is
 * canonical and is imported at every connect, so a quarantined or deleted
 * cache is rebuilt from it.
 *
 * Auth keys are held in memory only. Because the session is re-imported with
 * `force` at every connect (which deletes and re-sets every key), a persisted
 * key would never be read back; keeping it out of the file means the primary
 * key exists only in the wrapped credential, even on an install that keeps
 * provider stores unencrypted. Keys for media data centres are re-derived on
 * demand after a restart.
 */

import { join } from "node:path";
import {
  BaseSqliteStorage,
  BaseSqliteStorageDriver,
  MemoryAuthKeysRepository,
  MemoryStorageDriver,
  type ISqliteDatabase,
  type ITelegramStorageProvider,
} from "@mtcute/core";
import { openProtectedDatabase } from "../../protected-store.js";

export const MTCUTE_CACHE_FILE = "mtcute.db";

class EncryptedSqliteStorageDriver extends BaseSqliteStorageDriver {
  constructor(
    private readonly path: string,
    private readonly key: Buffer | null,
  ) {
    super();
  }

  /**
   * Called on every load: the first connect, and again after a disconnect
   * closed the database. The key therefore lives as long as the driver; the
   * adapter zeroes it on close.
   */
  _createDatabase(): ISqliteDatabase {
    // better-sqlite3's Database is the shape `ISqliteDatabase` was cut from.
    return openProtectedDatabase(
      this.path,
      this.key,
      "connection cache",
    ) as unknown as ISqliteDatabase;
  }
}

/** The storage provider an account's live client runs on. */
export function createMtcuteStorage(opts: {
  dir: string;
  key: Buffer | null;
}): ITelegramStorageProvider {
  const driver = new EncryptedSqliteStorageDriver(join(opts.dir, MTCUTE_CACHE_FILE), opts.key);
  const sqlite = new BaseSqliteStorage(driver);
  return {
    driver,
    kv: sqlite.kv,
    peers: sqlite.peers,
    refMessages: sqlite.refMessages,
    authKeys: new MemoryAuthKeysRepository(new MemoryStorageDriver()),
  };
}
