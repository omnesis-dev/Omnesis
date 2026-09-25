// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The verdict, over the shapes a real install produces.
 *
 * The degenerate ones are the point. A watch that has never matched, one whose
 * judge refuses everything, one that only holds a timer, and one that fires
 * rarely all look identical from every other surface — same status, same empty
 * firing count, same nothing. If the verdict cannot separate them here it
 * cannot separate them on a screen, and a wrong verdict is worse than none: it
 * teaches the operator to stop reading the line.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { watchVerdict, WATCH_VERDICT_NAMES } from "./verdict.js";
import type { WatchQualityInput } from "./verdict.js";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** A watch installed long enough ago to be judged, doing nothing in particular. */
function watch(overrides: Partial<WatchQualityInput> = {}): WatchQualityInput {
  return {
    status: "active",
    addedAtMs: NOW - 30 * DAY,
    now: NOW,
    wakesAnAgent: false,
    anchorStanding: null,
    firings: 0,
    lastFiredAtMs: null,
    declined: 0,
    judgeMatched: 0,
    judgeDeclined: 0,
    holding: false,
    stoppedCause: null,
    evaluatedThroughSeq: 4_000,
    ...overrides,
  };
}

describe("a watch that is working", () => {
  it("is healthy once it has fired, and says when", () => {
    const verdict = watchVerdict(watch({ firings: 4, lastFiredAtMs: NOW - 2 * DAY }));

    expect(verdict.name).toBe("healthy");
    expect(verdict.because).toBe("fired 4 times, most recently 2 days ago");
  });

  it("is healthy when it fires rarely, which is not the same as never", () => {
    // The shape that would otherwise read as broken: one firing in a month is
    // exactly what a watch for a rare event is supposed to look like.
    const verdict = watchVerdict(
      watch({ firings: 1, lastFiredAtMs: NOW - 26 * DAY, declined: 9_000 }),
    );

    expect(verdict.name).toBe("healthy");
    expect(verdict.because).toBe("fired 1 time, most recently 26 days ago");
  });

  it("stays healthy however much it has declined along the way", () => {
    // Declining is what a narrow watch does all day. Only a watch that has
    // never fired can be described by what it declined.
    expect(watchVerdict(watch({ firings: 2, declined: 50_000 })).name).toBe("healthy");
  });
});

describe("a watch that has never matched anything", () => {
  it("says how much it looked at and over how long", () => {
    const verdict = watchVerdict(watch({ declined: 4_183, addedAtMs: NOW - 21 * DAY }));

    expect(verdict.name).toBe("never-matched");
    expect(verdict.because).toBe("looked at 4,183 events over 21 days and admitted none");
  });

  it("says nothing of the kind before it has looked at enough", () => {
    // A quiet source is not a broken watch. Without the look threshold every
    // watch on a source that produces a document a week reads as never-matched.
    expect(watchVerdict(watch({ declined: 12, addedAtMs: NOW - 60 * DAY })).name).toBe("resting");
  });

  it("says nothing of the kind before enough time has passed", () => {
    // A backfill can push tens of thousands of events through a watch in its
    // first hour, which says nothing about the weeks it was written for.
    expect(watchVerdict(watch({ declined: 30_000, addedAtMs: NOW - 2 * DAY })).name).toBe(
      "resting",
    );
  });
});

describe("a watch whose judge refuses everything", () => {
  it("names the judge rather than the arm, because they are different repairs", () => {
    const verdict = watchVerdict(watch({ judgeDeclined: 37, declined: 9_000 }));

    expect(verdict.name).toBe("judge-declines-everything");
    expect(verdict.because).toBe("its arm nominated 37 documents and the judge refused every one");
  });

  it("waits for enough judgements before calling it", () => {
    // A judgement is expensive and rare; three of them is a run, not a rule.
    expect(watchVerdict(watch({ judgeDeclined: 3 })).name).toBe("resting");
  });

  it("says nothing of the kind once the judge has ever said yes", () => {
    expect(watchVerdict(watch({ judgeDeclined: 400, judgeMatched: 1 })).name).toBe("resting");
  });
});

describe("a watch that is resting", () => {
  it("distinguishes never having read anything from having read and found nothing", () => {
    expect(watchVerdict(watch({ evaluatedThroughSeq: null })).because).toBe(
      "installed, and has not read anything yet",
    );
  });

  it("says a timer-only watch is holding something rather than idle", () => {
    // A watch with an armed timer and no cells is waiting on a clock, and reads
    // as empty on every count-based surface.
    const verdict = watchVerdict(watch({ holding: true }));

    expect(verdict.name).toBe("resting");
    expect(verdict.because).toBe("holding something, and waiting for the rest of it");
  });

  it("says a young watch is young rather than silent", () => {
    expect(watchVerdict(watch({ addedAtMs: NOW - 3 * DAY })).because).toBe(
      "installed 3 days ago; too early to say",
    );
  });

  it("says an old watch on a quiet source has seen too little to judge", () => {
    expect(watchVerdict(watch({ declined: 12 })).because).toBe(
      "looked at 12 events; too few to say",
    );
  });
});

