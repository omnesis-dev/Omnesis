// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Every reference must be rebuildable from its own request.
 *
 * The paired measurement asks a compiler to write a watch given a request and
 * the ontology. It can only mean that if the reference binds nothing the
 * request did not supply — otherwise the answer key is asking for information
 * it withheld, and the attempts it fails were never winnable.
 *
 * Three of seventeen were in that state, and between them they account for
 * fifteen of the eighty-five attempts in the first measured run: a watch firing
 * on the opposite of its request, a watch counting four where the request said
 * three, and a watch matching on content the request never named.
 *
 * So each bound value has to be one of two things, and neither can be quiet.
 * Either the request **names** it — the number is in the prose — or the watch
 * **declares it free** in `free-parameters.ts` with the range that reads the
 * request fairly. A parameter that is neither fails here. A parameter declared
 * free while the request names it also fails here, because that is the other
 * way to make an unwinnable attempt look winnable.
 */

import { describe, expect, it } from "vitest";

import { watchNames } from "../backtest/golden.js";
import { loadEvents } from "../compiler/events.js";
import { loadWatch } from "../runtime/run.js";
import { boundConstants, boundContent, boundParameters } from "./bound-parameters.js";
import { FREE_PARAMETERS, toleranceFor } from "./free-parameters.js";
import {
  countsNamedIn,
  datesNamedIn,
  namesARateLimit,
  namesBusinessDays,
  sharedStems,
  spansNamedIn,
} from "./named-in-request.js";

/**
 * A matched subject must share at least this much with its request.
 *
 * One is the honest bar: the request has to *name* the subject, not restate the
 * recall query. "invoice bill amount due payable" elaborates an invoice, and a
 * request saying "an invoice" has named it. What one rejects is the case this
 * exists for — a watch matching relocation against a request that says only
 * "the same subject", which shares nothing at all.
 */
const SUBJECT_NAMED = 1;

function requestOf(name: string): string {
  const query = loadWatch(name).nl_query;
  if (!query) throw new Error(`'${name}' has no nl_query`);
  return query;
}

/**
 * Whether the request names this exact value, for this parameter.
 *
 * Scoped by role, not only by value. A span in the request belongs to whatever
 * the request was talking about: "for a whole week" names the window a query
 * looks back over, and a cooldown that happens to be seven days is not thereby
 * named. Reading it as named is worse than a missed check — it then *forbids*
 * declaring that cooldown free, so a compilation choosing a different rate
 * limit is graded as a misreading of a request that never mentioned one.
 *
 * A working-day span is its own unit and has to be asked for in those words: a
 * request saying "5 days" does not name a watch's "5 business_days".
 */
function named(
  request: string,
  parameter: { kind: string; value: number; at: string; written: string },
): boolean {
  if (parameter.kind === "count") return countsNamedIn(request).includes(parameter.value);
  if (parameter.kind !== "duration") {
    // An hour of day is essentially never named, and when it is, it is named as
    // a time rather than a count. Treated as free unless declared otherwise.
    return false;
  }
  if (parameter.written.includes("business_day") && !namesBusinessDays(request)) return false;
  if (parameter.at.endsWith(".min_interval") && !namesARateLimit(request)) return false;
  return spansNamedIn(request).includes(parameter.value);
}

describe("every bound value is named by its request or declared free", () => {
  it.each(watchNames())("%s", (name) => {
    const request = requestOf(name);
    const unaccounted = boundParameters(loadWatch(name))
      .filter((p) => !named(request, p) && toleranceFor(name, p.at) === null)
      .map((p) => `${p.at} = ${p.written}`);

    expect(
      unaccounted,
      `${name} binds values its request does not name and does not declare free.\n` +
        `  request: ${request}\n` +
        `  Either put the value in the request, or declare it in free-parameters.ts with the range that reads the request fairly.`,
    ).toEqual([]);
  });
});

