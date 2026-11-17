// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createDatabase, openReadOnlyDatabase } from "../../packages/gateway/src/db.ts";
import { keySqliteDb } from "../../packages/gateway/src/sqlite-encryption.ts";

const require = createRequire(import.meta.url);
const [scratch, ...roots] = process.argv.slice(2);
assert.equal(process.platform, "win32");
assert.equal(roots.length, 2);
const engineVersions = ["3.54.1", "3.53.4"];
for (const [index, root] of roots.entries()) {
  const Constructor = require(root);
  const db = new Constructor(join(scratch, `binding-${index}.db`));
  try {
    assert.equal(db.prepare("SELECT sqlite_version()").pluck().get(), engineVersions[index]);
    db.pragma("journal_mode=WAL");
    db.exec("CREATE TABLE notes(body TEXT);INSERT INTO notes VALUES('invented durable note')");
    assert.deepEqual(db.prepare("SELECT body FROM notes").all(), [
      { body: "invented durable note" },
    ]);
    assert.ok(
      require.cache[require.resolve(join(root, "prebuilds", `win32-${process.arch}.node`))],
      "the default package must load the newly published prebuilt path",
    );
  } finally {
    db.close();
  }
}
const key = randomBytes(32);
const encryptedPath = join(scratch, "encrypted-schema.db");
const encrypted = createDatabase(encryptedPath, { encryptionKey: key });
try {
  assert.equal(encrypted.pragma("quick_check", { simple: true }), "ok");
  encrypted.exec(
    "CREATE TABLE native_proof(body TEXT);INSERT INTO native_proof VALUES('invented encrypted note')",
  );
} finally {
  encrypted.close();
}
assert.notEqual(readFileSync(encryptedPath).subarray(0, 16).toString("utf8"), "SQLite format 3\0");
const Plain = require(roots[0]);
const unkeyed = new Plain(encryptedPath, { readonly: true });
try {
  assert.throws(() => unkeyed.prepare("SELECT * FROM sqlite_master").all());
} finally {
  unkeyed.close();
}
const reopened = openReadOnlyDatabase(encryptedPath, { encryptionKey: key });
try {
  assert.deepEqual(reopened.prepare("SELECT body FROM native_proof").all(), [
    { body: "invented encrypted note" },
  ]);
} finally {
  reopened.close();
}

// The rebuilt cipher must read an existing vendor binary's files, and that
// original binary must still read writes made by the rebuilt one.
const previous = join(scratch, "better-sqlite3-multiple-ciphers.previous.node");
if (existsSync(previous)) {
  const Cipher = require(roots[1]);
  const path = join(scratch, "existing-cipher.db");
  const legacyKey = randomBytes(32);
  const old = new Cipher(path, { nativeBinding: previous });
  try {
    keySqliteDb(old, legacyKey);
    old.exec("CREATE TABLE notes(body TEXT);INSERT INTO notes VALUES('invented previous note')");
  } finally {
    old.close();
  }
  const next = new Cipher(path);
  try {
    keySqliteDb(next, legacyKey);
    assert.deepEqual(next.prepare("SELECT body FROM notes").all(), [
      { body: "invented previous note" },
    ]);
    next.exec("INSERT INTO notes VALUES('invented next note')");
  } finally {
    next.close();
  }
  const oldAgain = new Cipher(path, { nativeBinding: previous });
  try {
    keySqliteDb(oldAgain, legacyKey);
    assert.deepEqual(oldAgain.prepare("SELECT body FROM notes ORDER BY rowid").all(), [
      { body: "invented previous note" },
      { body: "invented next note" },
    ]);
  } finally {
    oldAgain.close();
  }
  process.stdout.write("Original and rebuilt SQLite cipher bindings preserve file compatibility\n");
}
process.stdout.write(
  "Default plain and encrypted SQLite bindings and full Gateway schema passed\n",
);
