// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Authentication usage flushes keep informational activity writes out of
 * request paths for both operational device tokens and principal credentials.
 *
 * Shape:
 *   - Each usage buffer is a small, bounded in-memory accumulator. The auth
 *     middleware records successful authentication. A one-minute per-id
 *     rate limit keeps activity updates informational rather than hot writes.
 *   - PeriodicTasks drain the buffers every 5s into one batched writer
 *     operation each. Empty buffers back off to 30s.
 *
 * Why a buffer + periodic flush instead of `coalesce`:
 *   - The Scheduler's `coalesce` collapses two pending Tasks of the
 *     SAME shape. Token usage notes arrive as `(tokenId, deviceId)`
 *     pairs from many tokens — coalescing per-pair would require a
 *     Map-shaped Task arg, which adds complexity for no win. A buffer
 *     + periodic drain is simpler and more familiar.
 *   - The 60s gate stays per-token-id rate-limit, same as today's
 *     `shouldFireTokenBeacon`. The 5s flush window adds small
 *     additional dedup but doesn't change semantics.
 *
 * Failures are swallowed: token-usage updates are informational. A
 * transient writer-queue stall shouldn't surface as user-visible noise.
 */

import { QueueTracker } from "../../background-jobs/trackers.js";
import { periodicJob } from "../../background-jobs/scheduler-job.js";
import type { Logger } from "@omnesis/core";
import type { DeviceId, TokenId } from "@omnesis/types";
import type { BackgroundJob } from "../../background-jobs/types.js";
import type { Scheduler } from "../scheduler.js";
import type { WriteGate } from "../../write-gate.js";
import type { PeriodicTask, TaskOutcome } from "../types.js";

/** Per-token rate limit on `note()` calls. Caps the Map's growth. */
const TOKEN_BEACON_INTERVAL_MS = 60_000;
/** Cap the lastSeen Map so a long-running gateway can't leak. */
const LAST_SEEN_CAP = 500;

/** Principal credentials use the same informational one-minute beacon. */
const PRINCIPAL_CREDENTIAL_BEACON_INTERVAL_MS = 60_000;

export interface TokenUsageBuffer {
  /** Record an auth hit. Rate-limited per-token. */
  note(tokenId: TokenId, deviceId: DeviceId): void;
  /** Drain the pending touches. Returns one entry per token. */
  drain(): Array<{ tokenId: TokenId; deviceId: DeviceId }>;
  /** Number of pending touches (for tests + metrics). */
  size(): number;
}

export function createTokenUsageBuffer(): TokenUsageBuffer {
  /** Pending: tokenId → most-recent deviceId. */
  const pending = new Map<TokenId, DeviceId>();
  /** Last `note` time per token, for rate-limiting. */
  const lastSeen = new Map<TokenId, number>();
  return {
    note(tokenId, deviceId) {
      const now = Date.now();
      const last = lastSeen.get(tokenId) ?? 0;
      if (now - last < TOKEN_BEACON_INTERVAL_MS) return;
      lastSeen.set(tokenId, now);
      pending.set(tokenId, deviceId);
      if (lastSeen.size > LAST_SEEN_CAP) {
        // Evict the oldest insertion. Map iteration order is insertion order.
        const first = lastSeen.keys().next().value;
        if (first !== undefined) lastSeen.delete(first);
      }
    },
    drain() {
      const out = Array.from(pending.entries()).map(([tokenId, deviceId]) => ({
        tokenId,
        deviceId,
      }));
      pending.clear();
      return out;
    },
    size() {
      return pending.size;
    },
  };
}

export interface PrincipalCredentialUsageBuffer {
  /** Record a successful principal OAuth authentication. Rate-limited per credential. */
  note(credentialId: string, observedAt?: number): void;
  /** Drain the pending credential touches. */
  drain(): Array<{ credentialId: string; observedAt: number }>;
  /** Restore a batch after a transient writer failure. */
  restore(rows: ReadonlyArray<{ credentialId: string; observedAt: number }>): void;
  /** Number of pending touches (for tests + metrics). */
  size(): number;
}

export function createPrincipalCredentialUsageBuffer(): PrincipalCredentialUsageBuffer {
  const pending = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  return {
    note(credentialId, observedAt = Date.now()) {
      const now = Date.now();
      const last = lastSeen.get(credentialId) ?? 0;
      if (now - last < PRINCIPAL_CREDENTIAL_BEACON_INTERVAL_MS) return;
      lastSeen.set(credentialId, now);
      pending.set(credentialId, observedAt);
      if (pending.size > LAST_SEEN_CAP) {
        const first = pending.keys().next().value;
        if (first !== undefined) pending.delete(first);
      }
      if (lastSeen.size > LAST_SEEN_CAP) {
        const first = lastSeen.keys().next().value;
        if (first !== undefined) lastSeen.delete(first);
      }
    },
    drain() {
      const rows = Array.from(pending, ([credentialId, observedAt]) => ({
        credentialId,
        observedAt,
      }));
      pending.clear();
      return rows;
    },
    restore(rows) {
      for (const row of rows) {
        if (pending.size >= LAST_SEEN_CAP) break;
        const current = pending.get(row.credentialId) ?? 0;
        pending.set(row.credentialId, Math.max(current, row.observedAt));
      }
    },
    size() {
      return pending.size;
    },
  };
}

