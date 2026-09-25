// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Public surface of the background-jobs module.
 */

export type {
  BackgroundJob,
  BackgroundJobsSnapshot,
  JobCadence,
  JobCategory,
  JobObservation,
  JobProgress,
  JobState,
  ProgressTracker,
} from "./types.js";

export { QueueTracker, ScanTracker, StatelessTracker, WatermarkTracker } from "./trackers.js";

export { BackgroundJobsRegistry, type BackgroundJobsRegistryOptions } from "./registry.js";

export { periodicJob, wakeableJob, type SchedulerBackedJobOpts } from "./scheduler-job.js";
