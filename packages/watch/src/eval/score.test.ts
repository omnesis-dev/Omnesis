// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The scorer has to be able to fail, and this file's job is to prove it.
 *
 * A scorer that says "equivalent" too readily turns an evaluation into a
 * number that always looks good, and there is nothing downstream to catch it —
 * the whole point of the run is that this is the last check. So each assertion
 * below is paired with a watch that is *deliberately* not equivalent, in a way
 * a plausible compilation actually gets wrong: the right shape on the wrong
 * source, the right filter without the cancel, the right structure keyed on
 * the wrong thing.
 *
 * The counterweight matters as much: two spellings of the same watch must come
 * out equivalent, or the scorer is grading vocabulary and every rate it
 * reports is a lower bound on something else.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { watchNames } from "../backtest/golden.js";
import { loadWatch } from "../runtime/run.js";
import { universeDir } from "../universe/paths.js";
import { watchDslSchema, type WatchDefinition } from "../dsl/schema.js";
import { behaviourOf, compareBehaviour, type Behaviour } from "./score.js";

/**
 * References are fixture data once their real replay finishes. Keep only the
 * result, never a database, and clone it so comparisons cannot affect a later
 * test. Lazy loading keeps a focused test from replaying unrelated references.
 * The identity checks below deliberately run both sides fresh.
 */
const referenceBehaviours = new Map<string, Promise<Behaviour>>();

async function referenceBehaviour(name: string): Promise<Behaviour> {
  let reference = referenceBehaviours.get(name);
  if (!reference) {
    reference = behaviourOf(loadWatch(name));
    referenceBehaviours.set(name, reference);
  }
  return structuredClone(await reference);
}

/** A corpus watch with one thing changed, still validating. */
function variantOf(
  name: string,
  mutate: (watch: Record<string, unknown>) => void,
): WatchDefinition {
  const raw = readFileSync(join(universeDir(), "watches", `${name}.json`), "utf8");
  const doc = JSON.parse(raw) as { watch: Record<string, unknown> };
  mutate(doc.watch);
  return watchDslSchema.parse(doc).watch;
}

describe("a watch compared with itself", () => {
  // The floor. A scorer that cannot recognise identity would fail every request
  // in the run and the number would mean nothing.
  //
  // Two watches rather than seventeen, and these two. `goldens.test.ts` replays
  // every watch against its frozen trace, but under the universe's *scripted*
  // judge — a different and much smaller replay than the one scored here, where
  // a judge that agrees with everything opens every gate below it. The two
  // differ by more than an order of magnitude: the invoice watch fires once
  // against the scripted judge and seventy-seven times against the agreeing
  // one, and it is the seventy-seven-instance replay whose stability nothing
  // else pins.
  //
  // So these are the two whose agreeing-judge replay is largest and most
  // concurrent, which is where a nondeterministic instance sweep would show.
  // A watch that behaves identically under both judges would add nothing here
  // that `goldens.test.ts` does not already have.
  it.each(["invoice-and-receipt-both-arrived", "important-email-unanswered"])(
    "%s is equivalent to itself",
    async (name) => {
      const watch = loadWatch(name);
      const behaviour = await behaviourOf(watch);
      expect(compareBehaviour(behaviour, await behaviourOf(watch)).equivalent).toBe(true);
    },
    120_000,
  );
});

describe("the reaches the scorer counts", () => {
  it("names every reach of a watch whose judgement an event arms", async () => {
    const judged = await referenceBehaviour("important-email-unanswered");
    expect(judged.totalReaches).toBeGreaterThan(0);
    expect(judged.reaches).toHaveLength(judged.totalReaches);
  });

  it("counts, without naming, the reaches a timer arms", async () => {
    // A timer-driven evaluation has no comparable sequence — the number it
    // gets depends on how many timers came due before it, which differs
    // between two watches that are otherwise the same — and the trace records
    // no instant against it. So it is counted rather than named, and the total
    // is compared separately.
    const ticked = await referenceBehaviour("major-life-turning-point");
    expect(ticked.totalReaches).toBeGreaterThan(0);
    expect(ticked.reaches).toEqual([]);
  });

  it("catches a timer-driven watch that judges twice as often", async () => {
    // Neither side names a single reach — a timer-driven evaluation has no
    // comparable sequence — so if this is caught at all it is caught by the
    // count.
    const original = await referenceBehaviour("major-life-turning-point");
    const busier = await behaviourOf(
      variantOf("major-life-turning-point", (watch) => {
        const nodes = watch.nodes as { type: string; recurring?: string }[];
        for (const node of nodes) if (node.recurring) node.recurring = "0 20 * * WED,SUN";
      }),
    );
    expect(original.reaches, "the premise is gone").toEqual([]);
    expect(busier.reaches).toEqual([]);
    expect(busier.totalReaches).toBeGreaterThan(original.totalReaches);
    expect(compareBehaviour(original, busier).equivalent).toBe(false);
  });

  it("compares the total on its own, for the case where nothing else differs", async () => {
    // The named lists can agree while the counts do not, and that difference
    // has to be its own check rather than a side effect of another one.
    const behaviour = await referenceBehaviour("major-life-turning-point");
    const busier = { ...behaviour, totalReaches: behaviour.totalReaches + 1 };
    const verdict = compareBehaviour(behaviour, busier);
    expect(verdict.equivalent).toBe(false);
    expect(verdict.difference).toContain("in total");
  });
});

