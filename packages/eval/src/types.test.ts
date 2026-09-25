// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { SuiteRaw, ProgressEvent, RunOutput } from "./types.js";

describe("SuiteRaw schema", () => {
  it("accepts the minimal form (expected_url shorthand)", () => {
    const parsed = SuiteRaw.parse({
      description: "test",
      version: 1,
      queries: [{ id: "q1", query: "hello", expected_url: "https://example.com/a" }],
    });
    expect(parsed.queries[0]!.expected_url).toBe("https://example.com/a");
    expect(parsed.default_top_k).toBe(10);
  });

  it("accepts the structured form with aliases", () => {
    const parsed = SuiteRaw.parse({
      description: "test",
      version: 1,
      queries: [
        {
          id: "q1",
          query: "hello",
          expected_urls: [
            "https://example.com/a",
            { aliases: ["https://example.com/b#x", "https://example.com/b"] },
          ],
          type: "semantic",
          difficulty: "hard",
          notes: "alias case",
          top_k: 20,
          must_rank_above: 3,
          unexpected_urls: ["https://example.com/junk"],
        },
      ],
    });
    expect(parsed.queries[0]!.expected_urls).toHaveLength(2);
    expect(parsed.queries[0]!.type).toBe("semantic");
  });

  it("rejects empty query text", () => {
    expect(() =>
      SuiteRaw.parse({
        description: "test",
        version: 1,
        queries: [{ id: "q1", query: "", expected_url: "https://example.com/a" }],
      }),
    ).toThrow();
  });

  it("rejects empty queries array", () => {
    expect(() => SuiteRaw.parse({ description: "test", version: 1, queries: [] })).toThrow();
  });

  it("rejects unknown top-level fields (strict)", () => {
    expect(() =>
      SuiteRaw.parse({
        description: "test",
        version: 1,
        queries: [{ id: "q1", query: "x", expected_url: "https://example.com/a" }],
        wat: true,
      }),
    ).toThrow();
  });

  it("rejects empty aliases array", () => {
    expect(() =>
      SuiteRaw.parse({
        description: "test",
        version: 1,
        queries: [{ id: "q1", query: "x", expected_urls: [{ aliases: [] }] }],
      }),
    ).toThrow();
  });
});

describe("ProgressEvent schema", () => {
  it("accepts the four event variants", () => {
    expect(() =>
      ProgressEvent.parse({
        type: "run_started",
        ts: "2026-05-12T14:00:00Z",
        run_id: "r1",
        total_queries: 10,
      }),
    ).not.toThrow();
    expect(() =>
      ProgressEvent.parse({
        type: "query_started",
        ts: "2026-05-12T14:00:00Z",
        query_idx: 0,
        query_id: "q1",
      }),
    ).not.toThrow();
    expect(() =>
      ProgressEvent.parse({
        type: "query_completed",
        ts: "2026-05-12T14:00:00Z",
        query_idx: 0,
        query_id: "q1",
        elapsed_ms: 123.4,
      }),
    ).not.toThrow();
    expect(() =>
      ProgressEvent.parse({
        type: "run_completed",
        ts: "2026-05-12T14:00:00Z",
        run_id: "r1",
        duration_ms: 999,
      }),
    ).not.toThrow();
  });

  it("rejects unknown event types", () => {
    expect(() => ProgressEvent.parse({ type: "wat", ts: "2026", run_id: "r" })).toThrow();
  });
});

describe("RunOutput schema — archived multi-lane runs", () => {
  it("rejects a run whose queries are keyed by search backend, with a legible reason", () => {
    const archived = {
      run_id: "2026-01-01T00-00-00_abcd",
      queries: [{ id: "q1", backends: { hybrid: {} } }],
      stages: ["bm25", "hybrid"],
    };
    expect(() => RunOutput.parse(archived)).toThrow(/multi-lane eval build/);
    // The reason must be the FIRST issue, not buried under a wall of shape
    // mismatches — that is the whole point of detecting the shape up front.
    const result = RunOutput.safeParse(archived);
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/re-run the suite/);
  });

  it("rejects a run that only carries the top-level `stages` lane list", () => {
    expect(() => RunOutput.parse({ run_id: "r", stages: ["hybrid"] })).toThrow(
      /multi-lane eval build/,
    );
  });

  it("reports ordinary shape problems normally when the run is not multi-lane", () => {
    const result = RunOutput.safeParse({ run_id: "r" });
    expect(result.success).toBe(false);
    expect(result.error!.issues.every((i) => !/multi-lane/.test(i.message))).toBe(true);
  });
});
