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

const ACTIONS: Array<{ name: string; proposal: Proposal; field: TaskAuthoredField }> = [
  { name: "complete", proposal: { kind: "complete" }, field: "state" },
  {
    name: "description addition",
    proposal: {
      kind: "edit",
      fields: { description: "Invoice for the spring clean. Paid by bank transfer." },
    },
    field: "description",
  },
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
  for (const action of ACTIONS) {
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

  test("striking is always a proposal, whatever the evidence", () => {
    for (const verdict of VERDICTS)
      expect(decideTaskAutoApply(plan({ kind: "strike" }), verdict)).toEqual({
        apply: false,
        why: "striking a task is always the user's call",
      });
  });

  test("a title change is always a proposal, user-authored or not", () => {
    for (const authored of [[], ["title"]] as TaskAuthoredField[][])
      expect(
        plan({ kind: "edit", fields: { title: "Pay the window cleaner by card" } }, { authored }),
      ).toEqual({ eligible: false, why: "a new title is always proposed" });
  });

  test("an inference, no evidence, or auto-apply turned off is a proposal", () => {
    expect(plan({ kind: "complete" }, { evidence: { ...EXPLICIT, basis: "inferred" } })).toEqual({
      eligible: false,
      why: "the change rests on an inference",
    });
    expect(plan({ kind: "complete" }, { evidence: undefined })).toEqual({
      eligible: false,
      why: "no evidence was stated",
    });
    expect(plan({ kind: "complete" }, { enabled: false })).toEqual({
      eligible: false,
      why: "automatic task changes are turned off",
    });
  });

  test("no verifier is a proposal", () => {
    expect(decideTaskAutoApply(plan({ kind: "complete" }), null)).toEqual({
      apply: false,
      why: "the evidence could not be verified",
    });
  });

  test("rewriting a description or removing a deadline is a proposal", () => {
    expect(plan({ kind: "edit", fields: { description: "Paid by card." } })).toEqual({
      eligible: false,
      why: "rewriting a description is always proposed",
    });
    expect(plan({ kind: "edit", fields: { deadline: null } })).toEqual({
      eligible: false,
      why: "removing a deadline is always proposed",
    });
  });

  test("one ineligible field keeps the whole edit a proposal", () => {
    expect(
      plan(
        { kind: "edit", fields: { deadline: DEADLINE, description: "Paid by card." } },
        { authored: [] },
      ).eligible,
    ).toBe(false);
    expect(
      plan(
        {
          kind: "edit",
          fields: { deadline: DEADLINE, description: `${LOOP.description} Paid by card.` },
        },
        { authored: ["description"] },
      ),
    ).toEqual({ eligible: false, why: "the user wrote this description" });
  });

  test("the claim binds the stated fact to the change it justifies", () => {
    expect(plan({ kind: "complete" })).toEqual({
      eligible: true,
      change: { kind: "complete" },
      claim:
        "The window cleaner invoice was paid in full today. So this is done: Pay the window cleaner.",
    });
    // A description addition is judged on the words it adds.
    expect(plan(ACTIONS[1]!.proposal)).toMatchObject({
      eligible: true,
      claim: "Paid by bank transfer.",
    });
    expect(
      plan({
        kind: "edit",
        fields: { deadline: DEADLINE, description: `${LOOP.description} Paid by card.` },
      }),
    ).toEqual({
      eligible: true,
      change: {
        kind: "edit",
        fields: { deadline: DEADLINE, description: `${LOOP.description} Paid by card.` },
      },
      claim: "Paid by card. The window cleaner invoice was paid in full today.",
    });
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