describe("two spellings of the same watch", () => {
  it("is equivalent when only the node ids differ", async () => {
    // A compiler is not reproducing a file. Names it chose itself must not
    // count against it.
    const original = loadWatch("mum-call-rhythm-stopped");
    const renamed = variantOf("mum-call-rhythm-stopped", (watch) => {
      const json = JSON.stringify(watch).replaceAll("rhythm_broken", "gap_detected");
      Object.assign(watch, JSON.parse(json) as Record<string, unknown>);
    });

    const verdict = compareBehaviour(await behaviourOf(original), await behaviourOf(renamed));
    expect(verdict.difference).toBeNull();
  });

  it("is equivalent when only the key component names differ", async () => {
    // `{thread_id: …}` and `{thread: …}` separate the same instances. Grading
    // the difference would be grading vocabulary.
    const original = loadWatch("important-email-unanswered");
    const renamed = variantOf("important-email-unanswered", (watch) => {
      // Both halves: the component's name and the extractor that reads it.
      // Renaming only one is a broken watch, not a differently-spelled one.
      const json = JSON.stringify(watch)
        .replaceAll('".thread_id"', '".thread"')
        .replaceAll('"thread_id"', '"thread"');
      Object.assign(watch, JSON.parse(json) as Record<string, unknown>);
    });

    expect(
      compareBehaviour(await behaviourOf(original), await behaviourOf(renamed)).difference,
    ).toBeNull();
  });
});

describe("a timer whose hour the request never named", () => {
  it("is equivalent when the tick moves within the day", async () => {
    // Nothing in "warn me if my resting heart rate stays above 70 for a whole
    // week" says what time of day to look. A compilation that ticks at eight
    // rather than nine is the same watch, and failing it would be grading
    // taste rather than behaviour.
    const original = await referenceBehaviour("elevated-resting-hr-week");
    const earlier = await behaviourOf(
      variantOf("elevated-resting-hr-week", (watch) => {
        const nodes = watch.nodes as { recurring?: string }[];
        for (const node of nodes) if (node.recurring) node.recurring = "0 8 * * *";
      }),
    );
    expect(original.firings.length, "the watch under test fires nothing").toBeGreaterThan(0);
    expect(compareBehaviour(original, earlier).difference).toBeNull();
  });

  it("is not equivalent when the tick moves the firing to another day", async () => {
    // The counterweight. Day granularity is a tolerance, not a blind spot.
    const original = await referenceBehaviour("elevated-resting-hr-week");
    const weekly = await behaviourOf(
      variantOf("elevated-resting-hr-week", (watch) => {
        const nodes = watch.nodes as { recurring?: string }[];
        for (const node of nodes) if (node.recurring) node.recurring = "0 9 * * MON";
      }),
    );
    const verdict = compareBehaviour(original, weekly);
    expect(verdict.equivalent, verdict.difference ?? "").toBe(false);
  });
});

