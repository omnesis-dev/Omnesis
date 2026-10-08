// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — renders the plain-JS portal component in a lightweight DOM.
// The verbose pipeline view shows the time a query named and the lane that read it.
import { h, render } from "preact";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineDebug, formatTemporalWindow } from "./pipeline-debug.js";
import { ScoreDetails } from "./score-details.js";

let host;
beforeEach(() => {
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.document);
  host = dom.document.querySelector("main");
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

const local = (y, m, d) => new Date(y, m - 1, d).toISOString();

describe("verbose search pipeline", () => {
  it("shows the windows read and the temporal lane beside the others", () => {
    render(
      h(PipelineDebug, {
        response: {
          query: {
            original: "invoice last week",
            temporal: {
              windows: [
                { start: local(2026, 9, 28), endExclusive: local(2026, 10, 5), text: "last week" },
              ],
              strippedText: "invoice",
              timeZone: "UTC",
            },
          },
          timing: { totalMs: 120 },
          results: [],
          stages: {
            bm25: { status: "ran", durationMs: 4, candidates: 50 },
            temporal: {
              status: "ran",
              durationMs: 30,
              candidates: 12,
              eventDocuments: 3,
              ranking: "relevance",
            },
            fusion: {
              status: "ran",
              method: "rrf",
              rrfK: 60,
              bm25Weight: 1,
              vectorWeight: 1,
              temporalWeight: 1,
              resultCount: 40,
            },
          },
        },
      }),
      host,
    );
    const text = host.textContent;
    expect(text).toContain("Time:last week → 2026-09-28 – 2026-10-04");
    expect(text).toContain("Time window:12 candidates · 30ms · 3 about the window");
    expect(text).toContain("time=1");
  });

  it("names a one-day window by its day", () => {
    expect(
      formatTemporalWindow({ start: local(2026, 10, 8), endExclusive: local(2026, 10, 9), text: "tomorrow" }),
    ).toBe("tomorrow → 2026-10-08");
  });

  it("shows a result's rank in the temporal lane", () => {
    render(h(ScoreDetails, { breakdown: { bm25Rank: 4, temporalRank: 1, finalScore: 0.03 } }), host);
    expect(host.textContent).toContain("Time: #1");
  });
});
