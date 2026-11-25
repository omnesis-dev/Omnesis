// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, expect, test } from "vitest";
import { BUNDLED_DUCKDB_EXTENSION_DIRECTORY } from "../analytics/connection-pool.js";
import { authenticateDuckDbBlocks } from "./auxiliary-duckdb-auth.js";
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture(encrypted = true, legacyProfile = false) {
  const home = await mkdtemp(join(tmpdir(), "omnesis-analytics-auth-"));
  homes.push(home);
  const path = join(home, "invented.duckdb"),
    key = Buffer.alloc(32, 7);
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "1",
    memory_limit: "64MB",
    temp_directory: "",
    autoload_known_extensions: "false",
    autoinstall_known_extensions: "false",
  });
  const connection = await instance.connect();
  try {
    const [version, platform] = (
      await connection.runAndReadAll("SELECT version(), (SELECT platform FROM pragma_platform())")
    ).getRows()[0]!;
    const extension = join(
      BUNDLED_DUCKDB_EXTENSION_DIRECTORY,
      String(version),
      String(platform),
      "httpfs.duckdb_extension",
    );
    await connection.run(`LOAD '${extension.replace(/'/g, "''")}'`);
    await connection.run(
      `ATTACH '${path.replace(/'/g, "''")}' AS invented (${legacyProfile ? "debug_encryption_version 'v0', STORAGE_VERSION 'v1.4.0', " : ""}${encrypted ? `ENCRYPTION_KEY '${key.toString("hex")}', ` : ""}BLOCK_SIZE 16384)`,
    );
    await connection.run(
      "CREATE TABLE invented.main.invented_records AS SELECT i::BIGINT AS id, 'invented-private-payload-marker' AS content FROM range(1000) t(i)",
    );
    await connection.run("CHECKPOINT invented");
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  return { bytes: await readFile(path), key };
}
async function* chunks(data: Buffer) {
  for (let i = 0; i < data.length; i += 777) yield data.subarray(i, i + 777);
}
async function authenticated(data: Buffer, key: Buffer) {
  const buffers: Buffer[] = [];
  for await (const block of authenticateDuckDbBlocks(
    chunks(data),
    key,
    new AbortController().signal,
  ))
    buffers.push(block);
  return Buffer.concat(buffers);
}
test("real DuckDB GCM ciphertext authenticates byte-for-byte across arbitrary stream chunks", async () => {
  const f = await fixture();
  expect(await authenticated(f.bytes, f.key)).toEqual(f.bytes);
  expect(f.bytes.includes(Buffer.from("invented-private-payload-marker"))).toBe(false);
});
test("plaintext, wrong keys, changed ciphertext and truncation never pass authentication", async () => {
  const f = await fixture(),
    plain = await fixture(false);
  await expect(authenticated(plain.bytes, f.key)).rejects.toThrow();
  await expect(authenticated(f.bytes, Buffer.alloc(32, 8))).rejects.toThrow();
  const changed = Buffer.from(f.bytes);
  changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
  await expect(authenticated(changed, f.key)).rejects.toThrow();
  await expect(authenticated(f.bytes.subarray(0, -1), f.key)).rejects.toThrow();
});

test("the actual legacy GCM profile also authenticates before materialization", async () => {
  const f = await fixture(true, true);
  expect(f.bytes[119]).toBe(0);
  expect(await authenticated(f.bytes, f.key)).toEqual(f.bytes);
});
