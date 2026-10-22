// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KnowledgeStorageError } from "./types.js";
import type { ParsedClaimMarkup } from "./claims.js";
import type Database from "better-sqlite3";

/**
 * Cheap structural checks on a wiki save, run before any paid check. A page
 * states the current understanding of one subject, under a name for that
 * subject. Two shapes contradict that and are refused here: a page that keeps
 * growing by one date-named section per batch of events (a log), and a title
 * that repeats the subject line of a document the page cites.
 */

/** A page with at least this many date-named sections, most of its sections, reads as a log. */
export const CHRONOLOGICAL_LOG_MIN_DATED_SECTIONS = 4;
/** Titles shorter than this many distinct words are names, whatever document shares them. */
export const COPIED_TITLE_MIN_WORDS = 4;
/** Word-set similarity at or above which a title repeats a document's title. */
export const COPIED_TITLE_SIMILARITY = 0.8;
/** Cited documents whose titles are compared, per save. */
const MAX_TITLE_SOURCES = 64;

// Month names in the languages a library is commonly written in, including
// unaccented spellings. A month only dates a heading next to a day or a year.
const MONTHS = [
  // English, with abbreviations
  "january|february|march|april|may|june|july|august|september|october|november|december",
  "jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec",
  // French
  "janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre",
  // German
  "januar|februar|märz|maerz|juni|juli|oktober|dezember",
  // Spanish
  "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre",
  // Italian
  "gennaio|febbraio|aprile|maggio|giugno|luglio|settembre|ottobre|dicembre",
  // Portuguese
  "janeiro|fevereiro|março|marco|maio|junho|julho|setembro|outubro|dezembro",
  // Dutch
  "januari|februari|maart|mei|augustus",
].join("|");
const DAY = String.raw`\d{1,2}(?:st|nd|rd|th|er|e)?\.?`;
const DATE_PATTERNS = [
  // 7 September, 21–24 August, 1er août, 7. September, 7 de septiembre
  new RegExp(
    String.raw`(?<![\p{L}\p{N}])${DAY}(?:\s*[-–—]\s*${DAY})?\s+(?:de\s+)?(?:${MONTHS})(?!\p{L})`,
    "iu",
  ),
  // September 7, Aug 24th
  new RegExp(
    String.raw`(?<!\p{L})(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?(?![\p{L}\p{N}])`,
    "iu",
  ),
  // August 2026, agosto de 2026
  new RegExp(String.raw`(?<!\p{L})(?:${MONTHS})\.?\s+(?:de\s+)?\d{4}(?!\p{N})`, "iu"),
  // 2026-09-07
  /(?<!\p{N})\d{4}-\d{1,2}-\d{1,2}(?!\p{N})/u,
  // 07/09/2026, 7.9.26
  /(?<!\p{N})\d{1,2}[./]\d{1,2}[./](?:\d{4}|\d{2})(?!\p{N})/u,
];

/** Whether a heading names a calendar date (a day, a day range or a month of a year). */
export function headingNamesDate(heading: string): boolean {
  return DATE_PATTERNS.some((pattern) => pattern.test(heading));
}

export interface WikiSectionShape {
  /** Section headings (levels 2–6), in page order. */
  headings: string[];
  /** The headings among them that name a date. */
  dated: string[];
}

/** The section headings of a page's readable text, outside fenced code. */
export function wikiSectionShape(text: string): WikiSectionShape {
  const headings: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^\s{0,3}#{2,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading) headings.push(heading);
  }
  return { headings, dated: headings.filter(headingNamesDate) };
}

export interface ChronologicalLogGrowth {
  /** Date-named headings this save adds. */
  added: string[];
  dated: number;
  sections: number;
}

/**
 * A save that turns an existing page further into a log: it adds date-named
 * sections, and afterwards at least {@link CHRONOLOGICAL_LOG_MIN_DATED_SECTIONS}
 * of its sections, and most of them, are named by dates. A save that keeps or
 * lowers the number of date-named sections (an in-place update, a
 * consolidation) is never one; neither is a new page.
 */
export function chronologicalLogGrowth(
  previousText: string | null,
  nextText: string,
): ChronologicalLogGrowth | null {
  if (previousText === null) return null;
  const before = wikiSectionShape(previousText);
  const after = wikiSectionShape(nextText);
  if (after.dated.length <= before.dated.length) return null;
  if (after.dated.length < CHRONOLOGICAL_LOG_MIN_DATED_SECTIONS) return null;
  if (after.dated.length * 2 <= after.headings.length) return null;
  const remaining = new Map<string, number>();
  for (const heading of before.dated) remaining.set(heading, (remaining.get(heading) ?? 0) + 1);
  const added = after.dated.filter((heading) => {
    const left = remaining.get(heading) ?? 0;
    if (left > 0) remaining.set(heading, left - 1);
    return left === 0;
  });
  return { added, dated: after.dated.length, sections: after.headings.length };
}

export function chronologicalLogRefusal(growth: ChronologicalLogGrowth): KnowledgeStorageError {
  return new KnowledgeStorageError(
    "claim_invalid",
    `Not saved: this save adds another section named by a date (${JSON.stringify(growth.added)}), after which ${growth.dated} of the page's ${growth.sections} sections are named by dates. ` +
      "A wiki states the current understanding of its subject, not a chronological log of batches of events: each event stays in its source and the time index, and the page's earlier states stay in its revisions. " +
      "Fold what the new evidence changes into the existing account instead: update the passage that states the subject's current or latest observed state in place (knowledge_edit replace_text or replace_section), keep a material exception or turning point as a dated sentence within the section about that aspect, name sections by aspect rather than by date, or leave the page unchanged when the new events change nothing about the subject. " +
      "The page is queued for a whole-page review, which can consolidate its date-named sections.",
  );
}

function titleWords(title: string): Set<string> {
  return new Set(
    title
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Refuse a new or changed page title that repeats the title of a document
 * the page cites: a message subject line, an issue or ticket title or a
 * notification headline names that document, not the page's subject. Short
 * titles are names in their own right and are never compared.
 */
export function assertSubjectTitle(
  db: Database.Database,
  input: { title: string; expectedRevision: number },
  parsed: ParsedClaimMarkup,
  previousTitle: string | null,
): void {
  if (input.expectedRevision > 0 && previousTitle === input.title) return;
  const words = titleWords(input.title);
  if (words.size < COPIED_TITLE_MIN_WORDS) return;
  const sources = [
    ...new Set(
      parsed.claims.flatMap((claim) =>
        claim.refs.filter((ref) => ref.kind === "source").map((ref) => ref.id),
      ),
    ),
  ].slice(0, MAX_TITLE_SOURCES);
  if (!sources.length) return;
  const rows = db
    .prepare<
      string[],
      { id: string; title: string | null }
    >(`SELECT id,title FROM documents WHERE id IN (${sources.map(() => "?").join(",")})`)
    .all(...sources);
  const copied = rows.find(
    (row) => row.title && similarity(words, titleWords(row.title)) >= COPIED_TITLE_SIMILARITY,
  );
  if (!copied) return;
  throw new KnowledgeStorageError(
    "claim_invalid",
    `Not saved: node.title repeats the title of cited source ${copied.id}. ` +
      "A page title names the page's subject (a person, place, organization, system, account, project, arrangement or event) in the page's language, the way a reader would look it up; it is not a message's subject line, an issue or ticket title, or a notification headline. " +
      "Choose a short name for the subject itself (for a booking confirmation, the stay or trip it confirms, with its place and time) and save again.",
  );
}
