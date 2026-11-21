// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { z } from "zod";
import { SourceId } from "@omnesis/types";
import { CliError, EXIT_USER_ERROR, isJSON } from "../utils.js";
import { renderStorage, storageJobLine } from "./storage-display.js";
import { watchStorageJobs } from "./storage-jobs.js";
import {
  cleanupJobSchema,
  readStorage,
  readStorageJob,
  storageJobs,
  storageRequest,
  storageSourceProjection,
  storageSnapshotSchema,
  trimJobSchema,
  type CleanupTarget,
  type StorageJob,
} from "./storage-wire.js";

type Args = Record<string, unknown>;
const timeoutArg = {
  type: "string" as const,
  default: "600",
  description: "Maximum wait in seconds (1–86400); timing out leaves background jobs running",
};
const yesArg = { type: "boolean" as const, alias: "y", description: "Confirm this operation" };
const beforeArg = {
  type: "string" as const,
  required: true,
  description: "Exclusive cutoff: YYYY-MM-DD (UTC midnight) or UTC ISO timestamp",
};
const waitArg = {
  type: "boolean" as const,
  description: "Wait for background deletion and search cleanup to finish",
};
const statusArgs = {
  source: { type: "string" as const, description: "Show measurements for this exact source ID" },
  history: {
    type: "boolean" as const,
    description: "Expand monthly payloads in human output; JSON already includes the monthly data",
  },
};
function usage(message: string): never {
  throw new CliError(message, EXIT_USER_ERROR);
}
function positionals(args: Args, maximum: number): void {
  if (Array.isArray(args._) && args._.length > maximum)
    usage(
      "Unexpected positional arguments. Storage commands take one exact source, target, or job ID where indicated; use --help.",
    );
}
function number(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))
    usage(`${label} must be a number between ${minimum} and ${maximum}.`);
  const result = Number(value);
  if (
    !Number.isFinite(result) ||
    result < minimum ||
    result > maximum ||
    (integer && !Number.isSafeInteger(result))
  )
    usage(
      `${label} must be ${integer ? "an integer" : "a number"} between ${minimum} and ${maximum}.`,
    );
  return result;
}
function timeout(args: Args): number {
  return number(args.timeout ?? "600", "--timeout", 1, 86_400, true) * 1_000;
}
function exactSource(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value))
    usage("Provide one valid literal source ID.");
  try {
    return SourceId(value);
  } catch {
    return usage("Provide one valid exact source ID.");
  }
}
function jobId(value: unknown): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) usage("Provide a complete storage job UUID.");
  return parsed.data;
}
function confirm(args: Args, action: string): void {
  if (args.yes !== true) usage(`${action} requires explicit confirmation. Re-run with --yes.`);
}
export function storageCutoff(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value)
  )
    usage("--before must be YYYY-MM-DD or a UTC ISO timestamp ending in Z.");
  const iso =
    value.length === 10 ? `${value}T00:00:00.000Z` : value.replace(/(?<=:\d{2})Z$/, ".000Z");
  const time = Date.parse(iso);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== iso)
    usage("--before must be a real calendar date and time.");
  return iso;
}
function output(value: unknown, human: string | (() => string)): void {
  console.log(isJSON ? JSON.stringify(value) : typeof human === "function" ? human() : human);
}
async function showStatus(args: Args, refresh = false): Promise<void> {
  positionals(args, 0);
  const source = args.source === undefined ? undefined : exactSource(args.source);
  const duration = refresh ? timeout(args) : undefined;
  const snapshot = refresh
    ? await storageRequest(
        "/admin/storage/refresh",
        storageSnapshotSchema,
        { method: "POST", body: "{}" },
        duration,
      )
    : await readStorage();
  output(source ? storageSourceProjection(snapshot, source) : snapshot, () =>
    renderStorage(snapshot, { source, history: args.history === true }),
  );
}
async function accepted(job: StorageJob, args: Args, duration: number): Promise<void> {
  if (args.wait === true) {
    if (isJSON)
      process.stderr.write(
        `Accepted storage job ${job.id}; it runs independently on the gateway. Ctrl-C or a waiting error only detaches this CLI. Reconnect with: omnesis storage wait ${job.id}\n`,
      );
    if (!isJSON)
      console.log(
        `Accepted: ${storageJobLine(job)}\nWaiting; Ctrl-C detaches without cancelling the gateway job.`,
      );
    await watchStorageJobs({ id: job.id, timeoutMs: duration, initial: [job] });
  } else
    output(
      job,
      `Accepted: ${storageJobLine(job)}\nRuns in the background. Follow with: omnesis storage wait ${job.id}`,
    );
}

