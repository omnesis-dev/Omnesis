// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Observation salience: the request sent to the decision model, the
 * judgement taken from a scripted DecisionCapability (no model inference),
 * the deterministic ship/hold/already_known policy, the ranking order and
 * the "would have pushed" rule.
 */

import { describe, expect, test, vi } from "vitest";
import { createLogger, type DecisionCapability, type DecisionResult } from "@omnesis/core";
import {
  buildSalienceRequest,
  compareSalience,
  DEFAULT_SALIENCE_THRESHOLDS,
  judgeSalience,
  salienceVerdict,
  TOP_CONSEQUENCE,
  TOP_TIMING,
  wouldHavePushed,
  type SalienceSubject,
} from "./salience.js";
import type { ObservationScores } from "../storage/types.js";

const log = createLogger("test").child("observation-salience");
const NOW = Date.parse("2026-07-02T07:00:00.000Z");

const subject: SalienceSubject = {
  summary: "The studio rent invoice is due on Friday.",
  why: "A late payment adds a fee.",
  userAuthored: false,
  notedAt: NOW - 3_600_000,
  windowStart: null,
  relevantUntil: NOW + 3 * 86_400_000,
  sources: [{ title: "Invoice", source: "mail-fixture", date: "2026-07-01" }],
};

function scripted(
  answers: Record<string, number> | Error,
  model = "scripted-decision",
): DecisionCapability & { decide: ReturnType<typeof vi.fn> } {
  const decide = vi.fn(async (): Promise<DecisionResult> => {
    if (answers instanceof Error) throw answers;
    return {
      model,
      inputTokens: 42,
      answers: Object.fromEntries(
        Object.entries(answers).map(([k, score]) => [k, { type: "score" as const, score }]),
      ),
    };
  });
  return { modelId: model, decide, dispose() {} };
}

function s(
  consequence: number | null,
  timing: number | null = null,
  alreadyKnown: number | null = null,
): ObservationScores {
  return { consequence, timing, alreadyKnown, modelId: "m", at: NOW };
}

describe("buildSalienceRequest", () => {
  test("puts the subject in the state as ISO times and asks the three questions", () => {
    const request = buildSalienceRequest({ ...subject, sinceNoted: ["Loop is now done."] }, NOW);
    expect(request.state).toEqual({
      now: new Date(NOW).toISOString(),
      observation: subject.summary,
      whyItMatters: subject.why,
      notedAt: new Date(subject.notedAt).toISOString(),
      windowStart: null,
      relevantUntil: new Date(subject.relevantUntil!).toISOString(),
      userWroteEverySource: false,
      sources: subject.sources,
      sinceNoted: ["Loop is now done."],
    });
    expect(Object.keys(request.questions).sort()).toEqual([
      "already_known",
      "consequence",
      "timing",
    ]);
    const q = request.questions as unknown as Record<string, { type: string; criteria: string[] }>;
    expect(q.consequence!.criteria).toHaveLength(TOP_CONSEQUENCE + 1);
    expect(q.timing!.criteria).toHaveLength(TOP_TIMING + 1);
    expect(q.already_known!.criteria).toHaveLength(2);
  });

  test("an empty why and empty sinceNoted become null", () => {
    const request = buildSalienceRequest({ ...subject, why: "", sinceNoted: [] }, NOW);
    expect(request.state).toMatchObject({ whyItMatters: null, sinceNoted: null });
    expect(buildSalienceRequest(subject, NOW).state).toMatchObject({ sinceNoted: null });
  });
});

describe("judgeSalience", () => {
  test("returns all three levels and records spend", async () => {
    const decision = scripted({ consequence: 3, timing: 2, already_known: 0 });
    const recordSpend = vi.fn(async () => {});
    const judged = await judgeSalience(decision, subject, NOW, { recordSpend, log });
    expect(judged.scores).toEqual({
      consequence: 3,
      timing: 2,
      alreadyKnown: 0,
      modelId: "scripted-decision",
      at: NOW,
    });
    expect(judged.judgement.error).toBeNull();
    expect(recordSpend).toHaveBeenCalledExactlyOnceWith("scripted-decision", 42);
    expect(decision.decide).toHaveBeenCalledTimes(1);
  });

  test("an unavailable decision model yields null levels and never throws", async () => {
    const judged = await judgeSalience(scripted(new Error("scripted outage")), subject, NOW, {
      recordSpend: async () => {},
      log,
    });
    expect(judged.scores).toEqual({
      consequence: null,
      timing: null,
      alreadyKnown: null,
      modelId: null,
      at: NOW,
    });
    expect(judged.judgement.error).toContain("scripted outage");
  });

  test("a reply missing a secondary dimension is unavailable as a whole", async () => {
    const judged = await judgeSalience(scripted({ consequence: 3, timing: 2 }), subject, NOW, {
      recordSpend: async () => {},
      log,
    });
    expect(judged.scores.consequence).toBeNull();
    expect(judged.scores.timing).toBeNull();
    expect(judged.scores.alreadyKnown).toBeNull();
  });

  test("an out-of-range score is unavailable", async () => {
    const judged = await judgeSalience(
      scripted({ consequence: 5, timing: 2, already_known: 0 }),
      subject,
      NOW,
      { recordSpend: async () => {}, log },
    );
    expect(judged.scores.consequence).toBeNull();
  });
});

