// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Near-dup inbox flush — coalesces the per-document near-dup enqueues that
 * the event-bus subscriber (`near-dupes/event-handler.ts`) produces into
 * batched, background-priority `near_dup_inbox` inserts. See #555.
 *
 * Why the indirection (buffer + periodic task) instead of enqueuing inline:
 *   - `document.upserted` is emitted synchronously inside the originating
 *     request's `runWithPriority("realtime")` scope (collector ingest). A
 *     writer op dispatched from that synchronous context inherits realtime
 *     (priority resolves as `options.priority ?? getActivePriority() ??
 *     task.priority` in `scheduler/core.ts`), which would defeat this op's
 *     declared `background` priority and make it compete with the actual
 *     document writes — under bulk ingest that parks `/search` and
 *     `/sync-state`. So the enqueue must NOT happen on the event path.
 *   - The subscriber only does an in-memory `buffer.add(docId, reason)`.
 *     This PeriodicTask drains the buffer outside any request ALS scope,
 *     where `getActivePriority()` is null, so the op runs at its declared
 *     `background` priority and yields to realtime/user writes. It also
 *     coalesces: one writer op per `chunkSize` doc ids rather than one per
 *     doc. Mirrors the `TokenUsageBuffer` + `tokenUsageFlushTask` shape.
 *   - Under a large ingest burst the background flush drains at roughly the
 *     scheduler's anti-starvation rate (it yields to realtime), so near-dup
 *     edge population trails the import — recovered fully, just not
 *     promptly. That lag is fine: edges aren't user-latency-critical.
 *
 * Durability. Enqueues are best-effort. A failed flush chunk is re-buffered
 * for the next tick (so a transient writer stall retries rather than drops).
 * `flushNow()` drains the buffer on graceful (SIGTERM/SIGINT) shutdown, so a
 * clean restart loses nothing. An *ungraceful* crash (kill -9 / OOM) loses
 * whatever was buffered-but-not-yet-flushed (≤ one active flush interval of
 * ingested docs); there is no signature-coverage reconciler, so those docs
 * regain a near-dup signature only when `bumpNearDupAlgo` next re-enqueues
 * the whole corpus — i.e. on an algo-version change, not on a same-version
 * restart. That gap (and a durable backstop for it) is tracked in #556.
 */

import { QueueTracker } from "../../background-jobs/trackers.js";
import { periodicJob } from "../../background-jobs/scheduler-job.js";
import type { Logger } from "@omnesis/core";
import type { BackgroundJob } from "../../background-jobs/types.js";
import type { Scheduler } from "../scheduler.js";
import type { WriteGate } from "../../write-gate.js";
import type { NearDupInboxReason } from "../../near-dupes/inbox.js";
import type { PeriodicTask, TaskOutcome } from "../types.js";

/** Active flush cadence (buffer non-empty). */
const DEFAULT_INTERVAL_MS = 1_000;
/** Idle flush cadence (buffer empty) — back off so we don't wake every 1s for nothing. */
const DEFAULT_IDLE_MS = 15_000;
/** Doc ids per writer op. Keeps each background enqueue short so it yields. */
const DEFAULT_CHUNK_SIZE = 1_000;
/**
 * Max pending ids before new adds are dropped. Bounds memory if the writer
 * stays saturated with realtime work for a long stretch (anti-starvation
 * still drains the flush eventually, so this is a safety ceiling, not a
 * normal operating point). Document ids are short strings, so at the cap
 * the buffer is on the order of ~100 MB — bounded, never a normal state.
 * Drops are recovered at the next algo-bump bulk re-enqueue (see #556).
 */
const DEFAULT_CAP = 500_000;

export interface NearDupInboxBuffer {
  /** Record a doc for near-dup enqueue. In-memory, deduped per (reason, docId). */
  add(docId: string, reason: NearDupInboxReason): void;
  /** Drain pending ids grouped by reason. Clears the buffer. */
  drain(): Array<{ reason: NearDupInboxReason; docIds: string[] }>;
  /** Total pending ids across all reasons (for the tracker + tests). */
  size(): number;
}

export interface NearDupInboxBufferOpts {
  /** Max total pending ids before new adds drop. Default 500_000. */
  cap?: number;
  /** When set, a rate-limited warn fires while drops are happening. */
  log?: Logger;
}

