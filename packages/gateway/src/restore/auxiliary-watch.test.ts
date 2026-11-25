// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openEncryptedSqlite } from "../sqlite-encryption.js";
import { initializeRestoredWatchSchema, rebuildRestoredWatchDatabase } from "./auxiliary-watch.js";
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "omnesis-restored-watch-"));
  homes.push(home);
  const sourcePath = join(home, "source.db"),
    destinationPath = join(home, "restored.db");
  const sourceKey = Buffer.alloc(32, 7),
    destinationKey = Buffer.alloc(32, 8);
  const source = initializeRestoredWatchSchema(sourcePath, sourceKey);
  source
    .prepare(
      "INSERT INTO watch_defs(id,name,status,dsl_json,added_at) VALUES('invented-watch','Invented reminder','active','{}','2025-01-01')",
    )
    .run();
  source.prepare("INSERT INTO watch_state(watch_id,active) VALUES('invented-watch',1)").run();
  source
    .prepare(
      "INSERT INTO watch_firings(watch_id,seq,node_id,key_hash,fired_at,payload_json) VALUES('invented-watch',1,'invented-node','invented-key','2025-01-01','{\"summary\":\"invented private watch marker\"}')",
    )
    .run();
  source
    .prepare(
      "INSERT INTO watch_deliveries(watch_id,seq,node_id,key_hash,kind,delivered,at) VALUES('invented-watch',?,'invented-node','invented-key','omnesis-notify',?,'2025-01-01')",
    )
    .run(1, 1);
  source
    .prepare(
      "INSERT INTO watch_deliveries(watch_id,seq,node_id,key_hash,kind,delivered,at) VALUES('invented-watch',?,'invented-node','invented-key','omnesis-notify',?,'2025-01-01')",
    )
    .run(2, 0);
  source
    .prepare(
      "INSERT INTO timers(watch_id,node_id,key_hash,instance,kind,key_json,due_at_ms) VALUES('invented-watch','invented-node','invented-key',0,'invented','{}',1)",
    )
    .run();
  source.prepare("UPDATE watch_defs SET note='invented owner note'").run();
  const sourceImage = source.serialize();
  source.close();
  await chmod(sourcePath, 0o600);
  return {
    home,
    sourcePath,
    sourceKey,
    destinationPath,
    destinationKey,
    sourceImage,
    signal: new AbortController().signal,
  };
}
test("fresh encrypted Watch schema preserves completed history while pausing definitions and removing future work", async () => {
  const f = await fixture(),
    before = await readFile(f.sourcePath);
  const result = rebuildRestoredWatchDatabase({
    sourcePath: f.sourcePath,
    sourceKey: f.sourceKey,
    destinationPath: f.destinationPath,
    destinationKey: f.destinationKey,
    signal: f.signal,
  });
  expect(result.watchesPaused).toBe(1);
  expect(result.pendingWorkDiscarded).toBe(2);
  expect(await readFile(f.sourcePath)).toEqual(before);
  const output = openEncryptedSqlite(f.destinationPath, {
    key: f.destinationKey,
    readonly: true,
    migratePlaintext: false,
  });
  try {
    expect(output.prepare("SELECT status,reference_digest FROM watch_defs").get()).toEqual({
      status: "paused",
      reference_digest: null,
    });
    expect(output.prepare("SELECT note FROM watch_defs").pluck().get()).toContain(
      "invented owner note",
    );
    expect(output.prepare("SELECT active FROM watch_state").pluck().get()).toBe(0);
    expect(output.prepare("SELECT count(*) FROM timers").pluck().get()).toBe(0);
    expect(output.prepare("SELECT count(*) FROM watch_firings").pluck().get()).toBe(1);
    expect(output.prepare("SELECT count(*) FROM watch_deliveries").pluck().get()).toBe(1);
  } finally {
    output.close();
  }
  expect(
    (await readFile(f.destinationPath)).includes(Buffer.from("invented private watch marker")),
  ).toBe(false);
});
test("a bounded legacy plaintext image is read only in memory and the destination uses the current key", async () => {
  const f = await fixture();
  expect(f.sourceImage.subarray(0, 16).toString()).toBe("SQLite format 3\0");
  expect(
    rebuildRestoredWatchDatabase({
      sourceImage: f.sourceImage,
      destinationPath: f.destinationPath,
      destinationKey: f.destinationKey,
      signal: f.signal,
    }).watchesPaused,
  ).toBe(1);
  expect(
    (await readFile(f.destinationPath)).includes(Buffer.from("invented private watch marker")),
  ).toBe(false);
});
test("foreign executable schema refuses without producing a replacement store", async () => {
  const f = await fixture();
  const db = openEncryptedSqlite(f.sourcePath, { key: f.sourceKey });
  db.exec("CREATE VIEW invented_foreign_program AS SELECT 'invented forbidden program' AS value");
  db.close();
  expect(() =>
    rebuildRestoredWatchDatabase({
      sourcePath: f.sourcePath,
      sourceKey: f.sourceKey,
      destinationPath: f.destinationPath,
      destinationKey: f.destinationKey,
      signal: f.signal,
    }),
  ).toThrow("unreviewed");
  await expect(stat(f.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
});
