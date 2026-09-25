// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A must-refuse request has to be out-of-sample.
 *
 * The static prompt explains the DSL, and its explanations carry examples. If
 * one of those examples *is* an eval request — the same identifier, the same
 * phrasing — then refusing it is reading an answer back, and the rate it
 * contributes to measures nothing. Two of the five were in that state: the
 * identifier request shared its token with the prompt's own worked example,
 * and the blocked-loop request was spelled out almost verbatim.
 *
 * Two checks, because there are two ways to hand the answer over. The prompt
 * must not use a request's own distinctive example — its identifier, its
 * quantity — while explaining a rule. And it must not state a request's
 * *verdict*: the prompt has to say there is no blocked loop state, because that
 * is a fact a compiler needs, but saying "a request about being blocked on a
 * person should be refused" is the eval's question with its answer attached.
 *
 * A worked example can hand it over too. `alice-declines-dinner` carries a
 * comment naming the exact absence two of these requests turn on, so those
 * requests withhold it — the same hold-out the paired set uses, for the same
 * reason.
 */

import { describe, expect, it } from "vitest";

import { loadOntology } from "../universe/paths.js";
import { examplesFor } from "../compiler/examples.js";
import { loadEvents } from "../compiler/events.js";
import { loadLoops } from "../compiler/loops.js";
import { promptPrefix } from "../compiler/prompt.js";
import { UNSEEN_PROMPTS } from "./prompts.js";
import { unmentioned, pairedTasks } from "./harness.js";

const PROMPT = promptPrefix({
  ontology: loadOntology(),
  loops: loadLoops(),
  events: loadEvents(),
  examples: examplesFor(),
})[0]!.content.toLowerCase();

/**
 * Phrases the prompt puts in quotation marks, as ways of saying something
 * rather than as values.
 *
 * Two words, because the phrasings most worth quoting are short — "warn me",
 * "every time" — and a floor set above them would miss exactly the ones a
 * cadence rule is tempted to list. What the floor has to exclude instead is DSL
 * literals: a worked example carrying `"deadline": "3 days"` shares those words
 * with any request that says "3 days" while teaching nothing about how a
 * request was worded. A leading number is what tells the two apart.
 */
function quotedPhrases(prompt: string): string[] {
  return [...prompt.matchAll(/"([^"\n]{4,60})"/g)]
    .map((m) => m[1]!)
    .filter((phrase) => {
      const words = phrase.trim().split(/\s+/);
      return words.length >= 2 && !/^\d+$/.test(words[0]!);
    });
}

const fold = (text: string) =>
  ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;

/** Words distinctive enough that sharing one is sharing an example. */
function distinctiveLiterals(query: string): string[] {
  return [...query.matchAll(/\b[A-Z]{2,}-\d{2,}\b|\b\d+\s*(?:kilometres|km|miles)\b/g)].map(
    (m) => m[0]!,
  );
}

/**
 * Every request the evaluation asks, whichever set it is in.
 *
 * All three sets, with no filter. A request that is only expected to compile
 * can be leaked to just as thoroughly as one expected to be refused — the
 * prompt printing its distinctive token, or the words it is phrased in, hands
 * it the answer either way, and which set it happens to sit in changes nothing
 * about that.
 */
/** The prompt as the harness builds it for one request: its own example held back. */
function promptFor(id: string): string {
  return promptPrefix({
    ontology: loadOntology(),
    loops: loadLoops(),
    events: loadEvents(),
    examples: examplesFor([id]),
  })[0]!.content.toLowerCase();
}

const EVERY_REQUEST: readonly (readonly [string, string])[] = [
  ...UNSEEN_PROMPTS.map((p) => [p.id, p.query] as const),
  ...pairedTasks().map((t) => [t.id, t.query] as const),
];

