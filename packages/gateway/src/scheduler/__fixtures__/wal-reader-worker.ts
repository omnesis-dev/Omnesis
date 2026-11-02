// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A reader thread for WAL tests: runs read statements on its own read-only
 * handle back to back, the way the gateway's readers overlap the writer, until
 * the shared stop flag is set. With `holdMs`, every `holdEveryMs` it also keeps
 * one read transaction open for `holdMs`, like a long scan. With `real`, it
 * runs the gateway's own background reads in turn instead: the date pass's
 * batch fetch, a source's stats aggregation, the near-dup DF load and the
 * indexer's id list. Posts how many reads it ran and the longest statement,
 * which outside a transaction is the longest snapshot it held, with the
 * longest of each real read.
 */

import { parentPort, workerData } from "node:worker_threads";
import { openReadOnlyDatabase } from "../../db.js";
import { listDocumentIds } from "../../data/repositories/DocumentRepository.js";
import { computeSourceStatsRow } from "../../data/repositories/SourceStatsRepository.js";
import { fetchDateExtractionBatch } from "../../enrichment/dates/storage.js";
import { fetchNearDupDfData } from "../../near-dupes/NearDupComputeService.js";
import type { Db } from "../../data/types.js";

interface ReaderData {
  path: string;
  keyHex: string;
  stop: SharedArrayBuffer;
  /** Documents each statement reads. */
  window: number;
  holdMs?: number;
  holdEveryMs?: number;
  real?: { statsSourceId: string; algoVersion: string; dateBatch: number; dateMaxChars: number };
}

const data = workerData as ReaderData;
const stop = new Int32Array(data.stop);
const db = openReadOnlyDatabase(data.path, { encryptionKey: Buffer.from(data.keyHex, "hex") });
const pause = new Int32Array(new SharedArrayBuffer(4));

let reads = 0;
let maxStatementMs = 0;
const maxOpMs: Record<string, number> = {};

const recordStatement = (startedMs: number) => {
  maxStatementMs = Math.max(maxStatementMs, performance.now() - startedMs);
};

/** `stmt` with every execution timed; `raw` and `pluck` keep the timing. */
function timedStatement<S extends object>(stmt: S): S {
  const proxy: S = new Proxy(stmt, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== "function") return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (prop === "raw" || prop === "pluck" || prop === "expand")
        return (...a: unknown[]) => {
          fn.apply(target, a);
          return proxy;
        };
      if (prop === "all" || prop === "get" || prop === "run")
        return (...a: unknown[]) => {
          const started = performance.now();
          try {
            return fn.apply(target, a);
          } finally {
            recordStatement(started);
          }
        };
      if (prop === "iterate")
        return (...a: unknown[]) => {
          const started = performance.now();
          const rows = fn.apply(target, a) as Iterable<unknown>;
          return (function* () {
            try {
              yield* rows;
            } finally {
              recordStatement(started);
            }
          })();
        };
      return fn.bind(target);
    },
  });
  return proxy;
}

const timedDb = new Proxy(db, {
  get(target, prop) {
    if (prop === "prepare") return (sql: string) => timedStatement(target.prepare(sql));
    const value = Reflect.get(target, prop) as unknown;
    return typeof value === "function"
      ? (value as (...a: unknown[]) => unknown).bind(target)
      : value;
  },
}) as unknown as Db;

function realReads(real: NonNullable<ReaderData["real"]>): Array<[string, () => unknown]> {
  return [
    [
      "fetchDateExtractionBatch",
      () => fetchDateExtractionBatch(timedDb, real.dateBatch, real.dateMaxChars),
    ],
    ["computeSourceStatsRow", () => computeSourceStatsRow(timedDb, real.statsSourceId)],
    ["fetchNearDupDfData", () => fetchNearDupDfData(timedDb, real.algoVersion)],
    ["listDocumentIds", () => listDocumentIds(timedDb)],
  ];
}

parentPort!.postMessage({ type: "started" });
if (data.real) {
  const ops = realReads(data.real);
  for (let i = 0; Atomics.load(stop, 0) === 0; i++) {
    const [name, run] = ops[i % ops.length]!;
    const started = performance.now();
    run();
    maxOpMs[name] = Math.max(maxOpMs[name] ?? 0, performance.now() - started);
    reads += 1;
  }
} else {
  const maxRowid = db.prepare<[], { n: number }>("SELECT max(rowid) AS n FROM documents").get()!.n;
  const read = db.prepare<[number, number], { n: number; bytes: number }>(
    "SELECT count(*) AS n, sum(length(content)) AS bytes FROM documents WHERE rowid BETWEEN ? AND ?",
  );
  let nextHold = data.holdMs ? performance.now() + (data.holdEveryMs ?? 0) : Infinity;
  while (Atomics.load(stop, 0) === 0) {
    const from = Math.floor(Math.random() * Math.max(1, maxRowid - data.window));
    const started = performance.now();
    if (started >= nextHold) {
      db.exec("BEGIN");
      read.get(from, from + data.window);
      Atomics.wait(pause, 0, 0, data.holdMs);
      db.exec("COMMIT");
      nextHold = performance.now() + (data.holdEveryMs ?? 0);
    } else {
      read.get(from, from + data.window);
      recordStatement(started);
    }
    reads += 1;
  }
}
db.close();
parentPort!.postMessage({ type: "done", reads, maxStatementMs, maxOpMs });
