// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `AnalyticsConnectionPool` — the one DuckDB instance the gateway holds on
 * the analytics store, its connection pool and its write queue. Every public
 * analytics op funnels through `withConn` (read path), `serializeWrite`
 * (write path) or `withSandboxStatement` (user SQL) so a thrown error never
 * leaks a connection and two writes never race. The public façade lives in
 * `analytics-db.ts`.
 *
 * ── One instance, one file handle ──────────────────────────────────────
 * Once the instance is open, nothing else in the process opens the store's
 * file — not for user SQL, not for a backup, not for a probe (the migration
 * probes below run before the instance exists and close before it opens).
 * That is a correctness rule, not a performance one. DuckDB guards its
 * database file with a POSIX record lock (`fcntl`), and those locks belong to
 * the *process*, not to the handle that took them: the moment any other
 * handle to the same file is closed anywhere in the process, the kernel
 * releases every lock the process holds on that file. A second in-process
 * open therefore silently strips the writer of its exclusive lock while it
 * keeps writing, and from then on any other process — a duplicate gateway, a
 * previous gateway still shutting down, a stray tool — can open the same file
 * read-write. Two writers on one DuckDB file checkpoint over each other's
 * blocks; the result ranges from lost rows to a store that no longer opens
 * with its own key.
 *
 * User SQL is sandboxed *inside* this instance instead. The instance boots
 * with DuckDB's external access disabled and an allow-list naming only the
 * store's own files and its spill directory; every user query is one
 * prepared SELECT on a dedicated connection inside a read-only transaction;
 * and because DuckDB always lets a query read an attached database's own
 * file — which would open that second handle — the query's syntax tree is
 * vetted first and any function that touches the filesystem is refused. See
 * `withSandboxStatement`.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { availableParallelism, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  DuckDBInstance,
  StatementType,
  type DuckDBConnection,
  type DuckDBPreparedStatement,
} from "@duckdb/node-api";
import { createLogger } from "@omnesis/core";
import { ANALYTICS_INTERNAL_TABLES, escapeStr } from "./internal.js";
import type { MetricsRegistry } from "../metrics.js";
import type { PooledConn } from "./internal.js";

const log = createLogger("gateway:analytics");

const DEFAULT_POOL_SIZE = 4;
const ANALYTICS_ATTACHED_DB = "omnesis_analytics";

const MIB = 1024 * 1024;
/**
 * DuckDB's own defaults are 80% of physical memory and every core. User SQL
 * shares this instance's budget, so the ceilings are what bound a runaway
 * query — DuckDB spills to the store's temp directory beyond the memory
 * limit rather than growing, and the thread cap leaves cores for the SQLite
 * writer, the indexer and request handling.
 */
const MIN_MEMORY_LIMIT_MIB = 512;
const MAX_DEFAULT_MEMORY_LIMIT_MIB = 4096;
const MIN_THREADS = 2;
const MAX_DEFAULT_THREADS = 8;

/**
 * Table functions a user query may call. Everything else DuckDB compiles in
 * either reads or writes files (`read_*`, `glob`, `parquet_*`, `arrow_scan`,
 * `sniff_csv`), runs SQL from a string (`query`, `query_table`,
 * `json_execute_serialized_sql`), or operates the engine (`checkpoint`,
 * `force_checkpoint`, logging and profiling switches). Extensions cannot be
 * loaded on the locked instance, so this inventory is closed.
 */
const SANDBOX_TABLE_FUNCTIONS = new Set([
  "range",
  "generate_series",
  "unnest",
  "repeat",
  "repeat_row",
  "json_each",
  "json_tree",
  "summary",
  "pragma_table_info",
  "pragma_storage_info",
  "pragma_metadata_info",
  "pragma_database_size",
  "pragma_version",
  "pragma_platform",
  "pragma_collations",
  "pg_timezone_names",
  "icu_calendar_names",
  "duckdb_columns",
  "duckdb_constraints",
  "duckdb_databases",
  "duckdb_dependencies",
  "duckdb_functions",
  "duckdb_indexes",
  "duckdb_keywords",
  "duckdb_schemas",
  "duckdb_sequences",
  "duckdb_settings",
  "duckdb_table_sample",
  "duckdb_tables",
  "duckdb_types",
  "duckdb_views",
]);
/** Scalar functions that open a file: the table readers also exist in scalar form. */
const SANDBOX_DENIED_SCALAR_FUNCTIONS = /^(read_|parquet_|arrow_|glob$|sniff_csv$)/;

export interface AnalyticsConnectionPoolOptions {
  maxPoolSize?: number;
  metrics?: MetricsRegistry;
  encryptionKeyHex?: string;
  /** Instance-wide memory ceiling. Defaults to a quarter of physical memory, clamped to 512 MiB–4 GiB. */
  memoryLimitMiB?: number;
  /** Instance-wide worker threads. Defaults to half the cores, clamped to 2–8. */
  threads?: number;
  /**
   * Called once if DuckDB reports the database invalidated by a fatal error.
   * Nothing on this instance works again after that, so the gateway exits
   * and lets its supervisor reopen the store from the WAL.
   */
  onFatal?: (error: Error) => void;
}