describe("a watch that has admitted something, but not enough to fire", () => {
  it("does not say it admitted none because its declines cleared the bar", () => {
    // A mid-flight join on a busy corpus: the judge matched three documents and
    // a cell is armed waiting for its second arm. Every one of those is
    // something admitted, and the decline count says nothing about them —
    // reading it alone produced "admitted none" about a watch one arrival from
    // firing, with the repair "widen the arm", which would make it worse.
    const verdict = watchVerdict(
      watch({ declined: 4_183, addedAtMs: NOW - 21 * DAY, judgeMatched: 3, holding: true }),
    );

    expect(verdict.name).toBe("resting");
    expect(verdict.because).toBe("holding something, and waiting for the rest of it");
  });

  it("does not say it admitted none while its judge has ever said yes", () => {
    // Holding nothing right now — the cell that judgement armed has since been
    // cancelled or expired — but the judge has still matched. "Admitted none"
    // is a claim about everything the watch ever took up.
    const verdict = watchVerdict(
      watch({ declined: 4_183, addedAtMs: NOW - 21 * DAY, judgeMatched: 3 }),
    );

    expect(verdict.name).toBe("resting");
    expect(verdict.because).toBe("its judge has admitted 3 documents, and nothing has fired yet");
  });

  it("does not say it admitted none while a cell is part way to arming", () => {
    // No judge at all — a procedural watch whose join is short an arm. Holding
    // is the only evidence there is that it admitted anything.
    const verdict = watchVerdict(
      watch({ declined: 4_183, addedAtMs: NOW - 21 * DAY, holding: true }),
    );

    expect(verdict.name).toBe("resting");
  });

  it("still says so when it has admitted nothing at all", () => {
    // The rule the three above narrow, unchanged: nothing matched, nothing
    // held, and enough looked at over long enough.
    expect(watchVerdict(watch({ declined: 4_183, addedAtMs: NOW - 21 * DAY })).name).toBe(
      "never-matched",
    );
  });
});

