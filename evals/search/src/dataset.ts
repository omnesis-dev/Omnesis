// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The on-disk layout of a prepared search-eval dataset, shared by the script
 * that builds it and the scripts that read it.
 *
 * A dataset is one directory per language under the data directory, holding a
 * document pool, the judged queries and their relevance judgments. Nothing in
 * it is committed: the text is downloaded from the public MIRACL release.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Every language the MIRACL development split judges. */
const LANGUAGES = [
  "ar",
  "bn",
  "de",
  "en",
  "es",
  "fa",
  "fi",
  "fr",
  "hi",
  "id",
  "ja",
  "ko",
  "ru",
  "sw",
  "te",
  "th",
  "yo",
  "zh",
] as const;
export type Language = (typeof LANGUAGES)[number];

export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  ar: "Arabic",
  bn: "Bengali",
  de: "German",
  en: "English",
  es: "Spanish",
  fa: "Persian",
  fi: "Finnish",
  fr: "French",
  hi: "Hindi",
  id: "Indonesian",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  sw: "Swahili",
  te: "Telugu",
  th: "Thai",
  yo: "Yoruba",
  zh: "Chinese",
};

export interface Passage {
  /** MIRACL passage id, `<article>#<index>`; unique within one language only. */
  docid: string;
  title: string;
  text: string;
}

interface Query {
  id: string;
  text: string;
}

/** What `prepare` records about one language's pool. */
export interface LanguageManifest {
  language: Language;
  passages: number;
  judgedPassages: number;
  /** Judged passage ids the corpus release does not contain. */
  missingJudgedPassages: number;
  /** Passages in the full MIRACL corpus the pool was sampled from. */
  corpusPassages: number;
  queries: number;
  judgments: number;
  sha256: { corpus: string; queries: string; qrels: string };
}

export interface DatasetManifest {
  dataset: "miracl-dev-pools";
  poolSize: number;
  revisions: { topics: string; corpus: string };
  languages: LanguageManifest[];
}

/** Where a passage is recorded on the document pushed for it, and read back from a search result. */
export function passageUrl(language: Language, docid: string): string {
  return `miracl://${language}/${docid}`;
}

/**
 * Search results as the passage ids the judgments use. A result that is not a
 * passage of `language` is a wrong answer: it keeps its rank under an id no
 * judgment names.
 */
export function rankedPassageIds(
  results: ReadonlyArray<{ sourceUrl?: string | null }>,
  language: Language,
): string[] {
  const prefix = passageUrl(language, "");
  return results.map((r, i) =>
    r.sourceUrl?.startsWith(prefix) ? r.sourceUrl.slice(prefix.length) : `other:${i}`,
  );
}

/** One short fingerprint of a language's passages, questions and judgments. */
export function poolFingerprint(manifest: LanguageManifest): string {
  const { corpus, queries, qrels } = manifest.sha256;
  return createHash("sha256").update(`${corpus}\n${queries}\n${qrels}`).digest("hex").slice(0, 16);
}

export function defaultDataDir(): string {
  return process.env.OMNESIS_SEARCH_EVAL_DATA ?? join(homedir(), ".cache", "omnesis-search-eval");
}

export function languageDir(dataDir: string, language: Language): string {
  return join(dataDir, language);
}

function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

/** `a,b,c` → validated languages; absent → all of them. */
export function parseLanguages(value: string | undefined): Language[] {
  if (!value) return [...LANGUAGES];
  const picked = value.split(",").map((v) => v.trim());
  for (const p of picked) {
    if (!isLanguage(p)) throw new Error(`Unknown language "${p}". Known: ${LANGUAGES.join(", ")}`);
  }
  return picked as Language[];
}

export function readManifest(dataDir: string): DatasetManifest {
  const path = join(dataDir, "manifest.json");
  if (!existsSync(path)) {
    throw new Error(`No dataset at ${dataDir}. Run \`npm run search-eval:prepare\` first.`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as DatasetManifest;
}

export async function* readPassages(dataDir: string, language: Language): AsyncGenerator<Passage> {
  // Split on "\n" only: passages contain U+2028, which `readline` treats as a
  // line break.
  const decoder = new TextDecoder();
  let rest = "";
  const input = createReadStream(join(languageDir(dataDir, language), "corpus.jsonl"));
  for await (const chunk of input as AsyncIterable<Buffer>) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (line) yield JSON.parse(line) as Passage;
    }
  }
  if (rest) yield JSON.parse(rest) as Passage;
}

export function readQueries(dataDir: string, language: Language): Query[] {
  return readFileSync(join(languageDir(dataDir, language), "queries.tsv"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { id: line.slice(0, tab), text: line.slice(tab + 1) };
    });
}

/** query id → passage id → relevance grade (0 = judged not relevant). */
export function readQrels(dataDir: string, language: Language): Map<string, Map<string, number>> {
  const qrels = new Map<string, Map<string, number>>();
  const lines = readFileSync(join(languageDir(dataDir, language), "qrels.tsv"), "utf8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    const [queryId, , docid, grade] = line.split("\t");
    if (!queryId || !docid) continue;
    let judged = qrels.get(queryId);
    if (!judged) qrels.set(queryId, (judged = new Map()));
    judged.set(docid, Number(grade));
  }
  return qrels;
}
