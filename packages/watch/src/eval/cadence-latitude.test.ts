// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a declared cadence latitude has to earn.
 *
 * The declaration says a rate limiter on a reference is the reference's own
 * choice rather than something its request asked for, so a compilation that
 * fitted none has not misread anything. That is a claim about a particular
 * request and a particular watch, and every part of it is checked here: the
 * bound exists, the bound does something, the request does not name a rate, and
 * the words given as the reason are the request's own.
 *
 * The last of these is what keeps the table from growing by assertion. A
 * `because` that quotes nothing can say whatever makes a number look better.
 */

import { describe, expect, it, vi } from "vitest";

import { watchDslSchema, type WatchDefinition } from "../dsl/schema.js";
import { watchNames } from "../backtest/golden.js";
import { loadWatch } from "../runtime/run.js";
import { boundParameters } from "./bound-parameters.js";
import { classifyDivergence } from "./divergence.js";
import { behaviourOf } from "./score.js";
import { CADENCE_LATITUDES, cadenceLatitudeFor } from "./free-parameters.js";
import { namesARateLimit } from "./named-in-request.js";

/**
 * These replay real watches over the corpus journal, which is minutes of work
 * across the file rather than the milliseconds a unit test takes. The suite's
 * 30s default is sized for the latter, and the slower cases here sit close
 * enough to it that ordinary concurrency tips them over — a timeout that reads
 * as a failing assertion and sends whoever is on CI looking for a bug in the
 * change they just made.
 */
vi.setConfig({ testTimeout: 300_000 });

const DECLARED = Object.keys(CADENCE_LATITUDES);

it("declares at least one watch, so the guards below are not vacuous", () => {
  // `it.each([])` registers no cases and the file passes green. An emptied or
  // renamed table would take every check with it, silently.
  expect(DECLARED.length).toBeGreaterThan(0);
});

/** The role a bound plays, spelled the way the divergence classifier spells it. */
function slotsOf(watch: WatchDefinition): string[] {
  return boundParameters(watch).map((parameter) => {
    const nodeId = parameter.at.slice(0, parameter.at.indexOf("."));
    const field = parameter.at.slice(nodeId.length + 1);
    return `${watch.nodes.find((n) => n.id === nodeId)?.type ?? "?"}|${field}`;
  });
}

/** The watch as a compilation that fitted no such limiter would have written it. */
function withoutTheLimiter(name: string, slot: string): WatchDefinition {
  const type = slot.slice(0, slot.indexOf("|"));
  const document = JSON.parse(JSON.stringify({ watch: loadWatch(name) })) as {
    watch: { nodes: Record<string, unknown>[]; sink: Record<string, unknown> };
  };
  const node = document.watch.nodes.find((n) => n.type === type);
  if (node === undefined) throw new Error(`${name} has no ${type} to remove`);
  const upstream = Object.keys(node.inputs as Record<string, unknown>)[0]!;
  document.watch.nodes = document.watch.nodes.filter((n) => n !== node);
  if (document.watch.sink.input === node.id) document.watch.sink.input = upstream;
  return watchDslSchema.parse(document).watch;
}

