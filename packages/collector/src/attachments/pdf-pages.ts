// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Worker } from "node:worker_threads";
import { createLogger, resolveWorkerEntry } from "@omnesis/core";
import type { PdfPagesReply, PdfPagesRequest } from "./pdf-worker.js";

const log = createLogger("attachments:pdf");

/** A PDF still being read after this long is given up and its worker replaced. */
export const PDF_READ_TIMEOUT_MS = 120_000;

/** The worker exits after this long without a file, returning its memory. */
const IDLE_SHUTDOWN_MS = 60_000;

interface PdfWorker {
  thread: Worker;
  /** Whether the thread started: a failure before that is the host's, not the file's. */
  online: boolean;
  failure?: Error;
}

let current: PdfWorker | null = null;
let idleTimer: NodeJS.Timeout | undefined;
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;

/**
 * Per-page native text of a PDF, read in a worker thread: one entry per page
 * ("" for a page without text), or null when the file cannot be read at all
 * (encrypted, corrupt, not a PDF, or the parser died or ran out of time on it).
 *
 * The parser runs off the main thread because pdf.js leaves promises that
 * reject after it has given a corrupt file up (see `pdf-worker.ts`); there they
 * are harmless, here they would be unhandled rejections. Files are read one at
 * a time, so a file that kills the worker fails only itself. Rejects only when
 * the worker cannot be started at all — a fault of the install, not the file.
 */
export function readPdfPages(
  data: Uint8Array,
  opts?: { timeoutMs?: number },
): Promise<string[] | null> {
  const run = queue.then(() => readInWorker(data, opts?.timeoutMs ?? PDF_READ_TIMEOUT_MS));
  queue = run.catch(() => undefined);
  return run;
}

function spawn(): PdfWorker {
  const entry = resolveWorkerEntry("./pdf-worker.ts", import.meta.url, "../register-tsx.mjs");
  const thread = new Worker(entry.url, { execArgv: entry.execArgv });
  // An idle parser must not keep the collector alive on shutdown.
  thread.unref();
  const handle: PdfWorker = { thread, online: false };
  thread.once("online", () => (handle.online = true));
  thread.on("error", (err) => (handle.failure = err));
  thread.once("exit", () => {
    if (current === handle) current = null;
  });
  return handle;
}

function retire(handle: PdfWorker): void {
  if (current === handle) current = null;
  void handle.thread.terminate();
}

function readInWorker(data: Uint8Array, timeoutMs: number): Promise<string[] | null> {
  clearTimeout(idleTimer);
  const handle = (current ??= spawn());
  const id = ++nextId;
  // A copy, transferred: the caller keeps its bytes for OCR.
  const bytes = new Uint8Array(data);
  return new Promise<string[] | null>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      handle.thread.off("message", onMessage);
      handle.thread.off("exit", onExit);
      idleTimer = setTimeout(() => current && retire(current), IDLE_SHUTDOWN_MS);
      idleTimer.unref();
    };
    const onMessage = (reply: PdfPagesReply) => {
      if (reply.id !== id) return;
      finish();
      if (!reply.ok) {
        if (/encrypt|password/i.test(reply.message)) {
          log.warn(`PDF is encrypted (${data.length} bytes): ${reply.message}`);
        } else {
          log.warn(`PDF unreadable (${data.length} bytes): ${reply.message}`);
        }
        resolve(null);
        return;
      }
      if (reply.failedPages > 0) {
        log.warn(
          `PDF read with ${reply.failedPages} of ${reply.pages.length} page(s) unreadable (${data.length} bytes)`,
        );
      }
      resolve(reply.pages.length > 0 ? reply.pages : null);
    };
    const onExit = () => {
      finish();
      const reason = handle.failure?.message ?? "exited";
      if (!handle.online) {
        reject(new Error(`PDF worker failed to start: ${reason}`));
        return;
      }
      log.warn(`PDF parser died reading ${data.length} bytes, leaving it unextracted: ${reason}`);
      resolve(null);
    };
    const timer = setTimeout(() => {
      finish();
      retire(handle);
      log.warn(
        `PDF still unread after ${Math.round(timeoutMs / 1000)}s (${data.length} bytes), leaving it unextracted`,
      );
      resolve(null);
    }, timeoutMs);
    handle.thread.on("message", onMessage);
    handle.thread.once("exit", onExit);
    handle.thread.postMessage({ id, data: bytes } satisfies PdfPagesRequest, [bytes.buffer]);
  });
}
