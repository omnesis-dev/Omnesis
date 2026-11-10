// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  compareAnswer,
  compareGate,
  formatAgreement,
  formatGates,
  summarizeAgreement,
  summarizeGates,
} from "./decision-agreement.mjs";

describe("compareAnswer", () => {
  it("agrees on a noul on the same side of one half", () => {
    expect(compareAnswer({ type: "noul", noul: 0.9 }, { type: "noul", noul: 0.6 })).toEqual({
      type: "noul",
      answered: true,
      agree: true,
      distance: expect.closeTo(0.3),
    });
    expect(compareAnswer({ type: "noul", noul: 0.9 }, { type: "noul", noul: 0.4 }).agree).toBe(
      false,
    );
  });

  it("agrees on a score that rounds to the same level", () => {
    expect(
      compareAnswer({ type: "score", score: 2.4 }, { type: "score", score: 1.6 }),
    ).toMatchObject({
      agree: true,
      distance: expect.closeTo(0.8),
    });
    expect(compareAnswer({ type: "score", score: 2.4 }, { type: "score", score: 1.4 }).agree).toBe(
      false,
    );
  });

  it("agrees on a choice only on the same key", () => {
    expect(
      compareAnswer({ type: "choice", choice: "ask" }, { type: "choice", choice: "ask" }),
    ).toMatchObject({
      agree: true,
      distance: 0,
    });
    expect(
      compareAnswer({ type: "choice", choice: "ask" }, { type: "choice", choice: "tell" }),
    ).toMatchObject({
      agree: false,
      distance: 1,
    });
  });

  it("counts a missing or mistyped answer as unanswered", () => {
    expect(compareAnswer({ type: "noul", noul: 1 }, null)).toEqual({
      type: "noul",
      answered: false,
      agree: false,
      distance: null,
    });
    expect(compareAnswer({ type: "noul", noul: 1 }, { type: "score", score: 1 }).answered).toBe(
      false,
    );
  });
});

describe("summarizeAgreement", () => {
  it("summarises per type over answered questions only", () => {
    const rows = [
      compareAnswer({ type: "score", score: 3 }, { type: "score", score: 3 }),
      compareAnswer({ type: "score", score: 3 }, { type: "score", score: 1 }),
      compareAnswer({ type: "score", score: 3 }, null),
      compareAnswer({ type: "noul", noul: 1 }, { type: "noul", noul: 1 }),
    ];
    const summary = summarizeAgreement(rows);
    expect(summary).toEqual([
      { type: "noul", asked: 1, answered: 1, agreement: 1, meanDistance: 0, p90Distance: 0 },
      { type: "score", asked: 3, answered: 2, agreement: 0.5, meanDistance: 1, p90Distance: 2 },
    ]);
    expect(formatAgreement(summary)).toMatch(/score\s+3\s+2\s+50\.0%/);
  });
});

describe("compareGate", () => {
  it("reads both answers against the threshold, not by rounded level", () => {
    // Both round to 1, but the gate passes one and skips the other.
    expect(
      compareGate(
        "worth_score",
        1.08,
        { type: "score", score: 1.12 },
        { type: "score", score: 0.98 },
      ),
    ).toEqual({
      question: "worth_score",
      threshold: 1.08,
      recordedPass: true,
      candidatePass: false,
    });
    // Different levels, both pass.
    expect(
      compareGate(
        "worth_score",
        1.08,
        { type: "score", score: 1.6 },
        { type: "score", score: 1.4 },
      ),
    ).toMatchObject({ recordedPass: true, candidatePass: true });
  });

  it("thresholds a noul's probability and ignores choices", () => {
    expect(
      compareGate("same", 0.8, { type: "noul", noul: 0.9 }, { type: "noul", noul: 0.7 }),
    ).toMatchObject({ recordedPass: true, candidatePass: false });
    expect(compareGate("route", 1, { type: "choice", choice: "ask" }, null)).toBeNull();
  });

  it("leaves an unanswered question without a candidate verdict", () => {
    expect(compareGate("worth_score", 1.08, { type: "score", score: 2 }, null)).toMatchObject({
      candidatePass: null,
    });
  });
});

describe("summarizeGates", () => {
  it("reports pass/skip agreement and recall on the recorded passes", () => {
    const gate = (recorded, candidate) =>
      compareGate(
        "worth_score",
        1.08,
        { type: "score", score: recorded },
        candidate === null ? null : { type: "score", score: candidate },
      );
    const summary = summarizeGates([
      gate(2, 2), // pass, kept
      gate(1.12, 0.98), // pass, dropped
      gate(0, 0), // skip, skipped
      gate(0, 1.5), // skip, passed
      gate(3, null), // unanswered
    ]);
    expect(summary).toEqual([
      {
        question: "worth_score",
        threshold: 1.08,
        asked: 5,
        answered: 4,
        passAgreement: 0.5,
        recall: 0.5,
        recordedPassRate: 0.5,
        candidatePassRate: 0.5,
      },
    ]);
    expect(formatGates(summary)).toMatch(/worth_score\s+1\.08\s+4\/5\s+50\.0%\s+50\.0%/);
  });
});
