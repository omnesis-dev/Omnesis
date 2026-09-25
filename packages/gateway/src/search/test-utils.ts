// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { rmSync } from "node:fs";
import type Database from "better-sqlite3";

/** Close a temp test DB and remove its file + WAL/SHM siblings. */
export function closeTempDb(db: Database.Database): void {
  const p = db.name;
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(p + suffix, { force: true });
  }
}
