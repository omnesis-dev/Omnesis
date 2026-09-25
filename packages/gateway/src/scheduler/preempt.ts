// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Preempt token: cooperative-yield signaling between Scheduler (main
 * thread) and a runner (worker thread).
 *
 * Backed by a SharedArrayBuffer with two Int32 slots. Slot 0 is the
 * preempt flag (0 = continue, 1 = yield ASAP). Slot 1 is reserved for
 * future use (e.g. encoding the priority of the waiter).
 *
 * The Scheduler:
 *   - Creates one PreemptBuffer per single-in-flight runner.
 *   - On enqueue, if the new task's priority strictly outranks the
 *     in-flight task's priority on the same runner, calls
 *     `requestYield()` which atomically writes 1 to slot 0.
 *   - Clears the flag (`reset()`) after the in-flight task completes.
 *
 * The runner (in the worker thread):
 *   - Wraps the SharedArrayBuffer view as a `PreemptToken` and passes
 *     it to the task's TaskContext.
 *   - The task polls `token.requested()` inside loops; if true, it
 *     COMMITs the current SAVEPOINT and returns a yield outcome.
 *
 * The 4-byte alignment + Atomics gives us synchronization without a
 * postMessage round-trip per check. Reads are ~1ns on modern CPUs.
 */

const FLAG_SLOT = 0;
const RESERVED_SLOT = 1;
const BUFFER_SIZE_BYTES = 8;

/**
 * Main-thread handle: lets the Scheduler request a yield and reset
 * the flag. Owns the underlying SharedArrayBuffer.
 */
export class PreemptBuffer {
  private readonly buffer: SharedArrayBuffer;
  private readonly view: Int32Array;

  constructor() {
    this.buffer = new SharedArrayBuffer(BUFFER_SIZE_BYTES);
    this.view = new Int32Array(this.buffer);
  }

  /** Hand to a worker via postMessage's transferList-style sharing. */
  share(): SharedArrayBuffer {
    return this.buffer;
  }

  /** Set the flag; the worker's next shouldYield() will return true. */
  requestYield(): void {
    Atomics.store(this.view, FLAG_SLOT, 1);
  }

  /** Clear the flag — call after the in-flight task completes. */
  reset(): void {
    Atomics.store(this.view, FLAG_SLOT, 0);
    Atomics.store(this.view, RESERVED_SLOT, 0);
  }

  /** True if a yield was requested and not yet reset. */
  isRequested(): boolean {
    return Atomics.load(this.view, FLAG_SLOT) === 1;
  }
}

/**
 * Worker-thread handle: read-only check.
 *
 * Composed with the per-task latency budget (deadline) inside the
 * runner — the runner's TaskContext combines `token.requested()` with
 * `elapsed > budget` to produce the final shouldYield() answer.
 */
export class PreemptToken {
  private readonly view: Int32Array;
  constructor(buffer: SharedArrayBuffer) {
    if (buffer.byteLength < BUFFER_SIZE_BYTES) {
      throw new Error(
        `PreemptToken: buffer too small (${buffer.byteLength} < ${BUFFER_SIZE_BYTES})`,
      );
    }
    this.view = new Int32Array(buffer);
  }

  /** True if the Scheduler has requested a yield. */
  requested(): boolean {
    return Atomics.load(this.view, FLAG_SLOT) === 1;
  }
}
