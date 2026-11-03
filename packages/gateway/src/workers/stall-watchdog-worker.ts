// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The stall watchdog thread: see `observability/stall-monitor.ts`.
 *
 * Polls the shared heartbeat on its own event loop, which a stall on the main
 * thread does not stop, and reports each stall with the activity it was
 * stuck in. Everything that profiles the main thread also runs here, so none
 * of that work lands on the thread being diagnosed:
 *
 *   - A snapshot: once a stall has lasted twice the threshold (and at least
 *     500 ms), a profile of a fraction of a second names the code it is in.
 *     Activity marks name the work that was *running*; code after an `await`
 *     runs outside them, and the snapshot is what still names it. At most one
 *     per `SNAPSHOT_MIN_GAP_MS`, so a storm of stalls is not also a storm of
 *     profiles.
 *   - The flight recorder: when stalls recur past its budget, a profile of a
 *     minute, summarised and kept on disk.
 *
 * It imports only Node built-ins and the observability modules beside it,
 * and posts every result to the main thread rather than logging: a worker's
 * console is relayed through the main thread anyway.
 */

import { parentPort, workerData } from "node:worker_threads";

import {
  captureMainThreadProfile,
  profileIdAt,
  writeProfileSummary,
  PROFILE_SUMMARY_VERSION,
  type ProfileSummary,
} from "../observability/flight-recorder.js";
import {
  formatFrame,
  summarizeProfile,
  type ProfileFrame,
} from "../observability/profile-summary.js";
import {
  ProfileTrigger,
  StallDetector,
  type DetectedStall,
} from "../observability/stall-detector.js";
import {
  epochNowMs,
  sampleActivity,
  stallSharedStateOf,
  takeMaxGap,
  type ActivityNamesMessage,
  type StallEvent,
  type StallWatchdogInit,
  type StallWatchdogMessage,
} from "../observability/stall-protocol.js";

/** How long a snapshot samples for. */
const SNAPSHOT_SAMPLE_MS = 200;
/** Microseconds between a snapshot's samples. */
const SNAPSHOT_SAMPLING_INTERVAL_US = 1_000;
/** Least time between two snapshots. */
const SNAPSHOT_MIN_GAP_MS = 10_000;
/**
 * Longest the main thread may take to answer a snapshot's first inspector
 * call. Stuck in JavaScript, it services the interrupt within milliseconds,
 * and the reply reaches this thread as soon as it is scheduled, which on a
 * loaded host can take a while; stuck in native code, it answers only when
 * that returns, typically seconds later, and the samples would then be of
 * whatever ran after. The bound sits between the two.
 */
const SNAPSHOT_MAX_ANSWER_WAIT_MS = 250;
/** Frames of the snapshot's hottest stack a stall keeps. */
const SNAPSHOT_STACK_FRAMES = 8;

if (!parentPort) throw new Error("stall-watchdog-worker must run as a worker thread");
const port = parentPort;

const init = workerData as StallWatchdogInit;
const { beat, slots } = stallSharedStateOf(init.buffer);
const names = new Map<number, string>();

function post(msg: StallWatchdogMessage): void {
  port.postMessage(msg);
}

port.on("message", (msg: ActivityNamesMessage) => {
  if (msg.type === "names") for (const [id, name] of msg.entries) names.set(id, name);
});

const nameOf = (id: number): string | null => (id === 0 ? null : (names.get(id) ?? `#${id}`));

const detector = new StallDetector(
  init.heartbeatIntervalMs,
  init.thresholdMs,
  // This thread not running for this long means the whole process was not.
  Math.max(2_000, 20 * init.pollIntervalMs),
  Number(Atomics.load(beat, 0)),
  epochNowMs(),
);
const snapshotAfterMs = Math.max(2 * init.thresholdMs, 500);

const policy = init.profile;
const trigger = policy ? new ProfileTrigger(policy) : null;
let capture: { id: string; stalls: StallEvent[] } | null = null;

interface Snapshot {
  code: ProfileFrame | null;
  stack: ProfileFrame[];
  /** The innermost activity the main thread was in while the snapshot sampled it (0 = none). */
  activity: number;
}
/** The snapshot of the stall in progress, keyed by the heartbeat it went stale after. */
let snapshot: { beat: number; done: Promise<Snapshot | null> } | null = null;
/** A snapshot still profiling, whichever stall it was for. */
let snapshotRunning: Promise<unknown> | null = null;
let lastSnapshotAt = Number.NEGATIVE_INFINITY;

function startSnapshot(forBeat: number): void {
  const done = takeSnapshot(forBeat);
  snapshot = { beat: forBeat, done };
  snapshotRunning = done.finally(() => {
    snapshotRunning = null;
  });
}

