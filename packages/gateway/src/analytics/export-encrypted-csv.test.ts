// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { expect, test } from "vitest";
import {
  ensureInstallRootKey,
  readInstallRootKey,
  decryptArtifactFileToBuffer,
} from "@omnesis/core";
import { exportEncryptedAnalyticsCsv } from "./export-encrypted-csv.js";

test("analytics CSV streams real typed rows into ciphertext with portable quoting and no plaintext spill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-encrypted-csv-"));
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const options = { configDir: directory, backend: "file" as const };
  try {
    await ensureInstallRootKey(options);
    const rootKey = (await readInstallRootKey(options))!;
    await connection.run(
      "CREATE TABLE sample(id BIGINT, note VARCHAR, optional VARCHAR, empty VARCHAR)",
    );
    await connection.run(
      "INSERT INTO sample VALUES (9007199254740993, 'invented, \"quoted\"' || chr(10) || 'note', NULL, '')",
    );
    await exportEncryptedAnalyticsCsv(connection, directory, ["sample"], {
      rootKey,
      scope: "export:fixture",
    });
    expect((await readdir(directory)).filter((file) => file.startsWith("sample"))).toEqual([
      "sample.csv.enc",
    ]);
    const output = join(directory, "sample.csv.enc");
    expect((await readFile(output)).includes(Buffer.from("invented"))).toBe(false);
    expect((await decryptArtifactFileToBuffer(output, options)).toString()).toBe(
      'id,note,optional,empty\n9007199254740993,"invented, ""quoted""\nnote",,""\n',
    );
    await expect(
      exportEncryptedAnalyticsCsv(connection, directory, ["../escape"], {
        rootKey,
        scope: "export:fixture",
      }),
    ).rejects.toThrow("filename");
    // A refused/failed export releases the same live connection for ordinary work.
    expect((await connection.runAndReadAll("SELECT count(*) FROM sample")).getRows()).toEqual([
      [1n],
    ]);
  } finally {
    connection.closeSync();
    instance.closeSync();
    await rm(directory, { recursive: true, force: true });
  }
});
