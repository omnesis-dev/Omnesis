// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const jobsSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.string(),
      observation: z.object({
        state: z.string(),
        inFlight: z.boolean(),
        progress: z.unknown(),
      }),
    }),
  ),
});
const queueSchema = z.object({
  kind: z.literal("queue"),
  remaining: z.number().int().nonnegative(),
  groundTruthAt: z.number().finite().nonnegative(),
});

/** Wait while the caller retains its collector sockets and descriptor declarations. */
export async function waitForDemoGraph(options: {
  readJobs(): Promise<unknown>;
  after: number;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  refresh?: () => Promise<void>;
  report?: (message: string) => void;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2 * 60 * 60_000,
    pollMs = options.pollMs ?? 5_000,
    clock = options.clock ?? Date.now,
    sleep = options.sleep ?? ((ms) => delay(ms, undefined, { signal: options.signal }));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(pollMs) || pollMs < 1)
    throw new Error("Demo graph wait requires positive timeout and polling interval");
  const deadline = clock() + timeoutMs;
  let previous: string | undefined;
  while (true) {
    options.signal?.throwIfAborted();
    await options.refresh?.();
    const parsed = jobsSchema.safeParse(await options.readJobs());
    if (!parsed.success) throw new Error("Invalid demo background-job observation");
    const stage = parsed.data.jobs.find(
        (job) => job.id === "backfill.derivationSla.links",
      )?.observation,
      extractor = parsed.data.jobs.find((job) => job.id === "backfill.linkBatch")?.observation,
      queue = queueSchema.safeParse(stage?.progress),
      now = clock(),
      pending = queue.success ? queue.data.remaining : "unknown",
      line = `Graph links pending=${pending}; observer=${stage?.state ?? "unknown"}; extractor=${extractor?.state ?? "unknown"}`;
    if (line !== previous) {
      options.report?.(line);
      previous = line;
    }
    if (now >= deadline) throw new Error(`Demo graph wait timed out: links pending=${pending}`);
    if (
      stage &&
      extractor &&
      queue.success &&
      queue.data.remaining === 0 &&
      queue.data.groundTruthAt >= options.after &&
      queue.data.groundTruthAt <= now &&
      ["idle", "running"].includes(stage.state) &&
      ["idle", "running"].includes(extractor.state) &&
      stage.inFlight === false &&
      extractor.inFlight === false
    )
      return;
    await sleep(Math.min(pollMs, deadline - now));
  }
}

/** Remain connected until an explicit stop signal, refreshing declarations on reconnect. */
export async function retainDemoHost(options: {
  signal: AbortSignal;
  refresh(): Promise<void>;
  pollMs?: number;
}): Promise<void> {
  while (!options.signal.aborted) {
    await options.refresh();
    try {
      await delay(options.pollMs ?? 1_000, undefined, { signal: options.signal });
    } catch (error) {
      if (!options.signal.aborted) throw error;
    }
  }
}
