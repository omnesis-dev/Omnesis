// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading a request's cadence, and saying something useful when a plan
 * disagrees with it.
 *
 * The measured taxonomy is unambiguous about where the compiler fails: it
 * writes the right graph and leaves out what bounds it. Five attempts dropped a
 * cooldown and fired thirteen times where the reference fires three. The
 * revision pass had only a reach count to offer, which is a cost with no scale
 * — a compiler cannot tell whether forty reaches is too many without knowing
 * what the request wanted.
 *
 * These pin the two halves that make the feedback actionable: that the cadence
 * read from the prose is the one a person would read, and that the concern
 * fires when the plan speaks too often and stays quiet when it does not.
 */

import { describe, expect, it } from "vitest";

import { frozenGolden, watchNames } from "../backtest/golden.js";
import { loadWatch } from "../runtime/run.js";
import { cadenceConcern, impliedCadence } from "./cadence.js";

describe("the cadence a request names", () => {
  it("hears an exception where the request asks to be warned", () => {
    expect(impliedCadence("Warn me if my resting heart rate stays above 70")?.cadence).toBe(
      "exceptional",
    );
    expect(impliedCadence("Alert me when Alice tells me she is not coming")?.cadence).toBe(
      "exceptional",
    );
    expect(impliedCadence("Ping me when my tax return gets closed")?.cadence).toBe("exceptional");
  });

  it("hears one per occurrence where the request says so", () => {
    expect(impliedCadence("Tell me every time an invoice arrives")?.cadence).toBe("per-occurrence");
    expect(impliedCadence("Let me know whenever a payment lands")?.cadence).toBe("per-occurrence");
  });

  it("prefers an explicit phrase over the mood of the sentence", () => {
    // "tell me" alone reads as exceptional; "every time" is the request saying
    // plainly that it wants one alert per occurrence, and it wins.
    expect(impliedCadence("Tell me if every time an invoice arrives")?.cadence).toBe(
      "per-occurrence",
    );
  });

  it("says nothing when the request names no cadence", () => {
    expect(impliedCadence("Something happened with the order")).toBeNull();
    expect(impliedCadence("")).toBeNull();
  });
});

describe("what the backtest says back", () => {
  const REQUEST = "Warn me if my resting heart rate stays above 70 for a whole week";

  it("names both rates when a plan speaks more often than the request implies", () => {
    const concern = cadenceConcern(REQUEST, 40, 90);
    expect(concern, "a plan speaking every other day drew no comment").not.toBeNull();
    expect(concern).toContain("40 times over 90 days");
    expect(concern, "the reader is not told what it is being compared against").toContain("0.2");
    expect(concern, "the feedback does not name a bound to reach for").toMatch(
      /cooldown|schedule|deadline/,
    );
  });

  it("stays quiet when the plan speaks as rarely as the request implies", () => {
    expect(cadenceConcern(REQUEST, 3, 90)).toBeNull();
  });

  it("stays quiet when the request names no cadence at all", () => {
    // Guessing here would produce revision advice that is confidently wrong,
    // and the revision pass gets one turn.
    expect(cadenceConcern("Something about the order", 400, 90)).toBeNull();
  });

  it("matches on whole words, not on substrings", () => {
    // The phrases are matched space-padded after folding. Without that, a
    // request about a "warning mechanism" would be read as a request to be
    // warned, and the revision pass would bound a watch that never asked.
    expect(impliedCadence("Warn mechanisms that fail")).toBeNull();
    expect(impliedCadence("Alert me, when the disk fills")?.cadence).toBe("exceptional");
    expect(impliedCadence("ALERT ME if the disk fills")?.cadence).toBe("exceptional");
  });

  it("says nothing at the band's own rate, and speaks just above it", () => {
    // The boundary is the whole rule. A watch firing at exactly the rate its
    // request implies is not a watch to complain about.
    const days = 100;
    const atBand = 0.2 * days;
    expect(cadenceConcern(REQUEST, atBand, days)).toBeNull();
    expect(cadenceConcern(REQUEST, atBand + 1, days)).not.toBeNull();
  });

  it("names which of the three readings it took", () => {
    // The message has to say what it thinks the request wanted, or the model is
    // being asked to reconsider against a number with no stated meaning.
    expect(cadenceConcern("Warn me if the disk fills", 90, 90)).toContain(
      "only when something is wrong",
    );
    expect(cadenceConcern("Every week, summarise my spending", 900, 90)).toContain(
      "a regular rhythm",
    );
    expect(cadenceConcern("Tell me every time a file appears", 9000, 90)).toContain(
      "one alert per occurrence",
    );
  });

  it("caps each band at the rate it names", () => {
    expect(impliedCadence("Tell me every time a file appears")?.firingsPerDay).toBe(5);
    expect(impliedCadence("Every week, summarise my spending")?.firingsPerDay).toBe(1);
    expect(impliedCadence("Warn me if the disk fills")?.firingsPerDay).toBe(0.2);
  });

  it("does not divide by a journal of no days", () => {
    expect(cadenceConcern(REQUEST, 5, 0)).toBeNull();
  });

  it("leaves every corpus reference alone, and not narrowly", () => {
    // The references are the answer key. A rule that complained about one of
    // them would be teaching compilations to diverge from the thing they are
    // scored against, which is worse than saying nothing.
    //
    // But "no reference trips it" is satisfied by a band sitting a hair above
    // the busiest reference, and a band chosen that way is fitted to the answer
    // key rather than to the language. So the margin is asserted too: every
    // reference must sit comfortably inside its band, not just under it.
    // Tightening a threshold until it hugs the corpus fails here.
    const complained: string[] = [];
    let tightest = { name: "none", share: 0 };
    for (const name of watchNames()) {
      const watch = loadWatch(name);
      const request = watch.nl_query ?? "";
      const { firings, days } = frozenFirings(name);
      if (cadenceConcern(request, firings, days)) complained.push(name);

      const band = impliedCadence(request);
      if (!band) continue;
      const share = firings / days / band.firingsPerDay;
      if (share > tightest.share) tightest = { name, share };
    }

    expect(complained, "the revision rule would push these away from the answer key").toEqual([]);
    expect(
      tightest.share,
      `${tightest.name} sits at ${(tightest.share * 100).toFixed(0)}% of its band — the bands are fitted to the corpus rather than to the language`,
    ).toBeLessThan(0.5);
  });
});

/**
 * How often each reference fires over the journal, and over how many days.
 *
 * Read from the golden rather than replayed: this is a test about the rule, not
 * about the engine, and a replay here would be slow for no gain. The horizon
 * comes from the golden too — asserting against a longer journal than the
 * corpus has would hand every reference a firing budget it never gets.
 */
function frozenFirings(name: string): { firings: number; days: number } {
  const golden = frozenGolden(name);
  return { firings: golden.trace.firings.length, days: golden.backtest.days };
}