describe("a watch that is not the same watch", () => {
  it("catches a different source", async () => {
    // The most common near-miss: the right structure over the wrong feed.
    const original = await referenceBehaviour("important-email-unanswered");
    const wrong = await behaviourOf(
      variantOf("important-email-unanswered", (watch) => {
        const nodes = watch.nodes as { filter?: { source?: string } }[];
        for (const node of nodes) {
          if (node.filter?.source === "gmail") node.filter.source = "whatsapp-messages";
        }
      }),
    );
    expect(compareBehaviour(original, wrong).equivalent).toBe(false);
  });

  it("catches a missing cancel, which is a watch that fires when it should not", async () => {
    const original = await referenceBehaviour("important-email-unanswered");
    const wrong = await behaviourOf(
      variantOf("important-email-unanswered", (watch) => {
        const nodes = watch.nodes as { id: string; inputs?: Record<string, { role: string }> }[];
        for (const node of nodes) {
          for (const [from, input] of Object.entries(node.inputs ?? {})) {
            if (input.role === "cancel") delete node.inputs![from];
          }
        }
      }),
    );
    const verdict = compareBehaviour(original, wrong);
    expect(verdict.equivalent, verdict.difference ?? "").toBe(false);
  });

  it("catches a different duration, which changes when it fires and not whether", async () => {
    // The instant is part of the comparison for exactly this: a watch that
    // fires the right number of times on the wrong days is not the same watch.
    const original = await referenceBehaviour("mum-call-rhythm-stopped");
    const wrong = await behaviourOf(
      variantOf("mum-call-rhythm-stopped", (watch) => {
        const nodes = watch.nodes as { duration?: string }[];
        for (const node of nodes) if (node.duration) node.duration = "20 days";
      }),
    );
    const verdict = compareBehaviour(original, wrong);
    expect(verdict.equivalent, verdict.difference ?? "").toBe(false);
  });

  it("catches a watch keyed on the wrong thing, by the key and not by luck", async () => {
    // The canonical near-miss: the right nodes wired the right way, gathering
    // into one cell instead of one per thread — so an invoice from one job
    // pairs with a receipt from another. Both sides fire at the same
    // sequences, so the key is the only thing that can separate them, and
    // this test exists because it did not: the key was being read off the
    // source node, which always fires as a singleton.
    const original = await referenceBehaviour("invoice-and-receipt-both-arrived");
    const global = await behaviourOf(
      variantOf("invoice-and-receipt-both-arrived", (watch) => {
        const nodes = watch.nodes as { inputs?: Record<string, { key?: unknown }> }[];
        for (const node of nodes) {
          for (const input of Object.values(node.inputs ?? {})) delete input.key;
        }
      }),
    );
    expect(
      new Set(original.firings.map((f) => f.key)).size,
      "the reference's key separates nothing, so this proves nothing",
    ).toBeGreaterThan(1);

    const verdict = compareBehaviour(original, global);
    expect(verdict.equivalent, verdict.difference ?? "").toBe(false);
  });

  it("does not grade a key that separates nothing", async () => {
    // A watch whose filter already pins one person, keyed on that person: the
    // key takes one value for the whole replay, so it partitions nothing and
    // the watch behaves exactly as it would with no key at all. Failing a
    // compilation for declining to write it grades vocabulary in the one place
    // this scorer is supposed to be reading structure.
    //
    // A live compilation of the Alice request did exactly this, five times out
    // of five. The fixture here is a different watch, because Alice's fires
    // once: a single firing has a one-value key whatever the key is, so it
    // would satisfy the precondition below without exercising it. This one
    // fires thirteen times on one key.
    const original = await referenceBehaviour("same-topic-across-two-channels");
    expect(
      original.firings.length,
      "one firing has a one-value key trivially, so this proves nothing",
    ).toBeGreaterThan(1);
    expect(
      new Set(original.firings.map((f) => f.key)).size,
      "the reference's key already separates things, so this proves nothing",
    ).toBe(1);

    const unkeyed = await behaviourOf(
      variantOf("same-topic-across-two-channels", (watch) => {
        for (const node of watch.nodes as { inputs?: Record<string, { key?: unknown }> }[]) {
          for (const input of Object.values(node.inputs ?? {})) delete input.key;
        }
      }),
    );
    const verdict = compareBehaviour(original, unkeyed, {
      reference: "same-topic-across-two-channels",
    });
    expect(verdict.equivalent, "a key that separates nothing was graded").toBe(true);
    expect(
      verdict.used,
      "the latitude was granted without being recorded, so nothing can count it",
    ).toEqual(["key-vocabulary"]);
    expect(
      compareBehaviour(original, unkeyed).equivalent,
      "read strictly, a differently-spelled key is still a difference",
    ).toBe(false);
  }, 120_000);

  it("does not grade how a number was rounded", async () => {
    // The reference reports `round(avg(rhr), 1)`; a compilation reporting the
    // same average unrounded is reporting one fact, and the request says
    // nothing about presenting it. Three significant figures is the bar.
    const original = await referenceBehaviour("elevated-resting-hr-week");
    const unrounded = await behaviourOf(
      variantOf("elevated-resting-hr-week", (watch) => {
        for (const node of watch.nodes as { query?: string }[]) {
          if (node.query) node.query = node.query.replace("round(avg(rhr), 1)", "avg(rhr)");
        }
      }),
    );
    const verdict = compareBehaviour(original, unrounded, {
      reference: "elevated-resting-hr-week",
    });
    expect(verdict.equivalent, "rounding was graded as a difference in behaviour").toBe(true);
    expect(verdict.used, "the tolerance was granted without being recorded").toEqual([
      "numeric-precision",
    ]);
    expect(
      compareBehaviour(original, unrounded).equivalent,
      "read strictly, an unrounded average is a different number",
    ).toBe(false);

    // And a genuinely different number is still a different number.
    const doubled = await behaviourOf(
      variantOf("elevated-resting-hr-week", (watch) => {
        for (const node of watch.nodes as { query?: string }[]) {
          if (node.query) node.query = node.query.replace("round(avg(rhr), 1)", "avg(rhr) * 2");
        }
      }),
    );
    expect(compareBehaviour(original, doubled).equivalent).toBe(false);
  }, 120_000);

  it("catches a watch that splits one instance into several", async () => {
    // The direction a coarser key cannot show: a compilation that keys on
    // something finer than the request asks for, where both still fire. Its
    // firings group differently, which is what the partition comparison is for.
    const original = await referenceBehaviour("same-topic-across-two-channels");
    const split = await behaviourOf(
      variantOf("same-topic-across-two-channels", (watch) => {
        for (const node of watch.nodes as {
          inputs?: Record<string, { key?: Record<string, string> }>;
        }[]) {
          for (const input of Object.values(node.inputs ?? {})) {
            if (input.key) input.key.doc = "$e.docId";
          }
        }
      }),
    );
    const verdict = compareBehaviour(original, split);
    expect(verdict.equivalent, "a finer key scored as the same watch").toBe(false);
  }, 120_000);

  it("catches a watch that adds a key component the reference does not have", async () => {
    const original = await referenceBehaviour("restaurant-budget-500");
    const overkeyed = await behaviourOf(
      variantOf("restaurant-budget-500", (watch) => {
        const nodes = watch.nodes as {
          inputs?: Record<string, { key?: Record<string, string> }>;
        }[];
        for (const node of nodes) {
          for (const input of Object.values(node.inputs ?? {})) {
            if (input.key) input.key.currency = ".currency";
          }
        }
      }),
    );
    expect(compareBehaviour(original, overkeyed).equivalent).toBe(false);
  });

  it("catches a looser filter, which changes what a model is asked to look at", async () => {
    // Dropping the inbound predicate lets the user's own mail reach the judge.
    // The reach list is what states that, and it is compared for exactly this:
    // a watch that judges twice as much is not the same watch even when the
    // firings happen to line up.
    const original = await referenceBehaviour("important-email-unanswered");
    const looser = await behaviourOf(
      variantOf("important-email-unanswered", (watch) => {
        const nodes = watch.nodes as { filter?: { people?: unknown } }[];
        for (const node of nodes) if (node.filter?.people) delete node.filter.people;
      }),
    );
    expect(
      looser.totalReaches,
      "the looser filter reached no more than the original",
    ).toBeGreaterThan(original.totalReaches);
    expect(compareBehaviour(original, looser).equivalent).toBe(false);
  });

  it("catches a difference that lives entirely below a judgement", async () => {
    // The reason the probe agrees with everything rather than counting. Under a
    // judge that never fires, the cancel below it is unreachable and a watch
    // without one replays identically — the comparison would pass on a watch
    // that fires when it should have been called off.
    const original = await referenceBehaviour("important-email-unanswered");
    expect(original.firings.length, "nothing below the judge is being reached").toBeGreaterThan(0);

    const uncancellable = await behaviourOf(
      variantOf("important-email-unanswered", (watch) => {
        const nodes = watch.nodes as { inputs?: Record<string, { role: string }> }[];
        for (const node of nodes) {
          for (const [from, input] of Object.entries(node.inputs ?? {})) {
            if (input.role === "cancel") delete node.inputs![from];
          }
        }
      }),
    );
    expect(original.reaches, "the difference is above the judge, not below it").toEqual(
      uncancellable.reaches,
    );
    const verdict = compareBehaviour(original, uncancellable);
    expect(verdict.equivalent).toBe(false);
    expect(verdict.difference).toContain("firings");
  });
});