export function createNearDupInboxBuffer(opts: NearDupInboxBufferOpts = {}): NearDupInboxBuffer {
  const cap = opts.cap ?? DEFAULT_CAP;
  const log = opts.log;
  /** reason → set of pending doc ids. Matches the `(doc_id, reason)` dedup index. */
  const pending = new Map<NearDupInboxReason, Set<string>>();
  let total = 0;
  let droppedSinceWarn = 0;
  // -Infinity so the first drop always warns (any real/fake clock - (-Inf) > window).
  let lastDropWarnAt = Number.NEGATIVE_INFINITY;

  return {
    add(docId, reason) {
      const set = pending.get(reason);
      // Already buffered under this reason → no-op. Checked before the cap
      // gate so a re-add at capacity is a dedup hit, not a counted drop.
      if (set?.has(docId)) return;
      if (total >= cap) {
        droppedSinceWarn++;
        const now = Date.now();
        // Reset the throttle window regardless of whether a logger is
        // present, so `droppedSinceWarn` can't grow unbounded without one.
        if (now - lastDropWarnAt > 10_000) {
          if (log) {
            log.warn(
              `near-dup inbox buffer at cap (${cap}); dropped ${droppedSinceWarn} enqueues since last warn — recovered at next algo bump`,
            );
          }
          lastDropWarnAt = now;
          droppedSinceWarn = 0;
        }
        return;
      }
      if (set) {
        set.add(docId);
      } else {
        pending.set(reason, new Set<string>([docId]));
      }
      total++;
    },
    drain() {
      const out: Array<{ reason: NearDupInboxReason; docIds: string[] }> = [];
      for (const [reason, set] of pending) {
        if (set.size > 0) out.push({ reason, docIds: Array.from(set) });
      }
      pending.clear();
      total = 0;
      return out;
    },
    size() {
      return total;
    },
  };
}

interface IdleResult {
  idle: boolean;
}

export interface NearDupInboxFlushOpts {
  buffer: NearDupInboxBuffer;
  writeGate: Pick<WriteGate, "enqueueNearDupInbox">;
  log: Logger;
  /** Active flush cadence. Default 1_000ms. */
  intervalMs?: number;
  /** Idle cadence when the buffer is empty. Default 15_000ms. */
  idleMs?: number;
  /** Doc ids per writer op. Default 1_000. */
  chunkSize?: number;
}

export interface NearDupInboxFlushBundle {
  task: PeriodicTask<unknown, IdleResult>;
  job: BackgroundJob;
  /** Drain + enqueue everything now. Used on graceful shutdown. */
  flushNow(): Promise<void>;
}

/**
 * Build the flush task + its BackgroundJob. The returned `flushNow` lets
 * the shutdown coordinator drain the buffer while the writer is still
 * alive, so a graceful restart never loses buffered ids.
 */
export function nearDupInboxFlushTask(
  opts: NearDupInboxFlushOpts,
  scheduler: Scheduler,
): NearDupInboxFlushBundle {
  const { buffer, writeGate, log } = opts;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const tracker = new QueueTracker({ initialRemaining: buffer.size() });

  // Drain the buffer and dispatch coalesced, chunked enqueues. Each chunk
  // is one background writer op; awaiting between chunks lets the scheduler
  // interleave realtime/user writes (the whole point of the fix).
  //
  // `hadWork` reflects whether the buffer was non-empty — it drives the
  // active-vs-idle cadence and must NOT depend on enqueue success, or a
  // transient writer error mid-ingest would back the flush off to the idle
  // cadence while docs keep arriving. `flushed` counts only ids that landed,
  // for the throughput tracker. A failed chunk is re-buffered (capped) so
  // the next active tick retries it — a transient writer stall (the #555
  // condition) must not silently drop near-dup coverage. The per-chunk
  // try/catch keeps a failure isolated: sibling chunks and other reasons
  // still flush.
  async function flush(): Promise<{ hadWork: boolean; flushed: number }> {
    const batches = buffer.drain();
    if (batches.length === 0) {
      tracker.setRemaining(buffer.size());
      return { hadWork: false, flushed: 0 };
    }
    let flushed = 0;
    for (const { reason, docIds } of batches) {
      for (let i = 0; i < docIds.length; i += chunkSize) {
        const chunk = docIds.slice(i, i + chunkSize);
        try {
          await writeGate.enqueueNearDupInbox(chunk, reason);
          flushed += chunk.length;
        } catch (err) {
          for (const id of chunk) buffer.add(id, reason);
          log.debug(
            `near-dup inbox flush re-buffered ${chunk.length} ids (${reason}) after writer error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    // Push ground truth after re-buffering so the tracker reflects retries.
    tracker.setRemaining(buffer.size());
    return { hadWork: true, flushed };
  }

  const task: PeriodicTask<unknown, IdleResult> = {
    name: "nearDup.inboxFlush",
    runner: "main",
    priority: "background",
    periodMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    idlePeriodMs: opts.idleMs ?? DEFAULT_IDLE_MS,
    startDelayMs: 2_000,
    initialArgs: undefined,
    isIdle: (r) => r.idle,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      const { hadWork, flushed } = await flush();
      if (flushed > 0) tracker.recordTick(flushed);
      return { kind: "done", value: { idle: !hadWork } };
    },
  };

  const job = periodicJob(task, {
    scheduler,
    displayName: "Near-dup inbox flush",
    description:
      "Coalesces per-document near-dup enqueues from an in-memory buffer into batched, background-priority writer inserts. Keeps bulk ingest from parking the writer (#555).",
    category: "graph",
    tracker,
  });

  return { task, job, flushNow: async () => void (await flush()) };
}
