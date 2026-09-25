// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Public surface of the Scheduler module.
 *
 * Consumers should import only from here, not the internal modules,
 * so we can refactor freely.
 */

export type {
  Priority,
  RunnerKind,
  Task,
  PeriodicTask,
  WakeableTask,
  TaskContext,
  TaskOutcome,
} from "./types.js";

export { SchedulerQueueFullError, TaskExecutionError } from "./types.js";

export type { TaskRunner } from "./runner.js";

export { PreemptBuffer, PreemptToken } from "./preempt.js";

export type {
  TaskExecOutcome,
  TaskExecSample,
  PerTaskStats,
  PerRunnerStats,
  UserSlaStats,
  SchedulerMetricsSnapshot,
} from "./metrics.js";

export { Scheduler, type SchedulerOptions } from "./scheduler.js";

export { MainTaskRunner, type MainTaskRunnerOptions } from "./runners/main.js";
export { WriterTaskRunner, type WriterTaskRunnerOptions } from "./runners/writer.js";
export { IoTaskRunner, type IoTaskRunnerOptions } from "./runners/io.js";

export { WriteOps, writeGateFromScheduler } from "./write-ops.js";

export { IoOps, ioGateFromScheduler, type IoGate } from "./io-ops.js";

export { CpuTaskRunner, type CpuTaskRunnerOptions } from "./runners/cpu.js";
export { CpuOps, cpuGateFromScheduler, type CpuGate } from "./cpu-ops.js";

export { createBackfillTasks, type BackfillTaskOpts } from "./tasks/backfill.js";

export {
  createTokenUsageBuffer,
  tokenUsageFlushTask,
  createPrincipalCredentialUsageBuffer,
  principalCredentialUsageFlushTask,
  type TokenUsageBuffer,
  type TokenUsageFlushOpts,
  type PrincipalCredentialUsageBuffer,
  type PrincipalCredentialUsageFlushOpts,
} from "./tasks/auth.js";

export { indexerWakeTask, type IndexerWakeTaskOpts } from "./tasks/indexer.js";

export {
  createNearDupInboxBuffer,
  nearDupInboxFlushTask,
  type NearDupInboxBuffer,
  type NearDupInboxFlushOpts,
  type NearDupInboxFlushBundle,
} from "./tasks/near-dup-inbox.js";

export { createCleanupTasks, type CleanupTaskOpts, type CleanupBundle } from "./tasks/cleanup.js";
export {
  createBackendReprobeTask,
  type BackendReprobeOpts,
  type BackendReprobeBundle,
} from "./tasks/backend-reprobe.js";

export {
  createSubscriptionDeliveriesTask,
  type SubscriptionDeliveriesTaskOpts,
  type SubscriptionDeliveriesTaskBundle,
} from "./tasks/subscription-deliveries.js";