describe("what the comparison reports", () => {
  it("names the side that differs and by how much", async () => {
    const original = await referenceBehaviour("restaurant-budget-500");
    const wrong = await behaviourOf(
      variantOf("restaurant-budget-500", (watch) => {
        const nodes = watch.nodes as { query?: string }[];
        for (const node of nodes) {
          if (node.query) node.query = node.query.replace("500", "5");
        }
      }),
    );
    const verdict = compareBehaviour(original, wrong);
    expect(verdict.equivalent).toBe(false);
    expect(verdict.difference).toMatch(/firings|model reaches/);
  });
});

describe("a condition computed on a judged value", () => {
  it("comes out both ways, so the comparison is exercised", async () => {
    // The travel watch freezes a passport expiry as a constant and compares a
    // judged departure date against it. Under a constant stub that comparison
    // came out false for every document, so it was never exercised — and a
    // compilation with it inverted, or missing, replayed identically to one
    // that had it right. One document's output is scripted so the reference
    // says yes to exactly that one and no to the other twenty.
    const behaviour = await referenceBehaviour("trip-vs-passport-expiry");
    expect(behaviour.totalReaches, "the judge is not being reached").toBeGreaterThan(10);
    expect(behaviour.firings, "the comparison never came out true").toHaveLength(1);
  });

  it("catches a compilation that inverted it", async () => {
    const original = await referenceBehaviour("trip-vs-passport-expiry");
    const inverted = await behaviourOf(
      variantOf("trip-vs-passport-expiry", (watch) => {
        const nodes = watch.nodes as { query?: string }[];
        for (const node of nodes) {
          if (node.query) node.query = node.query.replace(" < ", " > ");
        }
      }),
    );
    const verdict = compareBehaviour(original, inverted);
    expect(verdict.equivalent, verdict.difference ?? "").toBe(false);
  });

  it("catches a compilation that dropped it", async () => {
    const original = await referenceBehaviour("trip-vs-passport-expiry");
    const always = await behaviourOf(
      variantOf("trip-vs-passport-expiry", (watch) => {
        const nodes = watch.nodes as { query?: string }[];
        for (const node of nodes) if (node.query) node.query = "SELECT true AS fires";
      }),
    );
    expect(always.firings.length, "dropping the comparison changed nothing").toBeGreaterThan(
      original.firings.length,
    );
    expect(compareBehaviour(original, always).equivalent).toBe(false);
  });
});

