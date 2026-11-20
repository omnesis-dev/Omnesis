// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Stopping the search pool never terminates a worker that is inside a native
 * usearch call, and does not wait for the calls queued behind it.
 *
 * `Worker.terminate()` stops a thread's JavaScript at once, even while the
 * thread is inside a usearch call. The addon's next Node-API call then fails,
 * node-addon-api turns that failure into a C++ exception it cannot hand to
 * JavaScript, and `std::terminate` aborts the whole process.
 *
 * The pool runs in a child process, so an abort is that process's exit
 * signal rather than the loss of the Vitest worker. A FIFO stands in for the
 * worker's vector index: usearch's `view` opens it, and opening a FIFO for
 * reading blocks until a writer opens it, so the thread sits inside that
 * native call for as long as the test keeps the FIFO closed. The test opens
 * it only once the pool has reported that the worker missed its shutdown
 * acknowledgement deadline, the moment a pool that terminates on that
 * deadline would have done so.
 *
 * The same FIFO holds a query's vector lane inside usearch's `view`, so the
 * calls queued behind that query are still waiting when the pool stops.
 */

import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWorkerEntry } from "@omnesis/core";
import { afterEach, describe, expect, test } from "vitest";

import { EMBEDDING_DIM, createIndexDatabase } from "../indexer/db.js";
import {
  resolveDiversityConfig,
  resolveSearchSettings,
  resolveSourcePriorsConfig,
  resolveVectorConfig,
} from "../search/search-config.js";
import { SearchWorkerPool } from "./search-pool.js";
import type { CandidateGenRequest } from "../search/candidate-gen.js";

const SEARCH_WORKER = resolveWorkerEntry(
  "./search-worker.ts",
  import.meta.url,
  "./register-tsx.mjs",
);

/** The pool's warning when a worker has not acknowledged shutdown in time. */
const SHUTDOWN_DEADLINE_LINE = "search worker 0 shutdown";
const EARLY_TERMINATION = "terminated before acknowledging shutdown";

/**
 * Starts a one-worker pool, stops it at once, and reports on stdout any
 * `terminate()` of a worker that had not yet acknowledged shutdown, then
 * `disposed` once the pool's `dispose()` resolves.
 */
const POOL_HOST_SOURCE = `
import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";
const testCase = JSON.parse(process.env.SEARCH_POOL_SHUTDOWN_CASE);
const acknowledged = new WeakSet();
const emit = Worker.prototype.emit;
Worker.prototype.emit = function (event, message, ...rest) {
  if (event === "message" && message?.type === "shutdownComplete") acknowledged.add(this);
  return emit.call(this, event, message, ...rest);
};
const terminate = Worker.prototype.terminate;
Worker.prototype.terminate = function () {
  if (!acknowledged.has(this)) writeSync(1, "${EARLY_TERMINATION}\\n");
  return terminate.call(this);
};
const { SearchWorkerPool } = await import(testCase.poolModule);
const pool = new SearchWorkerPool({
  indexDbPath: testCase.indexDbPath,
  configDir: testCase.configDir,
  concurrency: 1,
  workerUrl: new URL(testCase.workerUrl),
  workerExecArgv: testCase.workerExecArgv,
});
void pool.start().catch(() => {});
await pool.dispose();
writeSync(1, "disposed\\n");
`;

/**
 * Open the FIFO's write end once a reader holds it, then close it at once,
 * which ends the reader's blocked open. Gives up once `done()` says no reader
 * is coming.
 */
