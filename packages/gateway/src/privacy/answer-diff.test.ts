// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { compareReleasedAnswer } from "./answer-diff.js";
import type { PrivacyAnswerComparison, PrivacyAnswerDiffLine } from "@omnesis/types/privacy";

function diffLines(comparison: PrivacyAnswerComparison): PrivacyAnswerDiffLine[] {
  if (comparison.kind !== "diff") {
    throw new Error(`Expected a diff, received ${JSON.stringify(comparison)}.`);
  }
  return comparison.lines;
}

/** The two texts a diff claims to describe, rebuilt from the lines it emitted. */
function rebuild(lines: PrivacyAnswerDiffLine[]): { candidate: string; released: string } {
  return {
    candidate: lines
      .filter((line) => line.op !== "added")
      .map((line) => line.text)
      .join("\n"),
    released: lines
      .filter((line) => line.op !== "removed")
      .map((line) => line.text)
      .join("\n"),
  };
}

function spanText(line: PrivacyAnswerDiffLine, op: "equal" | "removed" | "added"): string {
  return (line.spans ?? [])
    .filter((span) => span.op === op)
    .map((span) => span.text)
    .join("");
}

describe("released-answer comparison", () => {
  it("reports an identical release without describing a change", () => {
    const answer = "The venue is confirmed for Thursday.";
    expect(compareReleasedAnswer(answer, answer)).toEqual({ kind: "identical" });
    expect(compareReleasedAnswer("", "")).toEqual({ kind: "identical" });
  });

  it("marks the words a reduction struck from a line", () => {
    const candidate = "Dinner is booked for Thursday at Stellar Sound with Jamie Lopez.";
    const released = "Dinner is booked for Thursday with Jamie Lopez.";
    const lines = diffLines(compareReleasedAnswer(candidate, released));

    expect(lines.map((line) => line.op)).toEqual(["removed", "added"]);
    expect(spanText(lines[0], "removed").trim()).toBe("at Stellar Sound");
    expect(spanText(lines[1], "added")).toBe("");
    expect(rebuild(lines)).toEqual({ candidate, released });
  });

  it("removes a whole line without inventing a word-level pairing for it", () => {
    const candidate = [
      "The showcase runs from six until nine.",
      "Jamie Lopez is handling the door list.",
      "Parking is on the north side.",
    ].join("\n");
    const released = [
      "The showcase runs from six until nine.",
      "Parking is on the north side.",
    ].join("\n");
    const lines = diffLines(compareReleasedAnswer(candidate, released));

    expect(lines.map((line) => line.op)).toEqual(["equal", "removed", "equal"]);
    expect(lines[1].spans).toBeNull();
    expect(rebuild(lines)).toEqual({ candidate, released });
  });

  it("reports a reordered line as one removal and one addition", () => {
    const candidate = ["Venue confirmed.", "Caterer confirmed.", "Guest list pending."].join("\n");
    const released = ["Caterer confirmed.", "Venue confirmed.", "Guest list pending."].join("\n");
    const lines = diffLines(compareReleasedAnswer(candidate, released));

    expect(lines.filter((line) => line.op === "removed").map((line) => line.text)).toEqual([
      "Venue confirmed.",
    ]);
    expect(lines.filter((line) => line.op === "added").map((line) => line.text)).toEqual([
      "Venue confirmed.",
    ]);
    expect(rebuild(lines)).toEqual({ candidate, released });
  });

  it("declines to describe a wholesale rewrite as an edit", () => {
    const candidate =
      "Maya Reeves confirmed the riverside venue for the spring showcase and asked the caterer to hold two extra tables.";
    const released = "A booking exists. No further detail is being shared.";

    expect(compareReleasedAnswer(candidate, released)).toEqual({
      kind: "no_diff",
      reason: "dissimilar",
    });
  });

  it("declines when one side is empty", () => {
    expect(compareReleasedAnswer("The address is 42 Example Street.", "")).toEqual({
      kind: "no_diff",
      reason: "dissimilar",
    });
    expect(compareReleasedAnswer("", "The address is 42 Example Street.")).toEqual({
      kind: "no_diff",
      reason: "dissimilar",
    });
  });

  it("keeps a diff at the similarity threshold and drops it just below", () => {
    // Six of the twenty visible characters on each side survive: 2*6/40 = 0.30.
    expect(compareReleasedAnswer("AAAAAA\nBBBBBBBBBBBBBB", "AAAAAA\nCCCCCCCCCCCCCC").kind).toBe(
      "diff",
    );
    // One more character on the released side puts the same six under the bar.
    expect(compareReleasedAnswer("AAAAAA\nBBBBBBBBBBBBBB", "AAAAAA\nCCCCCCCCCCCCCCC")).toEqual({
      kind: "no_diff",
      reason: "dissimilar",
    });
  });

  it("keeps word spans on a close line pair and withholds them on a distant one", () => {
    const preamble = "Draft summary for the operator.";
    const close = compareReleasedAnswer(
      `${preamble}\nThe deposit of 480 was paid by Maya Reeves.`,
      `${preamble}\nThe deposit was paid by Maya Reeves.`,
    );
    expect(diffLines(close)[1].spans).not.toBeNull();

    const distant = compareReleasedAnswer(
      `${preamble}\nThe deposit of 480 was paid by Maya Reeves.`,
      `${preamble}\nA payment cleared.`,
    );
    const distantLines = diffLines(distant);
    expect(distantLines.map((line) => line.op)).toEqual(["equal", "removed", "added"]);
    expect(distantLines[1].spans).toBeNull();
    expect(distantLines[2].spans).toBeNull();
  });

  it("refuses a pair whose text exceeds the input bound", () => {
    const candidate = "x ".repeat(11_000);
    expect(compareReleasedAnswer(candidate, `${candidate}tail`)).toEqual({
      kind: "no_diff",
      reason: "too_large",
    });
  });

  it("refuses a pair whose line count exceeds the table budget", () => {
    const candidate = "\n".repeat(600);
    expect(compareReleasedAnswer(candidate, `${candidate}tail`)).toEqual({
      kind: "no_diff",
      reason: "too_large",
    });
  });

  it("reads line content rather than line terminators", () => {
    const content = ["Venue confirmed.", "Caterer confirmed."];
    const lines = diffLines(compareReleasedAnswer(content.join("\r\n"), content.join("\n")));

    expect(lines.map((line) => line.op)).toEqual(["equal", "equal"]);
    expect(lines.map((line) => line.text)).toEqual(content);
  });

  it("keeps a combining sequence inside the word it belongs to", () => {
    const decomposed = "cafe\u0301";
    const candidate = `The ${decomposed} on Example Street opens at nine.`;
    const released = `The ${decomposed} opens at nine.`;
    const lines = diffLines(compareReleasedAnswer(candidate, released));

    expect(spanText(lines[0], "equal")).toContain(decomposed);
    expect(spanText(lines[0], "removed").trim()).toBe("on Example Street");
    expect(rebuild(lines)).toEqual({ candidate, released });
  });

  it("reads a precomposed character and its decomposed form as different words", () => {
    const lines = diffLines(
      compareReleasedAnswer(
        "The cafe\u0301 opens at nine and closes at five.",
        "The caf\u00e9 opens at nine and closes at five.",
      ),
    );

    expect(spanText(lines[0], "removed")).toBe("cafe\u0301");
    expect(spanText(lines[1], "added")).toBe("caf\u00e9");
  });

  it("compares a script without word breaks a whole line at a time", () => {
    const candidate = [
      "Notes for Maya Reeves",
      "会議は火曜日の午後三時からです。",
      "End of notes",
    ].join("\n");
    const released = ["Notes for Maya Reeves", "会議は午後です。", "End of notes"].join("\n");
    const lines = diffLines(compareReleasedAnswer(candidate, released));

    expect(lines.map((line) => line.op)).toEqual(["equal", "removed", "added", "equal"]);
    expect(lines[1].spans).toBeNull();
    expect(lines[2].spans).toBeNull();
    expect(rebuild(lines)).toEqual({ candidate, released });
  });

  it("rebuilds both texts from the lines of a multi-edit comparison", () => {
    const candidate = [
      "Booking summary for the spring showcase.",
      "The deposit of 480 was paid by Maya Reeves on the ninth.",
      "The venue holds two hundred people.",
      "Ticket enquiries go to +1 (555) 010-0123.",
    ].join("\n");
    const released = [
      "Booking summary for the spring showcase.",
      "The deposit was paid by Maya Reeves on the ninth.",
      "The venue holds two hundred people.",
    ].join("\n");
    const lines = diffLines(compareReleasedAnswer(candidate, released));

    expect(rebuild(lines)).toEqual({ candidate, released });
    for (const line of lines) {
      if (line.spans) expect(line.spans.map((span) => span.text).join("")).toBe(line.text);
    }
  });
});
