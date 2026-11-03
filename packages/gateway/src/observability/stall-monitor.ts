// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway names its own main-thread stalls.
 *
 * The main thread's event loop runs every HTTP request, WebSocket frame and
 * scheduler slot, so a synchronous stretch of work on it is every one of
 * them waiting at once. Nothing on the stalled thread can see that while it
 * happens — its timers do not fire — so the watching is done from a worker
 * thread (`workers/stall-watchdog-worker.ts`):
 *
 *   - this side stamps a heartbeat into shared memory every
 *     `HEARTBEAT_INTERVAL_MS`, and `withActivity` (`main-activity.ts`)
 *     publishes beside it the name of the work in progress;
 *   - the watchdog notices the heartbeat going stale, samples the activity
 *     while it is, and reports the stall once the loop turns again;
 *   - this side adds the garbage collection that overlapped it, logs one line
 *     naming the culprit, and keeps it in a bounded ring for
 *     `GET /admin/stalls` and the doctor.
 *
 * When stalls recur past the flight recorder's budget the watchdog also
 * profiles the main thread and keeps a summary on disk
 * (`flight-recorder.ts`); this side only logs where it is.
 *
 * This is the one source of truth for stalls; the process-vitals sampler
 * reports event-loop-delay percentiles only.
 */

import { Worker } from "node:worker_threads";

import { createLogger, type WorkerEntry } from "@omnesis/core";

import { Ring } from "../ring-buffer.js";
import { listProfileSummaries } from "./flight-recorder.js";
import { formatFrame } from "./profile-summary.js";
import { activitySharedState, subscribeActivityNames } from "./main-activity.js";
import {
  attributeStall,
  rankStalls,
  stallView,
  type GcWindow,
  type StallRankEntry,
  type StallRecord,
  type StallReport,
  type StallTotals,
} from "./stall-report.js";
import {
  epochNowMs,
  recordHeartbeat,
  type ActivityNamesMessage,
  type StallEvent,
  type StallWatchdogInit,
  type StallWatchdogMessage,
} from "./stall-protocol.js";
import type { StallSettings } from "./stall-settings.js";

const log = createLogger("gateway:stalls");

/** How often the main thread stamps the heartbeat. */
const HEARTBEAT_INTERVAL_MS = 50;
/** How often the watchdog reads it. */
const POLL_INTERVAL_MS = 25;
/**
 * How long a reported stall waits before it is recorded, so the garbage
 * collections inside it have been delivered to the GC observer by then.
 */
const GC_SETTLE_MS = 100;
/** Stalls kept in memory. At the default threshold, hours of a badly stalling gateway. */
const RING_SIZE = 2_000;

export interface StallMonitorOptions {
  settings: StallSettings;
  /** The watchdog thread's entry, from `resolveWorkerEntry`. */
  workerEntry: WorkerEntry;
  /** Where the flight recorder keeps its profile summaries. */
  profileDir: string;
  /** Absolute path profile file paths are made relative to. */
  codeRoot: string;
  /** The garbage collection overlapping a span of epoch ms. */
  gcBetween?: (startMs: number, endMs: number) => GcWindow | null;
  heartbeatIntervalMs?: number;
}

/** What the HTTP layer and the doctor read from the monitor. */
export type StallReportPort = Pick<StallMonitor, "report" | "totals" | "running">;

