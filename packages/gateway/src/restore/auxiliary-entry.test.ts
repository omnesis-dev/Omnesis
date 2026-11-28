// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  GATEWAY_ANALYTICS_STORE_FILE,
  generateInstallRootKey,
  produceEncryptedArtifact,
} from "@omnesis/core";
import { DuckDBInstance } from "@duckdb/node-api";
import { BUNDLED_DUCKDB_EXTENSION_DIRECTORY } from "../analytics/connection-pool.js";
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

type AnalyticsCompositionStage = "source" | "seal" | "restore" | "inspect";

/** Native SQL failures may contain interpolated keys; never expose their message/cause in a fixture failure. */
async function privateAnalyticsStep<T>(
  stage: AnalyticsCompositionStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const category =
      error instanceof TypeError
        ? "TypeError"
        : error instanceof RangeError
          ? "RangeError"
          : error instanceof Error
            ? "Error"
            : "other";
    throw new Error(`Encrypted analytics composition failed at ${stage} (${category})`, {
      cause: error,
    });
  }
}

async function analyticsCompositionEngine() {
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "1",
    memory_limit: "128MB",
    temp_directory: "",
    autoload_known_extensions: "false",
    autoinstall_known_extensions: "false",
    allow_unsigned_extensions: "false",
  });
  let connection: Awaited<ReturnType<typeof instance.connect>> | undefined;
  try {
    connection = await instance.connect();
    const [version, platform] = (
      await connection.runAndReadAll("SELECT version(), (SELECT platform FROM pragma_platform())")
    ).getRows()[0]!;
    if (version !== "v1.5.6") throw new Error("The pinned fixture engine differs");
    const extension = join(
      BUNDLED_DUCKDB_EXTENSION_DIRECTORY,
      String(version),
      String(platform),
      "httpfs.duckdb_extension",
    );
    await connection.run(`LOAD '${extension.replace(/'/g, "''")}'`);
    return { instance, connection };
  } catch (error) {
    try {
      connection?.closeSync();
    } finally {
      instance.closeSync();
    }
    throw error;
  }
}

const analyticsLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

