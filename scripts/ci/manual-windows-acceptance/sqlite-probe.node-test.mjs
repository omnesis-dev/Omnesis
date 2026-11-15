// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const deps = process.cwd();
const require = createRequire(pathToFileURL(join(deps, "packages/gateway/package.json")));
const Database = require("better-sqlite3-multiple-ciphers");
for (const encrypted of [true, false])
  test(`keyless probe ${encrypted ? "accepts genuine encrypted refusal" : "rejects plaintext as encryption proof"}`, () => {
    const root = mkdtempSync(join(tmpdir(), "sqlite-keyless-contract-"));
    let db;
    try {
      const file = join(root, "invented.sqlite");
      db = new Database(file);
      if (encrypted) {
        db.pragma("cipher='sqlcipher'");
        db.pragma("legacy=4");
        db.pragma("key='invented-fixture-key'");
      }
      db.exec("CREATE TABLE invented(value INTEGER);INSERT INTO invented VALUES(17)");
      db.close();
      db = null;
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./no-key-sqlite.mjs", import.meta.url)),
          deps,
          file,
          join(root, "plain-control.sqlite"),
        ],
        { timeout: 10000, encoding: "utf8" },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      const proof = JSON.parse(result.stdout);
      assert.equal(proof.sqlitePlainControlRead, true);
      assert.equal(proof.sqliteWithoutKeyRefused, encrypted);
      assert.equal(result.status, encrypted ? 0 : 1);
      assert.equal(proof.unexpectedFailure, false);
    } finally {
      db?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
