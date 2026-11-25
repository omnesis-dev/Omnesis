// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { writeFileSync } from "node:fs";
import { createDatabase } from "../db.js";

type GatewayDb = ReturnType<typeof createDatabase>;

let schemaImage: Buffer | undefined;

/**
 * The image of a gateway database that `createDatabase` has just built,
 * produced once per test process. It is built in memory from the code under
 * test, so it always carries the current migrations and never waits on a disk.
 */
function migratedSchemaImage(): Buffer {
  if (!schemaImage) {
    const seed = createDatabase(":memory:");
    try {
      schemaImage = seed.serialize();
    } finally {
      seed.close();
    }
  }
  return schemaImage;
}

/**
 * Create a new gateway database file at `path` for a test, equivalent to
 * `createDatabase(path)` on a path that does not exist yet.
 *
 * Building a gateway database from nothing replays every schema migration as
 * a long series of small synchronous writes, and on a slow disk that can take
 * longer than a test hook may run. This writes a copy of a schema built once in
 * memory instead and then opens the file with `createDatabase`, which applies
 * the connection settings (WAL, foreign keys, busy timeout, no mmap) and finds
 * every migration already applied. Each call gets its own independent file.
 *
 * Use `createDatabase` itself for tests about migrations, encryption or
 * reopening an existing file. The path must not exist yet.
 */
export function createFreshTestDatabase(path: string): GatewayDb {
  writeFileSync(path, migratedSchemaImage(), { flag: "wx" });
  return createDatabase(path);
}