interface IdleResult {
  idle: boolean;
}

export interface TokenUsageFlushOpts {
  buffer: TokenUsageBuffer;
  writeGate: WriteGate;
  log: Logger;
  /** Active flush cadence. Default 5_000ms. */
  intervalMs?: number;
  /** Idle cadence when the buffer is empty. Default 30_000ms. */
  idleMs?: number;
}

export interface TokenUsageFlushBundle {
  task: PeriodicTask<unknown, IdleResult>;
  job: BackgroundJob;
}

export interface PrincipalCredentialUsageFlushOpts {
  buffer: PrincipalCredentialUsageBuffer;
  writeGate: WriteGate;
  log: Logger;
  /** Active flush cadence. Default 5_000ms. */
  intervalMs?: number;
  /** Idle cadence when the buffer is empty. Default 30_000ms. */
  idleMs?: number;
}

/**
 * Drain the buffer in one writer round-trip via `touchTokenUsageBatch`.
 *
 * Pre-batch shape (kept here for context): fan out one writer call per
 * pending token via `Promise.all`. Each call was a small UPDATE (~ms),
 * but N concurrent writer ops still serialized through the single
 * writer queue — total wall-clock was N × queue + exec, which showed
 * up as `auth.flushTokenUsage exec=6s` slow-ops against the 200 ms
 * budget under modest auth load.
 *
 * Returns the task and a paired BackgroundJob; both share a QueueTracker
 * whose `remaining` is pushed from the buffer's current size on each
 * tick. Buffer size is in-memory and bounded (LAST_SEEN_CAP) so the
 * tracker never goes unbounded.
 */
export function tokenUsageFlushTask(
  opts: TokenUsageFlushOpts,
  scheduler: Scheduler,
): TokenUsageFlushBundle {
  const { buffer, writeGate, log } = opts;
  const tracker = new QueueTracker({ initialRemaining: buffer.size() });
  const task: PeriodicTask<unknown, IdleResult> = {
    name: "auth.flushTokenUsage",
    runner: "main",
    priority: "background",
    periodMs: opts.intervalMs ?? 5_000,
    idlePeriodMs: opts.idleMs ?? 30_000,
    startDelayMs: 5_000,
    initialArgs: undefined,
    isIdle: (r) => r.idle,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      const batch = buffer.drain();
      // Push ground truth from buffer.size() — it's in-memory and
      // O(1) so we can call it on every tick without cost.
      tracker.setRemaining(buffer.size());
      if (batch.length === 0) return { kind: "done", value: { idle: true } };
      // Single writer round-trip. The handler runs the UPDATEs inside
      // one transaction with a shared `now()`; semantics match the
      // old per-token fan-out within one batch interval (~5s) of
      // last_used_at staleness, which is informational only.
      // Failure is non-critical (token-usage is a beacon) — log and
      // continue so a transient writer error doesn't drop buffered
      // touches that the next tick would re-flush anyway.
      try {
        await writeGate.touchTokenUsageBatch(batch);
      } catch (err) {
        log.debug(
          `touchTokenUsageBatch failed for ${batch.length} rows: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      tracker.recordTick(batch.length);
      return { kind: "done", value: { idle: false } };
    },
  };
  const job = periodicJob(task, {
    scheduler,
    displayName: "Token usage flush",
    description: "Drains the in-memory token usage buffer into writer touchTokenUsage updates.",
    category: "auth",
    tracker,
  });
  return { task, job };
}

/** Flush successful principal OAuth usage without adding writes to the request path. */
export function principalCredentialUsageFlushTask(
  opts: PrincipalCredentialUsageFlushOpts,
  scheduler: Scheduler,
): TokenUsageFlushBundle {
  const { buffer, writeGate, log } = opts;
  const tracker = new QueueTracker({ initialRemaining: buffer.size() });
  const task: PeriodicTask<unknown, IdleResult> = {
    name: "auth.flushPrincipalCredentialUsage",
    runner: "main",
    priority: "background",
    periodMs: opts.intervalMs ?? 5_000,
    idlePeriodMs: opts.idleMs ?? 30_000,
    startDelayMs: 5_000,
    initialArgs: undefined,
    isIdle: (r) => r.idle,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      const batch = buffer.drain();
      tracker.setRemaining(buffer.size());
      if (batch.length === 0) return { kind: "done", value: { idle: true } };
      try {
        await writeGate.touchPrincipalCredentialUsageBatch(batch);
      } catch (err) {
        buffer.restore(batch);
        log.debug(
          `touchPrincipalCredentialUsageBatch failed for ${batch.length} rows: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      tracker.recordTick(batch.length);
      return { kind: "done", value: { idle: false } };
    },
  };
  const job = periodicJob(task, {
    scheduler,
    displayName: "Principal credential usage flush",
    description:
      "Drains successful principal OAuth authentication beacons into bounded credential usage updates.",
    category: "auth",
    tracker,
  });
  return { task, job };
}