/** A watch whose query names a column that is not there, so replaying it throws. */
function brokenQuery(name: string): WatchDefinition {
  return variantOf(name, (watch) => {
    for (const node of watch.nodes as { predicate?: string; query?: string }[]) {
      if (node.predicate) node.predicate = `${node.predicate} AND no_such_column IS NULL`;
      else if (node.query) node.query = node.query.replace(/SELECT/, "SELECT no_such_column,");
    }
  });
}

describe("a firing's payload", () => {
  it("is part of what is compared, not just the moment", async () => {
    // A watch that fires on every right occasion and hands back the wrong
    // thing is not the watch that was asked for.
    const original = await referenceBehaviour("restaurant-budget-500");
    const wrongValue = await behaviourOf(
      variantOf("restaurant-budget-500", (watch) => {
        const sink = watch.sink as { output_map?: Record<string, string> };
        sink.output_map = { ...(sink.output_map ?? {}), month: "'1999-01-01'" };
      }),
    );
    const verdict = compareBehaviour(original, wrongValue);
    expect(verdict.equivalent, "a wrong payload value scored as the same watch").toBe(false);
    expect(verdict.difference).toContain("firings");
  });

  it("is equivalent when only the field names differ", async () => {
    // The same rule the key components get, and for the same reason: a
    // compilation chooses these names itself. Most requests name none of them —
    // a couple happen to contain a word a field is also called — and marking on
    // a vocabulary the request did not supply is the defect this round removed
    // from the answer key. So the values are graded and the names are not.
    const original = await referenceBehaviour("meeting-with-lost-touch");
    const renamed = await behaviourOf(
      variantOf("meeting-with-lost-touch", (watch) => {
        const sink = watch.sink as { output_map?: Record<string, string> };
        sink.output_map = Object.fromEntries(
          Object.entries(sink.output_map ?? {}).map(([field, value]) => [`${field}_list`, value]),
        );
      }),
    );
    expect(compareBehaviour(original, renamed).equivalent).toBe(true);
  });

  it("is equivalent when the compilation reports something further", async () => {
    // The direction the comparison deliberately does not run. No request names
    // its payload's contents any more than its field names, so a watch that
    // hands back everything the reference does plus one more fact has not
    // misread it — and marking that wrong is the answer key grading on
    // information it never supplied.
    //
    // A live compilation of the call-rhythm request did exactly this: it
    // reported the last contact, which the reference reports, and the channel
    // it came by, which the reference does not.
    const original = await referenceBehaviour("mum-call-rhythm-stopped");
    const alsoSays = await behaviourOf(
      variantOf("mum-call-rhythm-stopped", (watch) => {
        const sink = watch.sink as { output_map?: Record<string, string> };
        sink.output_map = { ...(sink.output_map ?? {}), channel: "'apple-call-log'" };
      }),
    );
    expect(
      compareBehaviour(original, alsoSays).equivalent,
      "an extra fact was graded as a defect",
    ).toBe(true);

    // And the direction it does run: dropping what the reference reported is
    // still caught, so this is not simply ignoring the payload.
    const saysNothing = await behaviourOf(
      variantOf("mum-call-rhythm-stopped", (watch) => {
        (watch.sink as { output_map: Record<string, string> }).output_map = {
          nothing: "'x'",
        };
      }),
    );
    expect(compareBehaviour(original, saysNothing).equivalent).toBe(false);
  }, 120_000);

  it("hands a compilation the same answer key whatever it called itself", async () => {
    // The probe scopes its verdicts to the reference they were written for, and
    // the scoping key has to be the *reference's* name. A compilation chooses
    // its own — none of the recorded attempts at this request chose the
    // reference's slug — so scoping on the replayed watch's name gives every
    // compilation an empty answer key and grades it on what it called itself.
    //
    // Every replay in this suite is of a corpus reference, whose name is its
    // own answer key's owner, so nothing else here can see the difference.
    const original = await behaviourOf(loadWatch("invoice-and-receipt-both-arrived"), {
      reference: "invoice-and-receipt-both-arrived",
    });
    expect(original.firings.length, "the reference fires nothing to compare").toBeGreaterThan(0);

    const renamed = await behaviourOf(
      variantOf("invoice-and-receipt-both-arrived", (watch) => {
        watch.name = "a-name-of-its-own-choosing";
      }),
      { reference: "invoice-and-receipt-both-arrived" },
    );
    expect(
      compareBehaviour(original, renamed, { reference: "invoice-and-receipt-both-arrived" })
        .equivalent,
      "the same plan under a different name scored differently",
    ).toBe(true);
  }, 120_000);

  it("does not compare a value that is one of the watch's own node names", async () => {
    // `$fired_by` resolves to the id of the node that fired, so the reference
    // hands back `alice_email_decline` — a name it chose for itself, which no
    // compilation can produce however correctly it read the request. Comparing
    // it grades node names through the payload.
    const original = await referenceBehaviour("alice-declines-dinner");
    const renamed = await behaviourOf(
      variantOf("alice-declines-dinner", (watch) => {
        const json = JSON.stringify(watch)
          .replaceAll("alice_email_decline", "by_email")
          .replaceAll("alice_whatsapp_decline", "by_whatsapp");
        Object.assign(watch, JSON.parse(json) as Record<string, unknown>);
      }),
    );
    const verdict = compareBehaviour(original, renamed, { reference: "alice-declines-dinner" });
    expect(
      verdict.equivalent,
      "the same plan under different node names scored as a different watch",
    ).toBe(true);
    expect(verdict.used, "the latitude was granted without being recorded").toEqual(["node-names"]);
    expect(
      compareBehaviour(original, renamed).equivalent,
      "read strictly, a node name in the payload is still a difference",
    ).toBe(false);
  }, 120_000);

  it("does not compare prose a compilation cannot be expected to reproduce", async () => {
    // Two watches that both take their prose from the journal and land on
    // different sentences: the reference reports the loop's title as it stood
    // after the change, this one as it stood before. A title transcribed is not
    // a decision, and two correct watches will word it differently.
    const original = await referenceBehaviour("tax-loop-closed");
    const reworded = await behaviourOf(
      variantOf("tax-loop-closed", (watch) => {
        const source = (watch.nodes as { id: string; output_map: Record<string, string> }[])[0]!;
        source.output_map.title = "$e.before.title";
      }),
    );
    expect(
      compareBehaviour(original, reworded).equivalent,
      "prose is being graded, so two correct watches would disagree",
    ).toBe(true);
  });

  it("grades a number that is wrong by more than its presentation", async () => {
    // The other side of the rounding tolerance. It has to be tight enough that
    // a total five pounds out on five hundred is a different total, which is
    // what a tolerance stated as significant figures would not be: three
    // figures reads as five pounds at this magnitude and as fifty at ten
    // thousand, and the request names a magnitude.
    const original = await referenceBehaviour("restaurant-budget-500");
    const overstated = await behaviourOf(
      variantOf("restaurant-budget-500", (watch) => {
        for (const node of watch.nodes as { query?: string }[]) {
          if (node.query)
            node.query = node.query.replace("sum(amount) AS total", "sum(amount) + 5 AS total");
        }
      }),
    );
    expect(
      compareBehaviour(original, overstated).equivalent,
      "a total five pounds out scored as the same total",
    ).toBe(false);
  }, 120_000);

  it("pairs firings at one moment by what they say, not by how their keys sort", () => {
    // Several instances can fire at one instant, and there is nothing to order
    // them by that both sides agree on — the key is spelled differently by
    // design. Ordering each side by its own keys pairs the reference's first
    // firing with whichever of the compilation's happens to sort first, which
    // reads as a wrong payload when the two are merely in a different order.
    const shape = { reaches: [], totalReaches: 0, crashedAt: null } as const;
    // Values as the scorer carries them: exact text plus the provenance a
    // strict reading needs.
    const says = (...values: string[]) =>
      values.map((exact) => ({ exact, numeric: null, isNodeName: false, isConstant: false }));
    // A reference whose request names no instance dimension, so the keys are
    // read as the partition they induce. Without that the differently-spelled
    // keys below are a difference in their own right and the pairing this test
    // is about is never reached.
    const REFERENCE = "same-topic-across-two-channels";
    const reference = {
      ...shape,
      firings: [
        { moment: "seq:10", key: "thread=A", reported: says("DOC-1") },
        { moment: "seq:10", key: "thread=B", reported: says("DOC-2") },
        { moment: "seq:10", key: "thread=A", reported: says("DOC-3") },
      ],
    };
    const renamed = {
      ...shape,
      firings: [
        { moment: "seq:10", key: "conversation=Z", reported: says("DOC-1") },
        { moment: "seq:10", key: "conversation=Y", reported: says("DOC-2") },
        { moment: "seq:10", key: "conversation=Z", reported: says("DOC-3") },
      ],
    };
    expect(
      compareBehaviour(reference, renamed, { reference: REFERENCE }).equivalent,
      "the same firings under differently-spelled keys scored as a different watch",
    ).toBe(true);

    // And a genuinely different grouping at that moment is still caught.
    const regrouped = {
      ...shape,
      firings: [
        { moment: "seq:10", key: "conversation=Z", reported: says("DOC-1") },
        { moment: "seq:10", key: "conversation=Z", reported: says("DOC-2") },
        { moment: "seq:10", key: "conversation=Y", reported: says("DOC-3") },
      ],
    };
    expect(compareBehaviour(reference, regrouped, { reference: REFERENCE }).equivalent).toBe(false);
  });

  it("does not let a constant stand in for a value it never computed", async () => {
    // The hole a covering comparison opens if constants count. A watch that
    // writes every month it could ever mean into every firing reports the right
    // one every time without ever deriving it, and on a fourth month it reports
    // nonsense. Under coverage alone that scores perfect.
    const original = await referenceBehaviour("restaurant-budget-500");
    const listsThemAll = await behaviourOf(
      variantOf("restaurant-budget-500", (watch) => {
        const sink = watch.sink as { output_map: Record<string, string> };
        delete sink.output_map.month;
        sink.output_map.m1 = "'2026-03-01'";
        sink.output_map.m2 = "'2026-04-01'";
        sink.output_map.m3 = "'2026-05-01'";
      }),
    );
    expect(
      compareBehaviour(original, listsThemAll).equivalent,
      "a watch that lists every answer scored as one that worked out which",
    ).toBe(false);
  }, 120_000);
});

