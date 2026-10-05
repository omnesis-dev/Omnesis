// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Main-thread side of the lexical index build.
 *
 * Building the in-memory lexical index reads every FTS5 posting once — about a
 * minute of synchronous work on a large corpus — so it runs on a throwaway,
 * deprioritized worker thread with its own read-only `index.db` handle. The
 * worker allocates the index on `SharedArrayBuffer`s and posts it back; posting
 * shares the memory rather than copying it, and the same arrays then go to
 * every search worker.
 */

import { Worker } from "node:worker_threads";
import type { LexicalIndexData } from "../search/lexical-index-data.js";

/** Everything the build thread needs, handed over as `workerData`. */
export interface LexicalIndexBuildInit {
  /** Path to the on-disk `index.db` the thread opens read-only. */
  indexDbPath: string;
  /** Hex encryption key for `index.db` under storage encryption (omitted when off). */
  indexDbKeyHex?: string;
  /** Page-cache budget in bytes for the throwaway handle. */
  cacheSizeBytes: number;
  /** OS nice for the building thread (resolved on the main thread). */
  backgroundWorkerNice: number;
}

export type LexicalIndexBuildToMain =
  | { type: "done"; data: LexicalIndexData; ms: number }
  | { type: "error"; error: string };

export interface LexicalIndexBuildOptions extends LexicalIndexBuildInit {
  workerUrl: URL;
  workerExecArgv?: string[];
}

export interface LexicalIndexBuild {
  /** Resolves with the built index; rejects when the thread fails or dies first. */
  readonly done: Promise<{ data: LexicalIndexData; ms: number }>;
  /** Stop a build still in progress. Idempotent. */
  terminate(): Promise<void>;
}

/** Spawn the build thread. Returns at once; the build runs entirely off this thread. */
export function startLexicalIndexBuild(opts: LexicalIndexBuildOptions): LexicalIndexBuild {
  const { workerUrl, workerExecArgv, ...init } = opts;
  const workerData: LexicalIndexBuildInit = init;
  const worker = new Worker(workerUrl, { execArgv: workerExecArgv ?? [], workerData });
  worker.unref();

  let settled = false;
  let resolveDone!: (v: { data: LexicalIndexData; ms: number }) => void;
  let rejectDone!: (err: Error) => void;
  const done = new Promise<{ data: LexicalIndexData; ms: number }>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const settle = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    fn();
  };
  worker.on("message", (msg: LexicalIndexBuildToMain) => {
    settle(() => {
      if (msg.type === "done") resolveDone({ data: msg.data, ms: msg.ms });
      else rejectDone(new Error(msg.error));
    });
  });
  worker.on("error", (err) => settle(() => rejectDone(err)));
  worker.on("exit", (code) =>
    settle(() =>
      rejectDone(new Error(`lexical index build exited before reporting (code=${code})`)),
    ),
  );

  return {
    done,
    terminate: async () => {
      settle(() => rejectDone(new Error("lexical index build stopped before it finished")));
      await worker.terminate().catch(() => {});
    },
  };
}
