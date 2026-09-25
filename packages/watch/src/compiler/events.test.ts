// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the event directory has to be for resolution to mean anything.
 *
 * A directory holding one candidate cannot tell a compiler that resolved a
 * request correctly from one that had no choice. So the corpus offers a wrong
 * answer alongside the right one, and this fails if that stops being true.
 */

import { describe, expect, it } from "vitest";

import { loadWatch } from "../runtime/run.js";
import { loadOntology } from "../universe/paths.js";
import { sharedStems } from "../eval/named-in-request.js";
import { watchNames } from "../backtest/golden.js";
import { loadEvents, horizonOf } from "./events.js";

describe("the event directory", () => {
  const events = loadEvents();

  it("offers more than one candidate for the request that resolves against it", () => {
    // "the dinner" has to be ambiguous on its face and settled by something —
    // here, which one the request can be about. A single entry would make the
    // resolution free.
    const request = loadWatch("alice-declines-dinner").nl_query ?? "";
    const candidates = events.filter((e) => sharedStems(e.title, request).length > 0);
    expect(
      candidates.length,
      "the directory names only one dinner, so resolving it proves nothing",
    ).toBeGreaterThan(1);
  });

  it("gives every entry an end a horizon can be derived from", () => {
    for (const event of events) {
      expect(
        Date.parse(horizonOf(event)),
        `${event.eventId} has no derivable horizon`,
      ).toBeGreaterThan(Date.parse(event.startsAt));
    }
  });

  it("puts the horizon after the occasion, not at its start", () => {
    // A decline an hour before the dinner is the case the watch exists for. A
    // horizon at the first minute of the event would miss exactly that.
    const [dinner] = events;
    expect(dinner).toBeDefined();
    expect(Date.parse(horizonOf(dinner!))).toBeGreaterThan(Date.parse(dinner!.endsAt!));
  });
});

describe("a watch bound to an event", () => {
  it("freezes the identity and the time it derives its horizon from", () => {
    const watch = loadWatch("alice-declines-dinner");
    const constants = watch.constants ?? {};
    const bound = Object.values(constants).map((c) => String(c.value));

    const resolved = loadEvents().find((e) => bound.includes(e.eventId));
    expect(resolved, "the watch binds no event in the directory").toBeDefined();
    expect(bound, "the horizon's source is not frozen with the identity").toContain(
      resolved!.startsAt,
    );
  });

  it("declares the horizon its referent implies", () => {
    const watch = loadWatch("alice-declines-dinner");
    const resolved = loadEvents().find((e) =>
      Object.values(watch.constants ?? {}).some((c) => c.value === e.eventId),
    )!;
    expect(watch.expires_at, "the watch outlives the thing it is about").toBe(horizonOf(resolved));
  });

  it("carries provenance on every frozen value, so a person can check it", () => {
    // The operator approves an interpretation. A value with no stated source is
    // one they cannot check, and a wrong resolution then surfaces at firing
    // rather than at creation.
    for (const [name, constant] of Object.entries(
      loadWatch("alice-declines-dinner").constants ?? {},
    )) {
      expect(constant.provenance_doc, `${name} was frozen from nothing`).toBeTruthy();
      expect(constant.provenance_note, `${name} does not say how it was read`).toBeTruthy();
    }
  });

  it("binds the candidate the request can reach, not merely a candidate", () => {
    // The guard that was missing. Every other check here passes just as happily
    // with the *other* dinner bound — same trace, same firing, same accounted
    // constants — so nothing stated which one "the dinner" means, and the whole
    // point of resolution went unpinned.
    //
    // What settles it is the person. The request names Alice; one dinner has
    // her on it and the other does not. A compilation that picked the other one
    // did not resolve the request, it guessed.
    const watch = loadWatch("alice-declines-dinner");
    const request = (watch.nl_query ?? "").toLowerCase();
    const bound = Object.values(watch.constants ?? {}).map((c) => String(c.value));

    const named = loadOntology()
      .snapshot.people.filter((person) =>
        request.includes(person.canonicalName.split(" ")[0]!.toLowerCase()),
      )
      .map((person) => person.id);
    expect(named, "the request names nobody, so nothing could settle which event").not.toHaveLength(
      0,
    );

    const reachable = loadEvents().filter((event) =>
      event.people.some((person) => named.includes(person)),
    );
    expect(reachable, "no event in the directory is reachable from this request").toHaveLength(1);
    expect(
      bound,
      "the watch binds a dinner the request cannot reach — a guess, not a resolution",
    ).toContain(reachable[0]!.eventId);
  });

  it("leaves every dated watch either bounded or knowingly unbounded", () => {
    // The lint asks a watch bound to a date to declare a horizon, as a warning
    // rather than an error, because the horizon is a judgement. Both readings
    // exist in this corpus and each is deliberate:
    //
    // - the dinner watch stops a day after the dinner, because the question it
    //   asks cannot be answered afterwards;
    // - the passport watch outlives the expiry date it is bound to, because a
    //   passport running out is the beginning of the problem rather than the
    //   end of it.
    //
    // What must not happen is a third watch acquiring a date and nobody
    // deciding which of those it is.
    const UNBOUNDED_ON_PURPOSE: Record<string, string> = {
      "trip-vs-passport-expiry":
        "a passport expiring is the start of the problem; the watch is still worth asking after the date it names",
    };

    const dated = watchNames().filter((name) =>
      Object.values(loadWatch(name).constants ?? {}).some(
        (c) => c.type === "date" || c.type === "timestamp",
      ),
    );
    expect(dated.length, "no dated watch left to check").toBeGreaterThan(0);

    for (const name of dated) {
      const declared = loadWatch(name).expires_at !== undefined;
      const excused = UNBOUNDED_ON_PURPOSE[name];
      expect(
        declared || excused !== undefined,
        `${name} is bound to a date and neither declares a horizon nor says why it has none`,
      ).toBe(true);
    }
  });
});
