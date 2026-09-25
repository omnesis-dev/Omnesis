// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AnalyticsConnectionPool,
  AnalyticsStoreOpenError,
  SandboxSqlRefusedError,
  isDuckDbInvalidated,
} from "./connection-pool.js";
import { AnalyticsCatalogStore } from "./catalog-store.js";
import { AnalyticsQueryRunner } from "./query-runner.js";

const duckdbPackageDir = dirname(
  createRequire(import.meta.url).resolve("@duckdb/node-api/package.json"),
);

function attachSql(path: string, keyHex: string | undefined, readonly: boolean): string {
  const options = [
    ...(readonly ? ["READ_ONLY"] : []),
    ...(keyHex ? [`ENCRYPTION_KEY '${keyHex}'`] : []),
  ];
  return `ATTACH '${path.replace(/'/g, "''")}' AS probe${options.length ? ` (${options.join(", ")})` : ""}`;
}

/**
 * What another process sees when it tries to open the store: DuckDB's own
 * verdict from a keyed read-only attach. Runs in a child so the attempt can
 * never touch this process's locks — that is the whole point.
 */
function otherProcessAttach(path: string, keyHex?: string): { opened: boolean; error: string } {
  const script = `
    const { DuckDBInstance } = require(${JSON.stringify(duckdbPackageDir)});
    (async () => {
      const inst = await DuckDBInstance.create(":memory:");
      const conn = await inst.connect();
      try {
        await conn.run(${JSON.stringify(attachSql(path, keyHex, true))});
        process.stdout.write(JSON.stringify({ opened: true, error: "" }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ opened: false, error: String(error.message) }));
      } finally {
        conn.closeSync();
        inst.closeSync();
      }
    })();
  `;
  return JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }));
}

