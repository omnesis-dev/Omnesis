// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  WalCheckpointer,
  WAL_SIZE_LIMIT_BYTES,
  type WalCheckpointPolicy,
} from "./wal-checkpoint.js";
import { openWriteConn } from "./writer-connection.js";

const POLICY: WalCheckpointPolicy = {
  pendingFrames: 100,
  restartFrames: 1_000,
  restartWaitMs: 200,
  restartRetryMinMs: 5_000,
  restartRetryMaxMs: 20_000,
  busyTimeoutMs: 5_000,
};

const opened: Database.Database[] = [];
const workers: Worker[] = [];
let path = "";

function writer(journalMode: "WAL" | "TRUNCATE" = "WAL"): Database.Database {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  const seed = new Database(path);
  seed.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body BLOB NOT NULL)");
  seed.close();
  const db = openWriteConn(path, journalMode);
  opened.push(db);
  return db;
}

function reader(): Database.Database {
  const db = new Database(path, { readonly: true });
  opened.push(db);
  return db;
}

/** Commit `rows` rows of about one page each, in small transactions. */
function write(db: Database.Database, rows: number): void {
  const insert = db.prepare("INSERT INTO notes (body) VALUES (randomblob(3000))");
  for (let done = 0; done < rows; done += 50) {
    db.transaction(() => {
      for (let i = 0; i < Math.min(50, rows - done); i++) insert.run();
    })();
  }
}

function wal(db: Database.Database): { log: number; checkpointed: number } {
  const rows = db.pragma("wal_checkpoint(NOOP)", { simple: false }) as Array<{
    log: number;
    checkpointed: number;
  }>;
  return rows[0];
}

/** A thread that runs short read statements back to back until told to stop. */
function busyReader(): { stop: () => Promise<number> } {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(
    `const Database = require(${JSON.stringify(createRequire(import.meta.url).resolve("better-sqlite3"))});
     const { workerData, parentPort } = require("node:worker_threads");
     const stop = new Int32Array(workerData.flag);
     const db = new Database(workerData.path, { readonly: true });
     const count = db.prepare("SELECT sum(length(body)) AS n FROM notes WHERE id > ?");
     let reads = 0;
     parentPort.postMessage("started");
     while (Atomics.load(stop, 0) === 0) { count.get(reads % 50); reads++; }
     db.close();
     parentPort.postMessage(reads);`,
    { eval: true, workerData: { path, flag: flag.buffer } },
  );
  workers.push(worker);
  const messages: unknown[] = [];
  const waiters: Array<(m: unknown) => void> = [];
  worker.on("message", (m) => {
    const next = waiters.shift();
    if (next) next(m);
    else messages.push(m);
  });
  const nextMessage = () =>
    new Promise<unknown>((resolve) => {
      const queued = messages.shift();
      if (queued !== undefined) resolve(queued);
      else waiters.push(resolve);
    });
  const started = nextMessage();
  return {
    stop: async () => {
      await started;
      Atomics.store(flag, 0, 1);
      return (await nextMessage()) as number;
    },
    ...{ started },
  } as { stop: () => Promise<number>; started: Promise<unknown> };
}

afterEach(async () => {
  for (const w of workers.splice(0)) await w.terminate();
  for (const db of opened.splice(0)) if (db.open) db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});