export interface AnalyticsSandbox {
  conn: DuckDBConnection;
  /** The vetted, prepared SELECT; bind parameters on it, then run it. */
  statement: DuckDBPreparedStatement;
  /**
   * The statement's `json_serialize_sql` parse tree, already vetted above.
   * Carried so a caller can answer engine-parsed questions (which base
   * tables a source-restricted grant would read) without re-parsing.
   */
  parseTree: unknown;
}

/** A user query the sandbox refuses before executing anything. */
export class SandboxSqlRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxSqlRefusedError";
  }
}

export class AnalyticsConnectionPool {
  private instance: DuckDBInstance | null = null;

  // ── Connection pool ──────────────────────────────────────────────
  // A single DuckDBConnection serializes every analytics op (a 12 s
  // ingest blocked the next /analytics/catalog poll for 12 s). Pool
  // up to N connections so reads/writes can fan out — DuckDB's
  // MVCC handles cross-conn isolation, schema CREATE/ALTER serialize
  // through the catalog lock as expected.
  private pool: PooledConn[] = []; // idle conns
  private created = 0; // total ever created (cap = maxPoolSize)
  private waiters: Array<(p: PooledConn) => void> = [];
  private readonly maxPoolSize: number;

  // ── Sandbox connections ──────────────────────────────────────────
  // User SQL never takes a pool slot: each query gets its own connection,
  // tracked here so `close()` can interrupt it, and admitted through a
  // semaphore of the pool's size so user SQL cannot fan out without bound
  // on the shared instance.
  private readonly sandboxConns = new Set<DuckDBConnection>();
  private sandboxActive = 0;
  private sandboxWaiters: Array<() => void> = [];

  // ── Write serialization ──────────────────────────────────────────
  // All structural writes (CREATE/ALTER/INSERT/UPDATE/DELETE) chain
  // through a single Promise so DuckDB never sees two overlapping
  // write transactions on this database.
  //
  // **Why this is necessary even though writes are individually
  // cheap (10–100ms):** DuckDB uses MVCC with optimistic concurrency
  // control on writes; two write transactions that overlap in time
  // can both abort at commit with "TransactionContext Error:
  // conflict on update" *or* surface as "Constraint Error: Duplicate
  // key violates primary key constraint" — even when neither would
  // fail in isolation. We saw this during iOS apple-health
  // re-bootstrap floods, where /analytics/ingest POSTs each took a
  // separate pool conn and the resulting parallel transactions
  // raced on `_analytics_catalog` (touched by `ensureTable` +
  // `updateCatalogStats` + `updateCatalogSourceId` per request)
  // and on data-table primary keys.
  //
  // **Performance note for future investigators debugging analytics
  // ingest latency or throughput:** the connection pool (size N) is
  // still here for *reads* — search queries, catalog GETs, and the
  // SQL endpoint all still fan out. Only writes serialize. A
  // per-data-table queue is tempting but does NOT help: every
  // ingest also writes `_analytics_catalog`, so per-data-table
  // queues would still race on the catalog table. If you eventually
  // need higher write throughput, the right move is a hybrid
  // (per-data-table queue PLUS a separate catalog queue), not
  // per-table alone.
  private writeQueue: Promise<void> = Promise.resolve();

  private closed = false;
  private ownsTempDirectory = false;
  private fatalReported = false;
  private readonly metrics?: MetricsRegistry;
  readonly encryptionKeyHex?: string;
  private readonly memoryLimitMiB: number;
  private readonly threads: number;
  private readonly onFatal?: (error: Error) => void;

  constructor(
    public readonly dbPath: string,
    opts?: AnalyticsConnectionPoolOptions,
  ) {
    this.maxPoolSize = Math.max(1, opts?.maxPoolSize ?? DEFAULT_POOL_SIZE);
    this.metrics = opts?.metrics;
    this.encryptionKeyHex = opts?.encryptionKeyHex;
    this.memoryLimitMiB = opts?.memoryLimitMiB ?? defaultMemoryLimitMiB();
    this.threads = opts?.threads ?? defaultThreads();
    this.onFatal = opts?.onFatal;
  }

  /**
   * Where DuckDB spills, a sibling of the store like a file-backed
   * instance's own default, and where backups and exports are staged before
   * they move to their destination. Wiped on open and removed on close:
   * nothing in it outlives the instance.
   */
  private get tempDirectory(): string {
    return `${this.dbPath}.tmp`;
  }

