// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Periodic cleanup tasks for in-DB and in-memory TTL state.
 *
 *   - `device_pairings` rows past `expires_at` (default TTL 10min).
 *   - `sessions` rows past `expires_at` (default TTL 30 days).
 *   - Notification queue content past its per-message `expires_at`.
 *   - External-access OAuth state in bounded phases, including public DCR
 *     clients that remain unreferenced beyond their retention window.
 *   - In-memory `AuthFlowRegistry` flows past TTL (default 15min) where
 *     the SSE subscriber never re-polled — `get()`'s lazy expire-on-read
 *     never fires for these.
 *
 * The DB sweeps run through the writer worker via `WriteGate.cleanupExpired*`
 * (one DELETE statement each); the auth-flow sweep is in-memory main-thread
 * work via `AuthFlowRegistry.cleanup()`. Both are idle-friendly: when no
 * rows / flows expired we back off to a longer cadence.
 */

import { StatelessTracker } from "../../background-jobs/trackers.js";
import { periodicJob } from "../../background-jobs/scheduler-job.js";
import type { Logger } from "@omnesis/core";
import type { BackgroundJob } from "../../background-jobs/types.js";
import type { Scheduler } from "../scheduler.js";
import type { WriteGate } from "../../write-gate.js";
import type { PeriodicTask, TaskOutcome } from "../types.js";
import type { AuthFlowRegistry } from "../../auth-flows.js";
import type { ImportFlowRegistry } from "../../import-flows.js";
import type { AccessCleanupPhase, OAuthClientCleanupCursor } from "../../access/store-cleanup.js";

interface IdleResult {
  /** When the next pending row falls due, if the sweep knows. */
  nextDueAt?: number;
  idle: boolean;
}

export interface CleanupTaskOpts {
  writeGate: WriteGate;
  authFlows: AuthFlowRegistry;
  importFlows: ImportFlowRegistry;
  log: Logger;
  /** Active cadence for DB-side cleanup. Default 1h. */
  dbIntervalMs?: number;
  /** Idle cadence when nothing expired. Default 6h. */
  dbIdleMs?: number;
  /** Convergence cadence between bounded access-state batches. Default 1s. */
  accessIntervalMs?: number;
  /** Idle cadence after a clean access-state sweep. Defaults to dbIdleMs. */
  accessIdleMs?: number;
  /** Rows deleted by one access-state writer operation. Default 200, maximum 500. */
  accessBatchSize?: number;
  now?: () => number;
  /** Active cadence for the in-memory auth-flow sweep. Default 5min. */
  authFlowIntervalMs?: number;
  /** Idle cadence when no flows expired. Default 30min. */
  authFlowIdleMs?: number;
}

export interface CleanupBundle {
  tasks: PeriodicTask<unknown, IdleResult>[];
  jobs: BackgroundJob[];
}

const ACCESS_CLEANUP_PHASES: readonly AccessCleanupPhase[] = [
  "executionBindings",
  "authorizationRequests",
  "accessTokens",
  "refreshTokens",
  "auditEvents",
  "oauthClients",
];

/**
 * Build the TTL-cleanup PeriodicTasks. Caller schedules tasks via
 * `scheduler.schedule(t)` and registers jobs via `registry.registerAll(jobs)`.
 */
