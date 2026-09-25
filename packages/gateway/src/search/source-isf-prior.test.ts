// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { computeIsfPriors, type SourceDocCount } from "./source-isf-prior.js";

const RRF_K = 60;

describe("computeIsfPriors", () => {
  test("the most common source gets no boost; rarer sources get a positive boost", () => {
    const counts: SourceDocCount[] = [
      { sourceId: "alpha:acct", docCount: 9000 }, // dominant
      { sourceId: "beta:acct", docCount: 900 },
      { sourceId: "gamma:acct", docCount: 90 }, // rarest
    ];
    const priors = computeIsfPriors(counts, { rrfK: RRF_K });
    // Dominant source is the baseline — no entry (boost 0).
    expect(priors["alpha:acct"]).toBeUndefined();
    // Rarer sources get positive boosts, rarest the largest.
    expect(priors["beta:acct"]).toBeGreaterThan(0);
    expect(priors["gamma:acct"]).toBeGreaterThan(priors["beta:acct"]!);
  });

  test("the rarest source's boost is bounded by ~one RRF rank-1 score at strength 1", () => {
    const counts: SourceDocCount[] = [
      { sourceId: "alpha:acct", docCount: 100000 },
      { sourceId: "rare:acct", docCount: 1 },
    ];
    const priors = computeIsfPriors(counts, { rrfK: RRF_K });
    const rankOneScore = 1 / (RRF_K + 1);
    // Rarest source caps at maxBoost = strength * 1/(k+1).
    expect(priors["rare:acct"]).toBeCloseTo(rankOneScore, 10);
  });

  test("strength multiplier scales every boost linearly", () => {
    const counts: SourceDocCount[] = [
      { sourceId: "a:x", docCount: 1000 },
      { sourceId: "b:x", docCount: 100 },
      { sourceId: "c:x", docCount: 10 },
    ];
    const base = computeIsfPriors(counts, { rrfK: RRF_K, strength: 1 });
    const doubled = computeIsfPriors(counts, { rrfK: RRF_K, strength: 2 });
    for (const id of Object.keys(base)) {
      expect(doubled[id]).toBeCloseTo(base[id]! * 2, 10);
    }
  });

  test("names no source — adapts to whatever the dominant source is", () => {
    // Same shape, different dominant source: the algorithm has no hardcoded
    // notion of which source is common.
    const a = computeIsfPriors(
      [
        { sourceId: "whatsapp:x", docCount: 9000 },
        { sourceId: "notes:x", docCount: 50 },
      ],
      { rrfK: RRF_K },
    );
    const b = computeIsfPriors(
      [
        { sourceId: "notes:x", docCount: 9000 },
        { sourceId: "whatsapp:x", docCount: 50 },
      ],
      { rrfK: RRF_K },
    );
    // In (a) notes is rare and boosted; in (b) whatsapp is rare and boosted.
    expect(a["notes:x"]).toBeGreaterThan(0);
    expect(a["whatsapp:x"]).toBeUndefined();
    expect(b["whatsapp:x"]).toBeGreaterThan(0);
    expect(b["notes:x"]).toBeUndefined();
  });

  test("inert when there is nothing to diversify", () => {
    // < 2 sources.
    expect(computeIsfPriors([{ sourceId: "only:x", docCount: 500 }], { rrfK: RRF_K })).toEqual({});
    // no documents.
    expect(
      computeIsfPriors(
        [
          { sourceId: "a:x", docCount: 0 },
          { sourceId: "b:x", docCount: 0 },
        ],
        {
          rrfK: RRF_K,
        },
      ),
    ).toEqual({});
    // all sources equally common — no rarity signal.
    expect(
      computeIsfPriors(
        [
          { sourceId: "a:x", docCount: 500 },
          { sourceId: "b:x", docCount: 500 },
        ],
        {
          rrfK: RRF_K,
        },
      ),
    ).toEqual({});
    // empty input.
    expect(computeIsfPriors([], { rrfK: RRF_K })).toEqual({});
  });

  test("produces only finite, positive boosts even with a wildly skewed corpus", () => {
    const counts: SourceDocCount[] = [
      { sourceId: "dominant:x", docCount: 1480000 },
      { sourceId: "mid:x", docCount: 1000 },
      { sourceId: "tiny:x", docCount: 1 },
    ];
    const priors = computeIsfPriors(counts, { rrfK: RRF_K });
    for (const v of Object.values(priors)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });
});
