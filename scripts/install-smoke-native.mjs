#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Loads and exercises every native module the gateway ships, resolved the way
// an installed gateway resolves them: from the @omnesis/gateway package under
// the given install root. `omnesis --version` loads none of them, so an
// install whose native builds failed or were skipped would otherwise pass.
//
//   node scripts/install-smoke-native.mjs <directory that contains node_modules/omnesis>

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  process.stderr.write("usage: install-smoke-native.mjs <node_modules parent>\n");
  process.exit(2);
}
const omnesis = join(root, "node_modules", "omnesis", "package.json");
if (!existsSync(omnesis)) {
  process.stderr.write(`no installed omnesis package at ${omnesis}\n`);
  process.exit(1);
}
const gateway = createRequire(realpathSync(omnesis)).resolve("@omnesis/gateway/package.json");
const require = createRequire(gateway);

const checks = {
  "better-sqlite3-multiple-ciphers": async () => {
    // A keyed file database, as the gateway opens its encrypted stores.
    const Database = require("better-sqlite3-multiple-ciphers");
    const dir = mkdtempSync(join(tmpdir(), "omnesis-install-smoke-"));
    try {
      const db = new Database(join(dir, "keyed.db"));
      db.pragma("key = 'install-smoke'");
      db.exec("create table t (n integer); insert into t values (42)");
      const n = db.prepare("select n from t").get().n;
      db.close();
      return n === 42;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  "better-sqlite3": async () => {
    const Database = require("better-sqlite3");
    return new Database(":memory:").prepare("select 41 + 1 as n").get().n === 42;
  },
  "@duckdb/node-api": async () => {
    const { DuckDBInstance } = await import(require.resolve("@duckdb/node-api"));
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    const reader = await connection.runAndReadAll("select 41 + 1 as n");
    return Number(reader.getRows()[0][0]) === 42;
  },
  usearch: async () => {
    const { Index } = require("usearch");
    const index = new Index({ dimensions: 2, metric: "cos" });
    index.add(1n, new Float32Array([1, 0]));
    index.add(2n, new Float32Array([0, 1]));
    const found = index.search(new Float32Array([0.9, 0.1]), 1);
    return Number(found.keys[0]) === 1;
  },
};

let failed = 0;
for (const [name, check] of Object.entries(checks)) {
  try {
    if (!(await check())) throw new Error("returned the wrong result");
    process.stdout.write(`ok: ${name}\n`);
  } catch (error) {
    failed++;
    process.stdout.write(`FAIL: ${name}: ${error.message.split("\n")[0]}\n`);
  }
}
process.exit(failed ? 1 : 0);
