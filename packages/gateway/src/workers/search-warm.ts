// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Main-thread side of the boot search-cache warm.
 *
 * `prewarmFtsCaches` is three synchronous full-table scans over `index.db`
 * that take tens of seconds on a large corpus. Run on the main thread they
 * are one macrotask that stalls every HTTP request, WebSocket frame and
 * worker heartbeat for their whole duration, so the gateway hosts them on a
 * throwaway worker thread instead: `search-warm-worker.ts` opens its own
 * read-only handle, runs the scans, closes the handle and exits. What
 * survives it is the kernel page cache, which every other `index.db` reader
 * — the search workers above all — shares.
 *
 * The thread is `unref`'d so an in-progress warm never delays process exit,
 * and `terminate()` lets shutdown stop one that is still scanning.
 */

import { Worker } from "node:worker_threads";
import type { PrewarmOutcome } from "../indexer/db.js";

/** Everything the warm thread needs, handed over as `workerData`. */
export interface SearchWarmInit {
  /** Path to the on-disk `index.db` the thread opens read-only. */
  indexDbPath: string;
  /** Hex encryption key for `index.db` under storage encryption (omitted when off). */
  indexDbKeyHex?: string;
  /** `mmap_size` for the throwaway handle. */
  mmapBytes: number;
  /** Page-cache budget in bytes for the throwaway handle. */
  cacheSizeBytes: number;
  /** OS nice for the scanning thread (resolved on the main thread). */
  backgroundWorkerNice: number;
}

export type SearchWarmToMain =
  | { type: "done"; outcome: SearchCacheWarmOutcome }
  | { type: "error"; error: string };

export interface SearchCacheWarmOptions extends SearchWarmInit {
  workerUrl: URL;
  workerExecArgv?: string[];
}

export interface SearchCacheWarmOutcome extends PrewarmOutcome {
  /** Wall-clock ms from thread start to the scans finishing. */
  ms: number;
  /** `worker_threads` id of the thread that ran the scans — never the main thread's 0. */
  threadId: number;
}

export interface SearchCacheWarm {
  /** Resolves when every scan has run; rejects when the thread fails or dies first. */
  readonly done: Promise<SearchCacheWarmOutcome>;
  /** Stop a warm still in progress. Idempotent; `done` rejects once the thread is gone. */
  terminate(): Promise<void>;
}

/** Spawn the warm thread. Returns at once; the scans run entirely off this thread. */
export function startSearchCacheWarm(opts: SearchCacheWarmOptions): SearchCacheWarm {
  const { workerUrl, workerExecArgv, ...init } = opts;
  const workerData: SearchWarmInit = init;
  const worker = new Worker(workerUrl, { execArgv: workerExecArgv ?? [], workerData });
  worker.unref();

  let resolveDone!: (outcome: SearchCacheWarmOutcome) => void;
  let rejectDone!: (err: Error) => void;
  const done = new Promise<SearchCacheWarmOutcome>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // A caller may `terminate()` before it has attached a handler; the outcome
  // is still theirs to read, but never an unhandled rejection.
  done.catch(() => {});
  let settled = false;
  const settle = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    fn();
  };
  worker.on("message", (msg: SearchWarmToMain) => {
    settle(() => {
      if (msg.type === "done") resolveDone(msg.outcome);
      else rejectDone(new Error(msg.error));
    });
  });
  worker.on("error", (err) => settle(() => rejectDone(err)));
  worker.on("exit", (code) =>
    settle(() =>
      rejectDone(new Error(`search warm worker exited before reporting (code=${code})`)),
    ),
  );

  return {
    done,
    terminate: async () => {
      // Settle first so the caller reads a deliberate stop, not a fault.
      settle(() => rejectDone(new Error("search cache pre-warm stopped before it finished")));
      await worker.terminate().catch(() => {});
    },
  };
}