export function createCleanupTasks(opts: CleanupTaskOpts, scheduler: Scheduler): CleanupBundle {
  const dbInterval = opts.dbIntervalMs ?? 60 * 60 * 1000;
  const dbIdle = opts.dbIdleMs ?? 6 * 60 * 60 * 1000;
  const authInterval = opts.authFlowIntervalMs ?? 5 * 60 * 1000;
  const authIdle = opts.authFlowIdleMs ?? 30 * 60 * 1000;
  const accessInterval = opts.accessIntervalMs ?? 1_000;
  const accessIdle = opts.accessIdleMs ?? dbIdle;
  const accessBatchSize = opts.accessBatchSize ?? 200;
  const now = opts.now ?? Date.now;
  let accessPhaseIndex = 0;
  let accessDeletedThisSweep = 0;
  let oauthClientCursor: OAuthClientCleanupCursor | undefined;

  const pairingsTask: PeriodicTask<unknown, IdleResult> = {
    name: "devices.cleanupExpiredPairings.tick",
    runner: "main",
    priority: "background",
    periodMs: dbInterval,
    idlePeriodMs: dbIdle,
    startDelayMs: 60_000,
    initialArgs: undefined,
    isIdle: (r) => r.idle,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      try {
        const removed = await opts.writeGate.cleanupExpiredPairings();
        if (removed > 0) {
          opts.log.info(`cleanupExpiredPairings deleted ${removed} row${removed === 1 ? "" : "s"}`);
        }
        return { kind: "done", value: { idle: removed === 0 } };
      } catch (err) {
        opts.log.warn(
          `cleanupExpiredPairings failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { kind: "done", value: { idle: true } };
      }
    },
  };

  const sessionsTask: PeriodicTask<unknown, IdleResult> = {
    name: "tokens.cleanupExpiredSessions.tick",
    runner: "main",
    priority: "background",
    periodMs: dbInterval,
    idlePeriodMs: dbIdle,
    startDelayMs: 60_000,
    initialArgs: undefined,
    isIdle: (r) => r.idle,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      try {
        const removed = await opts.writeGate.cleanupExpiredSessions();
        if (removed > 0) {
          opts.log.info(`cleanupExpiredSessions deleted ${removed} row${removed === 1 ? "" : "s"}`);
        }
        return { kind: "done", value: { idle: removed === 0 } };
      } catch (err) {
        opts.log.warn(
          `cleanupExpiredSessions failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { kind: "done", value: { idle: true } };
      }
    },
  };

  const tokensTask: PeriodicTask<unknown, IdleResult> = {
    name: "tokens.cleanupExpiredTokens.tick",
    runner: "main",
    priority: "background",
    periodMs: dbInterval,
    idlePeriodMs: dbIdle,
    startDelayMs: 60_000,
    initialArgs: undefined,
    isIdle: (r) => r.idle,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      try {
        const removed = await opts.writeGate.cleanupExpiredTokens();
        if (removed > 0) {
          opts.log.info(`cleanupExpiredTokens deleted ${removed} row${removed === 1 ? "" : "s"}`);
        }
        return { kind: "done", value: { idle: removed === 0 } };
      } catch (err) {
        opts.log.warn(
          `cleanupExpiredTokens failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { kind: "done", value: { idle: true } };
      }
    },
  };

  const notificationsTask: PeriodicTask<unknown, IdleResult> = {
    name: "notifications.cleanupExpired.tick",
    runner: "main",
    priority: "background",
    periodMs: dbInterval,
    idlePeriodMs: dbIdle,
    // Private notification content gets one global sweep as the gateway
    // starts, then follows the ordinary bounded DB-cleanup cadence.
    startDelayMs: 0,
    initialArgs: undefined,
    isIdle: (r) => r.idle,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      try {
        const removed = await opts.writeGate.cleanupExpiredNotifications(now());
        if (removed > 0) {
          opts.log.info(
            `cleanupExpiredNotifications deleted ${removed} notification${removed === 1 ? "" : "s"}`,
          );
        }
        return { kind: "done", value: { idle: removed === 0 } };
      } catch (err) {
        opts.log.warn(
          `cleanupExpiredNotifications failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { kind: "done", value: { idle: true } };
      }
    },
  };

  // Between sweeps a pending authorization request is a known future event:
  // it falls due at a moment the store can name. A sweep that found nothing
  // wakes for that moment — plus a second for the clock to pass it, and the
  // phases that run before the request phase — rather than for its idle
  // period, so a connection nobody finished does not sit in the owner's
  // table for hours waiting on the next idle tick. A request created after
  // a clean sweep is covered by the kick its creation sends.
  let accessNextDueAt: number | undefined;
  const accessTask: PeriodicTask<unknown, IdleResult> = {
    name: "access.cleanupExpired.tick",
    runner: "main",
    priority: "background",
    periodMs: accessInterval,
    idlePeriodMs: accessIdle,
    startDelayMs: 60_000,
    latencyBudgetMs: 1_000,
    initialArgs: undefined,
    isIdle: (r) => r.idle,
    nextDelayMs: (r) => {
      if (!r.idle || r.nextDueAt === undefined) return undefined;
      return Math.min(accessIdle, Math.max(accessInterval, r.nextDueAt - now() + 1_000));
    },
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      const phase = ACCESS_CLEANUP_PHASES[accessPhaseIndex]!;
      let deleted = 0;
      let hasMore: boolean;
      try {
        const result = await opts.writeGate.cleanupExpiredAccessStateBatch(
          phase,
          now(),
          accessBatchSize,
          phase === "oauthClients" ? oauthClientCursor : undefined,
        );
        deleted = result.deleted;
        hasMore = result.hasMore;
        oauthClientCursor = result.cursor;
        if (result.nextDueAt !== undefined) {
          accessNextDueAt =
            accessNextDueAt === undefined
              ? result.nextDueAt
              : Math.min(accessNextDueAt, result.nextDueAt);
        }
      } catch (err) {
        opts.log.warn(
          `access cleanup ${phase} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Advance so a malformed phase cannot starve cleanup of the others.
        hasMore = false;
      }

      accessDeletedThisSweep += deleted;
      // Exactly one bounded writer transaction per tick. Remaining on the
      // same phase when hasMore=true converges promptly, while returning to
      // the Scheduler gives higher-priority work a preemption boundary.
      if (!hasMore) {
        accessPhaseIndex += 1;
        oauthClientCursor = undefined;
      }
      if (accessPhaseIndex < ACCESS_CLEANUP_PHASES.length) {
        return { kind: "done", value: { idle: false } };
      }

      if (accessDeletedThisSweep > 0) {
        opts.log.info(
          `access cleanup deleted ${accessDeletedThisSweep} expired row${
            accessDeletedThisSweep === 1 ? "" : "s"
          }`,
        );
      }
      const idle = accessDeletedThisSweep === 0;
      const nextDueAt = accessNextDueAt;
      accessPhaseIndex = 0;
      accessDeletedThisSweep = 0;
      accessNextDueAt = undefined;
      oauthClientCursor = undefined;
      return { kind: "done", value: nextDueAt === undefined ? { idle } : { idle, nextDueAt } };
    },
  };

  const authFlowsTask: PeriodicTask<unknown, IdleResult> = {
    name: "authFlows.cleanup.tick",
    runner: "main",
    priority: "background",
    periodMs: authInterval,
    idlePeriodMs: authIdle,
    startDelayMs: 30_000,
    initialArgs: undefined,
    isIdle: (r) => r.idle,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      const removed = opts.authFlows.cleanup();
      if (removed > 0) {
        opts.log.info(`authFlows.cleanup expired ${removed} flow${removed === 1 ? "" : "s"}`);
      }
      return { kind: "done", value: { idle: removed === 0 } };
    },
  };

  const importFlowsTask: PeriodicTask<unknown, IdleResult> = {
    name: "importFlows.cleanup.tick",
    runner: "main",
    priority: "background",
    periodMs: authInterval,
    idlePeriodMs: authIdle,
    startDelayMs: 30_000,
    initialArgs: undefined,
    isIdle: (r) => r.idle,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      const removed = opts.importFlows.cleanup();
      if (removed > 0) {
        opts.log.info(`importFlows.cleanup expired ${removed} flow${removed === 1 ? "" : "s"}`);
      }
      return { kind: "done", value: { idle: removed === 0 } };
    },
  };

  const tasks: PeriodicTask<unknown, IdleResult>[] = [
    pairingsTask,
    sessionsTask,
    tokensTask,
    notificationsTask,
    accessTask,
    authFlowsTask,
    importFlowsTask,
  ];
  const jobs: BackgroundJob[] = [
    periodicJob(pairingsTask, {
      scheduler,
      displayName: "Expired pairings cleanup",
      description: "Deletes device_pairings rows past their expires_at timestamp.",
      category: "auth",
      tracker: new StatelessTracker(),
    }),
    periodicJob(sessionsTask, {
      scheduler,
      displayName: "Expired sessions cleanup",
      description: "Deletes sessions rows (portal cookies) past their expires_at timestamp.",
      category: "auth",
      tracker: new StatelessTracker(),
    }),
    periodicJob(tokensTask, {
      scheduler,
      displayName: "Expired tokens cleanup",
      description:
        "Deletes tokens rows past their expires_at timestamp (short-lived callback tokens).",
      category: "auth",
      tracker: new StatelessTracker(),
    }),
    periodicJob(notificationsTask, {
      scheduler,
      displayName: "Expired notification cleanup",
      description:
        "Deletes expired private notification content while preserving active delivery leases.",
      category: "infra",
      tracker: new StatelessTracker(),
    }),
    periodicJob(accessTask, {
      scheduler,
      displayName: "Expired principal access state cleanup",
      description:
        "Deletes expired OAuth requests and tokens, old audit events, and orphaned OAuth clients in bounded phased writer batches.",
      category: "auth",
      tracker: new StatelessTracker(),
    }),
    periodicJob(authFlowsTask, {
      scheduler,
      displayName: "Auth flow registry cleanup",
      description:
        "Sweeps in-memory AuthFlowRegistry for entries past their TTL; abandoned OAuth/QR flows that were never re-polled.",
      category: "auth",
      tracker: new StatelessTracker(),
    }),
    periodicJob(importFlowsTask, {
      scheduler,
      displayName: "Import flow registry cleanup",
      description:
        "Sweeps in-memory ImportFlowRegistry (#588) for history-import flows past their TTL.",
      category: "auth",
      tracker: new StatelessTracker(),
    }),
  ];
  return { tasks, jobs };
}
