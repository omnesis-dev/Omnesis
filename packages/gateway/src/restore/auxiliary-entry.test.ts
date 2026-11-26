// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { generateInstallRootKey, produceEncryptedArtifact } from "@omnesis/core";
import { openEncryptedSqlite } from "../sqlite-encryption.js";
import { initializeRestoredWatchSchema } from "./auxiliary-watch.js";
import { restoreAuxiliaryEntry } from "./auxiliary-entry.js";
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-auxiliary-entry-")));
  homes.push(home);
  const sourcePath = join(home, "original.db"),
    sourceKey = Buffer.alloc(32, 7),
    destinationKey = Buffer.alloc(32, 8);
  const db = initializeRestoredWatchSchema(sourcePath, sourceKey);
  db.prepare(
    "INSERT INTO watch_defs(id,name,status,dsl_json,added_at) VALUES('invented-watch','Invented reminder','active','{}','2025-01-01')",
  ).run();
  const plaintext = db.serialize();
  db.close();
  await chmod(sourcePath, 0o600);
  const ciphertext = await readFile(sourcePath);
  await rm(sourcePath);
  const sourceRootKey = generateInstallRootKey(),
    targetRootKey = generateInstallRootKey();
  const wrap = async (bytes: Buffer, label: string) => {
    const scope = `backup:${randomUUID()}:watch.db`,
      inner = join(home, `${label}-inner.enc`),
      path = join(home, `${label}-outer.enc`);
    await produceEncryptedArtifact(inner, { rootKey: sourceRootKey, scope }, async (body) => {
      body.write(bytes);
    });
    const nested = await readFile(inner);
    await produceEncryptedArtifact(
      path,
      { rootKey: targetRootKey, scope: `desktop-restore:${label}` },
      async (body) => {
        body.write(nested);
      },
    );
    return {
      path,
      scope: `desktop-restore:${label}`,
      targetRootKey,
      sourceRootKey,
      logicalName: "watch.db.enc",
      sourceScope: scope,
      bytes: nested.length,
    };
  };
  return {
    home,
    plaintext,
    ciphertext,
    sourceKey,
    destinationKey,
    wrap,
    sourceCipherPath: join(home, "authenticated-input.db"),
    destinationPath: join(home, "restored.db"),
  };
}
test("nested encrypted Watch input authenticates before ciphertext staging and is rekeyed into a paused trusted store", async () => {
  const f = await fixture();
  const entry = await f.wrap(f.ciphertext, "current");
  expect((await restoreAuxiliaryEntry({ ...f, entry, kind: "watch" })).watchesPaused).toBe(1);
  await expect(stat(f.sourceCipherPath)).rejects.toMatchObject({ code: "ENOENT" });
  const restored = openEncryptedSqlite(f.destinationPath, {
    key: f.destinationKey,
    readonly: true,
    migratePlaintext: false,
  });
  try {
    expect(restored.prepare("SELECT status FROM watch_defs").pluck().get()).toBe("paused");
  } finally {
    restored.close();
  }
});
test("nested legacy SQLite is decoded only in memory and no plaintext intermediate is created", async () => {
  const f = await fixture(),
    entry = await f.wrap(f.plaintext, "legacy");
  await restoreAuxiliaryEntry({ ...f, entry, sourceKey: null, kind: "watch" });
  await expect(stat(f.sourceCipherPath)).rejects.toMatchObject({ code: "ENOENT" });
  for (const name of await readdir(f.home))
    expect((await readFile(join(f.home, name))).includes(Buffer.from("Invented reminder"))).toBe(
      false,
    );
});
test("late outer tag failures and ciphertext-shaped plaintext never produce a replacement or plaintext intermediate", async () => {
  for (const forged of [false, true]) {
    const f = await fixture();
    const bytes = Buffer.from(forged ? f.plaintext : f.ciphertext);
    if (forged) bytes.fill(0x31, 0, 16);
    const entry = await f.wrap(bytes, "refused");
    if (!forged) {
      const sealed = await readFile(entry.path);
      sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 1;
      await writeFile(entry.path, sealed);
    }
    await expect(restoreAuxiliaryEntry({ ...f, entry, kind: "watch" })).rejects.toThrow();
    await expect(stat(f.sourceCipherPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(f.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    for (const name of await readdir(f.home))
      expect((await readFile(join(f.home, name))).includes(Buffer.from("Invented reminder"))).toBe(
        false,
      );
  }
});
