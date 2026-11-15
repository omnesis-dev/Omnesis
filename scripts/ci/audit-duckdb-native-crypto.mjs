// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Diagnostic only: ask the pinned native engine whether it can write encrypted
// stores without httpfs. No extension is installed and no product gate changes.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

const scratch = await mkdtemp(join(tmpdir(), "omnesis-native-crypto-"));
const key = randomBytes(32).toString("hex");
const options = {
  autoinstall_known_extensions: "false",
  autoload_known_extensions: "false",
  allow_unsigned_extensions: "false",
  extension_directory: scratch,
};
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const summary = { platform: process.platform, arch: process.arch };
let instance;
let connection;
try {
  instance = await DuckDBInstance.create(":memory:", options);
  connection = await instance.connect();
  summary.engine = (
    await connection.runAndReadAll("SELECT version(), (SELECT platform FROM pragma_platform())")
  ).getRows()[0];
  const plain = join(scratch, "plain.db");
  await connection.run(`ATTACH ${literal(plain)} AS plain`);
  await connection.run("CREATE TABLE plain.control(value INTEGER)");
  await connection.run("INSERT INTO plain.control VALUES (42)");
  summary.plainRoundtrip =
    Number((await connection.runAndReadAll("SELECT value FROM plain.control")).getRows()[0][0]) ===
    42;
  await connection.run("DETACH plain");
  const encrypted = join(scratch, "encrypted.db");
  try {
    await connection.run(`ATTACH ${literal(encrypted)} AS secret (ENCRYPTION_KEY ${literal(key)})`);
    await connection.run("CREATE TABLE secret.control(value INTEGER)");
    await connection.run("INSERT INTO secret.control VALUES (42)");
    await connection.run("DETACH secret");
    connection.closeSync();
    instance.closeSync();
    instance = await DuckDBInstance.create(":memory:", options);
    connection = await instance.connect();
    try {
      await connection.run(`ATTACH ${literal(encrypted)} AS keyless (READ_ONLY)`);
      throw new Error("An encrypted store opened without its key");
    } catch (error) {
      if (error.message === "An encrypted store opened without its key") throw error;
      summary.keylessRefused = true;
    }
    await connection.run(`ATTACH ${literal(encrypted)} AS secret (ENCRYPTION_KEY ${literal(key)})`);
    summary.encryptedRoundtrip =
      Number(
        (await connection.runAndReadAll("SELECT value FROM secret.control")).getRows()[0][0],
      ) === 42;
    await connection.run("DETACH secret");
  } catch (error) {
    summary.encryptedRoundtrip = false;
    summary.encryptionError = String(error.message).replaceAll(key, "<redacted>");
  }
} finally {
  connection?.closeSync();
  instance?.closeSync();
  await rm(scratch, { recursive: true, force: true });
}
process.stdout.write(`Native crypto diagnostic: ${JSON.stringify(summary)}\n`);
if (!summary.plainRoundtrip) throw new Error("The native engine positive control failed");
