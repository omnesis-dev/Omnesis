// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { renderComparison, renderResults } from "./report.js";
import { listRuns, readQueryRows, readSummary, writeRun } from "./results.js";
import type { Language } from "./dataset.js";
import type { QueryRow, RunSummary } from "./results.js";

function summary(name: string, ndcg: number, languages: Language[] = ["ko"]): RunSummary {
  return {
    name,
    mode: "lexical",
    startedAt: `2026-01-0${name === "base" ? 1 : 2}T00:00:00.000Z`,
    source: { commit: "0123456789abcdef", packagesTree: "fedcba", dirty: false, branch: "main" },
    dataset: { name: "miracl-dev-pools", poolSize: 100, revisions: { topics: "t", corpus: "c" } },
    limits: { maxPassages: null, maxQueries: null },
    embedder: null,
    gatewayConfig: {},
    macro: { hit10: 0.75, ndcg10: ndcg, recall100: 0.5, mrr10: 0.4 },
    languages: languages.map((language) => ({
      language,
      queries: 3,
      passages: 100,
      emptyResults: 0,
      lexicalEngines: { memory: 2, fts5: 1 },
      pool: "0123456789abcdef",
      hit10: 0.75,
      ndcg10: ndcg,
      recall100: 0.5,
      mrr10: 0.4,
    })),
    totals: { passages: 100, chunks: 100, queries: 3 },
    timing: { ingestSeconds: 1, indexSeconds: 1, querySeconds: 1, queryMsP50: 5, queryMsP95: 9 },
  };
}

function rows(values: readonly number[], language: Language = "ko"): QueryRow[] {
  return values.map((v, i) => ({
    language,
    queryId: `q${i}`,
    hit10: v > 0 ? 1 : 0,
    ndcg10: v,
    recall100: v,
    mrr10: v,
  }));
}

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("run records", () => {
  test("a run written to disk reads back the same", () => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-search-eval-"));
    const written = summary("base", 0.25);
    writeRun(written, rows([0.1, 0.25, 0.4]), dir);
    expect(listRuns(dir)).toEqual(["base"]);
    expect(readSummary("base", dir)).toEqual(written);
    expect(readQueryRows("base", dir)).toEqual(rows([0.1, 0.25, 0.4]));
  });

  test("an unknown run names the known ones", () => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-search-eval-"));
    writeRun(summary("base", 0.25), rows([0.1]), dir);
    expect(() => readSummary("nope", dir!)).toThrow(/Known runs: base/);
  });
});

describe("renderResults", () => {
  test("lists each run and each language's score", () => {
    const text = renderResults([summary("base", 0.25), summary("next", 0.5)]);
    expect(text).toContain(
      "| base | lexical | 012345678 | 100 | 3 | 0.750 | 0.250 | 0.500 | 0.400 | 67% | 9 ms |",
    );
    expect(text).toContain("| Korean | 0.250 | 0.500 |");
  });
});

describe("renderComparison", () => {
  test("a gain on every query is reported as better", () => {
    const text = renderComparison(
      { summary: summary("base", 0.2), rows: rows([0.1, 0.2, 0.3]) },
      { summary: summary("next", 0.4), rows: rows([0.3, 0.4, 0.5]) },
      "ndcg10",
    );
    expect(text).toContain("| Korean | 3 | 0.200 | 0.400 | +0.200 | +0.200 to +0.200 | better |");
    expect(text).toContain("**+0.200**");
  });

  test("runs that scored different queries are refused", () => {
    expect(() =>
      renderComparison(
        { summary: summary("base", 0.2), rows: rows([0.1, 0.2]) },
        { summary: summary("next", 0.4), rows: rows([0.3]) },
        "ndcg10",
      ),
    ).toThrow(/missing from the second run/);
  });

  test("the overall change weighs a small language as much as a large one", () => {
    const text = renderComparison(
      {
        summary: summary("base", 0.2, ["ko", "th"]),
        rows: [...rows([0, 0, 0, 0, 0, 0, 0, 0], "ko"), ...rows([0, 0], "th")],
      },
      {
        summary: summary("next", 0.4, ["ko", "th"]),
        rows: [...rows([0, 0, 0, 0, 0, 0, 0, 0], "ko"), ...rows([0.4, 0.4], "th")],
      },
      "ndcg10",
    );
    // Two of ten queries gained 0.4; half of the languages did.
    expect(text).toContain("| **All languages** | 10 | **0.000** | **0.200** | **+0.200** |");
  });

  test("runs on different pools are refused", () => {
    const other = summary("next", 0.4);
    other.languages[0]!.pool = "another pool";
    expect(() =>
      renderComparison(
        { summary: summary("base", 0.2), rows: rows([0.1]) },
        { summary: other, rows: rows([0.3]) },
        "ndcg10",
      ),
    ).toThrow(/cannot be compared/);
  });

  test("a partial run is not compared with a full one", () => {
    const partial = summary("next", 0.4);
    partial.limits.maxQueries = 1;
    expect(() =>
      renderComparison(
        { summary: summary("base", 0.2), rows: rows([0.1]) },
        { summary: partial, rows: rows([0.3]) },
        "ndcg10",
      ),
    ).toThrow(/cannot be compared/);
  });
});
