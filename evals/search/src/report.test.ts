// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { renderComparison, renderResults } from "./report.js";
import { listRuns, readQueryRows, readSummary, writeRun } from "./results.js";
import type { QueryRow, RunSummary } from "./results.js";

function summary(name: string, ndcg: number): RunSummary {
  return {
    name,
    mode: "lexical",
    startedAt: `2026-01-0${name === "base" ? 1 : 2}T00:00:00.000Z`,
    source: { commit: "0123456789abcdef", dirty: false, branch: "main" },
    dataset: { name: "miracl-dev-pools", poolSize: 100, revisions: { topics: "t", corpus: "c" } },
    embedder: null,
    gatewayConfig: {},
    macro: { ndcg10: ndcg, recall100: 0.5, mrr10: 0.4 },
    languages: [
      {
        language: "ko",
        queries: 3,
        passages: 100,
        emptyResults: 0,
        ndcg10: ndcg,
        recall100: 0.5,
        mrr10: 0.4,
      },
    ],
    totals: { passages: 100, chunks: 100, queries: 3 },
    timing: { ingestSeconds: 1, indexSeconds: 1, querySeconds: 1, queryMsP50: 5, queryMsP95: 9 },
    lexicalEngines: { memory: 3 },
  };
}

function rows(values: readonly number[]): QueryRow[] {
  return values.map((v, i) => ({
    language: "ko",
    queryId: `q${i}`,
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
      "| base | lexical | 012345678 | 100 | 3 | 0.250 | 0.500 | 0.400 | 9 ms |",
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
});
