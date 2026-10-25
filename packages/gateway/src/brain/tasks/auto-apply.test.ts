// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  decideTaskAutoApply,
  descriptionAddition,
  planTaskAutoApply,
  type TaskChangeEvidence,
  type TaskEvidenceVerdict,
} from "./auto-apply.js";
import type { ProposedTaskChange, TaskAuthoredField } from "../storage/types.js";

const LOOP = {
  title: "Pay the window cleaner",
  description: "Invoice for the spring clean.",
  deadline: null,
  state: "open" as const,
};
const EXPLICIT: TaskChangeEvidence = {
  fact: "The window cleaner invoice was paid in full today",
  basis: "explicit",
};
const DEADLINE = { type: "by", date: "2026-11-02" };

type Proposal = Pick<ProposedTaskChange, "kind" | "fields">;

/** Changes that rest on a fact: they apply only on an entailment verdict. */
const FACTS: Array<{ name: string; proposal: Proposal; field: TaskAuthoredField }> = [
  { name: "complete", proposal: { kind: "complete" }, field: "state" },
  {
    name: "deadline set",
    proposal: { kind: "edit", fields: { deadline: DEADLINE } },
    field: "deadline",
  },
];

const VERDICTS: TaskEvidenceVerdict[] = ["entailment", "neutral", "contradiction", "unavailable"];

function plan(
  proposal: Proposal,
  options: {
    authored?: TaskAuthoredField[];
    evidence?: TaskChangeEvidence | undefined;
    enabled?: boolean;
  } = {},
) {
  return planTaskAutoApply({
    enabled: options.enabled ?? true,
    loop: LOOP,
    proposal,
    authored: new Set(options.authored ?? []),
    evidence: "evidence" in options ? options.evidence : EXPLICIT,
  });
}

describe("the auto-apply policy", () => {
  for (const action of FACTS) {
    for (const userAuthored of [false, true]) {
      for (const verdict of VERDICTS) {
        const applies = !userAuthored && verdict === "entailment";
        test(`${action.name}, ${userAuthored ? "user-authored" : "Omnesis-authored"}, verifier ${verdict}: ${applies ? "applied" : "proposed"}`, () => {
          const decision = decideTaskAutoApply(
            plan(action.proposal, { authored: userAuthored ? [action.field] : [] }),
            verdict,
          );
          expect(decision.apply).toBe(applies);
        });
      }
    }
  }

  test("context applies without evidence or a verifier where the user did not write it", () => {
    const context: Proposal[] = [
      { kind: "edit", fields: { title: "Pay the window cleaner by card" } },
      { kind: "edit", fields: { description: "Paid by card." } },
      { kind: "edit", fields: { description: `${LOOP.description} Paid by card.` } },
      { kind: "edit", fields: { deadline: null } },
    ];
    for (const proposal of context) {
      const planned = plan(proposal, { evidence: undefined });
      expect(planned).toEqual({ eligible: true, change: proposal });
      expect(decideTaskAutoApply(planned, null)).toEqual({ apply: true, change: proposal });
    }
  });

  test("an addition to the user's own description applies; a rewrite of it is proposed", () => {
    const addition: Proposal = {
      kind: "edit",
      fields: { description: `${LOOP.description} Paid by bank transfer.` },
    };
    expect(decideTaskAutoApply(plan(addition, { authored: ["description"] }), null)).toEqual({
      apply: true,
      change: addition,
    });
    expect(
      plan(
        { kind: "edit", fields: { description: "Paid by card." } },
        { authored: ["description"] },
      ),
    ).toEqual({ eligible: false, why: "the user wrote this description" });
  });

  test("the user's title and deadline are theirs to change", () => {
    expect(
      plan(
        { kind: "edit", fields: { title: "Pay the window cleaner by card" } },
        { authored: ["title"] },
      ),
    ).toEqual({ eligible: false, why: "the user wrote this title" });
    expect(plan({ kind: "edit", fields: { deadline: null } }, { authored: ["deadline"] })).toEqual({
      eligible: false,
      why: "the user set this deadline",
    });
  });

  test("striking is always a proposal, whatever the evidence", () => {
    for (const verdict of VERDICTS)
      expect(decideTaskAutoApply(plan({ kind: "strike" }), verdict)).toEqual({
        apply: false,
        why: "striking a task is always the user's call",
      });
  });

  test("a fact on an inference, on no evidence, or with auto-apply turned off is a proposal", () => {
    for (const fact of FACTS) {
      expect(plan(fact.proposal, { evidence: { ...EXPLICIT, basis: "inferred" } })).toEqual({
        eligible: false,
        why: "the change rests on an inference",
      });
      expect(plan(fact.proposal, { evidence: undefined })).toEqual({
        eligible: false,
        why: "no evidence was stated",
      });
    }
    expect(
      plan(
        { kind: "edit", fields: { title: "Pay the window cleaner by card" } },
        { enabled: false },
      ),
    ).toEqual({ eligible: false, why: "automatic task changes are turned off" });
  });

  test("no verifier keeps a fact a proposal", () => {
    expect(decideTaskAutoApply(plan({ kind: "complete" }), null)).toEqual({
      apply: false,
      why: "the evidence could not be verified",
    });
  });

  test("one field the user wrote keeps the whole edit a proposal", () => {
    expect(
      plan(
        { kind: "edit", fields: { title: "Pay the window cleaner by card", deadline: DEADLINE } },
        { authored: ["deadline"] },
      ),
    ).toEqual({ eligible: false, why: "the user set this deadline" });
  });

  test("the claim binds the stated fact to the change it justifies, and covers only facts", () => {
    expect(plan({ kind: "complete" })).toEqual({
      eligible: true,
      change: { kind: "complete" },
      claim:
        "The window cleaner invoice was paid in full today. So this is done: Pay the window cleaner.",
    });
    const mixed: Proposal = {
      kind: "edit",
      fields: { title: "Pay the window cleaner by card", deadline: DEADLINE },
    };
    expect(plan(mixed)).toEqual({
      eligible: true,
      change: mixed,
      claim: "The window cleaner invoice was paid in full today.",
    });
    // A context change that rides along with a fact still waits on its verdict.
    expect(decideTaskAutoApply(plan(mixed), "neutral").apply).toBe(false);
  });
});

describe("descriptionAddition", () => {
  test("is the text appended after the current description", () => {
    expect(descriptionAddition("Brakes squeak.", "Brakes squeak. Shop opens at nine.")).toBe(
      "Shop opens at nine.",
    );
    expect(descriptionAddition("", "Shop opens at nine.")).toBe("Shop opens at nine.");
  });

  test("is null for a rewrite or no change", () => {
    expect(descriptionAddition("Brakes squeak.", "Brakes are fine.")).toBeNull();
    expect(descriptionAddition("Brakes squeak.", "Brakes squeak.")).toBeNull();
  });
});
