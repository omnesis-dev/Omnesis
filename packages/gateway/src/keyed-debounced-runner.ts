// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Keyed debounced runner — shared machinery for "coalesce a burst of
 * signals per key into one async run at the end of an idle window".
 * Used by the omnesis-chat conversation upserter (key = session id) and
 * the omnesis-notes day-document upserter (key = day).
 *
 * Semantics:
 *   - `enqueue(key)` (re)arms a per-key debounce timer; repeated
 *     enqueues for the same key coalesce into one timer. Timers are
 *     unref'd so a pending run never keeps the process alive.
 *   - When a timer fires, `run(key)` executes on a per-key promise
 *     chain (`inflight` map): at most one run per key is ever executing
 *     at a time, and a run scheduled while another is in flight chains
 *     behind it rather than running concurrently.
 *   - `flush(key)` runs a pending run now; with nothing pending it
 *     still awaits any in-flight run so callers can rely on quiescence.
 *   - `cancelPending(key)` drops a pending timer without running AND
 *     awaits any already-started run — after it resolves, no further
 *     runs happen for `key` until a new `enqueue`.
 *   - `flushAll()` flushes every pending key and awaits every straggler
 *     in-flight run (the shutdown entry point).
 *   - `dispose()` cancels all timers and refuses further enqueues; it
 *     does NOT await in-flight runs — pair with `flushAll()` first when
 *     graceful shutdown matters.
 *
 * A rejected `run` is reported through `onError` (or swallowed when no
 * handler is given) and never breaks the key's chain — a subsequent
 * enqueue for the same key still runs.
 */

export interface KeyedDebouncedRunnerDeps {
  /** Idle window between the last `enqueue(key)` and its run. */
  debounceMs: number;
  /** Pluggable timer for unit tests. Defaults to unref'd setTimeout. */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  /**
   * The debounced work. Owns all per-key state loading — the runner
   * only tells it *which* key fired, at fire time, so the run always
   * sees the freshest state for the key.
   */
  run: (key: string) => Promise<void>;
  /** Called when a run rejects. The key's chain continues either way. */
  onError?: (key: string, err: unknown) => void;
}

export class KeyedDebouncedRunner {
  private readonly deps: KeyedDebouncedRunnerDeps;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  /** Pending debounce timers keyed by key. */
  private readonly pending = new Map<string, unknown>();
  /**
   * In-flight run promises keyed by key. Used to serialize concurrent
   * enqueues / flushes on the same key and to give `cancelPending` /
   * `flushAll` something to await so they can't race the actual work.
   */
  private readonly inflight = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(deps: KeyedDebouncedRunnerDeps) {
    this.deps = deps;
    this.schedule = deps.scheduler?.setTimeout ?? ((fn, ms) => setTimeoutUnref(fn, ms));
    this.cancel =
      deps.scheduler?.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Schedule a run for `key` after the debounce window. Subsequent
   * enqueues for the same key cancel the prior timer and install a new
   * one.
   */
  enqueue(key: string): void {
    if (this.disposed) return;
    const existing = this.pending.get(key);
    if (existing !== undefined) this.cancel(existing);
    const handle = this.schedule(() => {
      this.pending.delete(key);
      void this.startRun(key);
    }, this.deps.debounceMs);
    this.pending.set(key, handle);
  }

  /**
   * Run the pending work for `key` now and await it. Idempotent — no
   * pending timer means no new run (but any in-flight run still gets
   * awaited so callers can rely on quiescence on return).
   */
  async flush(key: string): Promise<void> {
    const handle = this.pending.get(key);
    if (handle !== undefined) {
      this.cancel(handle);
      this.pending.delete(key);
      await this.startRun(key);
      return;
    }
    const inflight = this.inflight.get(key);
    if (inflight) await inflight;
  }

  /**
   * Drop the pending timer for one key without running AND await any
   * already-started run. After this resolves, no further runs happen
   * for `key` until a new `enqueue` arrives.
   */
  async cancelPending(key: string): Promise<void> {
    const handle = this.pending.get(key);
    if (handle !== undefined) {
      this.cancel(handle);
      this.pending.delete(key);
    }
    const inflight = this.inflight.get(key);
    if (inflight) await inflight;
  }

  /**
   * Flush every pending key and await every in-flight run. Shutdown
   * hook — call this before `dispose()` so work that landed within the
   * debounce window before SIGTERM still runs.
   */
  async flushAll(): Promise<void> {
    const keys = [...this.pending.keys()];
    await Promise.all(keys.map((key) => this.flush(key)));
    // After flushing, await any straggler runs that flush itself didn't
    // know about (an in-flight run that started before flushAll was called).
    const stragglers = [...this.inflight.values()];
    if (stragglers.length > 0) await Promise.all(stragglers);
  }

  /**
   * Cancel every pending timer and refuse further enqueues. Does NOT
   * await in-flight runs — pair with `flushAll()` before this when
   * graceful shutdown matters.
   */
  dispose(): void {
    this.disposed = true;
    for (const [, handle] of this.pending) this.cancel(handle);
    this.pending.clear();
  }

  /** Visible for tests. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Visible for tests. */
  inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * Start `run(key)` and record the promise in `inflight` so concurrent
   * enqueues / flushes serialize behind it. Each key's runs chain on the
   * prior — at most one run per key is ever executing at a time.
   */
  private startRun(key: string): Promise<void> {
    const prior = this.inflight.get(key) ?? Promise.resolve();
    const next = prior
      .catch(() => {
        /* prior failure already reported; this chain continues */
      })
      .then(() => this.deps.run(key))
      .catch((err) => {
        this.deps.onError?.(key, err);
      })
      .finally(() => {
        // Only clear the inflight slot if the value still points at us
        // — a concurrent startRun may have replaced it.
        if (this.inflight.get(key) === next) this.inflight.delete(key);
      });
    this.inflight.set(key, next);
    return next;
  }
}

function setTimeoutUnref(fn: () => void, ms: number): unknown {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return t;
}
