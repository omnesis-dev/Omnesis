// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Recorder hook used by `retryOnBusy` to report retries to the gateway's
 * metrics registry. Set once at boot via `setBusyRetryRecorder` and
 * called with the optional caller-supplied `op` label on each retry.
 *
 * Module-level mutable state because `retryOnBusy` is on the hot path
 * inside repository code that doesn't want a metrics dependency in its
 * call sites — the alternative is threading a registry through every
 * write call signature, which adds noise for a counter that's a
 * one-line bump.
 */
let busyRetryRecorder: ((op?: string) => void) | null = null;

export function setBusyRetryRecorder(fn: ((op?: string) => void) | null): void {
  busyRetryRecorder = fn;
}

/**
 * Retry a required-to-succeed SQLite write through transient SQLITE_BUSY.
 *
 * The main-thread writes contend with the indexer + backfill workers. The
 * built-in `busy_timeout = 5000` already serializes most contention inside
 * SQLite, but during a heavy backfill-plus-indexing burst the 5 s window
 * can expire and the raw SQLITE_BUSY escapes — turning any unwrapped HTTP
 * write handler into a 500. `touchDevice` / `validateToken` swallow BUSY
 * because losing a heartbeat is harmless, but cursor / source / token
 * writes are *must-land*, so we retry with exponential backoff instead.
 *
 * `op` is an optional caller-supplied label that, when set, lets the
 * metrics snapshot break retries down by call site so the operator can
 * see which writer is burning the busy timeout.
 */
export function retryOnBusy<T>(
  fn: () => T,
  opts: { attempts?: number; initialBackoffMs?: number; op?: string } = {},
): T {
  const attempts = opts.attempts ?? 4;
  const initialBackoffMs = opts.initialBackoffMs ?? 50;
  let delay = initialBackoffMs;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code !== "SQLITE_BUSY" || i === attempts - 1) throw err;
      busyRetryRecorder?.(opts.op);
      sleepSync(delay);
      delay *= 2;
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new Error("retryOnBusy: exhausted without return");
}

/**
 * Synchronous sleep — used to back off through transient SQLITE_BUSY
 * inside a hot write path where making the whole call async would be
 * intrusive. Node has no `Bun.sleepSync`; `Atomics.wait` on an unset
 * Int32 on a SharedArrayBuffer yields the same "block this thread for
 * N ms" semantics.
 */
function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}