describe("WalCheckpointer", () => {
  it("copies once enough frames wait, and an idle call copies the rest", () => {
    const db = writer();
    const checkpointer = new WalCheckpointer(db, POLICY);
    write(db, 20);
    expect(wal(db).log).toBeLessThan(POLICY.pendingFrames);
    expect(checkpointer.maintain()).toBeNull();

    expect(checkpointer.maintain(1)).toMatchObject({ mode: "PASSIVE", outcome: "copied" });
    expect(wal(db).checkpointed).toBe(wal(db).log);

    write(db, 200);
    const run = checkpointer.maintain();
    expect(run).toMatchObject({ mode: "PASSIVE" });
    expect(run!.checkpointed).toBe(run!.log);
    expect(checkpointer.maintain(1)).toBeNull();
  });

  it("runs nothing on a database without a WAL", () => {
    const db = writer("TRUNCATE");
    write(db, 200);
    expect(new WalCheckpointer(db, POLICY).maintain(1)).toBeNull();
  });

  it("rewinds a long WAL and the next commit cuts the file to the size limit", () => {
    const db = writer();
    expect(db.pragma("journal_size_limit", { simple: true })).toBe(WAL_SIZE_LIMIT_BYTES);
    const checkpointer = new WalCheckpointer(db, { ...POLICY, pendingFrames: 1_000_000 });
    write(db, 1_200);
    expect(wal(db).log).toBeGreaterThanOrEqual(POLICY.restartFrames);

    const run = checkpointer.maintain();
    expect(run).toMatchObject({ mode: "RESTART", outcome: "rewound", log: 0, checkpointed: 0 });
    expect(run!.rewoundFrames).toBeGreaterThanOrEqual(POLICY.restartFrames);
    write(db, 1);
    expect(wal(db).log).toBeLessThan(10);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(POLICY.busyTimeoutMs);
  });

  it("truncates a rewound WAL past the limit", () => {
    const db = writer();
    db.pragma("journal_size_limit = 1048576");
    const checkpointer = new WalCheckpointer(db, { ...POLICY, pendingFrames: 1_000_000 });
    write(db, 1_200);
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(4 * 1024 * 1024);
    expect(checkpointer.maintain()).toMatchObject({ outcome: "rewound" });
    write(db, 1);
    expect(statSync(`${path}-wal`).size).toBeLessThanOrEqual(1024 * 1024);
  });

  it("gives up within its wait while a reader holds an old snapshot, and retries after the interval", () => {
    const db = writer();
    let clock = 0;
    const checkpointer = new WalCheckpointer(
      db,
      { ...POLICY, pendingFrames: 1_000_000 },
      () => clock + performance.now(),
    );
    write(db, 600);
    const held = reader();
    held.exec("BEGIN");
    held.prepare("SELECT count(*) FROM notes").get();
    write(db, 600);

    const started = performance.now();
    const blocked = checkpointer.maintain();
    expect(performance.now() - started).toBeLessThan(POLICY.restartWaitMs + 150);
    expect(blocked).toMatchObject({ mode: "RESTART", outcome: "deferred" });
    expect(wal(db).log).toBeGreaterThanOrEqual(POLICY.restartFrames);
    expect(checkpointer.maintain()).toBeNull();

    held.exec("COMMIT");
    clock += POLICY.restartRetryMinMs;
    expect(checkpointer.maintain()).toMatchObject({ mode: "RESTART", outcome: "rewound" });
    expect(db.pragma("busy_timeout", { simple: true })).toBe(POLICY.busyTimeoutMs);
  });

  it("rewinds while another thread reads back to back", async () => {
    const db = writer();
    const checkpointer = new WalCheckpointer(db, { ...POLICY, pendingFrames: 1_000_000 });
    const readers = [busyReader(), busyReader()] as Array<
      ReturnType<typeof busyReader> & { started: Promise<unknown> }
    >;
    await Promise.all(readers.map((r) => r.started));
    write(db, 1_200);

    const run = checkpointer.maintain();
    expect(run).toMatchObject({ mode: "RESTART", outcome: "rewound" });
    expect(run!.ms).toBeLessThan(POLICY.restartWaitMs + 150);
    write(db, 1);
    expect(wal(db).log).toBeLessThan(10);
    for (const r of readers) expect(await r.stop()).toBeGreaterThan(0);
  });

  describe("against a connection whose checkpoints are scripted", () => {
    interface Row {
      busy: number;
      log: number;
      checkpointed: number;
    }
    function scripted(script: { passive: () => Row; restart?: () => Row; log?: number }) {
      const calls: string[] = [];
      let busyTimeout = POLICY.busyTimeoutMs;
      const db = {
        prepare: (sql: string) => ({
          get: (): Row => {
            const mode = /\((\w+)\)/.exec(sql)![1]!;
            calls.push(mode);
            if (mode === "NOOP") return { busy: 0, log: script.log ?? 20_000, checkpointed: 0 };
            if (mode === "PASSIVE") return script.passive();
            return script.restart!();
          },
        }),
        pragma: (text: string) => {
          const set = /busy_timeout = (\d+)/.exec(text);
          if (set) busyTimeout = Number(set[1]);
        },
      } as unknown as Database.Database;
      return { db, calls, busyTimeout: () => busyTimeout };
    }
    const full = (): never => {
      throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    };

    it("backs off after a copy throws instead of retrying after every op", () => {
      let clock = 0;
      const conn = scripted({ passive: full, log: 5_000 });
      const checkpointer = new WalCheckpointer(conn.db, POLICY, () => clock);
      expect(() => checkpointer.maintain()).toThrow("database or disk is full");
      for (let op = 0; op < 10; op++) expect(checkpointer.maintain()).toBeNull();
      expect(conn.calls.filter((c) => c === "PASSIVE")).toHaveLength(1);

      clock += POLICY.restartRetryMinMs;
      expect(() => checkpointer.maintain()).toThrow();
      clock += POLICY.restartRetryMinMs;
      expect(checkpointer.maintain()).toBeNull();
      clock += POLICY.restartRetryMinMs;
      expect(() => checkpointer.maintain()).toThrow();
      expect(conn.calls.filter((c) => c === "PASSIVE")).toHaveLength(3);
    });

    it("backs off after a rewind throws and restores the busy timeout", () => {
      let clock = 0;
      const conn = scripted({
        passive: () => ({ busy: 0, log: 20_000, checkpointed: 20_000 }),
        restart: () => {
          throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
        },
      });
      const checkpointer = new WalCheckpointer(conn.db, POLICY, () => clock);
      expect(() => checkpointer.maintain()).toThrow("disk I/O error");
      expect(conn.busyTimeout()).toBe(POLICY.busyTimeoutMs);
      for (let op = 0; op < 10; op++) expect(checkpointer.maintain()).toBeNull();
      expect(conn.calls.filter((c) => c === "RESTART")).toHaveLength(1);
      clock += POLICY.restartRetryMinMs;
      expect(() => checkpointer.maintain()).toThrow();
      expect(conn.calls.filter((c) => c === "RESTART")).toHaveLength(2);
    });

    it("does not count a rewind whose own copy spent the wait as deferred, and tries again next op", () => {
      let clock = 0;
      let slowCopy = true;
      const conn = scripted({
        passive: () => {
          if (slowCopy) clock += POLICY.restartWaitMs + 1;
          return { busy: 0, log: 20_000, checkpointed: 20_000 };
        },
        restart: () => ({ busy: 0, log: 20_000, checkpointed: 20_000 }),
      });
      const checkpointer = new WalCheckpointer(conn.db, POLICY, () => clock);
      expect(checkpointer.maintain()).toMatchObject({ mode: "RESTART", outcome: "copied" });
      expect(conn.calls).not.toContain("RESTART");
      slowCopy = false;
      expect(checkpointer.maintain()).toMatchObject({
        outcome: "rewound",
        log: 0,
        checkpointed: 0,
        rewoundFrames: 20_000,
      });
    });
  });
});