/** A separate process holding the store open read-write until killed. */
async function otherProcessHolder(path: string, keyHex?: string): Promise<ChildProcess> {
  const script = `
    const { DuckDBInstance } = require(${JSON.stringify(duckdbPackageDir)});
    (async () => {
      const inst = await DuckDBInstance.create(":memory:");
      const conn = await inst.connect();
      ${
        keyHex
          ? // As the pool does: load httpfs, installing it first on a host that lacks it.
            'try { await conn.run("LOAD httpfs"); } catch { await conn.run("INSTALL httpfs"); await conn.run("LOAD httpfs"); }'
          : ""
      }
      await conn.run(${JSON.stringify(attachSql(path, keyHex, false))});
      process.stdout.write("held");
      setInterval(() => {}, 1000);
    })().catch((error) => { process.stderr.write(String(error.message)); process.exit(1); });
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("exit", (code) => reject(new Error(`holder exited with ${code}`)));
  });
  return child;
}

async function endHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

describe.each([false, true])("AnalyticsConnectionPool (encrypted=%s)", (encrypted) => {
  let directory: string;
  let dbPath: string;
  let keyHex: string | undefined;
  let pool: AnalyticsConnectionPool | null;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-test-pool-"));
    dbPath = join(directory, "analytics.db");
    keyHex = encrypted ? randomBytes(32).toString("hex") : undefined;
    pool = null;
  });

  afterEach(async () => {
    await pool?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps its exclusive file lock across user SQL, backups and checkpoints", async () => {
    pool = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
    await pool.open(async (conn) => {
      await conn.run("CREATE TABLE sample AS SELECT 1 AS id");
    });
    const runner = new AnalyticsQueryRunner(pool, new AnalyticsCatalogStore(pool));
    const refused = () => {
      const probe = otherProcessAttach(dbPath, keyHex);
      expect(probe.opened).toBe(false);
      expect(probe.error).toMatch(/conflicting lock is held/i);
    };

    refused();
    expect((await runner.executeQuery("SELECT id FROM sample")).rows).toEqual([[1]]);
    refused();
    // DuckDB lets a query read an attached database's own file whatever the
    // allow-list says; reading it would open a second handle and drop the
    // lock, so the sandbox refuses the call before anything runs.
    await expect(
      runner.executeQuery(`SELECT octet_length(content) FROM read_blob('${dbPath}')`),
    ).rejects.toBeInstanceOf(SandboxSqlRefusedError);
    await expect(
      runner.executeQuery(`SELECT read_text('${dbPath}.wal') AS wal`),
    ).rejects.toBeInstanceOf(SandboxSqlRefusedError);
    refused();
    await pool.serializeWrite(() =>
      pool!.withConn(async ({ conn }) => {
        await conn.run("INSERT INTO sample VALUES (2)");
        await conn.run("CHECKPOINT");
      }),
    );
    refused();
    await mkdir(join(directory, "backups"));
    await pool.backupTo(join(directory, "backups", "copy.db"));
    refused();
    for (let i = 0; i < 5; i++) await runner.executeQuery("SELECT count(*) FROM sample");
    refused();

    await pool.close();
    pool = null;
    expect(otherProcessAttach(dbPath, keyHex).opened).toBe(true);
  });

  it("resolves extensions beside the store, never in $HOME", async () => {
    // The service unit mounts the home directory read-only, so DuckDB's default
    // extension directory (~/.duckdb) cannot be created: `INSTALL httpfs` then
    // fails and an encrypted store makes the gateway exit on every start. Seen
    // on Fedora 42, where $HOME had no .duckdb yet.
    pool = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
    await pool.open();
    const [[configured]] = await pool.withConn(async ({ conn }) =>
      (await conn.runAndReadAll("SELECT current_setting('extension_directory')")).getRows(),
    );
    expect(String(configured)).toBe(`${dbPath}.extensions`);
    expect(String(configured).startsWith(homedir())).toBe(false);
    expect(existsSync(String(configured))).toBe(true);
    // Not inside the spill directory, which is wiped on open and removed on
    // close — an extension has to outlive the instance.
    expect(String(configured).startsWith(`${dbPath}.tmp`)).toBe(false);
  });

  it("applies the resource ceilings it was given and owns a spill directory only while open", async () => {
    pool = new AnalyticsConnectionPool(dbPath, {
      encryptionKeyHex: keyHex,
      memoryLimitMiB: 512,
      threads: 2,
    });
    await pool.open();
    const settings = await pool.withConn(async ({ conn }) =>
      (
        await conn.runAndReadAll(
          "SELECT current_setting('memory_limit'), current_setting('threads'), current_setting('temp_directory'), current_setting('enable_external_access')",
        )
      ).getRows(),
    );
    expect(settings[0]![0]).toBe("512.0 MiB");
    expect(Number(settings[0]![1])).toBe(2);
    expect(String(settings[0]![2]).replace(/\/$/, "")).toBe(`${dbPath}.tmp`);
    expect(settings[0]![3]).toBe(false);
    expect(existsSync(`${dbPath}.tmp`)).toBe(true);
    await pool.close();
    pool = null;
    expect(existsSync(`${dbPath}.tmp`)).toBe(false);
  });

  it("runs sandbox statements inside a read-only transaction on a dedicated connection", async () => {
    pool = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
    await pool.open(async (conn) => {
      await conn.run("CREATE TABLE sample AS SELECT 1 AS id");
    });
    // Only a SELECT reaches the caller; everything else is refused at prepare.
    for (const sql of [
      "INSERT INTO sample VALUES (2)",
      "CREATE TABLE smuggled(i INT)",
      "SET enable_external_access=true",
      "SELECT 1; SELECT 2",
      "COPY sample TO '/dev/null'",
      "CHECKPOINT",
    ]) {
      await expect(pool.withSandboxStatement(sql, async () => "ran")).rejects.toBeInstanceOf(
        SandboxSqlRefusedError,
      );
    }
    // A SELECT that runs cannot be turned into a write on its connection.
    await pool.withSandboxStatement("SELECT id FROM sample", async ({ conn }) => {
      await expect(conn.run("INSERT INTO sample VALUES (2)")).rejects.toThrow(/read-only/i);
    });
    // The writer's own connections are untouched by the sandbox's transaction.
    await pool.serializeWrite(() =>
      pool!.withConn(async ({ conn }) => {
        await conn.run("INSERT INTO sample VALUES (2)");
      }),
    );
    const rows = await pool.withSandboxStatement(
      "SELECT id FROM sample ORDER BY id",
      async ({ statement }) => (await statement.runAndReadAll()).getRows(),
    );
    expect(rows).toEqual([[1], [2]]);
  });

  it("refuses functions that read files, run SQL from text or operate the engine", async () => {
    pool = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
    await pool.open();
    const refusals: Record<string, RegExp> = {
      "SELECT * FROM read_csv('/etc/hosts')": /read_csv/,
      "SELECT * FROM glob('/*')": /glob/,
      "SELECT * FROM query('SELECT 1')": /query/,
      "SELECT * FROM query_table('sample')": /query_table/,
      "SELECT * FROM checkpoint()": /checkpoint/,
      "SELECT * FROM (SELECT * FROM parquet_metadata('x.parquet'))": /parquet_metadata/,
      "WITH x AS (SELECT * FROM read_json_auto('x.json')) SELECT * FROM x": /read_json_auto/,
      "SELECT * FROM sqlite_scan('x.db', 't')": /sqlite_scan/,
      "SELECT READ_TEXT('/etc/hosts')": /read_text/,
    };
    for (const [sql, pattern] of Object.entries(refusals)) {
      const failure = await pool
        .withSandboxStatement(sql, async () => "ran")
        .catch((e: unknown) => e);
      expect(failure, sql).toBeInstanceOf(SandboxSqlRefusedError);
      expect((failure as Error).message, sql).toMatch(pattern);
    }
    // Ordinary introspection and generators stay available.
    const rows = await pool.withSandboxStatement(
      "SELECT count(*) FROM range(3) r, unnest([1,2]) u, duckdb_tables() t, json_each('[1]') j, generate_series(1, 2) g",
      async ({ statement }) => (await statement.runAndReadAll()).getRows(),
    );
    expect(rows).toEqual([[0n]]);
  });

  it("stages backups and exports inside its spill directory and moves them out", async () => {
    pool = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
    await pool.open(async (conn) => {
      await conn.run("CREATE TABLE sample AS SELECT 1 AS id");
    });
    const backup = join(directory, "backups", "nested", "copy.db");
    await pool.backupTo(backup);
    expect(existsSync(backup)).toBe(true);
    const exportsDir = join(directory, "exports", "run-1");
    expect(await pool.exportTablesToCsv(exportsDir)).toEqual(["sample"]);
    expect(await readFile(join(exportsDir, "sample.csv"), "utf8")).toBe("id\n1\n");
    // Nothing is left behind in the staging area, and neither destination is
    // reachable from a sandboxed query.
    expect(readdirSync(join(`${dbPath}.tmp`, "stage"))).toEqual([]);
    await expect(
      pool.withSandboxStatement(`SELECT * FROM read_blob('${backup}')`, async () => "ran"),
    ).rejects.toBeInstanceOf(SandboxSqlRefusedError);
  });

  it("leaves the holder's spill directory alone when its own open is refused", async () => {
    const seed = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
    await seed.open();
    await seed.close();
    // Stand in for the live owner's scratch: a spill file it is still using.
    await mkdir(join(`${dbPath}.tmp`, "stage"), { recursive: true });
    await writeFile(join(`${dbPath}.tmp`, "spill-in-use"), "the holder's working set");

    const holder = await otherProcessHolder(dbPath, keyHex);
    const refused = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
    try {
      await expect(refused.open()).rejects.toBeInstanceOf(AnalyticsStoreOpenError);
      expect(existsSync(join(`${dbPath}.tmp`, "spill-in-use"))).toBe(true);
      // Closing a pool that never owned the store must not tidy up after the
      // process that does.
      await refused.close();
      expect(existsSync(join(`${dbPath}.tmp`, "spill-in-use"))).toBe(true);
    } finally {
      await endHolder(holder);
    }

    // The next pool that actually takes the store clears what the last life left.
    pool = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
    await pool.open();
    expect(existsSync(join(`${dbPath}.tmp`, "spill-in-use"))).toBe(false);
    expect(existsSync(join(`${dbPath}.tmp`, "stage"))).toBe(true);
  });

  it("names the process holding the store when it cannot open it", async () => {
    const seed = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
    await seed.open();
    await seed.close();
    const holder = await otherProcessHolder(dbPath, keyHex);
    try {
      const failure = await new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex })
        .open()
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AnalyticsStoreOpenError);
      const message = (failure as Error).message;
      expect(message).toMatch(/Another process holds the store/);
      expect(message).toContain(`PID ${holder.pid}`);
      expect(message).toMatch(/Keep the file/);
      if (keyHex) expect(message).not.toContain(keyHex);
    } finally {
      await endHolder(holder);
    }
  });

  it.skipIf(!encrypted)(
    "reports a damaged store as damaged, with DuckDB's words, never as a fresh install",
    async () => {
      pool = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
      await pool.open(async (conn) => {
        await conn.run("CREATE TABLE sample AS SELECT i FROM range(20000) r(i)");
        await conn.run("CHECKPOINT");
      });
      await pool.close();
      pool = null;

      const bytes = Buffer.from(await readFile(dbPath));
      bytes[4096 + 100] ^= 0xff;
      await writeFile(dbPath, bytes);

      const reopened = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
      const failure = await reopened.open().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AnalyticsStoreOpenError);
      const message = (failure as Error).message;
      expect(message).toMatch(/damaged/);
      expect(message).toMatch(/Open: .*AES tag/);
      expect(message).not.toContain(keyHex);
      expect(message).toMatch(/Keep the file/);
      await reopened.close();
      expect(existsSync(dbPath)).toBe(true);
    },
  );

  it.skipIf(!encrypted)(
    "puts an interrupted encryption migration back before opening",
    async () => {
      const plaintext = new AnalyticsConnectionPool(dbPath);
      await plaintext.open(async (conn) => {
        await conn.run("CREATE TABLE sample AS SELECT 42 AS id");
      });
      await plaintext.close();
      // The migration's first rename happened; the process died before the
      // second. Nothing sits at the store's path. An older leftover from an
      // earlier attempt and a half-written encrypted copy sit beside it.
      await rename(dbPath, `${dbPath}.plaintext-newest`);
      await writeFile(`${dbPath}.plaintext-older`, "stale");
      const earlier = new Date(Date.now() - 60_000);
      await utimes(`${dbPath}.plaintext-older`, earlier, earlier);
      await writeFile(`${dbPath}.encrypted-partial.tmp`, "half");

      pool = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
      await pool.open();
      const rows = await pool.withConn(async ({ conn }) =>
        (await conn.runAndReadAll("SELECT id FROM sample")).getRows(),
      );
      expect(rows).toEqual([[42]]);
      for (const leftover of ["plaintext-newest", "plaintext-older", "encrypted-partial.tmp"]) {
        expect(existsSync(`${dbPath}.${leftover}`), leftover).toBe(false);
      }
      await pool.close();
      pool = null;
      await expect(DuckDBInstance.create(dbPath, { access_mode: "READ_ONLY" })).rejects.toThrow();
    },
  );

  it.skipIf(!encrypted)("removes a plaintext copy a completed migration left behind", async () => {
    pool = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
    await pool.open(async (conn) => {
      await conn.run("CREATE TABLE sample AS SELECT 7 AS id");
    });
    await pool.close();
    pool = null;
    // The encrypted store is in place; the process died before deleting the
    // renamed original.
    await writeFile(`${dbPath}.plaintext-done`, "the corpus, in the clear");

    pool = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
    await pool.open();
    expect(existsSync(`${dbPath}.plaintext-done`)).toBe(false);
    const rows = await pool.withConn(async ({ conn }) =>
      (await conn.runAndReadAll("SELECT id FROM sample")).getRows(),
    );
    expect(rows).toEqual([[7]]);
  });

  it("reports DuckDB's invalidation once, through onFatal, from either entry point", async () => {
    const fatal: Error[] = [];
    pool = new AnalyticsConnectionPool(dbPath, {
      encryptionKeyHex: keyHex,
      onFatal: (error) => fatal.push(error),
    });
    await pool.open();
    const invalidated = new Error(
      "FATAL Error: Failed: database has been invalidated because of a previous fatal error. The database must be restarted prior to being used again.",
    );
    await expect(
      pool.withSandboxStatement("SELECT 1", () => Promise.reject(invalidated)),
    ).rejects.toBe(invalidated);
    await expect(pool.withConn(() => Promise.reject(invalidated))).rejects.toBe(invalidated);
    await expect(pool.withConn(() => Promise.reject(new Error("ordinary")))).rejects.toThrow(
      "ordinary",
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(fatal).toEqual([invalidated]);
    expect(isDuckDbInvalidated(invalidated)).toBe(true);
    expect(isDuckDbInvalidated(new Error("Conflicting lock is held"))).toBe(false);
  });

  it("interrupts a sandbox statement that outlives close", async () => {
    pool = new AnalyticsConnectionPool(dbPath, { encryptionKeyHex: keyHex });
    await pool.open();
    const longQuery = pool
      .withSandboxStatement(
        "SELECT count(*) FROM range(100000000) a CROSS JOIN range(100000) b",
        async ({ statement }) => (await statement.runAndReadAll()).getRows(),
      )
      .catch((error: unknown) => error);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await pool.close({ timeoutMs: 0 });
    pool = null;
    expect(await longQuery).toBeInstanceOf(Error);
    expect(otherProcessAttach(dbPath, keyHex).opened).toBe(true);
  });
});
