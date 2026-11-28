// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, test } from "vitest";
import {
  decryptArtifactFileToBuffer,
  ensureInstallRootKey,
  readInstallRootKey,
  resolveWorkerEntry,
} from "@omnesis/core";
import { openEncryptedSqlite } from "../sqlite-encryption.js";
import type { BackupWorkerInput, BackupWorkerMessage } from "./backup-protocol.js";

test("backup worker snapshots keyed SQLite directly as ciphertext and seals configuration while copying", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-backup-worker-"));
  const destination = join(directory, "backup");
  const key = randomBytes(32);
  await mkdir(destination);
  const source = join(directory, "source.db");
  const database = openEncryptedSqlite(source, { key });
  database.exec(
    "CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('invented corpus content')",
  );
  database.close();
  const secrets = { configDir: directory, backend: "file" as const };
  await ensureInstallRootKey(secrets);
  const rootKey = (await readInstallRootKey(secrets))!;
  const config = join(directory, "config.json");
  await writeFile(config, '{"instruction":"invented private instruction"}');
  const input: BackupWorkerInput = {
    artifactEncryption: { rootKey, scope: "backup:fixture" },
    vacuums: [
      {
        sourcePath: source,
        destPath: join(destination, "snapshot.db"),
        name: "snapshot.db",
        keyHex: key.toString("hex"),
      },
    ],
    copies: [{ from: config, to: join(destination, "config.json"), name: "config.json" }],
  };
  const entry = resolveWorkerEntry("./backup-worker.ts", import.meta.url, "./register-tsx.mjs");
  const worker = new Worker(entry.url, { workerData: input, execArgv: entry.execArgv });
  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      worker.on("message", (message: BackupWorkerMessage) => {
        if (message.type === "error") reject(new Error(message.error));
        if (message.type === "done") done = true;
      });
      worker.on("error", reject);
      worker.on("exit", (code) =>
        code === 0 && done ? resolve() : reject(new Error(`Worker failed: ${code}`)),
      );
    });
    const snapshot = join(destination, "snapshot.db");
    expect((await readFile(snapshot)).includes(Buffer.from("invented corpus content"))).toBe(false);
    expect((await readFile(snapshot)).subarray(0, 16).toString()).not.toBe("SQLite format 3\0");
    const copy = openEncryptedSqlite(snapshot, { key, readonly: true, migratePlaintext: false });
    try {
      expect(copy.prepare("SELECT value FROM fixture").get()).toEqual({
        value: "invented corpus content",
      });
    } finally {
      copy.close();
    }
    expect(await readdir(destination)).toEqual(
      expect.arrayContaining(["snapshot.db", "config.json.enc"]),
    );
    expect(await readFile(join(destination, "config.json.enc"), "utf8")).not.toContain(
      "invented private instruction",
    );
    expect(
      (await decryptArtifactFileToBuffer(join(destination, "config.json.enc"), secrets)).toString(),
    ).toBe(await readFile(config, "utf8"));
  } finally {
    await worker.terminate();
    key.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});