  /**
   * Where DuckDB resolves the extensions this instance loads. Beside the store,
   * deliberately not in $HOME: the service unit mounts the home directory
   * read-only, so DuckDB's default (~/.duckdb) cannot be created, `INSTALL
   * httpfs` fails, and an encrypted store makes the gateway exit on every start.
   * Not under tempDirectory either — that is wiped on open and removed on
   * close, and an extension has to outlive the instance or every start goes
   * back to the network for it.
   */
  private get extensionDirectory(): string {
    return `${this.dbPath}.extensions`;
  }

  private get stagingDirectory(): string {
    return join(this.tempDirectory, "stage");
  }

  /**
   * Open the store and run the caller-supplied one-shot init under a
   * single pool conn (the catalog table setup is the only init the
   * analytics façade currently needs).
   *
   * Boot order matters and is pinned here:
   *   1. Point DuckDB at an extension directory beside the store, then load the
   *      extensions the instance needs (`httpfs` carries the read-write
   *      encryption module). Loading is filesystem access, so it has to happen
   *      before that access is disabled — and the default directory is in
   *      $HOME, which the service unit mounts read-only.
   *   2. Declare the paths the instance may touch — the store, its WAL and
   *      checkpoint sidecar, and its spill directory.
   *   3. Disable external access and lock the configuration. From here on no
   *      connection, the user-SQL sandbox included, can widen the allow-list,
   *      re-enable file access or change a resource limit.
   *   4. Attach the store — the point at which this process holds the store's
   *      OS lock, and only then take over the spill directory. Emptying it
   *      any earlier would let a process that is about to be refused destroy
   *      the scratch space of the one that actually owns the store.
   */
  async open(init?: (conn: DuckDBConnection) => Promise<void>): Promise<void> {
    recoverInterruptedPlaintextMigration(this.dbPath);
    if (this.encryptionKeyHex) {
      await migratePlaintextDuckDbIfNeeded(this.dbPath, this.encryptionKeyHex);
    }
    const instance = await DuckDBInstance.create(":memory:");
    const bootstrap = await instance.connect();
    try {
      // Before any LOAD or INSTALL: DuckDB resolves extensions against this
      // directory, and its default sits in $HOME, which the service unit mounts
      // read-only.
      mkdirSync(this.extensionDirectory, { recursive: true });
      await bootstrap.run(`SET extension_directory='${escapeStr(this.extensionDirectory)}'`);
      if (this.encryptionKeyHex) await loadEncryptionModule(bootstrap);
      await bootstrap.run(`SET memory_limit='${this.memoryLimitMiB}MiB'`);
      await bootstrap.run(`SET threads=${this.threads}`);
      // A path only — DuckDB creates it when it first spills, so nothing on
      // disk is touched until the attach below succeeds.
      await bootstrap.run(`SET temp_directory='${escapeStr(this.tempDirectory)}'`);
      await bootstrap.run(`SET allowed_paths=${sqlStringList(storeFiles(this.dbPath))}`);
      await bootstrap.run(`SET allowed_directories=${sqlStringList([this.tempDirectory])}`);
      await bootstrap.run("SET enable_external_access=false");
      await bootstrap.run("SET lock_configuration=true");
      try {
        await bootstrap.run(attachSql(this.dbPath, ANALYTICS_ATTACHED_DB, this.encryptionKeyHex));
      } catch (error) {
        throw new AnalyticsStoreOpenError(
          this.dbPath,
          redactKey(describeError(error), this.encryptionKeyHex),
        );
      }
      await bootstrap.run(`USE ${ANALYTICS_ATTACHED_DB}`);
    } catch (error) {
      try {
        bootstrap.closeSync();
      } catch {
        /* ignore */
      }
      try {
        instance.closeSync();
      } catch {
        /* ignore */
      }
      throw error;
    }
    try {
      bootstrap.closeSync();
    } catch {
      /* ignore */
    }
    // The store is ours, so its spill directory is too: whatever a previous
    // life of this store left there is stale.
    rmSync(this.tempDirectory, { recursive: true, force: true });
    mkdirSync(this.stagingDirectory, { recursive: true, mode: 0o700 });
    this.ownsTempDirectory = true;
    this.instance = instance;

    if (init) {
      await this.withConn(async (p) => init(p.conn));
    }

    log.info(
      `Analytics DB opened: ${this.dbPath} (pool max=${this.maxPoolSize}, memory_limit=${this.memoryLimitMiB}MiB, threads=${this.threads}, encryption=${this.encryptionKeyHex ? "on" : "off"})`,
    );
  }