test.each(["default", "16384"] as const)(
  "actual encrypted analytics artifact entry composes authentication and rebuild (block size %s)",
  async (blockSize) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-analytics-entry-")));
    homes.push(home);
    const source = join(home, "source.db"),
      work = join(home, "work");
    await mkdir(work, { mode: 0o700 });
    const sourceKey = Buffer.alloc(32, 17),
      destinationKey = Buffer.alloc(32, 18);
    await privateAnalyticsStep("source", async () => {
      const { instance, connection } = await analyticsCompositionEngine();
      try {
        await connection.run(
          `ATTACH ${analyticsLiteral(source)} AS original (ENCRYPTION_KEY ${analyticsLiteral(sourceKey.toString("hex"))}${blockSize === "16384" ? ", BLOCK_SIZE 16384" : ""})`,
        );
        await connection.run(
          "CREATE TABLE original.main.records(id BIGINT PRIMARY KEY, content VARCHAR NOT NULL, enabled BOOLEAN DEFAULT false)",
        );
        await connection.run(
          "INSERT INTO original.main.records(id,content) VALUES (1,'Invented staged analytics record'),(2,'Invented second analytics record')",
        );
        await connection.run("CHECKPOINT original");
        await connection.run("DETACH original");
      } finally {
        try {
          connection.closeSync();
        } finally {
          instance.closeSync();
        }
      }
    });
    await chmod(source, 0o600);
    const original = await readFile(source);
    expect(original.length).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(original.subarray(8, 12).toString("ascii")).toBe("DUCK");
    expect((original.readBigUInt64LE(20) & 1n) === 1n).toBe(true);
    const rootKey = generateInstallRootKey(),
      scope = "desktop-restore:analytics-qualification";
    const sealed = join(work, "backup.enc"),
      staging = join(work, "authenticated.db"),
      destination = join(work, "restored.db");
    await privateAnalyticsStep("seal", async () => {
      await produceEncryptedArtifact(sealed, { rootKey, scope }, async (body) => {
        await new Promise<void>((resolve, reject) => {
          body.write(original, (error) => (error ? reject(error) : resolve()));
        });
      });
    });
    const result = await privateAnalyticsStep("restore", () =>
      restoreAuxiliaryEntry({
        kind: "analytics",
        entry: {
          path: sealed,
          scope,
          targetRootKey: rootKey,
          sourceRootKey: rootKey,
          logicalName: GATEWAY_ANALYTICS_STORE_FILE,
          sourceScope: null,
          bytes: original.length,
        },
        sourceKey,
        sourceCipherPath: staging,
        destinationPath: destination,
        destinationKey,
      }),
    );
    expect(result).toEqual({ rowsPreserved: 2, pendingWorkDiscarded: 0, watchesPaused: 0 });
    await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(source)).equals(original)).toBe(true);
    const observed = await privateAnalyticsStep("inspect", async () => {
      const { instance, connection } = await analyticsCompositionEngine();
      try {
        let oldKeyRefused = false;
        try {
          await connection.run(
            `ATTACH ${analyticsLiteral(destination)} AS wrong_key (READ_ONLY, ENCRYPTION_KEY ${analyticsLiteral(sourceKey.toString("hex"))})`,
          );
        } catch {
          oldKeyRefused = true;
        }
        if (!oldKeyRefused) await connection.run("DETACH wrong_key");
        await connection.run(
          `ATTACH ${analyticsLiteral(destination)} AS restored (ENCRYPTION_KEY ${analyticsLiteral(destinationKey.toString("hex"))})`,
        );
        const rows = (
          await connection.runAndReadAll(
            "SELECT id,content,enabled FROM restored.main.records ORDER BY id",
          )
        ).getRows();
        const constraints = (
          await connection.runAndReadAll(
            "SELECT constraint_type,to_json(constraint_column_names)::VARCHAR AS columns FROM duckdb_constraints() WHERE database_name='restored' AND table_name='records'",
          )
        ).getRowObjects();
        let defaulted: unknown;
        await connection.run("BEGIN TRANSACTION");
        try {
          await connection.run(
            "INSERT INTO restored.main.records(id,content) VALUES(3,'Invented temporary verification record')",
          );
          defaulted = (
            await connection.runAndReadAll("SELECT enabled FROM restored.main.records WHERE id=3")
          ).getRows()[0]?.[0];
        } finally {
          await connection.run("ROLLBACK");
        }
        await connection.run("DETACH restored");
        return { oldKeyRefused, rows, constraints, defaulted };
      } finally {
        try {
          connection.closeSync();
        } finally {
          instance.closeSync();
        }
      }
    });
    expect(observed.oldKeyRefused).toBe(true);
    expect(observed.rows).toEqual([
      [1n, "Invented staged analytics record", false],
      [2n, "Invented second analytics record", false],
    ]);
    expect(
      observed.constraints.some(
        (row) => row.constraint_type === "PRIMARY KEY" && row.columns === '["id"]',
      ),
    ).toBe(true);
    expect(
      observed.constraints.some(
        (row) => row.constraint_type === "NOT NULL" && row.columns === '["content"]',
      ),
    ).toBe(true);
    expect(observed.defaulted).toBe(false);
    expect((await readdir(work)).sort()).toEqual(["backup.enc", "restored.db"]);
    for (const path of [sealed, destination]) {
      const info = await lstat(path),
        bytes = await readFile(path);
      expect(info.isFile()).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.nlink).toBe(1);
      expect(info.size).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(info.uid).toBe(process.getuid!());
      expect(info.mode & 0o777).toBe(0o600);
      for (const text of [
        "Invented staged analytics record",
        "Invented second analytics record",
        "Invented temporary verification record",
      ])
        expect(bytes.includes(Buffer.from(text))).toBe(false);
    }
    const restoredBytes = await readFile(destination);
    expect(restoredBytes.subarray(8, 12).toString("ascii")).toBe("DUCK");
    expect((restoredBytes.readBigUInt64LE(20) & 1n) === 1n).toBe(true);
    expect((await readFile(source)).equals(original)).toBe(true);
  },
);
