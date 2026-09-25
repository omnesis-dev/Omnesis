// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Worker } from "node:worker_threads";
import { createLogger, resolveWorkerEntry, createPrivateScratch } from "@omnesis/core";
import { type ImportCallbacks, type ImportSummary } from "@omnesis/source-sdk";
import type { MessageStore } from "../message-store.js";
import type { ImportWorkerData, WorkerMessage } from "./import-worker.js";

const log = createLogger("whatsapp:import");

/** Messages parsed + merged per worker batch / store transaction. */
const MERGE_BATCH = 2_000;

export interface ImportOptions {
  /** Path to the encrypted iPhone backup folder (contains Manifest.plist). */
  backupPath: string;
  /** Backup password. */
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
 * One-time WhatsApp full-history import from a local encrypted iOS backup (#588).
 * The heavy decrypt + parse runs in a worker thread (off the collector's main
 * loop); this parent merges the streamed batches into the durable store by
 * stable id, so dirty-day marking + the normal sync drain publish the result.
 * Cancellation (`callbacks.signal`) terminates the worker.
 *
 * This is the iOS-backup variant. Planned siblings emit the same batches into
 * the same merge: #591 (Android crypt15 backup), #590 (Tier-2 targeted pull).
 */
export async function importWhatsAppHistory(opts: ImportOptions): Promise<ImportSummary> {
  const { backupPath, passphrase, store, own, callbacks } = opts;
  const onProgress = callbacks?.onProgress;
  const signal = callbacks?.signal;
  const batchSize = opts.batchSize ?? MERGE_BATCH;
  if (signal?.aborted) throw new Error("Import cancelled");

  const scratch = createPrivateScratch("wa-chatstorage");
  try {
    const workerData: ImportWorkerData = {
      backupPath,
      passphrase,
      own,
      batchSize,
      scratchPath: scratch.path,
    };
    const entry = resolveWorkerEntry("./import-worker.ts", import.meta.url, "./register-tsx.mjs");
    const worker = new Worker(entry.url, { execArgv: entry.execArgv, workerData });

    let imported = 0;
    let merged = 0;
    let skipped = 0;
    let total: number | undefined;
    let onAbort: (() => void) | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        onAbort = () => reject(new Error("Import cancelled"));
        if (signal) signal.addEventListener("abort", onAbort, { once: true });

        worker.on("message", (msg: WorkerMessage) => {
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
              skipped = msg.skipped;
              resolve();
            } else if (msg.type === "error") {
              reject(new Error(msg.message));
            }
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code !== 0) reject(new Error(`import worker exited with code ${code}`));
        });
      });
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      await worker.terminate();
    }

    log.info(
      `Backup import complete: ${imported} new, ${merged} already present, ${skipped} skipped`,
    );
    return { imported, merged, skipped };
  } finally {
    // Worker termination must complete before deleting its plaintext files.
    scratch.cleanup();
  }
}
