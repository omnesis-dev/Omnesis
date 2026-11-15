// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createDatabase } from "../../packages/gateway/src/db.ts";

const require = createRequire(import.meta.url);
const [scratch, ...roots] = process.argv.slice(2);
assert.equal(process.platform, "win32");
assert.equal(roots.length, 2);
for (const [index, root] of roots.entries()) {
  const Constructor = require(root);
  const db = new Constructor(join(scratch, `binding-${index}.db`));
  try {
    assert.equal(db.prepare("SELECT sqlite_version()").pluck().get(), "3.53.4");
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
const encrypted = createDatabase(join(scratch, "encrypted-schema.db"), {
  encryptionKey: randomBytes(32),
});
try {
  assert.equal(encrypted.pragma("quick_check", { simple: true }), "ok");
} finally {
  encrypted.close();
}
process.stdout.write("SQLite 3.53.4 default bindings and full encrypted Gateway schema passed\n");
