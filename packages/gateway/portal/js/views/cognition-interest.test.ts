// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure-logic coverage for the Interest panel: source wording stays
 * data-driven (unknown sources render as themselves), polarity badges by
 * kind, signal links to their task or observation, the backlog and counts
 * lines, the probe's three lists, and the module import health. Plain
 * function calls in the node env — same harness as cognition.test.ts.
 */

import { describe, expect, test } from "vitest";
// @ts-expect-error plain-JS portal module without type declarations
import * as interest from "./cognition-interest.js";

describe("sourceLabel", () => {
  test("words every known reaction and passes an unknown one through", () => {
    expect(interest.sourceLabel("task_accepted")).toBe("accepted a suggestion");
    expect(interest.sourceLabel("brief_not_interested")).toBe("brief item not interested");
    expect(interest.sourceLabel("statement")).toBe("said so in the brief");
    // A source the gateway grows later must still render, not vanish.
    expect(interest.sourceLabel("calendar_rsvp")).toBe("calendar_rsvp");
  });
});

describe("polarityBadge", () => {
  test("reactions read wanted / not wanted; statements read more / less", () => {
    expect(interest.polarityBadge({ kind: "task", polarity: 1 }).label).toBe("wanted");
    expect(interest.polarityBadge({ kind: "observation", polarity: -1 }).label).toBe("not wanted");
    expect(interest.polarityBadge({ kind: "statement", polarity: 1 }).label).toBe("more");
    expect(interest.polarityBadge({ kind: "statement", polarity: -1 }).label).toBe("less");
    // Same colour for the same polarity whatever the kind.
    expect(interest.polarityBadge({ kind: "task", polarity: -1 }).color).toBe(
      interest.polarityBadge({ kind: "statement", polarity: -1 }).color,
    );
  });
});

describe("signalHref", () => {
  test("links a task signal to its task and an observation signal to its observation", () => {
    expect(interest.signalHref({ loopId: "loop_a", observationId: null })).toEqual({
      label: "Task",
      href: "/portal/debug/cognition/knowledge/loop_a?kind=loop",
    });
    expect(interest.signalHref({ loopId: null, observationId: "obs/1" })).toEqual({
      label: "Observation",
      href: "/portal/debug/cognition/observations/obs%2F1",
    });
    // The task wins when a signal carries both.
    expect(interest.signalHref({ loopId: "loop_a", observationId: "obs_1" }).label).toBe("Task");
    expect(interest.signalHref({ loopId: null, observationId: null })).toBeNull();
  });
});

describe("status lines", () => {
  test("backlogLabel counts what waits and is silent when nothing does", () => {
    expect(interest.backlogLabel(0)).toBeNull();
    expect(interest.backlogLabel(undefined)).toBeNull();
    expect(interest.backlogLabel(1)).toBe("1 signal waiting for a vector");
    expect(interest.backlogLabel(4)).toBe("4 signals waiting for a vector");
  });

  test("countsLine renders every count and treats a missing one as zero", () => {
    expect(
      interest.countsLine({ live: 12, superseded: 3, positive: 8, negative: 3, statements: 1 }),
    ).toBe("12 live · 3 superseded · 8 wanted · 3 not wanted · 1 statement");
    expect(interest.countsLine(undefined)).toBe("0 live · 0 superseded · 0 wanted · 0 not wanted · 0 statements");
  });

  test("age and similarity formatting", () => {
    expect(interest.ageDaysLabel(0)).toBe("today");
    expect(interest.ageDaysLabel(3)).toBe("3d ago");
    expect(interest.ageDaysLabel(undefined)).toBe("—");
    expect(interest.similarityLabel(0.625)).toBe("0.63");
    expect(interest.similarityLabel(null)).toBe("—");
  });
});

describe("probeSections", () => {
  test("always yields the three lists, empty for a null result", () => {
    const sections = interest.probeSections(null);
    expect(sections.map((s: { key: string }) => s.key)).toEqual(["positive", "negative", "statements"]);
    expect(sections.every((s: { items: unknown[] }) => s.items.length === 0)).toBe(true);
    const result = {
      positive: [{ text: "a", source: "task_accepted", ageDays: 1, similarity: 0.5 }],
      negative: [],
      statements: [{ text: "b", direction: "less", ageDays: 0, similarity: 0.3 }],
    };
    expect(interest.probeSections(result).map((s: { items: unknown[] }) => s.items.length)).toEqual([1, 0, 1]);
  });
});

describe("module health", () => {
  test("exports the InterestTab component and the empty-state copy", () => {
    expect(typeof interest.InterestTab).toBe("function");
    expect(interest.EMPTY_LEDGER_TEXT).toContain("thumbs");
  });
});
