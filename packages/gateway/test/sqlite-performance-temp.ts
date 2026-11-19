// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Place latency fixtures on explicit scratch storage without changing private-file temporary roots. */
export function sqlitePerformanceDatabasePath(): string {
  const configured = process.env.OMNESIS_TEST_SQLITE_TMP;
  if (configured && (!isAbsolute(configured) || !statSync(configured).isDirectory()))
    throw new Error("SQLite performance fixture storage must be an existing absolute directory");
  return join(configured || tmpdir(), `omnesis-test-${randomUUID()}.db`);
}