describe("nothing is declared free that the request already names", () => {
  it.each(watchNames())("%s", (name) => {
    const request = requestOf(name);
    // The other way to make an unwinnable attempt look winnable: excuse a
    // divergence on a number the request stated plainly.
    const excused = boundParameters(loadWatch(name))
      .filter((p) => named(request, p) && toleranceFor(name, p.at) !== null)
      .map((p) => `${p.at} = ${p.written}`);

    expect(excused, `${name} declares free a value its request names`).toEqual([]);
  });

  it("declares no tolerance for a watch or node that does not exist", () => {
    // A stale declaration is a silent exemption: the parameter it named is
    // gone, and whatever replaced it is unaccounted for.
    const stale: string[] = [];
    for (const [name, parameters] of Object.entries(FREE_PARAMETERS)) {
      if (!watchNames().includes(name)) {
        stale.push(`${name} (no such watch)`);
        continue;
      }
      const bound = new Set(boundParameters(loadWatch(name)).map((p) => p.at));
      for (const parameter of parameters) {
        if (!bound.has(parameter.at)) stale.push(`${name}: ${parameter.at}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("says why each free parameter is free, in the request's own terms", () => {
    for (const [name, parameters] of Object.entries(FREE_PARAMETERS)) {
      for (const parameter of parameters) {
        expect(parameter.because.length, `${name}: ${parameter.at}`).toBeGreaterThan(25);
        expect(parameter.from, `${name}: ${parameter.at}`).toBeLessThanOrEqual(parameter.to);
      }
    }
  });

  it("keeps every declared value inside its own declared range", () => {
    // A watch may not declare a tolerance that excludes what it actually does.
    const outside: string[] = [];
    for (const name of watchNames()) {
      for (const parameter of boundParameters(loadWatch(name))) {
        const tolerance = toleranceFor(name, parameter.at);
        if (!tolerance) continue;
        if (parameter.value < tolerance.from || parameter.value > tolerance.to) {
          outside.push(`${name}: ${parameter.at} = ${parameter.written}`);
        }
      }
    }
    expect(outside).toEqual([]);
  });
});

/**
 * What a request can bind by pointing rather than by stating.
 *
 * A request that says "the dinner" does not state an event id, and no amount of
 * reading the prose will produce one — but a compiler holding the event
 * directory can resolve it, exactly as it resolves a person's name to a person
 * id. So a bound identity is accounted for when the directory holds an event
 * the request could be pointing at.
 *
 * Every value of a candidate entry counts, not only the one this reference
 * chose: this asks whether a compilation could have produced the value at all,
 * which is a different question from whether it produced the right one.
 *
 * The right one is checked elsewhere, and has to be. Two candidates can behave
 * identically over a journal — same firings, same payloads — so nothing about
 * *behaviour* distinguishes them, and a reference bound to the wrong one would
 * pass every check here. `events.test.ts` is what pins the choice, by requiring
 * the bound candidate to be the one the request can actually reach.
 */
function resolvableFrom(request: string): string[] {
  return loadEvents().flatMap((event) =>
    sharedStems(event.title, request).length > 0
      ? [event.eventId, event.startsAt, ...(event.endsAt ? [event.endsAt] : [])]
      : [],
  );
}

describe("every constant is named by its request", () => {
  it.each(watchNames())("%s", (name) => {
    // The hardest case of the same rule. A constant is not derived from the
    // ontology at all — there is no table, no metadata path, nothing to read it
    // from — so a compilation can only get it from the request. A watch that
    // freezes one the request does not state is asking a compilation to invent
    // it, and a compilation that refuses on the grounds that the data is not
    // there has read the ontology correctly.
    const request = requestOf(name);
    const named = [...datesNamedIn(request), ...resolvableFrom(request)];
    const unaccounted = boundConstants(loadWatch(name))
      .filter((constant) => !named.includes(constant.written))
      .map((constant) => `${constant.at} = ${constant.written}`);

    expect(
      unaccounted,
      `${name} freezes a constant its request does not state.\n` +
        `  request: ${request}\n` +
        `  A constant has no source in the ontology, so either the request states it or no ` +
        `compilation can produce it — and refusing becomes the correct answer.`,
    ).toEqual([]);
  });

  it("reads a date written the way a person writes it", () => {
    expect(datesNamedIn("it runs out on 2031-05-14")).toEqual(["2031-05-14"]);
    expect(datesNamedIn("my passport expires 14 May 2031")).toEqual(["2031-05-14"]);
    expect(datesNamedIn("some time next year")).toEqual([]);
  });
});

describe("every matched subject is named by its request", () => {
  it.each(watchNames())("%s", (name) => {
    const request = requestOf(name);
    const unnamed = boundContent(loadWatch(name))
      .filter((content) => sharedStems(content.text, request).length < SUBJECT_NAMED)
      .map((content) => `${content.at}: "${content.text.slice(0, 60)}"`);

    expect(
      unnamed,
      `${name} matches on a subject its request does not name.\n` +
        `  request: ${request}\n` +
        `  A compilation cannot invent the subject; either the request names it, or the watch should not match on it.`,
    ).toEqual([]);
  });

  it("would reject a watch matching on a subject nobody asked for", () => {
    // The case this exists for, kept as an executable example: a request about
    // "the same subject" and a watch matching on relocation shared nothing.
    expect(sharedStems("moving house relocation new address", "the same subject").length).toBe(0);
    expect(
      sharedStems("moving house relocation new address", "Alice raises her house move").length,
    ).toBeGreaterThanOrEqual(SUBJECT_NAMED);
  });
});

describe("the matcher itself", () => {
  it("reads a span written as a word or a digit", () => {
    expect(spansNamedIn("within ten days")).toContain(10 * 86_400_000);
    expect(spansNamedIn("for 3 days")).toContain(3 * 86_400_000);
    expect(spansNamedIn("in a week")).toContain(7 * 86_400_000);
    expect(spansNamedIn("over the past two weeks")).toContain(14 * 86_400_000);
  });

  it("does not read a span the request never gave", () => {
    expect(spansNamedIn("tell me if that rhythm stops")).toEqual([]);
    expect(spansNamedIn("for the same job")).toEqual([]);
  });

  it("tells a working-day span from a calendar one", () => {
    expect(namesBusinessDays("within 5 working days")).toBe(true);
    expect(namesBusinessDays("within 5 days")).toBe(false);
  });

  it("does not read a currency amount as a count", () => {
    // "£200" would otherwise name any watch binding 200.
    expect(countsNamedIn("three payments over £200 in a week")).toEqual([3]);
  });

  it("does not read a span elsewhere in the request as a rate limit", () => {
    // The scoping that matters most: a cooldown is not named by the window a
    // query looks back over.
    expect(namesARateLimit("stays above 70 for a whole week")).toBe(false);
    expect(namesARateLimit("tell me at most once a month")).toBe(true);
  });

  it("does not read a calendar span as a working-day one", () => {
    expect(namesBusinessDays("within 5 days")).toBe(false);
    expect(namesBusinessDays("within 5 working days")).toBe(true);
  });

  it("reads a hyphenated span", () => {
    expect(spansNamedIn("a two-week silence")).toContain(14 * 86_400_000);
  });

  it("does not read an article as a count", () => {
    // "a client" is not one client, and reading it as a count would let any
    // watch binding 1 pass without its request saying so.
    expect(countsNamedIn("send a proposal to a client")).toEqual([]);
    expect(countsNamedIn("three payments")).toContain(3);
    expect(countsNamedIn("two different channels")).toContain(2);
  });
});