  /**
   * Async close — drains in-flight writes before tearing down the
   * pool. Order:
   *
   *   1. Set `closed=true` so new acquireConn calls reject.
   *   2. Reject every queued acquireConn and sandbox waiter explicitly.
   *   3. Await the writeQueue tail so the last serializeWrite finishes.
   *   4. Interrupt and close every sandbox conn, close every pool conn,
   *      close the instance, remove the spill directory.
   *
   * Without (3), a Ctrl-C during analytics ingest could `closeSync`
   * a conn while a transaction was still mid-flight, dropping the
   * batch and leaking the conn. The gateway shutdown path
   * (`index.ts`) awaits this before closing the SQLite handles.
   *
   * Wallclock cap: the drain phase is capped at `timeoutMs`
   * (default 5_000ms) so a wedged DuckDB call — e.g. a runaway
   * cross-join with no row limit — can't park shutdown forever. Once
   * the cap wins we proceed to closeSync, which blocks until DuckDB
   * releases the conn (also bounded but out of our hands). Tests
   * that intentionally fire long queries pass `timeoutMs: 0` to skip
   * the drain.
   */
  async close(opts?: { timeoutMs?: number }): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const timeoutMs = opts?.timeoutMs ?? 5_000;

    // Reject pending acquireConn waiters with a real error rather
    // than handing them a null conn.
    for (const w of this.waiters) {
      try {
        // The waiter callback ignores its argument now that `closed`
        // is set — every consumer reads it from inside `withConn`,
        // which checks `this.closed` first.
        w({ conn: null as unknown as DuckDBConnection });
      } catch {
        /* ignore */
      }
    }
    this.waiters.length = 0;
    for (const wake of this.sandboxWaiters.splice(0)) wake();

