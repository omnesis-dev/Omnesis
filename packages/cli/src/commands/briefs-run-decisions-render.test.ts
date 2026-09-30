// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure-render coverage for the decision-model block of `omnesis brain run
 * <id>`: what the worth gate and the record check decided for a run, and what
 * that meant for it.
 *
 * All fixture data is invented.
 */

import { describe, expect, test } from "vitest";
import { renderRunDecisions, type RunDecisionDto } from "./briefs.js";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const render = (d: RunDecisionDto[]): string => renderRunDecisions(d).map(stripAnsi).join("\n");

function decision(over: Partial<RunDecisionDto> = {}): RunDecisionDto {
  return {
    purpose: "worth-gate",
    lane: "bootstrap",
    verdict: "skip",
    score: 0.41,
    threshold: 1.08,
    modelId: "jev-1.13.0",
    inheritedFromParent: false,
    subjectDoc: { id: "doc-1", title: "Weekly deals inside" },
    subjectDocumentId: "doc-1",
    reusedFrom: null,
    recordId: null,
    enforced: true,
    error: null,
    latencyMs: 280,
    request: null,
    ...over,
  };
}

describe("the worth gate", () => {
  test("a skip reads as gated, with its score against the threshold and the judged email", () => {
    const out = render([decision()]);
    expect(out).toContain("worth gate · gated, no agent turn  score 0.41 < 1.08");
    expect(out).toContain("jev-1.13.0");
    expect(out).toContain("judged:   Weekly deals inside");
  });

  test("an attachment names the email that contains it, and a reuse says no call was made", () => {
    const out = render([
      decision({ verdict: "pass", score: 2.4, inheritedFromParent: true, reusedFrom: "dec_0" }),
    ]);
    expect(out).toContain("worth a run  score 2.40 ≥ 1.08");
    expect(out).toContain("judged:   the email that contains it, Weekly deals inside");
    expect(out).toContain("reused:   decision dec_0");
  });

  test("an outage says the run went ahead and shows the provider's error", () => {
    const out = render([
      decision({ verdict: "unavailable", score: null, error: "TypeSafe HTTP 402: no credit" }),
    ]);
    expect(out).toContain("worth gate · unavailable, run went ahead");
    expect(out).not.toContain("score");
    expect(out).toContain("error:    TypeSafe HTTP 402: no credit");
  });
});

describe("the record check", () => {
  const record = (over: Partial<RunDecisionDto> = {}) =>
    decision({
      purpose: "record-check",
      threshold: 0.81,
      score: 0.12,
      recordId: "ta_example",
      enforced: false,
      request: {
        state: { record_type: "timeline", record: "A gym opens a new cycle room." },
      },
      ...over,
    });

  test("shows the record and its id, and whether the skip was acted on", () => {
    const observing = render([record()]);
    expect(observing).toContain("record check · would drop (observing)  score 0.12 < 0.81");
    expect(observing).toContain("record:   A gym opens a new cycle room.");
    expect(observing).toContain("id:       ta_example");
    expect(observing).not.toContain("judged:");
    expect(render([record({ enforced: true })])).toContain("record check · dropped");
  });

  test("still names the record id once retention has cleared the request", () => {
    const out = render([record({ request: null, verdict: "pass", score: 2.5 })]);
    expect(out).toContain("record check · keep");
    expect(out).toContain("id:       ta_example");
    expect(out).not.toContain("record:");
  });
});

test("an unknown purpose falls back to its raw verdict", () => {
  expect(render([decision({ purpose: "future-check", verdict: "pass" })])).toContain(
    "future check · pass",
  );
});