describe("a watch that is not running", () => {
  it("is not diagnosed by what it has not done", () => {
    // A watch paused on a thrown node goes on ageing, and every rule that reads
    // silence as evidence would eventually tell the operator to rewrite an arm
    // that was never given anything to admit.
    const verdict = watchVerdict(
      watch({ status: "paused", declined: 9_000, judgeDeclined: 400, addedAtMs: NOW - 90 * DAY }),
    );

    expect(verdict.name).toBe("stopped");
    expect(verdict.because).toBe(
      "paused after 0 firings; nothing is evaluated until it runs again",
    );
  });

  it("does not let a watch that broke read like one somebody paused", () => {
    // The status column says `paused` for both, and four of the five sites
    // that write it are faults the machine detected. A broken watch reading
    // as a deliberate hold is the one thing on this listing nobody would act
    // on — so it gets its own verdict, and a mark.
    const broke = watchVerdict(watch({ status: "paused", stoppedCause: "failed", firings: 2 }));

    expect(broke.name).toBe("broken");
    expect(broke.actionable, "a watch that broke by itself asks for nothing").toBe(true);
    expect(broke.because).toBe(
      "a node threw and stopped it after 2 firings; see `watch trace` for which",
    );
  });

  it("says when the install moved under a watch, and names the remedy that works", () => {
    // The sentence used to say the watch needed rewriting, and that was wrong
    // for the case that actually happens. The install's shape is one hash, so a
    // source declaring something no watch has heard of stops every watch at
    // once — observed live on thirty of them, all healed by a re-stamp with no
    // definition edited. Rewriting is for a watch that still fails after being
    // checked against the world as it now is.
    const drifted = watchVerdict(
      watch({
        status: "paused",
        stoppedCause: "drifted",
        firings: 0,
        driftCodes: "ONTOLOGY_FINGERPRINT_MISMATCH",
      }),
    );

    expect(drifted.name).toBe("broken");
    expect(drifted.because).toBe(
      "it no longer validates against this install after 0 firings (ONTOLOGY_FINGERPRINT_MISMATCH); re-stamp it if only the fingerprint moved, otherwise it needs rewriting",
    );
  });

  it("does not tell a watch held for review that it no longer validates", () => {
    // It does validate. Saying otherwise sends the operator to rewrite a watch
    // whose only problem is that a person has not yet looked at what moved.
    const sentence = watchVerdict(
      watch({
        status: "paused",
        stoppedCause: "drifted",
        firings: 0,
        driftCodes: "ONTOLOGY_FINGERPRINT_MISMATCH",
        heldSurface: "re-stamp it to accept the surface it now reads",
      }),
    ).because;

    expect(sentence).not.toContain("no longer validates");
    expect(sentence).toContain("the ontology it reads has changed");
    expect(sentence).toContain("re-stamp it");
  });

  it("still says something useful when the drift codes were not kept", () => {
    // A note written before the codes were read back off it. Naming nothing
    // beats naming `undefined` at an operator.
    const drifted = watchVerdict(watch({ status: "paused", stoppedCause: "drifted", firings: 0 }));

    expect(drifted.because).toBe(
      "it no longer validates against this install after 0 firings; re-stamp it if only the fingerprint moved, otherwise it needs rewriting",
    );
  });

  it("leaves a watch the operator held unmarked", () => {
    // Their own decision, restating a status every surface already shows. A
    // badge on it makes the badge mean nothing.
    const held = watchVerdict(watch({ status: "paused", stoppedCause: "held", firings: 5 }));

    expect(held.name).toBe("stopped");
    expect(held.actionable).toBe(false);
  });

  it("says a finished watch is finished, and carries what it did", () => {
    const verdict = watchVerdict(watch({ status: "retired", stoppedCause: "retired", firings: 1 }));

    expect(verdict.name).toBe("stopped");
    expect(verdict.because).toBe("finished after 1 firing; it will not fire again");
  });

  it("does not warn a finished watch about a record it never needed", () => {
    // A watch that finished without ever firing lost nothing, and the expiry of
    // the record it would have woken through is the ordinary end of that record
    // rather than a fault to repair.
    const verdict = watchVerdict(
      watch({
        status: "retired",
        stoppedCause: "retired",
        wakesAnAgent: true,
        anchorStanding: 0,
        firings: 0,
      }),
    );

    expect(verdict.name).toBe("stopped");
  });

  it("still says a finished watch lost the firings it made", () => {
    // The one breach nothing can repair, and the one the status must not
    // swallow: three firings went into a record that could not carry them,
    // nobody was woken, and it will never fire again. "Finished, nothing to
    // do" is the silence this whole module exists to break.
    const verdict = watchVerdict(
      watch({ status: "retired", wakesAnAgent: true, anchorStanding: 0, firings: 3 }),
    );

    expect(verdict.name).toBe("silent-risk");
    expect(verdict.because).toBe("has fired 3 times, and holds no record to wake an agent through");
  });

  it("still reports a running watch that reaches nobody", () => {
    expect(
      watchVerdict(watch({ status: "active", wakesAnAgent: true, anchorStanding: 0 })).name,
    ).toBe("silent-risk");
  });
});

describe("a watch that reaches nobody", () => {
  it("outranks everything else, because the rest of it may be working", () => {
    // A watch matching perfectly and delivering into a revoked record is the
    // failure with no symptom of its own.
    const verdict = watchVerdict(
      watch({ wakesAnAgent: true, anchorStanding: 0, firings: 12, lastFiredAtMs: NOW }),
    );

    expect(verdict.name).toBe("silent-risk");
    expect(verdict.because).toBe(
      "has fired 12 times, and holds no record to wake an agent through",
    );
  });

  it("names a second record nobody can reach", () => {
    const verdict = watchVerdict(watch({ wakesAnAgent: true, anchorStanding: 2 }));

    expect(verdict.because).toBe(
      "has fired 0 times so far, and holds 2 records to wake an agent through; only one is reachable",
    );
  });

  it("says nothing about a watch that wakes nobody by design", () => {
    // A watch that only notifies has no anchor to be missing, and reporting a
    // risk for it would be a permanent false alarm on an ordinary watch.
    expect(watchVerdict(watch({ wakesAnAgent: false, anchorStanding: null })).name).toBe("resting");
  });

  it("says nothing while its one record stands", () => {
    expect(watchVerdict(watch({ wakesAnAgent: true, anchorStanding: 1 })).name).toBe("resting");
  });
});

/** One real shape per verdict, so every member can be asked about by name. */
const SHAPES: Record<(typeof WATCH_VERDICT_NAMES)[number], WatchQualityInput> = {
  healthy: watch({ firings: 3, lastFiredAtMs: NOW - DAY }),
  resting: watch({ holding: true }),
  stopped: watch({ status: "paused", stoppedCause: "held" }),
  broken: watch({ status: "paused", stoppedCause: "failed" }),
  "never-matched": watch({ declined: 4_183, addedAtMs: NOW - 21 * DAY }),
  "judge-declines-everything": watch({ judgeDeclined: 37 }),
  "silent-risk": watch({ wakesAnAgent: true, anchorStanding: 0 }),
};