    if (timeoutMs > 0) {
      const drain = (async () => {
        try {
          await this.writeQueue;
        } catch {
          /* settled */
        }
      })();
      const cap = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        t.unref?.();
      });
      await Promise.race([drain, cap]);
    }

    // DuckDB's interrupt is edge-triggered and closing a connection blocks
    // until its statement settles, so keep pulsing until each sandbox
    // statement has unwound through its own `finally` (bounded).
    const interruptDeadline = Date.now() + Math.max(timeoutMs, 1_000);
    while (this.sandboxConns.size > 0 && Date.now() < interruptDeadline) {
      for (const conn of this.sandboxConns) {
        try {
          conn.interrupt();
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    for (const conn of this.sandboxConns) {
      try {
        conn.closeSync();
      } catch {
        /* ignore */
      }
    }
    this.sandboxConns.clear();
    for (const p of this.pool) {
      try {
        p.conn.closeSync();
      } catch {
        /* ignore */
      }
    }
    this.pool.length = 0;
    this.created = 0;
    if (this.instance) {
      try {
        this.instance.closeSync();
      } catch {
        /* ignore */
      }
      this.instance = null;
    }
    // Only the pool that took the store may remove its scratch: a pool whose
    // open was refused never owned it, and the live holder still needs it.
    if (this.ownsTempDirectory) {
      rmSync(this.tempDirectory, { recursive: true, force: true });
      this.ownsTempDirectory = false;
    }
  }

  /** True once `close()` has fully run. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** True between a successful `open()` and `close()`. */
  get isOpen(): boolean {
    return this.instance !== null && !this.closed;
  }

  /**
   * Chain a write through the global write queue. See `writeQueue`
   * comment above for the rationale and the perf trade-offs to
   * weigh before changing this.
   *
   * When a `MetricsRegistry` is attached, records (waitMs, durationMs)
   * for the snapshot's `analyticsWrites` summary so contention vs.
   * actual write time is visible.
   */
  serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const enqueueAt = Date.now();
    const next = this.writeQueue.then(async () => {
      const startAt = Date.now();
      try {
        return await fn();
      } finally {
        this.metrics?.recordAnalyticsWrite(startAt - enqueueAt, Date.now() - startAt);
      }
    });
    // Swallow rejections in the tail-of-queue so one failed write
    // doesn't poison every subsequent write. The rejection still
    // propagates to the original caller via `next`.
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Online copy of this DuckDB database into a fresh file at `destPath`.
   *Must run through the live instance: DuckDB allows a single
   * read-write process per file, so a separate instance (or process)
   * cannot even open the database for a backup while the gateway holds
   * it. `ATTACH` + `COPY FROM DATABASE` + `DETACH` produces a complete,
   * checkpointed copy; serializing through the write queue guarantees no
   * write transaction overlaps the copy. The copy is written inside the
   * store's own spill directory — the only place the instance may write —
   * and moved to `destPath` afterwards, so no other directory is ever
   * reachable from this instance.
   */
  async backupTo(destPath: string): Promise<void> {
    return this.serializeWrite(() =>
      this.withConn(async (p) => {
        const staged = join(this.stagingDirectory, `${randomUUID()}.db`);
        await p.conn.run(attachSql(staged, "_omnesis_backup", this.encryptionKeyHex));
        try {
          await p.conn.run(`COPY FROM DATABASE ${ANALYTICS_ATTACHED_DB} TO _omnesis_backup`);
        } finally {
          // DETACH checkpoints the copy so the data lands in the file
          // rather than its WAL. Best-effort: a failed COPY still needs
          // the attach released.
          try {
            await p.conn.run("DETACH _omnesis_backup");
          } catch {
            /* attach may not have survived the failure */
          }
        }
        rmSync(`${staged}.wal`, { force: true });
        moveFile(staged, destPath);
      }),
    );
  }

  /**
   * Export every base analytics table to its own CSV file under `destDir`.
   *Like `backupTo`, this must run through the live instance — DuckDB
   * allows a single read-write process per file, so a second instance
   * cannot open the database the gateway holds. DuckDB's native
   * `COPY (...) TO '<file>' (FORMAT CSV, HEADER)` handles RFC 4180 quoting
   * of embedded commas, quotes, and newlines correctly. Serializing
   * through the write queue guarantees no write transaction overlaps the
   * copies. Each file is staged in the spill directory and moved into
   * `destDir`. Returns the table names written.
   *
   * The plane's own bookkeeping tables (`ANALYTICS_INTERNAL_TABLES`) are
   * excluded — they are gateway metadata, not user data.
   */
  async exportTablesToCsv(destDir: string): Promise<string[]> {
    return this.serializeWrite(() =>
      this.withConn(async (p) => {
        const internal = ANALYTICS_INTERNAL_TABLES.map((name) => `'${name}'`).join(", ");
        const reader = await p.conn.runAndReadAll(
          "SELECT table_name FROM information_schema.tables " +
            `WHERE table_schema = 'main' AND table_name NOT IN (${internal}) ` +
            "ORDER BY table_name",
        );
        const tableNames = reader.getRows().map((r) => String(r[0]));
        const stage = join(this.stagingDirectory, randomUUID());
        mkdirSync(stage, { mode: 0o700 });
        for (const name of tableNames) {
          const src = `"${name.replace(/"/g, '""')}"`;
          const staged = join(stage, `${name}.csv`);
          await p.conn.run(
            `COPY (SELECT * FROM ${src}) TO '${escapeStr(staged)}' (FORMAT CSV, HEADER, QUOTE '"', ESCAPE '"')`,
          );
          moveFile(staged, join(destDir, `${name}.csv`));
        }
        rmSync(stage, { recursive: true, force: true });
        return tableNames;
      }),
    );
  }

  /**
   * Acquire a pool connection. Reuses an idle one if available,
   * lazily creates a new one up to `maxPoolSize`, otherwise queues
   * the caller until a release happens.
   */
  private async acquireConn(): Promise<PooledConn> {
    if (this.closed) throw new Error("AnalyticsDb closed");
    if (!this.instance) throw new Error("AnalyticsDb not open");
    const idle = this.pool.pop();
    if (idle) return idle;
    if (this.created < this.maxPoolSize) {
      const conn = await this.instance.connect();
      await conn.run(`USE ${ANALYTICS_ATTACHED_DB}`);
      this.created++;
      return { conn };
    }
    return new Promise<PooledConn>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Return a connection to the pool (or hand it directly to a waiter). */
  private releaseConn(p: PooledConn): void {
    const w = this.waiters.shift();
    if (w) {
      w(p);
      return;
    }
    this.pool.push(p);
  }

  /**
   * Convenience wrapper: acquire a pool conn, run the work, release.
   * Every public method funnels through this so a thrown error
   * never leaks a connection.
   */
  async withConn<T>(fn: (p: PooledConn) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("AnalyticsDb closed");
    const p = await this.acquireConn();
    try {
      return await fn(p);
    } catch (error) {
      this.noteFatal(error);
      throw error;
    } finally {
      this.releaseConn(p);
    }
  }

  /**
   * Run one user-supplied SQL statement on this instance without letting it
   * write, reach the filesystem, or open the store a second time. Three
   * gates, each an engine decision rather than a keyword filter:
   *
   *   1. The statement's syntax tree (DuckDB's own parser, via
   *      `json_serialize_sql`) may call only the table functions in
   *      `SANDBOX_TABLE_FUNCTIONS` and no scalar file reader. This is what
   *      keeps a second handle off the store: DuckDB always lets a query read
   *      an attached database's own file, allow-list or not.
   *   2. `prepare` admits exactly one statement, and it must be a SELECT.
   *   3. The statement runs on a dedicated connection inside
   *      `BEGIN TRANSACTION READ ONLY`; the instance-wide lockdown taken at
   *      `open` refuses ATTACH, INSTALL/LOAD, SET and any path outside the
   *      allow-list on top of that.
   *
   * An optional `authorize` hook runs between vetting and binding for
   * callers that enforce a source grant; the pool itself stays
   * policy-free.
   *
   * The transaction is rolled back and the connection closed whatever the
   * work does, so a query cancelled mid-flight leaves nothing behind.
   * Admission is bounded by the pool size so user SQL cannot fan out without
   * limit on the shared instance.
   */
  async withSandboxStatement<T>(
    sql: string,
    fn: (sandbox: AnalyticsSandbox) => Promise<T>,
    opts?: {
      /**
       * Runs after vetting, before `prepare` binds the statement — the
       * one place a source gate can see the engine-parsed statement
       * without racing the bind. Receives the sandbox connection (same
       * catalog context the query will bind in) alongside the vetted
       * tree. A rejection denies the query before anything executes or
       * binds, so unknown and denied names fail identically and no
       * existence oracle leaks through error codes.
       */
      authorize?: (sandbox: { conn: DuckDBConnection; parseTree: unknown }) => Promise<void>;
    },
  ): Promise<T> {
    if (this.closed) throw new Error("AnalyticsDb closed");
    const instance = this.instance;
    if (!instance) throw new Error("AnalyticsDb not open");
    await this.admitSandbox();
    let conn: DuckDBConnection | null = null;
    try {
      conn = await instance.connect();
      this.sandboxConns.add(conn);
      await conn.run(`USE ${ANALYTICS_ATTACHED_DB}`);
      await conn.run("BEGIN TRANSACTION READ ONLY");
      try {
        const parseTree = await vetSandboxSql(conn, sql);
        // Source gates run here — vetted but unbound — so a denied name
        // and a nonexistent name fail identically, and no existence
        // oracle leaks through the error code.
        await opts?.authorize?.({ conn, parseTree });
        let statement: DuckDBPreparedStatement;
        try {
          statement = await conn.prepare(sql);
        } catch (error) {
          throw new SandboxSqlRefusedError(
            `SQL queries must be a single statement: ${describeError(error)}`,
          );
        }
        try {
          if (statement.statementType !== StatementType.SELECT) {
            throw new SandboxSqlRefusedError("SQL queries must be a single SELECT statement");
          }
          return await fn({ conn, statement, parseTree });
        } finally {
          try {
            statement.destroySync();
          } catch {
            /* ignore */
          }
        }
      } catch (error) {
        this.noteFatal(error);
        throw error;
      } finally {
        try {
          await conn.run("ROLLBACK");
        } catch {
          /* an interrupted or aborted transaction has nothing left to roll back */
        }
      }
    } finally {
      if (conn) {
        this.sandboxConns.delete(conn);
        try {
          conn.closeSync();
        } catch {
          /* ignore */
        }
      }
      this.releaseSandbox();
    }
  }

  private async admitSandbox(): Promise<void> {
    if (this.sandboxActive < this.maxPoolSize) {
      this.sandboxActive++;
      return;
    }
    await new Promise<void>((resolve) => this.sandboxWaiters.push(resolve));
    if (this.closed) throw new Error("AnalyticsDb closed");
    this.sandboxActive++;
  }

  private releaseSandbox(): void {
    this.sandboxActive--;
    this.sandboxWaiters.shift()?.();
  }

  private noteFatal(error: unknown): void {
    if (this.fatalReported || !isDuckDbInvalidated(error)) return;
    this.fatalReported = true;
    const err = error instanceof Error ? error : new Error(String(error));
    log.error(`Analytics store invalidated by DuckDB: ${err.message}`);
    const hook = this.onFatal;
    if (!hook) return;
    // Off the failing call's stack, so a hook that throws can never replace
    // the DuckDB error its caller is about to see.
    queueMicrotask(() => {
      try {
        hook(err);
      } catch (hookError) {
        log.error(`onFatal hook threw: ${describeError(hookError)}`);
      }
    });
  }
}

/**
 * Refuse a user statement whose syntax tree calls anything that could open
 * a file. DuckDB parses it (`json_serialize_sql`) so comments, CTEs, nested
 * subqueries and casing cannot hide a call the way they can from a keyword
 * scan; a statement DuckDB cannot parse is refused with the parser's words.
 */
async function vetSandboxSql(conn: DuckDBConnection, sql: string): Promise<unknown> {
  const reader = await conn.runAndReadAll("SELECT json_serialize_sql($sql::VARCHAR)", { sql });
  const raw = reader.getRows()[0]?.[0];
  const tree = JSON.parse(String(raw)) as { error?: boolean; error_message?: string };
  if (tree.error) {
    throw new SandboxSqlRefusedError(
      `SQL query could not be parsed: ${tree.error_message ?? "unknown error"}`,
    );
  }
  const refused = new Set<string>();
  walkFunctions(tree, (name, kind) => {
    const lower = name.toLowerCase();
    if (kind === "table" && !SANDBOX_TABLE_FUNCTIONS.has(lower)) refused.add(lower);
    if (kind === "scalar" && SANDBOX_DENIED_SCALAR_FUNCTIONS.test(lower)) refused.add(lower);
  });
  if (refused.size > 0) {
    throw new SandboxSqlRefusedError(
      `SQL queries cannot call ${[...refused].sort().join(", ")}: it reads or writes files, runs SQL from text, or operates the engine`,
    );
  }
  return tree;
}

function walkFunctions(
  node: unknown,
  visit: (name: string, kind: "table" | "scalar") => void,
): void {
  if (Array.isArray(node)) {
    for (const child of node) walkFunctions(child, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "TABLE_FUNCTION") {
    const fn = record.function as Record<string, unknown> | undefined;
    if (typeof fn?.function_name === "string") visit(fn.function_name, "table");
  } else if (record.type === "FUNCTION" && typeof record.function_name === "string") {
    visit(record.function_name, "scalar");
  }
  for (const value of Object.values(record)) walkFunctions(value, visit);
}

/**
 * DuckDB reports a store it can no longer operate on with this wording, and
 * every later statement on the instance repeats it: nothing short of
 * reopening the file recovers from it.
 */
export function isDuckDbInvalidated(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database has been invalidated because of a previous fatal error/i.test(message);
}

function defaultMemoryLimitMiB(): number {
  const quarter = Math.floor(totalmem() / 4 / MIB);
  return Math.max(MIN_MEMORY_LIMIT_MIB, Math.min(MAX_DEFAULT_MEMORY_LIMIT_MIB, quarter));
}

function defaultThreads(): number {
  const half = Math.floor(availableParallelism() / 2);
  return Math.max(MIN_THREADS, Math.min(MAX_DEFAULT_THREADS, half));
}

/** The files DuckDB reads or writes for a store at `path`, beyond its spill directory. */
function storeFiles(path: string): string[] {
  return [path, `${path}.wal`, `${path}.wal.checkpoint`];
}

function sqlStringList(values: string[]): string {
  return `[${values.map((value) => `'${escapeStr(value)}'`).join(", ")}]`;
}

/** Move a finished artefact out of the staging directory; a copy when the destination is on another filesystem. */
function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/**
 * The encryption module DuckDB links statically only reads encrypted files;
 * writing one needs the OpenSSL-backed module that ships with `httpfs`.
 * DuckDB autoloads it from the local extension directory when it can — which
 * it cannot once external access is disabled, so the load is explicit here.
 * A missing extension is installed first; that needs the network once.
 */
async function loadEncryptionModule(conn: DuckDBConnection): Promise<void> {
  try {
    await conn.run("LOAD httpfs");
    return;
  } catch (loadError) {
    try {
      await conn.run("INSTALL httpfs");
      await conn.run("LOAD httpfs");
    } catch (installError) {
      throw new Error(
        "Encrypted analytics storage needs DuckDB's httpfs extension, which could not be loaded " +
          `(${describeError(loadError)}) or installed (${describeError(installError)}). ` +
          "Install it once with network access: `INSTALL httpfs` in DuckDB, or start the gateway online.",
        { cause: installError },
      );
    }
  }
}

function attachSql(
  path: string,
  alias: string,
  encryptionKeyHex?: string,
  opts: { readonly?: boolean } = {},
): string {
  const options: string[] = [];
  if (encryptionKeyHex) options.push(`ENCRYPTION_KEY '${escapeStr(encryptionKeyHex)}'`);
  if (opts.readonly) options.push("READ_ONLY");
  const suffix = options.length > 0 ? ` (${options.join(", ")})` : "";
  return `ATTACH '${escapeStr(path)}' AS ${alias}${suffix}`;
}

/**
 * Thrown when the store exists but cannot be opened. Carries DuckDB's own
 * words: a conflicting lock names the process that holds the file, an
 * AES-tag mismatch means a damaged block (DuckDB blames the key for any
 * block it cannot authenticate), anything else is the engine's verdict. On
 * an encrypted store the plaintext probe's verdict rides along, since a
 * store that opens neither way is the case that needs both.
 */
export class AnalyticsStoreOpenError extends Error {
  constructor(
    readonly path: string,
    readonly openError: string,
    readonly plaintextOpenError?: string,
  ) {
    super(
      `DuckDB analytics store at ${path} could not be opened. ` +
        `${diagnoseOpenFailure(openError)}` +
        `Open: ${openError}. ` +
        (plaintextOpenError ? `Plaintext open: ${plaintextOpenError}. ` : "") +
        "Keep the file and its .wal exactly as they are — they are recoverable evidence, not a cache.",
    );
    this.name = "AnalyticsStoreOpenError";
  }
}

function diagnoseOpenFailure(message: string): string {
  if (/conflicting lock is held/i.test(message)) {
    return "Another process holds the store open — a gateway still shutting down, a duplicate gateway, or a tool opened on the file. Stop it, then start this gateway again. ";
  }
  if (/AES tag|corrupt|checksum/i.test(message)) {
    return "The file is damaged (DuckDB reports a damaged block as a key mismatch). ";
  }
  return "";
}

/**
 * The plaintext-to-encrypted migration copies the store into
 * `<path>.encrypted-*.tmp`, renames the original to `<path>.plaintext-*`,
 * moves the copy into place and deletes the original — and a crash can land
 * between any two of those steps. Put the tree back into a state `open` can
 * take from: a store missing from `path` comes back from its newest
 * `.plaintext-*` copy; a store present at `path` makes any `.plaintext-*`
 * leftover a redundant plaintext copy of the corpus, which is removed; a
 * half-written `.encrypted-*.tmp` is discarded and the migration reruns.
 */
function recoverInterruptedPlaintextMigration(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) return;
  const base = basename(path);
  const entries = readdirSync(dir);
  for (const name of entries) {
    if (name.startsWith(`${base}.encrypted-`)) {
      rmSync(join(dir, name), { recursive: true, force: true });
      log.warn(`Discarded a half-written encryption migration copy: ${name}`);
    }
  }
  const plaintext = entries
    .filter((name) => name.startsWith(`${base}.plaintext-`))
    .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (plaintext.length === 0) return;
  if (!existsSync(path)) {
    const [newest, ...older] = plaintext;
    renameSync(join(dir, newest!.name), path);
    log.warn(
      `Recovered the analytics store from an interrupted encryption migration: ${newest!.name}`,
    );
    for (const stale of older) rmSync(join(dir, stale.name), { force: true });
    return;
  }
  for (const leftover of plaintext) {
    rmSync(join(dir, leftover.name), { force: true });
    log.warn(`Removed a plaintext copy left by a completed encryption migration: ${leftover.name}`);
  }
}

async function migratePlaintextDuckDbIfNeeded(
  path: string,
  encryptionKeyHex: string,
): Promise<void> {
  if (!existsSync(path)) return;
  const keyed = await probeEncryptedDuckDb(path, encryptionKeyHex);
  if (keyed === null) return;
  const plaintext = await probePlaintextDuckDb(path);
  if (plaintext !== null) {
    throw new AnalyticsStoreOpenError(
      path,
      redactKey(keyed, encryptionKeyHex),
      redactKey(plaintext, encryptionKeyHex),
    );
  }

  const scratch = randomUUID();
  const tmp = `${path}.encrypted-${scratch}.tmp`;
  const legacy = `${path}.plaintext-${scratch}`;

  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  try {
    await loadEncryptionModule(conn);
    await conn.run(attachSql(path, "_omnesis_plaintext_source", undefined, { readonly: true }));
    await conn.run(attachSql(tmp, "_omnesis_encrypted_dest", encryptionKeyHex));
    try {
      await conn.run("COPY FROM DATABASE _omnesis_plaintext_source TO _omnesis_encrypted_dest");
    } finally {
      for (const alias of ["_omnesis_encrypted_dest", "_omnesis_plaintext_source"]) {
        try {
          await conn.run(`DETACH ${alias}`);
        } catch {
          /* attach may not have survived the copy failure */
        }
      }
    }
  } finally {
    try {
      conn.closeSync();
    } catch {
      /* ignore */
    }
    try {
      inst.closeSync();
    } catch {
      /* ignore */
    }
  }

  // The original keeps its `.plaintext-*` name until the encrypted copy is
  // in place; `recoverInterruptedPlaintextMigration` knows every state this
  // sequence can be interrupted in.
  renameSync(path, legacy);
  rmSync(`${path}.wal`, { force: true });
  renameSync(tmp, path);
  rmSync(`${tmp}.wal`, { force: true });
  rmSync(legacy, { force: true });
  log.info(`Encrypted the analytics store at ${path}`);
}

/** DuckDB's error for a keyed read-only attach, or null when the attach succeeds. */
async function probeEncryptedDuckDb(
  path: string,
  encryptionKeyHex: string,
): Promise<string | null> {
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  try {
    await conn.run(attachSql(path, ANALYTICS_ATTACHED_DB, encryptionKeyHex, { readonly: true }));
    return null;
  } catch (error) {
    return describeError(error);
  } finally {
    try {
      conn.closeSync();
    } catch {
      /* ignore */
    }
    try {
      inst.closeSync();
    } catch {
      /* ignore */
    }
  }
}

/** DuckDB's error for a plaintext read-only open, or null when the open succeeds. */
async function probePlaintextDuckDb(path: string): Promise<string | null> {
  let inst: DuckDBInstance | null = null;
  try {
    inst = await DuckDBInstance.create(path, { access_mode: "READ_ONLY" });
    return null;
  } catch (error) {
    return describeError(error);
  } finally {
    if (inst) {
      try {
        inst.closeSync();
      } catch {
        /* ignore */
      }
    }
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.trim() || "unknown error";
}

function redactKey(message: string, encryptionKeyHex: string | undefined): string {
  return encryptionKeyHex ? message.replaceAll(encryptionKeyHex, "[redacted]") : message;
}
