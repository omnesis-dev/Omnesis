// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Worker thread for the WhatsApp history import (#588). Runs the CPU/IO-heavy
 * decrypt + parse off the collector's main loop so a large import never blocks
 * live sync; the parent merges the streamed batches into the store (keeping the
 * single-writer invariant). Cancellation is the parent calling `worker.terminate()`.
 *
 * Protocol (worker → parent), see WorkerMessage:
 *   { type: "progress", ... }   periodic progress
 *   { type: "batch", messages } a chunk of parsed messages to merge
 *   { type: "done", skipped }   terminal success
 *   { type: "error", message }  terminal failure
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { decryptChatStorage } from "./ios-backup-decrypt.js";
import { parseChatStorage } from "./chatstorage-parser.js";
import type { StoredMessage } from "../types.js";
import type { ImportProgress } from "@omnesis/source-sdk";

export interface ImportWorkerData {
  backupPath: string;
  passphrase: string;
  own: { jid: string; name: string };
  batchSize: number;
  scratchPath: string;
}

export type WorkerMessage =
  | ({ type: "progress" } & ImportProgress)
  | { type: "batch"; messages: StoredMessage[] }
  | { type: "done"; skipped: number }
  | { type: "error"; message: string };

const data = workerData as ImportWorkerData;
const port = parentPort;

function post(msg: WorkerMessage): void {
  port?.postMessage(msg);
}

try {
  post({ type: "progress", phase: "decrypt", processed: 0, detail: "Decrypting backup…" });
  const chatStorageBytes = decryptChatStorage(data.backupPath, data.passphrase, data.scratchPath);
  post({ type: "progress", phase: "decrypt", processed: 1, total: 1 });

  {
    const dbPath = join(data.scratchPath, "ChatStorage.sqlite");
    writeFileSync(dbPath, chatStorageBytes, { mode: 0o600 });

    post({ type: "progress", phase: "parse", processed: 0, detail: "Reading messages…" });
    const { messages, skipped } = parseChatStorage(dbPath, data.own);
    post({ type: "progress", phase: "parse", processed: messages.length, total: messages.length });

    for (let i = 0; i < messages.length; i += data.batchSize) {
      post({ type: "batch", messages: messages.slice(i, i + data.batchSize) });
    }
    post({ type: "done", skipped });
  }
} catch (err) {
  post({ type: "error", message: err instanceof Error ? err.message : String(err) });
}
