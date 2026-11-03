// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The stall flight recorder: a CPU profile of the main thread, captured when
 * stalls recur, kept as a summary in a small ring of files.
 *
 * The capture runs on the stall watchdog's thread. Its inspector session is
 * connected to the main thread in-process (`connectToMainThread`, no network
 * port), so the main thread only does what V8's profiler itself does —
 * sampling on its own thread, then serialising the profile on stop, a few
 * milliseconds — while parsing and summarising the profile, and writing the
 * summary, happen off it.
 *
 * Each summary is one JSON file under the gateway's
 * `<configDir>/diagnostics/stalls/`, named by its id, which sorts by capture
 * time. Writing a new one deletes the oldest beyond `keep`.
 */

import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { Session } from "node:inspector";
import { join } from "node:path";

import type { CpuProfile, ProfileSummaryBody } from "./profile-summary.js";
import type { StallEvent } from "./stall-protocol.js";

/**
 * Microseconds between profile samples. Fine enough to resolve a function
 * that holds the loop for tens of milliseconds, coarse enough that a minute
 * of samples stays a small profile to serialise.
 */
export const PROFILE_SAMPLING_INTERVAL_US = 2_000;

export const PROFILE_SUMMARY_VERSION = 1;

export interface ProfileSummary extends ProfileSummaryBody {
  version: number;
  id: string;
  /** ISO time the capture started. */
  capturedAt: string;
  /** Why it was captured, in words. */
  reason: string;
  /** The stalls recorded while it ran. */
  stalls: StallEvent[];
}

/** A capture id: its start time, sortable and safe as a file name. */
export function profileIdAt(epochMs: number): string {
  return `profile-${new Date(epochMs).toISOString().replace(/[:.]/g, "-")}`;
}

const FILE_PATTERN = /^profile-[0-9TZ-]+\.json$/;

/**
 * How long one inspector call may go unanswered. The main thread answers by
 * interrupt as soon as it is running JavaScript, but not while it is inside
 * native code (a synchronous SQLite call, a sync file read) until that
 * returns. A call still unanswered after this is abandoned, so a profile that
 * cannot finish never holds up the stall it was for, or every capture after it.
 */
const INSPECTOR_REPLY_TIMEOUT_MS = 10_000;

function post<T>(session: Session, method: string, params: object = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${method} unanswered after ${INSPECTOR_REPLY_TIMEOUT_MS}ms`)),
      INSPECTOR_REPLY_TIMEOUT_MS,
    );
    session.post(method, params, (err, result) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result as T);
    });
  });
}

/**
 * Profile the main thread for `durationMs`. Call from a worker thread only.
 * The inspector reaches the main thread by interrupt, so this starts while the
 * main thread is stuck in JavaScript — but only once it returns, when stuck in
 * native code. `stillWanted`, called once profiling has started with how long
 * the main thread took to answer the first, trivial inspector call — the
 * delay before it serviced an interrupt — lets the caller abandon a profile
 * that started too late to be of use: it is stopped at once and null is
 * returned.
 */
export async function captureMainThreadProfile(
  durationMs: number,
  samplingIntervalUs: number = PROFILE_SAMPLING_INTERVAL_US,
  stillWanted: (answerWaitMs: number) => boolean = () => true,
): Promise<CpuProfile | null> {
  const session = new Session();
  session.connectToMainThread();
  try {
    const asked = performance.now();
    await post(session, "Profiler.enable");
    const answerWaitMs = performance.now() - asked;
    await post(session, "Profiler.setSamplingInterval", { interval: samplingIntervalUs });
    await post(session, "Profiler.start");
    if (!stillWanted(answerWaitMs)) {
      await post(session, "Profiler.stop");
      await post(session, "Profiler.disable");
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const { profile } = await post<{ profile: CpuProfile }>(session, "Profiler.stop");
    await post(session, "Profiler.disable");
    return profile;
  } finally {
    session.disconnect();
  }
}

/** Write `summary` into the ring under `dir`, keeping the newest `keep`. Returns its path. */
export function writeProfileSummary(dir: string, summary: ProfileSummary, keep: number): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${summary.id}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  const files = readdirSync(dir)
    .filter((f) => FILE_PATTERN.test(f))
    .sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) {
    rmSync(join(dir, old), { force: true });
  }
  return file;
}

/** The summaries in the ring, newest first. A missing directory is an empty ring. */
export async function listProfileSummaries(dir: string): Promise<ProfileSummary[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => FILE_PATTERN.test(f));
  } catch {
    return [];
  }
  const summaries: ProfileSummary[] = [];
  for (const f of files.sort().reverse()) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, f), "utf8")) as ProfileSummary;
      if (parsed.version === PROFILE_SUMMARY_VERSION) summaries.push(parsed);
    } catch {
      // A file being replaced or damaged is skipped; the next write prunes it.
    }
  }
  return summaries;
}