describe("no request the evaluation asks is answered by the prompt itself", () => {
  it.each(EVERY_REQUEST)("%s", (id, query) => {
    // Built the way the harness builds it for this request: a paired task's
    // own reference is withheld from the worked examples, because comparing a
    // compilation against a watch it was just shown is not a measurement.
    // What must not carry the answer is everything else — the static prose
    // and the examples that remain.
    const shown = promptFor(id);
    const shared = distinctiveLiterals(query).filter((literal) =>
      shown.includes(literal.toLowerCase()),
    );
    expect(
      shared,
      "the prompt hands this request its own distinctive token, so answering it is reading it back",
    ).toEqual([]);
  });

  it.each(EVERY_REQUEST)("%s — not in the prompt's own words", (id, query) => {
    // The identifier check reads tokens; this reads phrasing. A prompt that
    // quotes the way a request is worded, and says what that wording means,
    // has answered the request's first question for it — which is the same
    // leak one degree softer, and invisible to a check looking for tokens.
    const shared = quotedPhrases(
      promptPrefix({
        ontology: loadOntology(),
        loops: loadLoops(),
        events: loadEvents(),
        examples: examplesFor([id]),
      })[0]!.content,
    ).filter((phrase) => fold(query).includes(fold(phrase)));
    expect(
      shared,
      "the prompt quotes this request's own wording, so reading the wording is reading the request",
    ).toEqual([]);
  });

  it("shows every candidate in the event directory, not a helpful subset", () => {
    // The leak a directory makes possible is not printing an identifier — the
    // compiler needs those the way it needs person ids. It is printing only the
    // one that happens to be right. A directory narrowed to the answer turns
    // resolution into transcription, and every request against it scores as
    // resolved without anything having been resolved.
    const events = loadEvents();
    expect(events.length, "no directory to check").toBeGreaterThan(1);
    for (const event of events) {
      expect(PROMPT, `the prompt hides ${event.eventId}, so picking is not a choice`).toContain(
        event.eventId.toLowerCase(),
      );
    }
  });

  it("finds quoted wording when there is some", () => {
    // The phrasing check has to be able to fire. A request's own worked example
    // carries its `nl_query`, so showing it back is the leak this catches.
    const nothingWithheld = promptFor("no-such-request");
    const request = pairedTasks().find((t) => t.id === "order-problem-by-number")!.query;
    expect(
      quotedPhrases(nothingWithheld).filter((phrase) => fold(request).includes(fold(phrase))),
    ).not.toEqual([]);
  });

  it("finds a leak when there is one", () => {
    // The guard has to be able to fire. Withholding a request's own example is
    // what keeps it quiet, so showing that example again is the leak, and this
    // is the request whose token would carry it.
    expect(distinctiveLiterals("a problem or a delay with order XR-4471")).toEqual(["XR-4471"]);
    expect(
      promptFor("no-such-request").includes("xr-4471"),
      "with nothing withheld the identifier is in the prompt, so the check above can fire",
    ).toBe(true);
    expect(promptFor("order-problem-by-number").includes("xr-4471")).toBe(false);
  });

  it("keeps the facts a compiler needs while dropping the verdicts", () => {
    // The prompt must go on teaching the rules — that an embedding cannot
    // retrieve a token, that a lexical term has to be distinctive, that there
    // is no blocked loop state. Removing them would be sabotage rather than
    // hold-out. What it may not do is answer the question: "should be refused"
    // attached to a request that is in the eval is the answer, not the rule.
    //
    // The identifier rule changed rather than went away. It used to end in a
    // refusal; it now ends in a lexical arm, and the obligation that arm
    // carries is what the eval asks about.
    expect(PROMPT).toContain("lexical");
    expect(PROMPT).toContain("distinctive");
    expect(PROMPT).toContain("blocked");
    expect(PROMPT, "the prompt states the verdict for a request the eval asks").not.toContain(
      "blocked on a",
    );
  });

  it("withholds a worked example that names the absence a request turns on", () => {
    // `alice-declines-dinner` says in a comment that another attendee's RSVP is
    // discarded — which is the whole of two of these requests.
    const held = UNSEEN_PROMPTS.filter((p) => p.expect === "refuses" && p.withholdExamples);
    expect(held.map((p) => p.id).sort()).toEqual(["others-have-not-accepted", "unretained-field"]);

    const withheld = promptPrefix({
      ontology: loadOntology(),
      loops: loadLoops(),
      events: loadEvents(),
      examples: examplesFor(["alice-declines-dinner"]),
    })[0]!.content;
    expect(withheld.toLowerCase()).not.toContain("another attendee's rsvp is discarded");
    expect(PROMPT, "the example does not name the absence, so withholding it is theatre").toContain(
      "another attendee's rsvp is discarded",
    );
  });
});

describe("every must-refuse request says what a good refusal names", () => {
  it.each(UNSEEN_PROMPTS.filter((p) => p.expect === "refuses").map((p) => [p.id, p]))(
    "%s",
    (_id, prompt) => {
      const groups = (prompt as { refusalMustMention?: readonly (readonly string[])[] })
        .refusalMustMention;
      expect(groups, "a refusal here would be graded on nothing").toBeDefined();
      expect(groups!.length).toBeGreaterThan(0);
      for (const group of groups!) expect(group.length).toBeGreaterThan(0);
    },
  );

  it("asks for nothing a request that should compile could not give", () => {
    // Only refusals are graded on their reasons; a compiling request has no
    // reasons to grade.
    for (const prompt of UNSEEN_PROMPTS.filter((p) => p.expect === "compiles")) {
      expect(
        (prompt as { refusalMustMention?: unknown }).refusalMustMention,
        prompt.id,
      ).toBeUndefined();
    }
  });
});

describe("a refusal that only echoes the request is not a refusal", () => {
  it.each(UNSEEN_PROMPTS.filter((p) => p.expect === "refuses").map((p) => [p.id, p]))(
    "%s",
    (_id, prompt) => {
      // The failure mode a substring check invites: a group containing one of
      // the request's own nouns is satisfied by repeating the question back.
      const echo = `I cannot do this. ${(prompt as { query: string }).query}`;
      expect(
        unmentioned(
          echo,
          (prompt as { refusalMustMention: readonly (readonly string[])[] }).refusalMustMention,
        ).length,
        "restating the request satisfies this prompt's grading",
      ).toBeGreaterThan(0);
    },
  );

  it("still accepts a refusal that names the absence", () => {
    // The counterweight: tightening the groups must not make them unsatisfiable.
    const good: Record<string, string> = {
      "undistinctive-lexical-term":
        "no term here is distinctive: 'call' is too common for a lexical arm, and a lexical term that common wakes the judge on a sixth of the corpus",
      "absent-source": "no source in this ontology produces workout or distance data",
      "unretained-field":
        "the attendee table holds no rsvp; response_status is the user's own response and another invitee's is not retained",
      "absent-loop-state":
        "the states are open, snoozed, done and dismissed — there is no blocked state, and blockedby holds loop ids",
      "others-have-not-accepted":
        "the attendee table has no column for rsvp; response_status is the user's own response",
    };
    for (const prompt of UNSEEN_PROMPTS.filter((p) => p.expect === "refuses")) {
      const groups = (prompt as { refusalMustMention: readonly (readonly string[])[] })
        .refusalMustMention;
      expect(unmentioned(good[prompt.id]!, groups), prompt.id).toEqual([]);
    }
  });
});