async function releaseFifo(path: string, done: () => boolean): Promise<void> {
  for (;;) {
    try {
      closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
      return;
    } catch (error) {
      // ENXIO: no reader has opened it yet.
      if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
    }
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A hybrid query with a query vector, so it reaches the vector lane. */
function vectorRequest(): CandidateGenRequest {
  const settings = resolveSearchSettings(undefined);
  return {
    mode: "hybrid",
    bm25Text: "harbour",
    embedderPresent: true,
    queryVector: new Float32Array(EMBEDDING_DIM).fill(0.1),
    embedMs: 0,
    queryModelId: null,
    filters: {},
    allowedDocumentIds: undefined,
    candidateLimit: settings.params.candidateLimit,
    limit: settings.params.resultLimit,
    settings,
    vectorConfig: resolveVectorConfig(undefined),
    sourcePriors: resolveSourcePriorsConfig(
      undefined,
      {},
      { docCounts: [], rrfK: settings.params.rrfK },
    ),
    diversity: resolveDiversityConfig(undefined),
    commonTokenThreshold: 0.1,
  };
}

describe.skipIf(process.platform === "win32")("SearchWorkerPool shutdown", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("a worker inside a native usearch call is not terminated before it acknowledges shutdown", async () => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-search-pool-shutdown-"));
    const indexDbPath = join(dir, "index.db");
    createIndexDatabase(indexDbPath).close();
    // With no generation adopted, the worker views the legacy graph path.
    const fifo = join(dir, "index.usearch");
    execFileSync("mkfifo", [fifo]);

    const host = spawn(
      process.execPath,
      [...SEARCH_WORKER.execArgv, "--input-type=module", "--eval", POOL_HOST_SOURCE],
      {
        env: {
          ...process.env,
          OMNESIS_LOG_LEVEL: "info",
          OMNESIS_LOG_FILE: "",
          SEARCH_POOL_SHUTDOWN_CASE: JSON.stringify({
            poolModule: new URL("./search-pool.ts", import.meta.url).href,
            indexDbPath,
            configDir: dir,
            workerUrl: SEARCH_WORKER.url.href,
            workerExecArgv: SEARCH_WORKER.execArgv,
          }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let exited = false;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      host.once("exit", (code, signal) => {
        exited = true;
        resolve({ code, signal });
      }),
    );
    const deadlineReported = new Promise<void>((resolve) => {
      host.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.includes(SHUTDOWN_DEADLINE_LINE)) resolve();
      });
      void exit.then(() => resolve());
    });
    host.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));

    await deadlineReported;
    await releaseFifo(fifo, () => exited);
    const { code, signal } = await exit;

    expect({
      code,
      signal,
      stdout,
      aborted: stderr.includes("terminate called"),
      deadlineReported: stderr.includes(SHUTDOWN_DEADLINE_LINE),
    }).toEqual({
      code: 0,
      signal: null,
      stdout: "disposed\n",
      aborted: false,
      deadlineReported: true,
    });
  }, 60_000);

  test("calls queued behind a running call are refused once the pool is stopping", async () => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-search-pool-shutdown-"));
    const indexDbPath = join(dir, "index.db");
    createIndexDatabase(indexDbPath).close();
    const pool = new SearchWorkerPool({
      indexDbPath,
      configDir: dir,
      concurrency: 1,
      // A worker held inside a native call misses its heartbeats, which the
      // pool notices after this gap.
      heartbeatIntervalMs: 20,
      heartbeatWarnGapMs: 200,
      workerUrl: SEARCH_WORKER.url,
      workerExecArgv: SEARCH_WORKER.execArgv,
    });
    await pool.start();
    // The worker started with no graph file; the next query views this one.
    const fifo = join(dir, "index.usearch");
    execFileSync("mkfifo", [fifo]);

    const running = pool.candidateGen(vectorRequest());
    const queued = [pool.candidateGen(vectorRequest()), pool.candidateGen(vectorRequest())];
    const settled = Promise.allSettled([running, ...queued]);
    const slot = (pool as unknown as { slots: Array<{ unresponsiveSince: number | null }> })
      .slots[0]!;
    while (slot.unresponsiveSince === null) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let stopped = false;
    const disposed = pool.dispose().finally(() => (stopped = true));
    // The running query holds the FIFO open for reading; had something else
    // stalled the worker before it took that query, it is refused like the
    // rest. Any query the worker runs views the FIFO again, so each is let
    // through until the pool has stopped.
    while (!stopped) await releaseFifo(fifo, () => stopped);
    await disposed;

    const [, ...behindIt] = await settled;
    expect(
      behindIt.map((outcome) =>
        outcome.status === "rejected" ? (outcome.reason as Error).message : "ran",
      ),
    ).toEqual(["search-worker shutting down", "search-worker shutting down"]);
  });
});
