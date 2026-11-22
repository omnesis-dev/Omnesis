// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectWindowsPrivatePathSync } from "@omnesis/core";

import { afterEach, describe, expect, test } from "vitest";

import {
  captureMainThreadProfile,
  listProfileSummaries,
  profileIdAt,
  PROFILE_SUMMARY_VERSION,
  writeProfileSummary,
  type ProfilerSession,
  type ProfileSummary,
} from "./flight-recorder.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function summaryAt(epochMs: number): ProfileSummary {
  return {
    version: PROFILE_SUMMARY_VERSION,
    id: profileIdAt(epochMs),
    capturedAt: new Date(epochMs).toISOString(),
    reason: "test",
    stalls: [],
    profiledMs: 1_000,
    hottestCode: null,
    busyMs: 500,
    longRunMs: 500,
    longRuns: [],
    bySelf: [],
    byTotal: [],
    topStacks: [],
  };
}

describe("the profile summary ring", () => {
  test("keeps the newest summaries and lists them newest first", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "omnesis-flight-")), "diagnostics", "stalls");
    dirs.push(dir);
    const t0 = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 4; i++) writeProfileSummary(dir, summaryAt(t0 + i * 60_000), 2);

    expect(readdirSync(dir)).toHaveLength(2);
    const keptFile = join(dir, `${profileIdAt(t0 + 3 * 60_000)}.json`);
    if (process.platform === "win32") {
      expect(inspectWindowsPrivatePathSync(dir, "directory").private).toBe(true);
      expect(inspectWindowsPrivatePathSync(keptFile, "file").private).toBe(true);
    } else {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(keptFile).mode & 0o777).toBe(0o600);
    }
    const listed = await listProfileSummaries(dir);
    expect(listed.map((s) => s.capturedAt)).toEqual([
      new Date(t0 + 3 * 60_000).toISOString(),
      new Date(t0 + 2 * 60_000).toISOString(),
    ]);
  });

  test("skips a damaged file and reads a missing directory as empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-flight-"));
    dirs.push(dir);
    writeProfileSummary(dir, summaryAt(Date.UTC(2026, 0, 1)), 5);
    writeFileSync(join(dir, `${profileIdAt(Date.UTC(2026, 0, 2))}.json`), "{ not json");
    expect(await listProfileSummaries(dir)).toHaveLength(1);
    expect(await listProfileSummaries(join(dir, "absent"))).toEqual([]);
  });

  test("names a capture by its start time, sortably and safely", () => {
    expect(profileIdAt(Date.UTC(2026, 10, 2, 14, 7, 5, 120))).toBe(
      "profile-2026-11-02T14-07-05-120Z",
    );
  });
});

/** An inspector session that answers every call at once and records what it was asked. */
function recordingSession(): {
  session: ProfilerSession;
  calls: string[];
  disconnected: () => boolean;
} {
  const calls: string[] = [];
  let disconnected = false;
  const session = {
    post(method: string, _params: object, callback: (err: Error | null, result?: object) => void) {
      calls.push(method);
      callback(
        null,
        method === "Profiler.stop" ? { profile: { nodes: [], startTime: 0, endTime: 0 } } : {},
      );
    },
    disconnect() {
      disconnected = true;
    },
  } as unknown as ProfilerSession;
  return { session, calls, disconnected: () => disconnected };
}

describe("capturing a main-thread profile", () => {
  // Starting V8's profiler records every compiled function on the main thread
  // before the first sample: the costly step, and on a starved host a stall of
  // its own. A profile the caller no longer wants must never reach it.
  test("an unwanted profile never starts the profiler", async () => {
    const { session, calls, disconnected } = recordingSession();
    let asked = false;
    const profile = await captureMainThreadProfile(
      200,
      1_000,
      () => {
        asked = true;
        return false;
      },
      () => session,
    );
    expect(asked).toBe(true);
    expect(profile).toBeNull();
    expect(calls).toEqual(["Profiler.enable", "Profiler.disable"]);
    expect(disconnected()).toBe(true);
  });

  test("a wanted profile starts, runs and stops", async () => {
    const { session, calls, disconnected } = recordingSession();
    const profile = await captureMainThreadProfile(
      0,
      1_000,
      () => true,
      () => session,
    );
    expect(profile).not.toBeNull();
    expect(calls).toEqual([
      "Profiler.enable",
      "Profiler.setSamplingInterval",
      "Profiler.start",
      "Profiler.stop",
      "Profiler.disable",
    ]);
    expect(disconnected()).toBe(true);
  });
});