describe("salienceVerdict", () => {
  const t = DEFAULT_SALIENCE_THRESHOLDS;
  test.each<[string, ObservationScores | null, string]>([
    ["no scores fail open", null, "ship"],
    ["unavailable consequence fails open", s(null, 0, 1), "ship"],
    ["already known at the threshold", s(4, 3, 0.6), "already_known"],
    ["already known beats a severe consequence", s(4, 3, 1), "already_known"],
    ["just below the already-known threshold", s(2, 0, 0.59), "ship"],
    ["null alreadyKnown is not known", s(2, 0, null), "ship"],
    ["consequence at the minimum ships regardless of timing", s(2, null, 0), "ship"],
    ["consequence above the minimum ships", s(4, 0, 0), "ship"],
    ["minor consequence, timely, ships", s(1, 2, 0), "ship"],
    ["minor consequence, urgent, ships", s(1, 3, 0), "ship"],
    ["minor consequence, not timely, holds", s(1, 1, 0), "hold"],
    ["minor consequence, unknown timing, holds", s(1, null, 0), "hold"],
    ["no consequence, urgent, holds", s(0, 3, 0), "hold"],
    ["fractional consequence below the minimum holds", s(1.9, 0, 0), "hold"],
  ])("%s", (_label, scores, verdict) => {
    expect(salienceVerdict(scores, t)).toBe(verdict);
  });

  test("honours custom thresholds", () => {
    const strict = {
      alreadyKnownMax: 0.9,
      minConsequence: 4,
      minTimelyConsequence: 3,
      timelyLevel: 3,
    };
    expect(salienceVerdict(s(3, 2, 0.8), strict)).toBe("hold");
    expect(salienceVerdict(s(3, 3, 0.8), strict)).toBe("ship");
    expect(salienceVerdict(s(4, 0, 0.9), strict)).toBe("already_known");
  });
});

describe("compareSalience", () => {
  const item = (id: string, scores: ObservationScores | null, createdAt = 0) => ({
    id,
    scores,
    createdAt,
  });

  test("orders by consequence, then timing, then age, then id; unscored last", () => {
    const items = [
      item("unscored_new", null, 9),
      item("c2_t1", s(2, 1), 1),
      item("c4_t0", s(4, 0), 5),
      item("unscored_old", null, 1),
      item("c2_t3", s(2, 3), 7),
      item("null_consequence", s(null, 3), 0),
      item("c2_t1_older", s(2, 1), 0),
      item("b_tie", s(3, 2), 4),
      item("a_tie", s(3, 2), 4),
      item("c2_untimed", s(2, null), 0),
    ];
    expect([...items].sort(compareSalience).map((i) => i.id)).toEqual([
      "c4_t0",
      "a_tie",
      "b_tie",
      "c2_t3",
      "c2_t1_older",
      "c2_t1",
      "c2_untimed",
      "null_consequence",
      "unscored_old",
      "unscored_new",
    ]);
  });

  test("is zero only for the same item", () => {
    const a = item("a", s(2, 2), 1);
    expect(compareSalience(a, a)).toBe(0);
    expect(compareSalience(a, item("b", s(2, 2), 1))).toBeLessThan(0);
  });
});

describe("wouldHavePushed", () => {
  const nextBrief = NOW + 86_400_000;
  const notedAt = NOW - 1000;

  test("top consequence and timing with a deadline before the next brief would push", () => {
    expect(wouldHavePushed(s(4, 3), nextBrief - 1, nextBrief, notedAt)).toBe(notedAt);
  });

  test("accepts scores within half a level of the top", () => {
    expect(wouldHavePushed(s(3.5, 2.5), nextBrief - 1, nextBrief, notedAt)).toBe(notedAt);
    expect(wouldHavePushed(s(3.49, 3), nextBrief - 1, nextBrief, notedAt)).toBeNull();
    expect(wouldHavePushed(s(4, 2.49), nextBrief - 1, nextBrief, notedAt)).toBeNull();
  });

  test("a deadline at or after the next brief, or none, would not push", () => {
    expect(wouldHavePushed(s(4, 3), nextBrief, nextBrief, notedAt)).toBeNull();
    expect(wouldHavePushed(s(4, 3), nextBrief + 1, nextBrief, notedAt)).toBeNull();
    expect(wouldHavePushed(s(4, 3), null, nextBrief, notedAt)).toBeNull();
  });

  test("missing scores would not push", () => {
    expect(wouldHavePushed(null, nextBrief - 1, nextBrief, notedAt)).toBeNull();
    expect(wouldHavePushed(s(null, 3), nextBrief - 1, nextBrief, notedAt)).toBeNull();
    expect(wouldHavePushed(s(4, null), nextBrief - 1, nextBrief, notedAt)).toBeNull();
  });
});
