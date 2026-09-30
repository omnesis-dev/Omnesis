// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decisionFingerprint, parseDecisionCassette } from "@omnesis/core";
import {
  EMAIL_WORTH_QUESTION_ID,
  WORTH_MAIL,
  passesWorthGate,
  worthAnswersFor,
  worthGateCassetteLines,
  worthRequestFor,
} from "./worth-gate-mail.js";

const CASSETTE = join(
  import.meta.dirname,
  "../../../../../evals/universes/loops-test-life/decision-cassettes/worth-gate.jsonl",
);

describe("worth-gate mail", () => {
  test("the committed replay cassette is exactly what the mail table generates", () => {
    // Regenerate with `npx tsx scripts/write-worth-gate-cassettes.mjs` when
    // the rubric or the table changes.
    expect(readFileSync(CASSETTE, "utf8")).toBe(`${worthGateCassetteLines().join("\n")}\n`);
  });

  test("every mail replays to its own score", () => {
    const entries = parseDecisionCassette(readFileSync(CASSETTE, "utf8"));
    for (const mail of Object.values(WORTH_MAIL)) {
      const entry = entries.get(decisionFingerprint(worthRequestFor(mail)));
      expect(entry, mail.key).toBeDefined();
      expect(entry!.response.answers[EMAIL_WORTH_QUESTION_ID]).toMatchObject({ score: mail.score });
    }
  });

  test("the table exercises both arms of the gate", () => {
    const verdicts = Object.values(WORTH_MAIL).map(passesWorthGate);
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });

  test("the scripted probabilities form a distribution whose expectation is the score", () => {
    for (const mail of Object.values(WORTH_MAIL)) {
      const answer = worthAnswersFor(mail)[EMAIL_WORTH_QUESTION_ID] as {
        probabilities: Record<string, number>;
      };
      const probs = Object.entries(answer.probabilities);
      expect(probs.reduce((a, [, p]) => a + p, 0)).toBeCloseTo(1, 6);
      expect(probs.reduce((a, [level, p]) => a + Number(level) * p, 0)).toBeCloseTo(mail.score, 2);
    }
  });
});
