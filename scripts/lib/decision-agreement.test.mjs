// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { compareAnswer, formatAgreement, summarizeAgreement } from "./decision-agreement.mjs";

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
