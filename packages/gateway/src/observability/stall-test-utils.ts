// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * For tests that pin an activity mark to a real code path: record the
 * activity the stall watchdog would sample at a chosen moment inside that
 * path, then replay a one-second stall holding it through the watchdog's own
 * detector on a simulated clock, and read back the names the stall is
 * reported under.
 */

import { activityName, activitySharedState } from "./main-activity.js";
import { StallDetector } from "./stall-detector.js";
import { sampleActivity, type ActivitySample } from "./stall-protocol.js";

/** The activity the watchdog would sample if the main thread stuck right now. */
export function captureActivity(): ActivitySample {
  return sampleActivity(activitySharedState().slots);
}

/** What a stall is named, by activity name. */
export interface NamedStall {
  readonly inner: string | null;
  readonly outer: string | null;
  readonly inFlight: readonly string[];
}

const INTERVAL_MS = 50;
const POLL_MS = 25;

/** The names a one-second stall holding `sample` throughout is reported under. */
export function nameStall(sample: ActivitySample): NamedStall {
  let now = 0;
  let beat = 0;
  let maxGap = 0;
  const detector = new StallDetector(INTERVAL_MS, 250, 2_000, beat, now);
  const takeMaxGap = () => {
    const gap = maxGap;
    maxGap = 0;
    return gap;
  };
  for (let t = 0; t < 1_000; t += POLL_MS) {
    now += POLL_MS;
    detector.poll(beat, now, () => sample, takeMaxGap);
  }
  maxGap = now - beat;
  beat = now;
  now += POLL_MS;
  const stall = detector.poll(beat, now, () => sample, takeMaxGap);
  if (!stall) throw new Error("the simulated stall was not detected");
  return {
    inner: activityName(stall.inner),
    outer: activityName(stall.outer),
    inFlight: stall.inFlight.map((id) => activityName(id) ?? "(unknown)"),
  };
}
