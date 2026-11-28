// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DuckDBInstance } from "@duckdb/node-api";
import { expect, test } from "vitest";
import { BUNDLED_DUCKDB_EXTENSION_DIRECTORY } from "../analytics/connection-pool.js";
import { serveRestoreMemoryFile } from "./auxiliary-memory-file.js";

test("capability-scoped range server serves a real legacy database to pinned DuckDB without plaintext materialization", async () => {
  const home = await mkdtemp(join(tmpdir(), "omnesis-legacy-analytics-"));
  let instance: DuckDBInstance | undefined;
  let served: Awaited<ReturnType<typeof serveRestoreMemoryFile>> | undefined;
  try {
    const source = join(home, "invented-original.duckdb");
    instance = await DuckDBInstance.create(source, { threads: "1", temp_directory: "" });
    const original = await instance.connect();
    await original.run(
      "CREATE TABLE invented_records AS SELECT 7::BIGINT AS id, 'invented legacy private row' AS content",
    );
    original.closeSync();
    instance.closeSync();
    const image = await readFile(source);
    await rm(source);
    served = await serveRestoreMemoryFile(image, new AbortController().signal);
    expect(
      (await fetch(served.url.replace(/\/[^/]+\/analytics.duckdb$/, "/not-allowed"))).status,
    ).toBe(404);
    const range = await fetch(served.url, { headers: { range: "bytes=8-11" } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("DUCK");
    instance = await DuckDBInstance.create(":memory:", {
      threads: "1",
      memory_limit: "128MB",
      temp_directory: "",
      autoload_known_extensions: "false",
      autoinstall_known_extensions: "false",
    });
    const reader = await instance.connect();
    try {
      const [version, platform] = (
        await reader.runAndReadAll("SELECT version(), (SELECT platform FROM pragma_platform())")
      ).getRows()[0]!;
      const extension = join(
        BUNDLED_DUCKDB_EXTENSION_DIRECTORY,
        String(version),
        String(platform),
        "httpfs.duckdb_extension",
      );
      await reader.run(`LOAD '${extension.replace(/'/g, "''")}'`);
      await reader.run("SET enable_external_file_cache=false");
      await reader.run("SET enable_http_metadata_cache=false");
      await reader.run(`SET allowed_paths=['${served.url}']`);
      await reader.run(`ATTACH '${served.url}' AS backup (READ_ONLY)`);
      await reader.run("SET enable_external_access=false");
      await reader.run("SET lock_configuration=true");
      expect(
        (await reader.runAndReadAll("SELECT * FROM backup.main.invented_records")).getRows(),
      ).toEqual([[7n, "invented legacy private row"]]);
      expect(await readdir(home)).toEqual([]);
    } finally {
      reader.closeSync();
      instance.closeSync();
      instance = undefined;
    }
    await served.close();
    served = undefined;
    image.fill(0);
  } finally {
    await served?.close();
    instance?.closeSync();
    await rm(home, { recursive: true, force: true });
  }
});

test("memory range reader refuses malformed requests and drains immediately on cancellation", async () => {
  const controller = new AbortController();
  const memory = await serveRestoreMemoryFile(
    Buffer.from("invented memory-only bytes"),
    controller.signal,
  );
  try {
    expect((await fetch(memory.url, { method: "POST" })).status).toBe(404);
    expect((await fetch(memory.url, { headers: { range: "bytes=0-1,3-4" } })).status).toBe(416);
    expect((await fetch(memory.url, { headers: { range: "bytes=999-1000" } })).status).toBe(416);
    controller.abort();
  } finally {
    await memory.close();
  }
  await expect(fetch(memory.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
});
