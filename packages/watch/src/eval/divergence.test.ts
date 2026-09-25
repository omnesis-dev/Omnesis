// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The split between a misreading and a judgement call decides the headline
 * number, so it has to be impossible to talk round.
 *
 * The first version of it was. It collected the parameters the two watches
 * bound, checked those against the declared tolerances, and read "no bound
 * parameter disagreed outside a tolerance" as "nothing structural is wrong" —
 * but a watch reading the wrong table, or matching the wrong subject, binds no
 * parameter at all and so contributed nothing to that check. One in-tolerance
 * tick hour was then enough to have the whole divergence excused. Five of the
 * eight watches that declare a free parameter declare an unconstrained hour,
 * which a compilation cannot guess, so that was the ordinary path rather than
 * a corner.
 *
 * The rule now: rebuild the reference making the compilation's own choices for
 * the parameters its request left open, and require the divergence to go away.
 * Necessary and sufficient — if the free parameters explain it, normalising
 * them removes it; if anything else is wrong, it survives.
 *
 * The four cases under "a real defect alongside an open choice" are the ones
 * that were being laundered.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { watchNames } from "../backtest/golden.js";
import { loadWatch } from "../runtime/run.js";
import { universeDir } from "../universe/paths.js";
import { watchDslSchema, type WatchDefinition } from "../dsl/schema.js";
import { boundParameters } from "./bound-parameters.js";
import { classifyDivergence, type DivergenceVerdict } from "./divergence.js";
import { behaviourOf, compareBehaviour } from "./score.js";

const LONG = 120_000;

function variantOf(
  name: string,
  mutate: (watch: Record<string, unknown>) => void,
): WatchDefinition {
  const raw = readFileSync(join(universeDir(), "watches", `${name}.json`), "utf8");
  const doc = JSON.parse(raw) as { watch: Record<string, unknown> };
  mutate(doc.watch);
  return watchDslSchema.parse(doc).watch;
}

/** Move a recurring source's hour, which every one of these requests leaves free. */
function atHour(watch: Record<string, unknown>, hour: number): void {
  for (const node of watch.nodes as { recurring?: string }[]) {
    if (!node.recurring) continue;
    const parts = node.recurring.split(/\s+/);
    parts[1] = String(hour);
    node.recurring = parts.join(" ");
  }
}

function classify(name: string, compiled: WatchDefinition): Promise<DivergenceVerdict> {
  return classifyDivergence(name, loadWatch(name), compiled);
}

describe("the role a parameter plays names it uniquely", () => {
  it.each(watchNames())("%s", (name) => {
    // What the matching rests on. Two waits in one watch would make
    // `stateful.wait.duration` ambiguous; the classifier drops an ambiguous
    // role rather than guessing, and the corpus keeps them unique so that
    // never has to happen on the reference side.
    const watch = loadWatch(name);
    const roles = boundParameters(watch).map((parameter) => {
      const nodeId = parameter.at.slice(0, parameter.at.indexOf("."));
      const field = parameter.at.slice(nodeId.length + 1);
      return `${watch.nodes.find((n) => n.id === nodeId)?.type ?? "?"}|${field}`;
    });
    expect(roles.length - new Set(roles).size, `duplicate role in ${name}`).toBe(0);
  });
});

describe("a divergence the request accounts for", () => {
  it(
    "is defensible when normalising the open choices removes it",
    async () => {
      // "we talk roughly every week — tell me if that rhythm stops" names no
      // number. Twelve days is a reading of it; so is the reference's nine.
      const verdict = await classify(
        "mum-call-rhythm-stopped",
        variantOf("mum-call-rhythm-stopped", (watch) => {
          for (const node of watch.nodes as { duration?: string }[]) {
            if (node.duration) node.duration = "12 days";
          }
        }),
      );
      expect(verdict.kind, verdict.detail).toBe("defensible");
      expect(verdict.detail, "the reader is not told why it was excused").toContain("rhythm stops");
    },
    LONG,
  );

  it(
    "survives the nodes being renamed, because parameters match by role",
    async () => {
      const renamed = variantOf("mum-call-rhythm-stopped", (watch) => {
        const json = JSON.stringify(watch)
          .replaceAll("rhythm_broken", "silence_gap")
          .replaceAll('"duration":"9 days"', '"duration":"12 days"');
        Object.assign(watch, JSON.parse(json) as Record<string, unknown>);
      });
      expect((await classify("mum-call-rhythm-stopped", renamed)).kind).toBe("defensible");
    },
    LONG,
  );
});