/**
 * Properties of a single reference, rather than of the set.
 *
 * Whether any two say the *same* thing, and whether each says enough to be
 * worth comparing against, are checked in `entropy.test.ts` — where the whole
 * corpus is replayed once and every such property reads that one result. This
 * file replays what it needs for the case in hand.
 */
describe("a crashed replay", () => {
  it("is never equivalent to a watch that ran to the end", async () => {
    // The property the field exists for. A watch that dies partway does less
    // than one that finishes, and comparing only what it managed to do reads
    // "broke" as "stayed quiet".
    const reference = await referenceBehaviour("restaurant-budget-500");
    const broken = await behaviourOf(
      variantOf("restaurant-budget-500", (watch) => {
        for (const node of watch.nodes as { query?: string }[]) {
          if (node.query)
            node.query = node.query.replace(
              "plaid_transactions",
              "plaid_transactions AS t CROSS JOIN (SELECT no_such_column) AS x",
            );
        }
      }),
    );
    expect(broken.crashedAt, "the fixture did not actually throw").not.toBeNull();

    const verdict = compareBehaviour(reference, broken);
    expect(verdict.equivalent, "a watch that threw scored as the same watch").toBe(false);
    expect(verdict.difference).toContain("threw at sequence");
  });

  it("records where it stopped, not merely that it did", async () => {
    // The value was pinned by nothing: degrading it to a constant left every
    // test green, and a constant loses exactly what the field is for.
    //
    // Two watches broken the same way stop in different places, because what
    // arms them differs — one waits for an analytics row and the other for its
    // first tick, and a tick's sequence is negative.
    const onARow = await behaviourOf(brokenQuery("restaurant-budget-500"));
    const onATick = await behaviourOf(brokenQuery("elevated-resting-hr-week"));

    expect(onARow.crashedAt, "the row-driven watch did not throw").not.toBeNull();
    expect(onATick.crashedAt, "the tick-driven watch did not throw").not.toBeNull();
    expect(onARow.crashedAt, "both crashes report the same place").not.toBe(onATick.crashedAt);
    expect(onARow.crashedAt!, "a crash on an event has that event's sequence").toBeGreaterThan(0);
    expect(onATick.crashedAt!, "a crash on a timer has a timer's sequence").toBeLessThan(0);
  }, 120_000);

  it("reads two crash points as different, and one as the same", async () => {
    const reference = await referenceBehaviour("restaurant-budget-500");
    const early = { ...reference, crashedAt: 12 };
    const late = { ...reference, crashedAt: 40 };
    expect(compareBehaviour(early, late).equivalent, "two crash points read alike").toBe(false);
    expect(compareBehaviour(early, early).equivalent, "one crash point reads as two").toBe(true);
  });

  it("says which side threw, and where", async () => {
    // The message is what a person acts on, and it named the wrong side when
    // both had crashed.
    const reference = await referenceBehaviour("restaurant-budget-500");
    const compiled = compareBehaviour(reference, { ...reference, crashedAt: 14 });
    expect(compiled.difference).toContain("the compiled watch threw at sequence 14");

    const referenceThrew = compareBehaviour({ ...reference, crashedAt: 9 }, reference);
    expect(referenceThrew.difference).toContain("the reference threw at sequence 9");

    const both = compareBehaviour({ ...reference, crashedAt: 9 }, { ...reference, crashedAt: 14 });
    expect(both.difference, "one side is described as having finished when it did not").toContain(
      "both threw",
    );
  });

  it("has no reference whose judgement is gated on an output it never gets", async () => {
    // Three corpus judgements gate on their own structured output. A stub that
    // does not fit the declared schema leaves those nodes holding and then
    // expiring, so the watch fires nothing and the reference is again a fact
    // about the probe.
    const gated = watchNames().filter((name) =>
      loadWatch(name).nodes.some((node) => node.type === "llm" && "fire_when" in node),
    );
    expect(gated.length, "no corpus judgement gates on its own output").toBeGreaterThan(2);
    for (const name of gated) {
      const behaviour = await behaviourOf(loadWatch(name));
      expect(behaviour.firings.length, `${name} fires nothing under the probe`).toBeGreaterThan(0);
    }
  }, 120_000);
});
