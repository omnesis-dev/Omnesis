// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A reader thread for WAL tests: runs read statements on its own read-only
 * handle back to back, the way the gateway's readers overlap the writer, until
 * the shared stop flag is set. With `holdMs`, every `holdEveryMs` it also keeps
 * one read transaction open for `holdMs`, like a long scan. Posts how many
 * statements it ran and the longest one.
 */

import { parentPort, workerData } from "node:worker_threads";
import { openReadOnlyDatabase } from "../../db.js";

interface ReaderData {
  path: string;
  keyHex: string;
  stop: SharedArrayBuffer;
  /** Documents each statement reads. */
  window: number;
  holdMs?: number;
  holdEveryMs?: number;
}

const data = workerData as ReaderData;
const stop = new Int32Array(data.stop);
const db = openReadOnlyDatabase(data.path, { encryptionKey: Buffer.from(data.keyHex, "hex") });
const maxRowid = db.prepare<[], { n: number }>("SELECT max(rowid) AS n FROM documents").get()!.n;
const read = db.prepare<[number, number], { n: number; bytes: number }>(
  "SELECT count(*) AS n, sum(length(content)) AS bytes FROM documents WHERE rowid BETWEEN ? AND ?",
);
const pause = new Int32Array(new SharedArrayBuffer(4));

let reads = 0;
let maxStatementMs = 0;
let nextHold = data.holdMs ? performance.now() + (data.holdEveryMs ?? 0) : Infinity;
parentPort!.postMessage({ type: "started" });
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
    maxStatementMs = Math.max(maxStatementMs, performance.now() - started);
  }
  reads += 1;
}
db.close();
parentPort!.postMessage({ type: "done", reads, maxStatementMs });
