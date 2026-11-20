// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { CliError, EXIT_CANCELLED, EXIT_FAILURE, EXIT_GATEWAY_ERROR, isJSON } from "../utils.js";
import { historyJob, pendingStorageJob, readStorageJob, type StorageJob } from "./storage-wire.js";
import { storageJobLine } from "./storage-display.js";

/** Poll bounded job records rather than corpus measurements; Ctrl-C only detaches the CLI. */
export async function watchStorageJobs(options: {
  id?: string;
  timeoutMs: number;
  initial?: StorageJob[];
  stream?: boolean;
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const selected = options.id
    ? new Set([options.id])
    : new Set(options.initial?.filter(pendingStorageJob).map((job) => job.id));
  let jobs = options.initial;
  let previous = "";
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new CliError(
        `Stopped waiting for storage ${options.id ?? "jobs"}: timeout reached. Background jobs continue; use 'omnesis storage jobs' or 'omnesis storage wait <id>' to reconnect.`,
        EXIT_GATEWAY_ERROR,
      );
    if (!jobs) {
      jobs = [];
      for (const id of selected) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        jobs.push((await readStorageJob(id, Math.min(30_000, left))).job);
      }
      if (Date.now() >= deadline) continue;
    }
    const current = jobs.filter((job) => selected.has(job.id));
    if (current.length !== selected.size)
      throw new CliError(
        `The gateway returned a different job than requested (${[...selected].join(", ")}); completion cannot be confirmed.`,
        EXIT_GATEWAY_ERROR,
      );
    const done = current.every((job) => !pendingStorageJob(job));
    const result = options.id
      ? current[0]
      : {
          trimJobs: current.filter((job) => !historyJob(job)),
          cleanupJobs: current.filter(historyJob),
        };
    const serialized = JSON.stringify(result);
    if (serialized !== previous && (!isJSON || options.stream || done)) {
      console.log(
        isJSON ? serialized : current.map(storageJobLine).join("\n") || "No active storage jobs.",
      );
      previous = serialized;
    }
    if (done) {
      const failed = current.find((job) => job.state === "failed");
      if (failed)
        throw new CliError(
          `Storage job ${failed.id} failed: ${failed.error ?? "see gateway job status"}`,
          EXIT_FAILURE,
        );
      const cancelled = current.find((job) => job.state === "cancelled");
      if (cancelled)
        throw new CliError(`Storage job ${cancelled.id} was cancelled.`, EXIT_CANCELLED);
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1_000, Math.max(1, deadline - Date.now()))),
    );
    jobs = undefined;
  }
}
