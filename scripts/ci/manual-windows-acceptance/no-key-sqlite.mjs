// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [deps, encryptedPath, plainPath] = process.argv.slice(2);
let sqliteWithoutKeyRefused = false,
  sqlitePlainControlRead = false,
  unexpectedFailure = false;
let encrypted, plain;
try {
  const require = createRequire(pathToFileURL(join(deps, "packages/gateway/package.json")));
  // Use the exact same native driver as Gateway's encrypted SQLite path.
  const Database = require("better-sqlite3-multiple-ciphers");
  plain = new Database(plainPath);
  plain.exec(
    "CREATE TABLE invented_control(value INTEGER); INSERT INTO invented_control VALUES (17)",
  );
  plain.close();
  plain = null;
  plain = new Database(plainPath, { readonly: true, fileMustExist: true });
  sqlitePlainControlRead = plain.prepare("SELECT value FROM invented_control").get().value === 17;
  plain.close();
  plain = null;
  try {
    encrypted = new Database(encryptedPath, {
      readonly: true,
      fileMustExist: true,
    });
    encrypted.prepare("SELECT COUNT(*) AS count FROM sqlite_schema").get();
  } catch (error) {
    sqliteWithoutKeyRefused = error?.code === "SQLITE_NOTADB";
    if (!sqliteWithoutKeyRefused) unexpectedFailure = true;
  }
} catch {
  unexpectedFailure = true;
} finally {
  for (const db of [plain, encrypted])
    if (db) {
      try {
        db.close();
      } catch {
        unexpectedFailure = true;
      }
    }
}
console.log(
  JSON.stringify({
    sqliteWithoutKeyRefused,
    sqlitePlainControlRead,
    unexpectedFailure,
  }),
);
if (!sqliteWithoutKeyRefused || !sqlitePlainControlRead || unexpectedFailure) process.exitCode = 1;