describe("the vocabulary", () => {
  it("reaches every member of the vocabulary from some real shape", () => {
    // A member nothing can produce is a word in a type and nowhere else.
    const reached = new Set(
      [
        watch({ firings: 3, lastFiredAtMs: NOW - DAY }),
        watch({ declined: 4_183, addedAtMs: NOW - 21 * DAY }),
        watch({ judgeDeclined: 37 }),
        watch({ holding: true }),
        watch({ wakesAnAgent: true, anchorStanding: 0 }),
        watch({ status: "paused", stoppedCause: "held" }),
        watch({ status: "paused", stoppedCause: "drifted" }),
      ].map((shape) => watchVerdict(shape).name),
    );
    expect([...reached].sort()).toEqual([...WATCH_VERDICT_NAMES].sort());
  });

  it("says whether there is anything to do about it, and the word for it", () => {
    // Written here rather than at each surface, and for a reason the sentence
    // does not share: a client deciding this from a list of names it was
    // compiled with renders nothing at all for a name it has not heard of — so
    // the surface built to raise an alarm stays silent about exactly the
    // verdicts a newer gateway learned to raise.
    expect(watchVerdict(watch({ wakesAnAgent: true, anchorStanding: 0 }))).toMatchObject({
      name: "silent-risk",
      label: "Reaching nobody",
      actionable: true,
    });
    expect(watchVerdict(watch({ firings: 2 }))).toMatchObject({
      label: "Working",
      actionable: false,
    });
    expect(watchVerdict(watch({ status: "paused" }))).toMatchObject({
      label: "Stopped",
      actionable: false,
    });
  });

  it("gives every member of the vocabulary a word and an answer", () => {
    // A member with no word renders as a raw slug at an operator; one with no
    // answer renders as nothing at all on the surfaces that mark.
    for (const name of WATCH_VERDICT_NAMES) {
      const shape = SHAPES[name];
      const decided = watchVerdict(shape);
      expect(decided.name, `${name} was not produced by its own shape`).toBe(name);
      expect(decided.label.length, `${name} has no word`).toBeGreaterThan(0);
      expect(typeof decided.actionable, `${name} does not say whether to act`).toBe("boolean");
    }
  });

  it("marks the four that ask for something, and only those", () => {
    // `stopped` restates a status every surface already shows, so a mark on it
    // is noise; the other two quiet ones are the ordinary states of a watch
    // that is fine. `broken` is the one not-running verdict nobody asked for.
    // A badge on every row makes the badge mean nothing.
    const marked = WATCH_VERDICT_NAMES.filter((name) => watchVerdict(SHAPES[name]).actionable);

    expect([...marked].sort()).toEqual([
      "broken",
      "judge-declines-everything",
      "never-matched",
      "silent-risk",
    ]);
  });

  it("states the figure it was decided from, not merely that there is one", () => {
    // The rule the whole module exists for: a verdict is never a bare
    // adjective. Asserting the actual numbers rather than "contains a digit",
    // which any implementation returning "0" would satisfy.
    expect(watchVerdict(watch({ firings: 3, lastFiredAtMs: NOW - DAY })).because).toBe(
      "fired 3 times, most recently 1 day ago",
    );
    expect(watchVerdict(watch({ declined: 4_183, addedAtMs: NOW - 21 * DAY })).because).toContain(
      "4,183 events",
    );
    expect(watchVerdict(watch({ judgeDeclined: 37 })).because).toContain("37 documents");
    expect(watchVerdict(watch({ wakesAnAgent: true, anchorStanding: 3 })).because).toContain(
      "3 records",
    );
  });

  it("reads an unparseable install date as an age of nothing, not as NaN", () => {
    // Every comparison against NaN is false, so the age gate would silently
    // stop working and a watch with fifty thousand declines would be told it
    // had seen too few.
    const verdict = watchVerdict(watch({ addedAtMs: Number.NaN, declined: 50_000 }));

    expect(verdict.name).toBe("resting");
    expect(verdict.because).toBe("installed 0 days ago; too early to say");
  });

  it("puts reaching nobody above every other fault at once", () => {
    // One watch satisfying three rules. Without an order, the sentence an
    // operator gets depends on which branch happens to be written first.
    const verdict = watchVerdict(
      watch({
        wakesAnAgent: true,
        anchorStanding: 0,
        declined: 9_000,
        judgeDeclined: 400,
        addedAtMs: NOW - 90 * DAY,
      }),
    );

    expect(verdict.name).toBe("silent-risk");
  });
});