export interface StallReportQuery {
  windowMinutes: number;
  minMs: number;
  limit: number;
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)}GiB`;
}

/** The log line for one stall. */
export function formatStallLine(
  r: StallRecord,
  mem: { heapUsed: number; rss: number } = process.memoryUsage(),
): string {
  // A snapshot taken in another activity than the one the stall is named
  // for says where it was sampled, so the code is not read as that activity's.
  const sampledIn =
    r.codeActivity !== r.activity
      ? ` (sampled ${r.codeActivity ? `in ${r.codeActivity}` : "outside any marked activity"})`
      : "";
  const at = r.code ? ` at ${formatFrame(r.code)}${sampledIn}` : "";
  let where: string;
  if (r.attribution === "running") {
    where = ` in ${r.activity}${r.outer && r.outer !== r.activity ? ` (outer: ${r.outer})` : ""}${at}`;
  } else if (r.attribution === "in-flight") {
    where = ` with only ${r.culprit} in flight${at}`;
  } else {
    where =
      `${at} outside any marked activity` +
      (r.inFlight.length > 0 ? ` (in flight: ${r.inFlight.join(", ")})` : "");
  }
  const gc = r.gc
    ? `gc=${r.gc.count} in ${Math.round(r.gc.totalMs)}ms, worst ${Math.round(r.gc.maxMs)}ms ${r.gc.maxKind}`
    : "gc=none";
  const profiled = r.profileId ? `; profiled in ${r.profileId}` : "";
  return (
    `event loop stalled ${r.durationMs}ms${where}; ${gc}; ` +
    `heap=${formatGiB(mem.heapUsed)} rss=${formatGiB(mem.rss)}${profiled}`
  );
}

export class StallMonitor {
  private readonly ring = new Ring<StallRecord>(RING_SIZE);
  private readonly heartbeatIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private worker: Worker | null = null;
  private capturing: string | null = null;
  private resolveReady: () => void = () => {};
  /** Resolves once the watchdog thread is polling; never, when detection is off. */
  readonly ready: Promise<void>;

  constructor(private readonly opts: StallMonitorOptions) {
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  /** Whether stalls are being recorded: detection is on and the watchdog is alive. */
  get running(): boolean {
    return this.worker !== null;
  }

  start(): void {
    if (!this.opts.settings.enabled || this.worker) return;
    const shared = activitySharedState();
    let previous = epochNowMs();
    recordHeartbeat(shared, previous, previous);
    const stamp = (): void => {
      const now = epochNowMs();
      recordHeartbeat(shared, now, previous);
      previous = now;
    };
    this.timer = setInterval(stamp, this.heartbeatIntervalMs);
    this.timer.unref();

    const { settings } = this.opts;
    const workerData: StallWatchdogInit = {
      buffer: shared.buffer,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      thresholdMs: settings.thresholdMs,
      pollIntervalMs: POLL_INTERVAL_MS,
      profile: settings.profile,
      profileDir: this.opts.profileDir,
      codeRoot: this.opts.codeRoot,
    };
    const worker = new Worker(this.opts.workerEntry.url, {
      workerData,
      execArgv: this.opts.workerEntry.execArgv,
    });
    worker.unref();
    this.worker = worker;
    const postNames = (entries: Array<[number, string]>): void => {
      const msg: ActivityNamesMessage = { type: "names", entries };
      worker.postMessage(msg);
    };
    postNames(subscribeActivityNames((id, name) => postNames([[id, name]])));
    worker.on("message", (msg: StallWatchdogMessage) => this.onMessage(msg));
    // The watchdog is a diagnostic: losing it must never take the gateway down.
    worker.on("error", (err) => {
      log.warn(`Stall watchdog stopped: ${err instanceof Error ? err.message : String(err)}`);
    });
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      // Not restarted: a watchdog that died once would most likely die again,
      // and the gateway is better off without it than restarting it in a loop.
      log.warn(`Stall watchdog exited (code ${code}); stalls are no longer recorded`);
      this.stopWatching();
    });
  }

  private onMessage(msg: StallWatchdogMessage): void {
    switch (msg.type) {
      case "ready":
        log.info(
          `Stall watchdog armed: recording stalls of ${this.opts.settings.thresholdMs}ms or more`,
        );
        this.resolveReady();
        return;
      case "stall": {
        const t = setTimeout(() => this.record(msg.stall), GC_SETTLE_MS);
        t.unref();
        return;
      }
      case "profile-started":
        this.capturing = msg.id;
        log.warn(
          `Stall budget exceeded (${msg.reason}); profiling the main thread for ${Math.round(msg.durationMs / 1000)}s as ${msg.id}`,
        );
        return;
      case "profile-finished":
        this.capturing = null;
        if (msg.file) {
          log.warn(
            `Stall profile ${msg.id} saved to ${msg.file}; hottest code in long busy runs: ${msg.top ?? "none named"}`,
          );
        } else {
          log.info(
            `Stall profile ${msg.id} held no busy run of ${this.opts.settings.thresholdMs}ms or more; nothing kept (${Math.round(msg.busyMs)}ms busy)`,
          );
        }
        return;
      case "profile-failed":
        this.capturing = null;
        log.warn(`Stall profile ${msg.id} failed: ${msg.error}`);
        return;
    }
  }

  private record(stall: StallEvent): void {
    const gc = this.opts.gcBetween?.(stall.startedAt, stall.startedAt + stall.durationMs) ?? null;
    const record = attributeStall(stall, gc);
    this.ring.push(record);
    const line = formatStallLine(record);
    if (record.durationMs >= this.opts.settings.warnMs) log.warn(line);
    else log.debug(line);
  }

  /**
   * Stalls in the window, oldest first. Ordered by start rather than by
   * arrival: a stall that waited for its snapshot arrives after later ones.
   */
  private inWindow(windowMinutes: number, minMs: number): StallRecord[] {
    return this.ring
      .inWindow(Date.now() - windowMinutes * 60_000)
      .filter((r) => r.durationMs >= minMs)
      .sort((a, b) => a.ts - b.ts);
  }

  /** Totals and ranking over a window; synchronous, for the doctor. */
  totals(
    windowMinutes: number,
    minMs: number,
  ): { summary: StallTotals; ranking: StallRankEntry[] } {
    return rankStalls(this.inWindow(windowMinutes, minMs));
  }

  async report(q: StallReportQuery): Promise<StallReport> {
    const records = this.inWindow(q.windowMinutes, q.minMs);
    const { summary, ranking } = rankStalls(records);
    return {
      generatedAt: new Date().toISOString(),
      enabled: this.running,
      thresholdMs: this.opts.settings.thresholdMs,
      windowMinutes: q.windowMinutes,
      minMs: q.minMs,
      summary,
      ranking,
      recent: (q.limit > 0 ? records.slice(-q.limit) : []).reverse().map(stallView),
      capturing: this.capturing,
      profiles: await listProfileSummaries(this.opts.profileDir),
    };
  }

  private stopWatching(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.worker = null;
    this.capturing = null;
    subscribeActivityNames(null);
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.stopWatching();
    await worker?.terminate();
  }
}
