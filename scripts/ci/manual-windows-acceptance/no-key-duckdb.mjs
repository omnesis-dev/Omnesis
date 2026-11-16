// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [source, path] = process.argv.slice(2);
const require = createRequire(pathToFileURL(join(source, "package.json")));
const { DuckDBInstance } = await import(pathToFileURL(require.resolve("@duckdb/node-api")).href);
let refused = false;
try {
  const instance = await DuckDBInstance.create(path, {
    access_mode: "READ_ONLY",
  });
  instance.closeSync();
} catch (error) {
  refused = /encrypt.*key|key.*encrypt/i.test(String(error?.message));
}
console.log(JSON.stringify({ encryptedWithoutKeyRefused: refused }));
if (!refused) process.exitCode = 1;
