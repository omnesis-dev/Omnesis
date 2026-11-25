// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ensureInstallRootKey, readInstallRootKey, produceEncryptedArtifact } from "@omnesis/core";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { openEncryptedSqlite, sqliteFileLooksPlaintext } from "../sqlite-encryption.js";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createToken, lookupToken } from "../data/repositories/TokenRepository.js";
import {
  inspectDesktopMainEntry,
  reconcileDesktopMainEntry,
  type RestoredMainEntryOptions,
} from "./index.js";
import type { Db } from "../data/types.js";

test("owned worker verifies nested artifact and every ciphertext page before preserving current authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-restored-entry-"));
  const sourceKey = randomBytes(32),
    targetKey = randomBytes(32),
    destinationKey = randomBytes(32);
  try {
    for (const name of ["source-root", "target-root"])
      await ensureInstallRootKey({ backend: "file", configDir: join(dir, name) });
    const sourceRootKey = (await readInstallRootKey({
        backend: "file",
        configDir: join(dir, "source-root"),
      }))!,
      targetRootKey = (await readInstallRootKey({
        backend: "file",
        configDir: join(dir, "target-root"),
      }))!;
    const sourcePath = join(dir, "source.db"),
      targetPath = join(dir, "target.db"),
      destinationPath = join(dir, "destination.db"),
      sourceCipherPath = join(dir, "worker-input.db");
    const create = (path: string, key: Buffer) => {
      const db = openEncryptedSqlite(path, { key });
      db.pragma("journal_mode=MEMORY");
      db.pragma("synchronous=OFF");
      runSchemaSetup(db as unknown as Db);
      runMigrations(db as unknown as Db);
      return db;
    };
    const source = create(sourcePath, sourceKey),
      target = create(targetPath, targetKey);
    const foreign = createDevice(source as unknown as Db, {
        name: "Invented archive device",
        kind: "collector",
      }),
      owner = createDevice(target as unknown as Db, {
        name: "Invented current desktop",
        kind: "cli",
      });
    const current = createToken(target as unknown as Db, owner.id, [SCOPE_ADMIN, SCOPE_READ]);
    source
      .prepare(
        "INSERT INTO sources(id,type,account_id,device_id,enabled,created_at,updated_at) VALUES('source-invented','invented','account-invented',?,1,1,1)",
      )
      .run(foreign.id);
    const legacyImage = source.serialize();
    source.close();
    target.close();
    await chmod(sourcePath, 0o600);
    await chmod(targetPath, 0o600);
    const epoch = randomUUID(),
      scope = `backup:${epoch}:omnesis.db`;
    const wrap = async (bytes: Buffer, label: string) => {
      const inner = join(dir, `${label}-inner.enc`),
        outer = join(dir, `${label}-stage.enc`);
      await produceEncryptedArtifact(inner, { rootKey: sourceRootKey, scope }, async (body) => {
        body.write(bytes);
      });
      const nested = await readFile(inner);
      await produceEncryptedArtifact(
        outer,
        { rootKey: targetRootKey, scope: `desktop-restore:${label}` },
        async (body) => {
          body.write(nested);
        },
      );
      return {
        path: outer,
        scope: `desktop-restore:${label}`,
        targetRootKey,
        sourceRootKey,
        logicalName: "omnesis.db.enc",
        sourceScope: scope,
        bytes: nested.length,
      };
    };
    const entry = await wrap(await readFile(sourcePath), "valid");
    const inspected = await inspectDesktopMainEntry(
      { entry, sourceKey, sourceCipherPath },
      new AbortController().signal,
    );
    expect(inspected).toMatchObject({ sources: 1, devices: 1, legacy: false });
    await expect(stat(sourceCipherPath)).rejects.toMatchObject({ code: "ENOENT" });
    const input: RestoredMainEntryOptions = {
      entry,
      sourceKey,
      sourceCipherPath,
      targetPath,
      targetKey,
      destinationPath,
      destinationKey,
    };
    const result = await reconcileDesktopMainEntry(input, new AbortController().signal);
    expect(result.sourcesPaused).toBe(1);
    expect(sqliteFileLooksPlaintext(destinationPath)).toBe(false);
    const restored = openEncryptedSqlite(destinationPath, { key: destinationKey });
    try {
      expect(lookupToken(restored as unknown as Db, current.token)?.deviceId).toBe(owner.id);
      expect(restored.prepare("SELECT enabled FROM sources").pluck().get()).toBe(0);
    } finally {
      restored.close();
    }
    await expect(stat(sourceCipherPath)).rejects.toMatchObject({ code: "ENOENT" });
    const legacy = await wrap(legacyImage, "legacy");
    legacyImage.fill(0);
    expect(
      await inspectDesktopMainEntry(
        { entry: legacy, sourceKey: null, sourceCipherPath },
        new AbortController().signal,
      ),
    ).toMatchObject({ sources: 1, legacy: true });
    await expect(stat(sourceCipherPath)).rejects.toMatchObject({ code: "ENOENT" });
    const corrupt = await readFile(sourcePath);
    corrupt[0] ^= 1;
    const damaged = await wrap(corrupt, "bad-page");
    await rm(destinationPath, { force: true });
    const before = await readFile(targetPath);
    await expect(
      reconcileDesktopMainEntry({ ...input, entry: damaged }, new AbortController().signal),
    ).rejects.toThrow("could not be prepared safely");
    await expect(stat(sourceCipherPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(targetPath)).toEqual(before);
  } finally {
    sourceKey.fill(0);
    targetKey.fill(0);
    destinationKey.fill(0);
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
