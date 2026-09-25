// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Replays that run beside each other do not touch each other.
 *
 * Every replay opens its own in-memory analytics database, queries it and
 * closes it, and an evaluation sweep does that thousands of times with several
 * in flight at once. That is the only place this package allocates natively,
 * and it is where a run once died with `free(): corrupted unsorted chunks` — a
 * glibc heap error, which says the fault is in native memory rather than in
 * anything JavaScript can see.
 *
 * That crash is unreproduced. `scripts/stress-replay.ts` is the deliberate
 * attempt: bare open/close cycles and full concurrent replays, at higher
 * concurrency than the sweep used, both survive. So this is not a regression
 * test for a known bug — it is the standing check that the property the crash
 * would have broken still holds. Concurrent replays must agree with serial
 * ones, exactly. A run that silently returned a different trace under
 * concurrency would be the same class of fault surfacing quietly instead of
 * loudly, and quietly is worse.
 */

import { describe, expect, it } from "vitest";

import { behaviourOf } from "../eval/score.js";
import { loadWatch } from "../runtime/run.js";

/** Enough watches to have several databases live at once, few enough to stay quick. */
const UNDER_TEST = ["mum-call-rhythm-stopped", "alice-declines-dinner", "restaurant-budget-500"];

describe("replays running beside each other", () => {
  it("agree with the same replays run one at a time", async () => {
    const serial = [];
    for (const name of UNDER_TEST) {
      serial.push(await behaviourOf(loadWatch(name), { reference: name }));
    }

    const parallel = await Promise.all(
      UNDER_TEST.map((name) => behaviourOf(loadWatch(name), { reference: name })),
    );

    for (const [index, name] of UNDER_TEST.entries()) {
      expect(parallel[index], `${name} replayed differently with other replays in flight`).toEqual(
        serial[index],
      );
    }
  });

  it("agree with themselves when the same watch runs twice at once", async () => {
    // Two databases over one watch, opened and closed on overlapping schedules.
    // Shared native state between them would show up here before it showed up
    // as a crash.
    const [first, second] = await Promise.all([
      behaviourOf(loadWatch(UNDER_TEST[0]!), { reference: UNDER_TEST[0]! }),
      behaviourOf(loadWatch(UNDER_TEST[0]!), { reference: UNDER_TEST[0]! }),
    ]);
    expect(first).toEqual(second);
  });
});
