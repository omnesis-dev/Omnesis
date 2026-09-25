// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The user-SQL sandbox as the `AnalyticsDb` façade exposes it. Each
// `executeQuery` is one prepared SELECT on a dedicated connection of the
// gateway's single DuckDB instance, inside a read-only transaction, with the
// instance's external access disabled and the statement's syntax tree vetted
// for file functions before it runs. Every vector below is refused by the
// engine or the parser gate, never by a keyword list.
import { unlinkSync, existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DuckDBConnection, DuckDBPreparedStatement } from "@duckdb/node-api";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { AnalyticsDb } from "./analytics-db.js";

let db: AnalyticsDb;
let path: string;

type DuckDBInstanceLike = { connect(): Promise<DuckDBConnection> };

beforeEach(async () => {
  path = `/tmp/omnesis-sandbox-${randomUUID()}.db`;
  db = new AnalyticsDb(path, { memoryLimitMiB: 768 });
  await db.open();
});

afterEach(async () => {
  await db.close({ timeoutMs: 0 });
  vi.restoreAllMocks();
  for (const suffix of ["", ".wal", "-wal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
  rmSync(`${path}.tmp`, { recursive: true, force: true });
});

describe("user-SQL sandbox", () => {
  test("SELECT works and sees writes from the writable instance", async () => {
    // ensureTable + insertRecords use the writable pool; executeQuery
    // uses the user-SQL conn. Same DuckDBInstance, so the user conn
    // sees the latest committed catalog state.
    await db.ensureTable(
      {
        tableName: "sandbox_test",
        displayName: "Sandbox Test",
        description: "Probe table for the sandbox suite",
        columns: [
          { name: "id", type: "INTEGER", nullable: false },
          { name: "label", type: "VARCHAR", nullable: true },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["label"], keyColumns: ["id", "label"] },
      },
      "test:sandbox",
    );
    await db.insertRecords(
      "sandbox_test",
      [
        { id: 1, label: "alpha" },
        { id: 2, label: "beta" },
      ],
      ["id"],
    );
    const out = await db.executeQuery("SELECT id, label FROM sandbox_test ORDER BY id");
    expect(out.rowCount).toBe(2);
    expect(out.columns).toEqual(["id", "label"]);
    expect(out.rows[0]).toEqual([1, "alpha"]);
  });

  test("writes are blocked by the read-only transaction (no keyword block-list)", async () => {
    await db.ensureTable(
      {
        tableName: "sandbox_w",
        displayName: "Sandbox Writes",
        description: "Write-rejection probe",
        columns: [{ name: "x", type: "INTEGER", nullable: false }],
        // Primary key required at the ensureTable boundary;
        // the sandbox test only needs *some* table to write against, so
        // the column itself acts as the PK.
        primaryKey: ["x"],
        semanticTimeColumn: null,
        record: { titleColumns: ["x"], keyColumns: ["x"] },
      },
      "test:sandbox",
    );

    const writeAttempts = [
      "INSERT INTO sandbox_w VALUES (1)",
      "DROP TABLE sandbox_w",
      "DELETE FROM sandbox_w",
      "UPDATE sandbox_w SET x = 99",
      "TRUNCATE sandbox_w",
      "ALTER TABLE sandbox_w ADD COLUMN y INTEGER",
      "CREATE TABLE evil (z INT)",
      "COPY sandbox_w TO '/tmp/exfil.csv'",
      // The cases the old block-list missed:
      "/* leading comment */ INSERT INTO sandbox_w VALUES (2)",
      "  -- leading line comment\nINSERT INTO sandbox_w VALUES (3)",
      "WITH cte AS (DELETE FROM sandbox_w RETURNING *) SELECT * FROM cte",
    ];
    for (const sql of writeAttempts) {
      await expect(db.executeQuery(sql), `write should be rejected: ${sql}`).rejects.toThrow();
    }
    // Confirm the table is still empty — none of the rejected writes
    // landed.
    const rs = await db.executeQuery("SELECT COUNT(*) AS n FROM sandbox_w");
    // DuckDB's BIGINT comes back via convertDuckDBValue as a number.
    expect(Number(rs.rows[0][0])).toBe(0);
  });

  test("file-system table-functions are blocked by enable_external_access=false", async () => {
    // Each of these is SELECT-shaped — the original keyword
    // block-list let them all through and trusted the SQLite scanner
    // to refuse. With external access off, DuckDB rejects them at
    // the catalog layer with "Permission Error: ... file system
    // operations are disabled by configuration".
    const externalAttempts = [
      "SELECT * FROM read_csv_auto('/etc/passwd')",
      "SELECT * FROM read_blob('/etc/hosts')",
      "SELECT * FROM read_text('/etc/passwd')",
      "ATTACH '/tmp/evil.db' AS evil",
      "INSTALL httpfs",
    ];
    for (const sql of externalAttempts) {
      await expect(
        db.executeQuery(sql),
        `external access should be rejected: ${sql}`,
      ).rejects.toThrow();
    }
  });

  test("returns columnTypes alongside rows", async () => {
    // Every consumer of /analytics/sql gets DuckDB's
    // declared type per column, so the portal can render numeric
    // columns right-aligned, dates as date pickers, etc.
    const out = await db.executeQuery(
      "SELECT 1 AS a, 'hello' AS b, CAST('2026-05-08' AS DATE) AS c",
    );
    expect(out.columns).toEqual(["a", "b", "c"]);
    expect(out.columnTypes).toHaveLength(3);
    expect(out.columnTypes[0]).toMatch(/INT/i);
    expect(out.columnTypes[1]).toMatch(/VARCHAR|STRING/i);
    expect(out.columnTypes[2]).toMatch(/DATE/i);
  });

  test("always applies the outer row cap despite LIMIT text inside the query", async () => {
    await db.ensureTable(
      {
        tableName: "sandbox_lim",
        displayName: "Sandbox Limit",
        description: "Limit-detection probe",
        columns: [
          { name: "id", type: "INTEGER", nullable: false },
          { name: "label", type: "VARCHAR", nullable: true },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["label"], keyColumns: ["id", "label"] },
      },
      "test:sandbox",
    );
    await db.insertRecords(
      "sandbox_lim",
      Array.from({ length: 100 }, (_, i) => ({ id: i, label: `row-${i}` })),
      ["id"],
    );

    // None of these occurrences proves that the outer result is bounded, so
    // each query must still receive the same non-bypassable outer cap.
    const bypassAttempts = [
      "SELECT id, 'LIMIT 999999' AS marker FROM sandbox_lim ORDER BY id",
      "SELECT id FROM sandbox_lim\n-- LIMIT 999999\nORDER BY id",
      "SELECT id FROM sandbox_lim ORDER BY id LIMIT 999999",
    ];
    for (const sql of bypassAttempts) {
      const out = await db.executeQuery(sql, { limit: 5 });
      expect(out.rowCount, sql).toBe(5);
    }
  });

  test("accepts one terminal semicolon but rejects multiple statements", async () => {
    const out = await db.executeQuery("SELECT 1 AS one;");
    expect(out.rows).toEqual([[1]]);

    await expect(db.executeQuery("SELECT 1 AS one; SELECT 2 AS two;")).rejects.toThrow();
  });

  test("rejects an excessive row cap instead of silently returning a partial result", async () => {
    await expect(
      db.executeQuery("SELECT range AS id FROM range(0, 20000)", {
        limit: 1_000_000,
      }),
    ).rejects.toThrow("SQL row limit must be an integer from 1 to 10000");
  });

  test("a failing user query leaves the next user query unaffected", async () => {
    // Each call opens its own READ_ONLY instance, so a poison from
    // one query can't leak into the next caller's state.
    await expect(db.executeQuery("DROP TABLE _analytics_catalog")).rejects.toThrow();
    const out = await db.executeQuery("SELECT 1 AS one");
    expect(out.rows[0][0]).toBe(1);
  });

  test("abort interrupts an executing DuckDB query and leaves the next query healthy", async () => {
    let markQueryStarted = (): void => undefined;
    const queryStarted = new Promise<void>((resolve) => {
      markQueryStarted = resolve;
    });
    // The user statement runs as a prepared statement; the only prepared
    // statement in this test is the probe, so its run is the query start.
    const originalRun = DuckDBPreparedStatement.prototype.runAndReadAll;
    vi.spyOn(DuckDBPreparedStatement.prototype, "runAndReadAll").mockImplementation(function (
      this: DuckDBPreparedStatement,
    ) {
      markQueryStarted();
      return originalRun.apply(this);
    });
    const originalInterrupt = DuckDBConnection.prototype.interrupt;
    let interruptCalls = 0;
    vi.spyOn(DuckDBConnection.prototype, "interrupt").mockImplementation(function (
      this: DuckDBConnection,
    ) {
      interruptCalls += 1;
      // Model an interrupt that reaches DuckDB while the submitted native job
      // is still queued. A later pulse must catch it once execution begins.
      if (interruptCalls > 1) originalInterrupt.call(this);
    });

    const controller = new AbortController();
    const query = db.executeQuery(
      "SELECT SUM(a.range * b.range) AS abort_probe " +
        "FROM range(0, 100000) AS a CROSS JOIN range(0, 100000) AS b",
      { signal: controller.signal },
    );
    await queryStarted;
    controller.abort();
    await expect(query).rejects.toThrow("SQL query was cancelled");
    expect(interruptCalls).toBeGreaterThan(1);

    const healthy = await db.executeQuery("SELECT 1 AS healthy");
    expect(healthy.rows).toEqual([[1]]);
  });

  test("abort keeps the query pending until a delayed sandbox connection is closed", async () => {
    const pool = (db as unknown as { pool: { getInstanceForTest?: unknown } }).pool as {
      isOpen: boolean;
    } & Record<string, unknown>;
    const instance = (pool as unknown as { instance: DuckDBInstanceLike }).instance;
    let resolveConnection = (_connection: DuckDBConnection): void => undefined;
    const delayedConnection = new Promise<DuckDBConnection>((resolve) => {
      resolveConnection = resolve;
    });
    const closeSync = vi.fn();
    const connectSpy = vi.spyOn(instance, "connect").mockReturnValueOnce(delayedConnection);
    const controller = new AbortController();
    let settled = false;
    const query = db
      .executeQuery("SELECT 1 AS delayed", { signal: controller.signal })
      .finally(() => {
        settled = true;
      });

    await vi.waitUntil(() => connectSpy.mock.calls.length === 1);
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveConnection({
      run: () => Promise.reject(new Error("connection is gone")),
      runAndReadAll: () => Promise.reject(new Error("connection is gone")),
      prepare: () => Promise.reject(new Error("connection is gone")),
      interrupt: () => undefined,
      closeSync,
    } as unknown as DuckDBConnection);
    await expect(query).rejects.toThrow();
    expect(closeSync).toHaveBeenCalledOnce();
  });

  test("does not miss an abort that lands while the listener is being registered", async () => {
    const controller = new AbortController();
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "addEventListener").mockImplementation(((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: unknown,
    ) => {
      // Reproduce the narrow check-then-register race: the signal fires
      // immediately before the real listener becomes attached.
      controller.abort();
      originalAdd(type, listener, options as AddEventListenerOptions);
    }) as AbortSignal["addEventListener"]);

    await expect(
      db.executeQuery("SELECT SUM(range) FROM range(0, 1000000)", {
        signal: controller.signal,
      }),
    ).rejects.toThrow("SQL query was cancelled");

    const healthy = await db.executeQuery("SELECT 1 AS healthy");
    expect(healthy.rows).toEqual([[1]]);
  });

  test("user SQL sees the instance's locked-down configuration", async () => {
    const out = await db.executeQuery(
      "SELECT current_setting('enable_external_access') AS external, " +
        "current_setting('lock_configuration') AS locked, " +
        "current_setting('memory_limit') AS memory_limit",
    );
    expect(out.rows[0][0]).toBe(false);
    expect(out.rows[0][1]).toBe(true);
    expect(String(out.rows[0][2])).toBe("768.0 MiB");
  });

  test("ingest commits succeed before, between, and after user-SQL queries (P0 regression)", async () => {
    // DuckDB treats writes to its own store (commit, WAL flush, checkpoint)
    // as filesystem access. The instance's lockdown must therefore still
    // allow the store's own files while user SQL runs beside the ingest
    // path; this test fails if the allow-list misses one of them.
    await db.ensureTable(
      {
        tableName: "ingest_probe",
        displayName: "Ingest probe",
        description: "Regression for #305-fallout",
        columns: [
          { name: "id", type: "INTEGER", nullable: false },
          { name: "label", type: "VARCHAR", nullable: true },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["label"], keyColumns: ["id", "label"] },
      },
      "test:sandbox",
    );
    // Initial ingest commits.
    expect(await db.insertRecords("ingest_probe", [{ id: 1, label: "before" }], ["id"])).toBe(1);
    // User SQL touches the DB on a separate per-query instance.
    const before = await db.executeQuery("SELECT COUNT(*) FROM ingest_probe");
    expect(Number(before.rows[0][0])).toBe(1);
    // Subsequent ingest still commits.
    expect(await db.insertRecords("ingest_probe", [{ id: 2, label: "after" }], ["id"])).toBe(1);
    const after = await db.executeQuery("SELECT COUNT(*) FROM ingest_probe");
    expect(Number(after.rows[0][0])).toBe(2);
  });

  test("user-SQL query and ingest can run in parallel (P0 regression)", async () => {
    // Confirms the writer pool isn't blocked by a long-running user
    // SQL query — they're separate DuckDB instances, so the writer
    // can commit while the reader is still pulling rows.
    await db.ensureTable(
      {
        tableName: "ingest_parallel",
        displayName: "Ingest parallel",
        description: "Regression for #305-fallout (parallelism)",
        columns: [
          { name: "id", type: "INTEGER", nullable: false },
          { name: "label", type: "VARCHAR", nullable: true },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["label"], keyColumns: ["id", "label"] },
      },
      "test:sandbox",
    );
    await db.insertRecords(
      "ingest_parallel",
      Array.from({ length: 200 }, (_, i) => ({ id: i, label: `row-${i}` })),
      ["id"],
    );
    const [queryOut, insertedCount] = await Promise.all([
      db.executeQuery("SELECT COUNT(*) FROM ingest_parallel CROSS JOIN range(0, 100)"),
      db.insertRecords("ingest_parallel", [{ id: 999, label: "during-query" }], ["id"]),
    ]);
    expect(insertedCount).toBe(1);
    expect(queryOut.rowCount).toBe(1);
    const final = await db.executeQuery("SELECT COUNT(*) FROM ingest_parallel");
    expect(Number(final.rows[0][0])).toBe(201);
  });
});
