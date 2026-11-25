// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, expect, test, vi } from "vitest";
import { BUNDLED_DUCKDB_EXTENSION_DIRECTORY } from "../analytics/connection-pool.js";
import { rebuildRestoredAnalyticsDatabase } from "./auxiliary-analytics.js";
const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function engine() {
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "1",
    temp_directory: "",
    autoload_known_extensions: "false",
    autoinstall_known_extensions: "false",
  });
  const connection = await instance.connect();
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
  return { instance, connection };
}
async function fixture(encrypted = true, executable?: "view" | "macro" | "generated") {
  const home = await mkdtemp(join(tmpdir(), "omnesis-rebuilt-analytics-"));
  homes.push(home);
  const sourcePath = join(home, "source.db"),
    destinationPath = join(home, "restored.db");
  const sourceKey = Buffer.alloc(32, 7),
    destinationKey = Buffer.alloc(32, 8);
  const { instance, connection } = await engine();
  try {
    await connection.run(
      `ATTACH '${sourcePath}' AS invented${encrypted ? ` (ENCRYPTION_KEY '${sourceKey.toString("hex")}')` : ""}`,
    );
    await connection.run(
      "CREATE TABLE invented.main.records (id BIGINT PRIMARY KEY, content VARCHAR NOT NULL, enabled BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT current_timestamp)",
    );
    await connection.run(
      "INSERT INTO invented.main.records(id,content) VALUES(1,'invented private analytics marker'),(2,'invented second row')",
    );
    await connection.run("CREATE SCHEMA invented._omnesis_internal");
    await connection.run(
      "CREATE SEQUENCE invented._omnesis_internal.watch_analytics_outbox_seq START 20",
    );
    await connection.run(
      "CREATE TABLE invented._omnesis_internal.watch_analytics_outbox(page_seq BIGINT PRIMARY KEY, records_json VARCHAR, consumed_at TIMESTAMPTZ)",
    );
    await connection.run(
      "INSERT INTO invented._omnesis_internal.watch_analytics_outbox VALUES(1,'invented completed history',current_timestamp),(2,'invented pending delivery',NULL)",
    );
    if (executable === "view")
      await connection.run(
        "CREATE VIEW invented.main.foreign_program AS SELECT 'invented forbidden program' AS value",
      );
    if (executable === "macro")
      await connection.run(
        "CREATE MACRO invented.main.foreign_program() AS 'invented forbidden program'",
      );
    if (executable === "generated")
      await connection.run(
        "CREATE TABLE invented.main.foreign_program(id BIGINT, value BIGINT GENERATED ALWAYS AS (id+1))",
      );
    await connection.run("CHECKPOINT invented");
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  await chmod(sourcePath, 0o600);
  return {
    home,
    sourcePath,
    sourceKey,
    destinationPath,
    destinationKey,
    signal: new AbortController().signal,
  };
}
async function inspect(path: string, key: Buffer) {
  const { instance, connection } = await engine();
  try {
    await connection.run(
      `ATTACH '${path}' AS result (READ_ONLY,ENCRYPTION_KEY '${key.toString("hex")}')`,
    );
    return {
      rows: (
        await connection.runAndReadAll(
          "SELECT id,content,enabled FROM result.main.records ORDER BY id",
        )
      ).getRows(),
      outbox: (
        await connection.runAndReadAll(
          "SELECT count(*) FROM result._omnesis_internal.watch_analytics_outbox",
        )
      ).getRows()[0]![0],
      constraints: (
        await connection.runAndReadAll(
          "SELECT count(*) FROM duckdb_constraints() WHERE database_name='result' AND constraint_type='PRIMARY KEY'",
        )
      ).getRows()[0]![0],
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
test("encrypted analytics rebuild keeps base rows and constraints under the current key, discarding pending delivery work", async () => {
  const f = await fixture();
  const result = await rebuildRestoredAnalyticsDatabase(f);
  expect(result).toEqual({ rowsPreserved: 3, watchesPaused: 0, pendingWorkDiscarded: 1 });
  expect(await inspect(f.destinationPath, f.destinationKey)).toEqual({
    rows: [
      [1n, "invented private analytics marker", false],
      [2n, "invented second row", false],
    ],
    outbox: 1n,
    constraints: 2n,
  });
  expect(
    (await readFile(f.destinationPath)).includes(Buffer.from("invented private analytics marker")),
  ).toBe(false);
});
test("legacy plaintext analytics is consumed through bounded memory ranges and only encrypted output persists", async () => {
  vi.stubEnv("http_proxy", "http://127.0.0.1:9");
  vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:9");
  const f = await fixture(false),
    sourceImage = await readFile(f.sourcePath);
  await rm(f.sourcePath);
  try {
    await rebuildRestoredAnalyticsDatabase({
      sourceImage,
      destinationPath: f.destinationPath,
      destinationKey: f.destinationKey,
      signal: f.signal,
    });
    expect((await inspect(f.destinationPath, f.destinationKey)).rows).toHaveLength(2);
    expect(await readdir(f.home)).toEqual(["restored.db"]);
    expect(
      (await readFile(f.destinationPath)).includes(
        Buffer.from("invented private analytics marker"),
      ),
    ).toBe(false);
  } finally {
    sourceImage.fill(0);
  }
});
test("foreign views, macros and generated expressions are refused and never published", async () => {
  for (const kind of ["view", "macro", "generated"] as const) {
    const f = await fixture(true, kind);
    await expect(rebuildRestoredAnalyticsDatabase(f)).rejects.toThrow(/unreviewed|reviewed/);
    await expect(stat(f.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  }
});
