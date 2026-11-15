// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Worker } from "node:worker_threads";
import {
  createLogger,
  resolveWorkerEntry,
  createPrivateScratch,
  ownedProcessCleanupReceipt,
} from "@omnesis/core";
import { type ImportCallbacks, type ImportSummary } from "@omnesis/source-sdk";
import type { MessageStore } from "../message-store.js";
import type { BackupKind, ImportWorkerData, WorkerMessage } from "./import-worker.js";

export type { BackupKind };

const log = createLogger("whatsapp:import");

/** Messages parsed + merged per worker batch / store transaction. */
const MERGE_BATCH = 2_000;

export interface ImportOptions {
  /** Which backup format to decrypt + parse. */
  backupKind: BackupKind;
  /** iOS: the encrypted backup folder (contains Manifest.plist). Android: the `msgstore.db.crypt15` file. */
  backupPath: string;
  /** iOS: the backup password. Android: the 64-hex backup key, or a path to a key file. */
  passphrase: string;
  /** The provider's durable store — the merge target (parent is the single writer). */
  store: MessageStore;
  /** The account's own JID + display name, for `from_me` rows. */
  own: { jid: string; name: string };
  callbacks?: ImportCallbacks;
  /** Override the per-batch size (tests). */
  batchSize?: number;
}

/**
 * One-time WhatsApp full-history import from a local encrypted iOS backup.
 * The heavy decrypt + parse runs in a worker thread (off the collector's main
 * loop); this parent merges the streamed batches into the durable store by
 * stable id, so dirty-day marking + the normal sync drain publish the result.
 * Cancellation (`callbacks.signal`) terminates the worker.
 *
 * Supports two backup kinds (see {@link BackupKind}): the iOS-backup variant
 * and the Android crypt15 variant (#29) — both emit the same batch shape
 * into the same merge below. Planned sibling: #28 (Tier-2 targeted pull).
 */
export async function importWhatsAppHistory(opts: ImportOptions): Promise<ImportSummary> {
  const { backupKind, backupPath, passphrase, store, own, callbacks } = opts;
  const onProgress = callbacks?.onProgress;
  const signal = callbacks?.signal;
  const batchSize = opts.batchSize ?? MERGE_BATCH;
  if (signal?.aborted) throw new Error("Import cancelled");

  const scratch = createPrivateScratch("wa-chatstorage");
  let workerJoined = true;
  let cleanupUncertain = false;
  try {
    const workerData: ImportWorkerData = {
      backupKind,
      backupPath,
      passphrase,
      own,
      batchSize,
      scratchPath: scratch.path,
      cancel: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    };
    const entry = resolveWorkerEntry("./import-worker.ts", import.meta.url, "./register-tsx.mjs");
    const worker = new Worker(entry.url, { execArgv: entry.execArgv, workerData });
    workerJoined = false;
    const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
    let exitCode: number | undefined;
    let workerError: Error | undefined;

    let imported = 0;
    let merged = 0;
    let skipped = 0;
    let total: number | undefined;
    let onAbort: (() => void) | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        let accepting = true;
        const fail = (error: unknown): void => {
          if (!accepting) return;
          accepting = false;
          reject(error);
        };
        onAbort = () => {
          Atomics.store(workerData.cancel, 0, 1);
          fail(new Error("Import cancelled"));
        };
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();

        worker.on("message", (msg: WorkerMessage) => {
          if (!accepting) return;
          try {
            if (msg.type === "progress") {
              if (msg.phase === "parse" && msg.total != null) total = msg.total;
              onProgress?.(msg);
            } else if (msg.type === "batch") {
              const res = store.importMessages(msg.messages);
              imported += res.imported;
              merged += res.merged;
              onProgress?.({ phase: "merge", processed: imported + merged, total });
            } else if (msg.type === "done") {
              accepting = false;
              skipped = msg.skipped;
              resolve();
            } else if (msg.type === "error") {
              fail(new Error(msg.message));
            } else if (msg.type === "cancelled") {
              fail(new Error("Import cancelled"));
            }
          } catch (err) {
            fail(err);
          }
        });
        worker.on("error", (error: Error) => {
          workerError = error;
          fail(error);
        });
        worker.on("exit", (code) => {
          fail(
            new Error(
              code === 0
                ? "import worker exited without a completion result"
                : `import worker exited with code ${code}`,
            ),
          );
        });
      });
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      exitCode = await stopWorker(worker, workerData.cancel, exited);
      workerJoined = true;
    }

    if (workerError) throw workerError;
    if (exitCode !== 0) throw new Error(`import worker exited with code ${exitCode}`);
    log.info(
      `Backup import complete: ${imported} new, ${merged} already present, ${skipped} skipped`,
    );
    return { imported, merged, skipped };
  } catch (error) {
    cleanupUncertain = ownedProcessCleanupReceipt(error) !== undefined;
    throw error;
  } finally {
    // Worker termination must complete before deleting its plaintext files.
    if (workerJoined && !cleanupUncertain) scratch.cleanup();
  }
}

/** How long a worker asked to stop has to end on its own before it is terminated. */
const WORKER_STOP_MS = 10_000;

/**
 * End the worker: ask it to stop and wait for it to exit, which it does
 * between batches with its database closed. Only a worker that does not stop
 * in time is terminated, since terminating one inside a native SQLite call can
 * abort the process.
 */
async function stopWorker(
  worker: Worker,
  cancel: Int32Array,
  exited: Promise<number>,
): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  try {
    Atomics.store(cancel, 0, 1);
    const stopped = await Promise.race([
      exited.then((code) => ({ code })),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), WORKER_STOP_MS);
      }),
    ]);
    if (stopped) return stopped.code;
    await worker.terminate();
    return await exited;
  } catch (error) {
    const receipt = ownedProcessCleanupReceipt(error);
    throw Object.assign(new Error("Import worker cleanup is unconfirmed", { cause: error }), {
      cleanupFailure: receipt ? receipt.failure : error,
    });
  } finally {
    clearTimeout(timer);
  }
}