describe("a divergence the request does not account for", () => {
  it(
    "is structural when the choice is outside the declared range",
    async () => {
      const verdict = await classify(
        "mum-call-rhythm-stopped",
        variantOf("mum-call-rhythm-stopped", (watch) => {
          for (const node of watch.nodes as { duration?: string }[]) {
            if (node.duration) node.duration = "40 days";
          }
        }),
      );
      expect(verdict.kind).toBe("structural");
    },
    LONG,
  );

  it(
    "is structural when the request named the value",
    async () => {
      // "I haven't replied for 3 days" states the wait, so five is a
      // misreading and the tolerance table has nothing to say about it.
      const verdict = await classify(
        "important-email-unanswered",
        variantOf("important-email-unanswered", (watch) => {
          for (const node of watch.nodes as { duration?: string }[]) {
            if (node.duration) node.duration = "5 days";
          }
        }),
      );
      expect(verdict.kind).toBe("structural");
    },
    LONG,
  );

  it(
    "is structural when a parameter is missing entirely",
    async () => {
      const verdict = await classify(
        "elevated-resting-hr-week",
        variantOf("elevated-resting-hr-week", (watch) => {
          watch.nodes = (watch.nodes as { type: string }[]).filter(
            (node) => node.type !== "stateful.cooldown",
          );
          (watch.sink as { input: string }).input = "hr_week_check";
        }),
      );
      expect(verdict.kind).toBe("structural");
      expect(verdict.detail).toContain("absent");
    },
    LONG,
  );
});

/**
 * Each of these pairs a real defect with a move of a tick hour — which every
 * one of these requests leaves open, and which a compilation cannot guess.
 * Under the old rule the in-tolerance hour was the only difference the check
 * could see, and the defect rode out with it.
 */
describe("a real defect alongside an open choice", () => {
  it(
    "is structural when the SQL threshold is wrong",
    async () => {
      const verdict = await classify(
        "elevated-resting-hr-week",
        variantOf("elevated-resting-hr-week", (watch) => {
          atHour(watch, 8);
          for (const node of watch.nodes as { query?: string }[]) {
            if (node.query) node.query = node.query.replace("> 70", "> 100");
          }
        }),
      );
      expect(verdict.kind, verdict.detail).toBe("structural");
    },
    LONG,
  );

  it(
    "is structural when the query reads the wrong table",
    async () => {
      const verdict = await classify(
        "sleep-materially-worse",
        variantOf("sleep-materially-worse", (watch) => {
          atHour(watch, 3);
          for (const node of watch.nodes as { query?: string }[]) {
            if (node.query) node.query = node.query.replaceAll("health_sleep", "health_vitals");
          }
        }),
      );
      expect(verdict.kind, verdict.detail).toBe("structural");
    },
    LONG,
  );

  it(
    "is structural when a window inside the query is wrong",
    async () => {
      const verdict = await classify(
        "meeting-with-lost-touch",
        variantOf("meeting-with-lost-touch", (watch) => {
          atHour(watch, 20);
          for (const node of watch.nodes as { query?: string }[]) {
            if (node.query) node.query = node.query.replace("INTERVAL 1 YEAR", "INTERVAL 100 YEAR");
          }
        }),
      );
      expect(verdict.kind, verdict.detail).toBe("structural");
    },
    LONG,
  );
});

describe("what this corpus can see", () => {
  it(
    "tells a threshold from one that admits everything",
    async () => {
      // Most days in this journal run in the fifties and sixties, with three
      // elevated spells, so a watch asking for 70 selects different days from
      // one asking for 40.
      //
      // Readings on both sides of a threshold are what make the threshold
      // measurable at all. Were every reading above both numbers, the two
      // watches would select the same days and replay identically, the
      // classifier would never be consulted because nothing diverged, and a
      // compilation that invented the number would score as though it had read
      // the request. This check is what stops a later fixture edit from
      // flattening the readings back out: such an edit looks harmless and
      // silently returns the watch to being unmeasurable.
      const reference = await behaviourOf(loadWatch("elevated-resting-hr-week"));
      const looser = await behaviourOf(
        variantOf("elevated-resting-hr-week", (watch) => {
          for (const node of watch.nodes as { query?: string }[]) {
            if (node.query) node.query = node.query.replace("> 70", "> 40");
          }
        }),
      );
      expect(
        compareBehaviour(reference, looser).equivalent,
        "every reading sits on one side of both thresholds again",
      ).toBe(false);
    },
    LONG,
  );
});

describe("a divergence with no parameter difference at all", () => {
  it(
    "is structural, because there is nothing to excuse it with",
    async () => {
      // A key removed. Same numbers, different routing — the difference is in
      // the shape, and the free-parameter table has no opinion about shapes.
      const verdict = await classify(
        "maya-conversation-lapsed",
        variantOf("maya-conversation-lapsed", (watch) => {
          for (const node of watch.nodes as { inputs?: Record<string, { key?: unknown }> }[]) {
            for (const input of Object.values(node.inputs ?? {})) delete input.key;
          }
        }),
      );
      expect(verdict.kind).toBe("structural");
      expect(verdict.detail).toContain("shape");
    },
    LONG,
  );

  it(
    "is structural when a compilation adds a parameter the reference has not",
    async () => {
      // The direction nothing else covers: not a different value, an extra one.
      const verdict = await classify(
        "maya-conversation-lapsed",
        variantOf("maya-conversation-lapsed", (watch) => {
          (watch.nodes as Record<string, unknown>[]).push({
            id: "capped",
            type: "stateful.cooldown",
            inputs: { lapsed: { role: "arm" } },
            min_interval: "30 days",
          });
          (watch.sink as { input: string }).input = "capped";
        }),
      );
      expect(verdict.kind).toBe("structural");
      expect(verdict.detail).toContain("absent");
    },
    LONG,
  );
});
