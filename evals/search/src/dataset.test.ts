// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  parseLanguages,
  passageUrl,
  poolFingerprint,
  rankedPassageIds,
  readPassages,
  readQrels,
  readQueries,
  type LanguageManifest,
} from "./dataset.js";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function dataset(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "omnesis-search-eval-"));
  mkdirSync(join(dir, "ko"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "ko", name), text);
  return dir;
}

describe("parseLanguages", () => {
  test("no value means every language", () => {
    expect(parseLanguages(undefined)).toHaveLength(18);
  });

  test("a list is kept in the order given", () => {
    expect(parseLanguages("ko, ja")).toEqual(["ko", "ja"]);
  });

  test("an unknown language is refused by name", () => {
    expect(() => parseLanguages("ko,xx")).toThrow(/Unknown language "xx"/);
  });
});

describe("reading a prepared language", () => {
  test("a question keeps the tabs inside its text", () => {
    const data = dataset({ "queries.tsv": "7\tfirst\tsecond\n8\tthird\n" });
    expect(readQueries(data, "ko")).toEqual([
      { id: "7", text: "first\tsecond" },
      { id: "8", text: "third" },
    ]);
  });

  test("judgments are grouped by question, with the grade as a number", () => {
    const data = dataset({ "qrels.tsv": "7\tQ0\t10#0\t1\n7\tQ0\t11#2\t0\n8\tQ0\t10#0\t1\n" });
    const qrels = readQrels(data, "ko");
    expect([...qrels.get("7")!]).toEqual([
      ["10#0", 1],
      ["11#2", 0],
    ]);
    expect([...qrels.get("8")!]).toEqual([["10#0", 1]]);
  });

  test("a line separator inside a passage does not split it", () => {
    const passage = { docid: "10#0", title: "Tides", text: "first\u2028second" };
    const data = dataset({ "corpus.jsonl": `${JSON.stringify(passage)}\n` });
    return (async () => {
      const read = [];
      for await (const p of readPassages(data, "ko")) read.push(p);
      expect(read).toEqual([passage]);
    })();
  });
});

describe("rankedPassageIds", () => {
  test("a passage of the language is named by its id", () => {
    expect(rankedPassageIds([{ sourceUrl: passageUrl("ko", "10#0") }], "ko")).toEqual(["10#0"]);
  });

  test("another language's passage and a document without an address keep their rank", () => {
    const results = [
      { sourceUrl: passageUrl("ja", "10#0") },
      { sourceUrl: passageUrl("ko", "10#0") },
      { sourceUrl: null },
      {},
    ];
    expect(rankedPassageIds(results, "ko")).toEqual(["other:0", "10#0", "other:2", "other:3"]);
  });
});

describe("poolFingerprint", () => {
  const manifest = (qrels: string): LanguageManifest => ({
    language: "ko",
    passages: 1,
    judgedPassages: 1,
    missingJudgedPassages: 0,
    corpusPassages: 1,
    queries: 1,
    judgments: 1,
    sha256: { corpus: "a", queries: "b", qrels },
  });

  test("changes when any of the three files does", () => {
    expect(poolFingerprint(manifest("c"))).toBe(poolFingerprint(manifest("c")));
    expect(poolFingerprint(manifest("c"))).not.toBe(poolFingerprint(manifest("d")));
  });
});
