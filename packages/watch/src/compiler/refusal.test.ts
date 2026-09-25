// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The disclosable half of a refusal.
 *
 * The property under test is a negative one: nothing a model wrote can reach a
 * caller through this function. So the inputs are shaped like leaks — free
 * text, a plausible-looking code that is not in the vocabulary, a code with a
 * sentence stapled to it — rather than like the happy path.
 *
 * Fixture text is invented; no corpus content.
 */

import { describe, expect, it } from "vitest";

import {
  disclosableCodes,
  refusalSentence,
  MODEL_REFUSAL_CODES,
  REFUSAL_CODES,
} from "./refusal.js";

describe("what a refusal may disclose", () => {
  it("keeps the codes it knows", () => {
    expect(disclosableCodes(["ambiguous_request", "not_a_condition"])).toEqual([
      "ambiguous_request",
      "not_a_condition",
    ]);
  });

  it("drops anything outside the vocabulary", () => {
    // A model that invents a code is inventing free text, and free text is the
    // thing this channel exists to keep out. There is no repair step: an
    // unrecognised entry is dropped, not trimmed or matched loosely.
    expect(
      disclosableCodes([
        "unsupported_condition: nothing from maya.reeves@example.com mentions a lease",
        "no_such_person",
        "UNSUPPORTED_CONDITION",
        "unsupported_condition",
      ]),
    ).toEqual(["unsupported_condition"]);
  });

  it("still refuses when the model ignored the grammar entirely", () => {
    // A reply with prose reasons and no codes has refused. Handing back nothing
    // would leave the caller unable to tell a refusal from a lost request.
    expect(disclosableCodes(["I cannot express this."])).toEqual(["unsupported_condition"]);
    expect(disclosableCodes([])).toEqual(["unsupported_condition"]);
    expect(disclosableCodes(undefined)).toEqual(["unsupported_condition"]);
  });

  it("says each code the same way every time, from a fixed sentence", () => {
    for (const code of REFUSAL_CODES) {
      const sentence = refusalSentence(code);
      expect(sentence.length).toBeGreaterThan(0);
      expect(refusalSentence(code)).toBe(sentence);
    }
  });

  it("keeps the vocabulary free of anything that answers a question about the install", () => {
    // Every code is true or false about the request alone. One that reported
    // what is or is not in the corpus — "no such person", "nothing matched" —
    // would turn a create endpoint into an oracle a caller could query by
    // submitting conditions until one came back. The same applies to the
    // install's shape: the caller receiving these holds `answer` and
    // `subscriptions:manage` and no `read`, so a code naming which sources are
    // connected would tell it something no other surface will.
    expect([...REFUSAL_CODES]).toEqual([
      "unsupported_condition",
      "not_a_condition",
      "ambiguous_request",
      "compiler_failed",
    ]);
  });

  it("refuses to take 'try again' from the model", () => {
    // `compiler_failed` says the compiler produced nothing legal and asking
    // again may work. A model emitting it for a considered refusal would send
    // an agent round that loop forever, so it is the host's to mint and the
    // filter drops it — leaving the general code, which says "decided".
    expect([...MODEL_REFUSAL_CODES]).not.toContain("compiler_failed");
    expect(disclosableCodes(["compiler_failed"])).toEqual(["unsupported_condition"]);
  });
});