export const storageStatusCommand = defineCommand({
  meta: { name: "status", description: "Show disk, file, source and measurement status" },
  args: statusArgs,
  run: ({ args }) => showStatus(args),
});
export const storageRefreshCommand = defineCommand({
  meta: {
    name: "refresh",
    description: "Refresh storage measurements independently of disk protection",
  },
  args: { ...statusArgs, timeout: timeoutArg },
  run: ({ args }) => showStatus(args, true),
});
export const storagePolicyCommand = defineCommand({
  meta: { name: "policy", description: "Show or set gateway storage limits and recovery margin" },
  args: {
    "max-bytes": {
      type: "string",
      description: "Gateway byte limit, or unlimited to clear the custom limit",
    },
    "disk-used-percent": {
      type: "string",
      description: "Pause growth at this disk usage percentage (50–99); default 95",
    },
    "resume-margin-percent": {
      type: "string",
      description: "Recovery margin below a limit (0.1–10 percent)",
    },
  },
  async run({ args }) {
    positionals(args, 0);
    const policy: {
      maxBytes?: number | null;
      maxDiskUsedPercent?: number;
      resumeMarginPercent?: number;
    } = {};
    if (args["max-bytes"] !== undefined)
      policy.maxBytes =
        args["max-bytes"] === "unlimited"
          ? null
          : number(args["max-bytes"], "--max-bytes", 1, Number.MAX_SAFE_INTEGER, true);
    if (args["disk-used-percent"] !== undefined)
      policy.maxDiskUsedPercent = number(args["disk-used-percent"], "--disk-used-percent", 50, 99);
    if (args["resume-margin-percent"] !== undefined)
      policy.resumeMarginPercent = number(
        args["resume-margin-percent"],
        "--resume-margin-percent",
        0.1,
        10,
      );
    const snapshot = Object.keys(policy).length
      ? await storageRequest("/admin/storage/policy", storageSnapshotSchema, {
          method: "PATCH",
          body: JSON.stringify(policy),
        })
      : await readStorage();
    output(
      snapshot.policy,
      `Custom limit: ${snapshot.policy.maxBytes ?? "unlimited"} bytes; disk-used threshold: ${snapshot.policy.maxDiskUsedPercent}%; recovery margin: ${snapshot.policy.resumeMarginPercent}%. Clearing a custom limit does not disable disk protection.`,
    );
  },
});
export const storageRetentionCommand = defineCommand({
  meta: { name: "retention", description: "List or change explicit rolling source retention" },
  args: {
    sourceId: { type: "positional", required: false, description: "Exact source ID" },
    days: {
      type: "string",
      description: "Keep this many days; starts automatic removal of older documents (1–36500)",
    },
    off: { type: "boolean", description: "Disable automatic trimming for this source" },
    yes: yesArg,
  },
  async run({ args }) {
    positionals(args, 1);
    if (args.days !== undefined && args.off) usage("Choose --days or --off, not both.");
    const mutating = args.days !== undefined || args.off === true;
    const sourceId = args.sourceId === undefined ? undefined : exactSource(args.sourceId);
    const maxAgeDays =
      args.days === undefined ? null : number(args.days, "--days", 1, 36_500, true);
    if (mutating && !sourceId) usage("A retention change requires one exact source ID.");
    if (args.days !== undefined) confirm(args, "Automatic deletion of older source documents");
    const snapshot = mutating
      ? await storageRequest("/admin/storage/retention", storageSnapshotSchema, {
          method: "PATCH",
          body: JSON.stringify({ sourceId, maxAgeDays }),
        })
      : await readStorage();
    const policies = snapshot.retention.filter((item) => !sourceId || item.sourceId === sourceId);
    output(
      { retention: policies },
      policies.length
        ? policies
            .map(
              (item) =>
                `${item.sourceId}: keep ${item.maxAgeDays} days; older eligible documents are removed automatically`,
            )
            .join("\n")
        : "No matching rolling retention policy. No automatic source trimming is configured here.",
    );
  },
});
export const storageTrimCommand = defineCommand({
  meta: {
    name: "trim",
    description: "Trim all eligible source documents before a cutoff in the background",
  },
  args: {
    sourceId: { type: "positional", required: true, description: "One exact source ID" },
    before: beforeArg,
    yes: yesArg,
    wait: waitArg,
    timeout: timeoutArg,
  },
  async run({ args }) {
    positionals(args, 1);
    const sourceId = exactSource(args.sourceId);
    const before = storageCutoff(args.before);
    const duration = timeout(args);
    if (Date.parse(before) > Date.now()) usage("Source trim cutoff must not be in the future.");
    confirm(args, "Deleting all eligible source documents before the cutoff");
    const job = await storageRequest("/admin/storage/trim/jobs", trimJobSchema, {
      method: "POST",
      body: JSON.stringify({ sourceId, before }),
    });
    await accepted(job, args, duration);
  },
});
export const storageCleanupCommand = defineCommand({
  meta: {
    name: "cleanup",
    description: "Trim Brain logs, chat history or completed backups before a cutoff",
  },
  args: {
    target: {
      type: "positional",
      required: true,
      description: "brain-transcripts, conversations, or backups",
    },
    before: beforeArg,
    yes: yesArg,
    wait: waitArg,
    timeout: timeoutArg,
    "include-newest": {
      type: "boolean",
      description: "For backups only: permit deleting the newest completed backup too",
    },
  },
  async run({ args }) {
    positionals(args, 1);
    const parsed = z.enum(["brain-transcripts", "conversations", "backups"]).safeParse(args.target);
    if (!parsed.success) usage("Choose brain-transcripts, conversations, or backups.");
    const target: CleanupTarget = parsed.data;
    const before = storageCutoff(args.before);
    const duration = timeout(args);
    if (args["include-newest"] && target !== "backups")
      usage("--include-newest is only valid for backups.");
    confirm(
      args,
      args["include-newest"]
        ? "Deleting old backups, including the newest completed backup if eligible"
        : "Deleting all eligible history items before the cutoff",
    );
    const body =
      target === "backups"
        ? { target, before, keepNewest: args["include-newest"] !== true }
        : { target, before };
    const result = await storageRequest(
      "/admin/storage/cleanup/jobs",
      z.object({ job: cleanupJobSchema }),
      { method: "POST", body: JSON.stringify(body) },
    );
    await accepted(result.job, args, duration);
  },
});
export const storageJobsCommand = defineCommand({
  meta: {
    name: "jobs",
    description: "List trim/cleanup jobs, or watch currently active jobs (NDJSON with --json)",
  },
  args: {
    watch: {
      type: "boolean",
      alias: "w",
      description: "Watch jobs active now until finished; JSON output is NDJSON",
    },
    timeout: timeoutArg,
  },
  async run({ args }) {
    positionals(args, 0);
    const duration = timeout(args);
    const snapshot = await readStorage(args.watch ? Math.min(30_000, duration) : undefined);
    if (args.watch)
      await watchStorageJobs({ timeoutMs: duration, initial: storageJobs(snapshot), stream: true });
    else
      output(
        { trimJobs: snapshot.trimJobs, cleanupJobs: snapshot.cleanupJobs ?? [] },
        storageJobs(snapshot).map(storageJobLine).join("\n") || "No storage jobs.",
      );
  },
});
export const storageWaitCommand = defineCommand({
  meta: { name: "wait", description: "Wait for one trim or cleanup job; Ctrl-C leaves it running" },
  args: {
    id: { type: "positional", required: true, description: "Complete storage job UUID" },
    timeout: timeoutArg,
  },
  async run({ args }) {
    positionals(args, 1);
    const id = jobId(args.id);
    const duration = timeout(args);
    await watchStorageJobs({ id, timeoutMs: duration });
  },
});
export const storageCancelCommand = defineCommand({
  meta: {
    name: "cancel",
    description: "Stop a history cleanup after any committed removal finishes",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "History cleanup UUID (source trim cancellation is unavailable)",
    },
    yes: yesArg,
  },
  async run({ args }) {
    positionals(args, 1);
    const id = jobId(args.id);
    confirm(args, "Stopping this cleanup");
    const existing = await readStorageJob(id);
    if (existing.kind === "trim")
      usage(
        "Source trim jobs cannot be cancelled. Disable a rolling retention policy with 'omnesis storage retention <source> --off' to stop future rolling work.",
      );
    const result = await storageRequest(
      `/admin/storage/cleanup/jobs/${encodeURIComponent(id)}/cancel`,
      z.object({ job: cleanupJobSchema }),
      { method: "POST", body: "{}" },
    );
    output(result.job, storageJobLine(result.job));
  },
});
export const storageCommand = defineCommand({
  meta: {
    name: "storage",
    description: "Inspect storage, manage limits and reclaim old data (admin scope)",
  },
  args: statusArgs,
  subCommands: {
    status: storageStatusCommand,
    refresh: storageRefreshCommand,
    policy: storagePolicyCommand,
    retention: storageRetentionCommand,
    trim: storageTrimCommand,
    cleanup: storageCleanupCommand,
    jobs: storageJobsCommand,
    wait: storageWaitCommand,
    cancel: storageCancelCommand,
  },
  run({ args }) {
    if (args._.length === 0) return showStatus(args);
    return undefined;
  },
});