async function takeSnapshot(forBeat: number): Promise<Snapshot | null> {
  try {
    // A stall in native code delays the profiler's start until it returns, by
    // which time the samples would be of whatever ran next: a slow answer, or
    // a heartbeat since `forBeat` (the stall is over), abandons the profile.
    let activity = 0;
    const profile = await captureMainThreadProfile(
      SNAPSHOT_SAMPLE_MS,
      SNAPSHOT_SAMPLING_INTERVAL_US,
      (answerWaitMs) => {
        activity = sampleActivity(slots).inner;
        return (
          answerWaitMs <= SNAPSHOT_MAX_ANSWER_WAIT_MS && Number(Atomics.load(beat, 0)) === forBeat
        );
      },
    );
    if (!profile) return null;
    // One gap can hold several callbacks back to back, so the activity the
    // stall is named for need not be the one sampled here. The snapshot says
    // which one it sampled, and is abandoned if the main thread moved to
    // another activity while it sampled: its code would belong to neither.
    if (sampleActivity(slots).inner !== activity) return null;
    const body = summarizeProfile(profile, {
      minRunMs: SNAPSHOT_SAMPLE_MS / 4,
      codeRoot: init.codeRoot,
      top: 1,
    });
    return {
      code: body.hottestCode,
      stack: body.topStacks[0]?.frames.slice(0, SNAPSHOT_STACK_FRAMES) ?? [],
      activity,
    };
  } catch {
    // A snapshot is a refinement: the stall is still reported without one.
    return null;
  }
}

async function runCapture(reason: string, startedAt: number): Promise<void> {
  const id = profileIdAt(startedAt);
  capture = { id, stalls: [] };
  post({ type: "profile-started", id, durationMs: policy!.durationMs, reason });
  try {
    // One profiler at a time on the main thread.
    await snapshotRunning;
    const profile = (await captureMainThreadProfile(policy!.durationMs))!;
    const body = summarizeProfile(profile, {
      minRunMs: init.thresholdMs,
      codeRoot: init.codeRoot,
    });
    const summary: ProfileSummary = {
      version: PROFILE_SUMMARY_VERSION,
      id,
      capturedAt: new Date(startedAt).toISOString(),
      reason,
      stalls: capture.stalls,
      ...body,
    };
    const file =
      body.longRuns.length > 0 ? writeProfileSummary(init.profileDir, summary, policy!.keep) : null;
    post({
      type: "profile-finished",
      id,
      file,
      top: body.hottestCode ? formatFrame(body.hottestCode) : null,
      busyMs: body.busyMs,
    });
  } catch (err) {
    post({ type: "profile-failed", id, error: err instanceof Error ? err.message : String(err) });
  } finally {
    capture = null;
    trigger!.finished();
  }
}

function report(found: DetectedStall, snap: Snapshot | null, profileId: string | null): void {
  const stall: StallEvent = {
    startedAt: found.startedAt,
    durationMs: found.durationMs,
    activity: nameOf(found.inner),
    outer: nameOf(found.outer),
    inFlight: found.inFlight.map((id) => nameOf(id)!),
    code: snap?.code ?? null,
    codeActivity: snap?.code ? nameOf(snap.activity) : null,
    stack: snap?.stack ?? [],
    profileId,
  };
  // A stall reported late, once its snapshot finished, may arrive after a
  // capture has started; it belongs to the capture only if it fell inside it.
  if (capture && profileId === capture.id) capture.stalls.push(stall);
  post({ type: "stall", stall });
}

setInterval(() => {
  const now = epochNowMs();
  const lastBeat = Number(Atomics.load(beat, 0));
  const found = detector.poll(
    lastBeat,
    now,
    () => sampleActivity(slots),
    () => takeMaxGap(slots),
  );
  // The loop has turned since the snapshot started: it belongs to the gap just
  // closed, whether or not that gap counted as a stall.
  const taken = snapshot && snapshot.beat !== lastBeat ? snapshot : null;
  if (taken) snapshot = null;

  if (!found) {
    const stalledMs = now - lastBeat - init.heartbeatIntervalMs;
    if (
      stalledMs >= snapshotAfterMs &&
      !snapshotRunning &&
      !capture &&
      now - lastSnapshotAt >= SNAPSHOT_MIN_GAP_MS
    ) {
      lastSnapshotAt = now;
      startSnapshot(lastBeat);
    }
    return;
  }

  const profileId = capture?.id ?? null;
  if (taken) {
    // The snapshot may still be stopping; the stall is reported once it has.
    void taken.done.then((snap) => report(found, snap, profileId));
  } else {
    report(found, null, profileId);
  }

  if (trigger?.noteStall(found.durationMs, now)) {
    const reason =
      `${policy!.stallCount} stalls of at least ${policy!.minStallMs}ms ` +
      `within ${Math.round(policy!.windowMs / 1000)}s`;
    void runCapture(reason, now);
  }
}, init.pollIntervalMs);

post({ type: "ready" });
