// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The goldens must not depend on where they were recorded.
 *
 * Two separate things could make them: the host's timezone leaking into the
 * engine, and the evaluation timezone being an assumption rather than an input.
 * The first would make a trace unreproducible; the second would make it
 * reproducible and wrong for anyone not on UTC.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runWatch } from "../runtime/run.js";
import { universeDir } from "../universe/paths.js";
import type { WatchTrace } from "../runtime/trace.js";

const TRACES = join(universeDir(), "traces");

function golden(name: string): WatchTrace {
  return (JSON.parse(readFileSync(join(TRACES, `${name}.json`), "utf8")) as { trace: WatchTrace })
    .trace;
}

const NAMES = readdirSync(join(universeDir(), "watches"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

/**
 * The two extremes, straddling UTC by more than a day's worth of offset.
 *
 * A watch that reads the host clock instead of the journal's usually still
 * agrees with its golden under a small shift, because a few hours rarely move a
 * decision across a day boundary; +14 and -8 do. Zones in between add a full
 * corpus replay each and cannot catch anything these two miss — a watch that
 * survives fourteen hours forward and eight back is not reading the host clock.
 */
const ZONES = ["Pacific/Kiritimati", "America/Los_Angeles"];

describe("goldens under a shifted host timezone", () => {
  const original = process.env.TZ;

  afterEach(() => {
    // Restoring an unset variable by assignment would set it to the string
    // "undefined", which is not a zone — the process would be left in a worse
    // state than it started, and only vitest's process isolation would hide it.
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it.each(ZONES)(
    "replays the whole corpus identically under TZ=%s",
    async (tz) => {
      process.env.TZ = tz;
      for (const name of NAMES) {
        expect(await runWatch(name), `${name} under ${tz}`).toEqual(golden(name));
      }
    },
    // Seventeen replays of a season-long journal, per zone, alongside the rest
    // of the package. Well past the default ceiling on a loaded pool.
    120_000,
  );
});
