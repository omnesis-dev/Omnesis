// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalyticsConnectionPool } from "./connection-pool.js";
import { AnalyticsCatalogStore } from "./catalog-store.js";
import { AnalyticsQueryRunner } from "./query-runner.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.each([false, true])("user-SQL sandbox (encrypted=%s)", (encrypted) => {
  let directory: string;
  let pool: AnalyticsConnectionPool;
  let runner: AnalyticsQueryRunner;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-test-sandbox-"));
    pool = new AnalyticsConnectionPool(join(directory, "analytics.db"), {
      ...(encrypted ? { encryptionKeyHex: randomBytes(32).toString("hex") } : {}),
    });
    await pool.open(async (conn) => {
      await conn.run("CREATE TABLE sample AS SELECT 1 AS id");
    });
    runner = new AnalyticsQueryRunner(pool, new AnalyticsCatalogStore(pool));
  });

  afterEach(async () => {
    await pool.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("answers a plain select", async () => {
    expect((await runner.executeQuery("SELECT id FROM sample")).rows).toEqual([[1]]);
  });

  it.each([
    ["INSERT", "INSERT INTO sample VALUES (2)"],
    ["UPDATE", "UPDATE sample SET id = 2"],
    ["DELETE", "DELETE FROM sample"],
    ["CREATE TABLE", "CREATE TABLE smuggled AS SELECT 1"],
    ["DROP TABLE", "DROP TABLE sample"],
    ["multi-statement", "SELECT 1; INSERT INTO sample VALUES (2)"],
    // Closing the wrapper's parenthesis and ending the read-only transaction
    // in the same text: the pool prepares exactly one statement, so the
    // rest never runs.
    [
      "paren escape + ROLLBACK",
      "SELECT 1) AS __x; ROLLBACK; INSERT INTO sample VALUES (99999); SELECT * FROM (SELECT 2",
    ],
    [
      "paren escape + COMMIT + DDL",
      "SELECT 1) AS __x; COMMIT; CREATE TABLE smuggled AS SELECT 1; SELECT * FROM (SELECT 2",
    ],
    ["paren escape + DROP", "SELECT 1) AS __x; DROP TABLE sample; SELECT * FROM (SELECT 2"],
    ["paren escape + CHECKPOINT", "SELECT 1) AS __x; CHECKPOINT; SELECT * FROM (SELECT 2"],
    ["PRAGMA", "PRAGMA memory_limit='64GiB'"],
    ["LOAD", "LOAD httpfs"],
  ])("refuses a write however it is phrased: %s", async (_label, sql) => {
    await expect(runner.executeQuery(sql)).rejects.toThrow();
    expect((await runner.executeQuery("SELECT id FROM sample")).rows).toEqual([[1]]);
    // The refusal came from the engine, not from anything the writer noticed.
    const rows = await pool.withConn(async ({ conn }) =>
      (await conn.runAndReadAll("SELECT id FROM sample")).getRows(),
    );
    expect(rows).toEqual([[1]]);
  });

  it("refuses the filesystem and the configuration", async () => {
    const secret = join(directory, "secret.txt");
    await writeFile(secret, "never readable from SQL");
    await expect(runner.executeQuery(`SELECT content FROM read_text('${secret}')`)).rejects.toThrow(
      /read_text/,
    );
    await expect(runner.executeQuery(`SELECT * FROM glob('${directory}/*')`)).rejects.toThrow(
      /glob/,
    );
    await expect(
      runner.executeQuery(`ATTACH '${join(directory, "other.db")}' AS other`),
    ).rejects.toThrow();
    await expect(runner.executeQuery("SET enable_external_access=true")).rejects.toThrow();
    await expect(runner.executeQuery("SET memory_limit='64GiB'")).rejects.toThrow();
    await expect(runner.executeQuery("INSTALL spatial")).rejects.toThrow();
    // Only a SELECT is prepared, so COPY never reaches the engine — into the
    // spill directory the pool itself may write, or anywhere else.
    await expect(
      runner.executeQuery(`COPY sample TO '${join(directory, "analytics.db.tmp", "leak.csv")}'`),
    ).rejects.toThrow(/could not be parsed|single statement|single SELECT/);
    await expect(
      runner.executeQuery(
        `SELECT 1) AS __x; COPY (SELECT 1) TO '${join(directory, "analytics.db.tmp", "leak.csv")}'; SELECT * FROM (SELECT 2`,
      ),
    ).rejects.toThrow(/could not be parsed|single statement/);
    expect(existsSync(join(directory, "analytics.db.tmp", "leak.csv"))).toBe(false);
    // The store's own file is readable by DuckDB whatever the allow-list
    // says; the parser gate refuses the call so no second handle opens.
    await expect(
      runner.executeQuery(
        `SELECT octet_length(content) FROM read_blob('${join(directory, "analytics.db")}')`,
      ),
    ).rejects.toThrow(/read_blob/);
  });

  it("keeps the caller's row cap even when the query closes the wrapper's parenthesis", async () => {
    await pool.serializeWrite(() =>
      pool.withConn(async ({ conn }) => {
        await conn.run("INSERT INTO sample SELECT i FROM range(2, 200) r(i)");
      }),
    );
    await expect(
      runner.executeQuery("SELECT id FROM sample) AS __x; SELECT * FROM (SELECT 2", { limit: 5 }),
    ).rejects.toThrow(/could not be parsed|single statement/);
    expect((await runner.executeQuery("SELECT id FROM sample", { limit: 5 })).rowCount).toBe(5);
  });

  it("sees a table the writer creates after the runner was built", async () => {
    await pool.serializeWrite(() =>
      pool.withConn(async ({ conn }) => {
        await conn.run("CREATE TABLE later AS SELECT 7 AS id");
      }),
    );
    expect((await runner.executeQuery("SELECT id FROM later")).rows).toEqual([[7]]);
  });

  it.each(["abort", "timeout"] as const)(
    "interrupts a running query on %s and leaves the pool usable",
    async (mode) => {
      const controller = new AbortController();
      const query = runner
        .executeQuery("SELECT count(*) FROM range(100000000) a CROSS JOIN range(100000) b", {
          ...(mode === "abort" ? { signal: controller.signal } : { timeoutMs: 100 }),
        })
        .catch((error: unknown) => error);
      if (mode === "abort") {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        controller.abort();
      }
      expect(await query).toEqual(
        expect.objectContaining({
          message: mode === "abort" ? "SQL query was cancelled" : "SQL query timed out after 100ms",
        }),
      );
      await pool.serializeWrite(() =>
        pool.withConn(async ({ conn }) => {
          await conn.run("INSERT INTO sample VALUES (2)");
        }),
      );
      expect((await runner.executeQuery("SELECT id FROM sample ORDER BY id")).rows).toEqual([
        [1],
        [2],
      ]);
    },
  );

  it("keeps readers and writers flowing while sandboxed queries run", async () => {
    const started = [deferred(), deferred()];
    const release = deferred();
    const readers = started.map((entry) =>
      pool.withConn(async ({ conn }) => {
        entry.resolve();
        await release.promise;
        return (await conn.runAndReadAll("SELECT id FROM sample")).getRows();
      }),
    );
    try {
      await Promise.all(started.map((entry) => entry.promise));
      expect((await runner.executeQuery("SELECT id FROM sample")).rows).toEqual([[1]]);
    } finally {
      release.resolve();
    }
    expect(await Promise.all(readers)).toEqual([[[1]], [[1]]]);
    await Promise.all([
      (async () => {
        for (let i = 0; i < 30; i++) {
          await pool.serializeWrite(() =>
            pool.withConn(async ({ conn }) => {
              await conn.run(`INSERT INTO sample VALUES (${i + 10})`);
            }),
          );
        }
      })(),
      (async () => {
        for (let i = 0; i < 20; i++) {
          expect((await runner.executeQuery("SELECT min(id) FROM sample")).rows).toEqual([[1]]);
        }
      })(),
    ]);
    expect((await runner.executeQuery("SELECT count(*) FROM sample")).rows).toEqual([[31]]);
  });

  it("rejects a query once the pool is closed", async () => {
    await pool.close({ timeoutMs: 0 });
    await expect(runner.executeQuery("SELECT id FROM sample")).rejects.toThrow(
      "AnalyticsDb not open",
    );
  });
});