describe("every declared cadence latitude", () => {
  it.each(DECLARED)("%s — declares a bound the reference actually carries", (name) => {
    const declared = CADENCE_LATITUDES[name]!;
    expect(
      slotsOf(loadWatch(name)),
      "the declaration names a bound this watch does not have, so it excuses nothing and checks nothing",
    ).toContain(declared.slot);
  });

  it.each(DECLARED)("%s — declares a bound that does something", async (name) => {
    // The biconditional. A limiter that never binds on this journal costs a
    // compilation nothing to omit — such an attempt already scores as an exact
    // match — so declaring latitude for it could only ever excuse a divergence
    // caused by something else.
    const declared = CADENCE_LATITUDES[name]!;
    const reference = await behaviourOf(loadWatch(name), { reference: name });
    const stripped = await behaviourOf(withoutTheLimiter(name, declared.slot), { reference: name });
    expect(
      stripped.firings.length,
      "removing this bound changes nothing, so the latitude is bought for free",
    ).not.toBe(reference.firings.length);
  });

  it.each(DECLARED)("%s — quotes the request it claims to read", (name) => {
    const declared = CADENCE_LATITUDES[name]!;
    // Outermost span, not paired matches: a quotation containing an apostrophe
    // ("that I'd consider") closes early under pair-matching, and everything
    // after it — usually the operative half — goes unchecked.
    const first = declared.because.indexOf("'");
    const last = declared.because.lastIndexOf("'");
    const quoted = first < 0 || last <= first ? [] : [declared.because.slice(first + 1, last)];
    expect(
      quoted,
      "the reason quotes nothing, so it cannot be checked against the request",
    ).not.toHaveLength(0);

    const request = (loadWatch(name).nl_query ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
    for (const phrase of quoted) {
      expect(
        request.includes(phrase.toLowerCase().replace(/[^a-z0-9]+/g, " ")),
        `the reason quotes "${phrase}", which is not in this watch's request`,
      ).toBe(true);
    }
  });

  it.each(DECLARED)("%s — is not declared over a rate the request names", (name) => {
    // The same guard reconstructibility applies to values, applied to presence:
    // a request that asks to hear at a rate has named one, and a compilation
    // dropping the limiter has then misread it rather than chosen differently.
    expect(
      namesARateLimit(loadWatch(name).nl_query ?? ""),
      "this request names a rate, so a compilation dropping the limiter misread it",
    ).toBe(false);
  });
});

describe("watches carrying the same bound but not declaring it", () => {
  it("carry one that does nothing on this journal", async () => {
    // The counterweight. Two other corpus watches hold a `stateful.cooldown`
    // whose request names no rate either; they are absent from the table
    // because stripping the limiter leaves them firing exactly as before. If
    // that stops being true the declaration becomes load-bearing for them too,
    // and this fails rather than letting the omission pass unexamined.
    const slot = "stateful.cooldown|min_interval";
    const carrying = watchNames().filter((name) => slotsOf(loadWatch(name)).includes(slot));
    const undeclared = carrying.filter((name) => cadenceLatitudeFor(name, slot) === null);
    expect(undeclared.length, "no undeclared carrier left to check").toBeGreaterThan(0);

    for (const name of undeclared) {
      const reference = await behaviourOf(loadWatch(name), { reference: name });
      const stripped = await behaviourOf(withoutTheLimiter(name, slot), { reference: name });
      expect(
        stripped.firings.length,
        `${name}'s limiter now bites, so whether its absence is defensible has to be decided rather than left out`,
      ).toBe(reference.firings.length);
    }
  });
});

describe("classifying a compilation that fitted no limiter", () => {
  const name = "major-life-turning-point";

  it("calls it defensible when that is the whole difference", async () => {
    const reference = loadWatch(name);
    const verdict = await classifyDivergence(
      name,
      reference,
      withoutTheLimiter(name, CADENCE_LATITUDES[name]!.slot),
    );
    expect(verdict.kind).toBe("defensible");
    expect(verdict.detail, "the verdict does not say what excused it").toContain("no rate limit");
  });

  it("calls it structural when the latitude is withheld", async () => {
    // The switch the published with-and-without figures rest on. Both numbers
    // come from this one code path, so they differ by the allowance and not by
    // the scorer.
    const reference = loadWatch(name);
    const verdict = await classifyDivergence(
      name,
      reference,
      withoutTheLimiter(name, CADENCE_LATITUDES[name]!.slot),
      { cadenceLatitude: false },
    );
    expect(verdict.kind).toBe("structural");
  });

  it("still calls it structural when something else is wrong too", async () => {
    // The latitude excuses a missing limiter, not a compilation that also read
    // the request wrongly. Rebuilt without the limiter, this one still diverges.
    const reference = loadWatch(name);
    const document = JSON.parse(
      JSON.stringify({ watch: withoutTheLimiter(name, CADENCE_LATITUDES[name]!.slot) }),
    ) as { watch: { nodes: Record<string, unknown>[] } };
    const tick = document.watch.nodes.find((n) => n.type === "source.time");
    if (tick === undefined) throw new Error("expected a schedule to break");
    // A different day of the week, which the request's "when something happens"
    // does not name and the free-parameter table declares open only for the
    // *hour*. The whole schedule moving is a different reading of the request.
    tick.recurring = "0 20 * * WED";

    const verdict = await classifyDivergence(name, reference, watchDslSchema.parse(document).watch);
    expect(verdict.kind).toBe("structural");
  });
});

describe("a schedule whose day the request never names", () => {
  // Not latitude. A compilation ticking another day of the week is scored as a
  // misreading, and the corpus requests that carry a weekly tick name no day —
  // so this is the scorer being stricter than the requests warrant. Widening it
  // is a live question and not a settled one: on one of the two watches that
  // carry a day, the tick is an arm of a threshold rather than a metronome, so
  // moving it changes what the watch does rather than only when it looks.
  //
  // Pinned here so the current reading is deliberate rather than incidental,
  // and so widening it later has to change a test that says what it means.
  const name = "major-life-turning-point";

  function tickingOn(cron: string): WatchDefinition {
    const document = JSON.parse(JSON.stringify({ watch: loadWatch(name) })) as {
      watch: { nodes: Record<string, unknown>[] };
    };
    document.watch.nodes.find((n) => n.type === "source.time")!.recurring = cron;
    return watchDslSchema.parse(document).watch;
  }

  it("is read as a misreading, whatever the hour", async () => {
    for (const cron of ["0 20 * * WED", "0 9 * * WED"]) {
      const verdict = await classifyDivergence(name, loadWatch(name), tickingOn(cron));
      expect(verdict.kind, `${cron} was excused`).toBe("structural");
    }
  });
});
