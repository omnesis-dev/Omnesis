// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Marked } from "marked";

export interface AnswerSourceEvidence {
  documentId: string;
  title: string | null;
  authority: "whole_source" | "selected_quote";
  text: string;
  sourceCreatedAt?: string | null;
  selectedQuotes: string[];
}

const MAX_WINDOWS_PER_SOURCE = 8;
const MAX_PARAGRAPHS_PER_SOURCE = 32_768;

interface Range {
  start: number;
  end: number;
}
interface Candidate extends Range {
  source: number;
  anchor: boolean;
  score: number;
}

/** Select exact observed paragraphs, not generated summaries or unseen text. */
export function selectAnswerEvidence(input: {
  sources: AnswerSourceEvidence[];
  anchors: ReadonlyMap<string, readonly string[]>;
  question: string;
  draft: string;
  maxBytes: number;
  packetBytes(sources: AnswerSourceEvidence[], incomplete: boolean): number;
}): { sources: AnswerSourceEvidence[]; incomplete: boolean } | null {
  if (input.packetBytes(input.sources, false) <= input.maxBytes)
    return { sources: input.sources, incomplete: false };
  if (input.packetBytes([], true) > input.maxBytes) return null;
  // A broad answer can mention many unrelated topics. Match one assertion at
  // a time so a long footer cannot outrank a focused passage merely by
  // accumulating incidental words from the whole answer.
  const clauses = `${input.question}\n${input.draft}`
    .split(/[.!?;](?=\s)|\n+/u)
    .map(relevanceWords)
    .filter((words) => words.size > 0);
  const matchingClauses = new Map<string, number[]>();
  for (const [index, words] of clauses.entries())
    for (const word of words) {
      const matches = matchingClauses.get(word) ?? [];
      matches.push(index);
      matchingClauses.set(word, matches);
    }
  const framing = new Map<
    number,
    { opening: string; headings: Array<{ offset: number; depth: number; text: string }> }
  >();
  const candidates: Candidate[][] = input.sources.map((source, sourceIndex) => {
    // Bound selection work as well as output. Oversized inputs can be omitted,
    // never silently promoted from a truncated scan into complete evidence.
    if (Buffer.byteLength(source.text) > input.maxBytes * 8) return [];
    const ranges: Range[] = [];
    const boundary = /\n[\t \r]*\n+/gu;
    let start = 0;
    for (const match of source.text.matchAll(boundary)) {
      if (match.index > start) ranges.push({ start, end: match.index });
      if (ranges.length >= MAX_PARAGRAPHS_PER_SOURCE) return [];
      start = match.index + match[0].length;
    }
    if (start < source.text.length) ranges.push({ start, end: source.text.length });
    const headings: Array<{ offset: number; depth: number; text: string }> = [];
    // Marked normalizes CRLF and lone CR before lexing. Map its UTF-16
    // offsets back to the observed original, preserving literal quote bytes.
    const originalOffsets = new Uint32Array(source.text.length + 1);
    let normalized = "";
    for (let original = 0; original < source.text.length; original++) {
      originalOffsets[normalized.length] = original;
      if (source.text[original] === "\r") {
        normalized += "\n";
        if (source.text[original + 1] === "\n") original++;
      } else normalized += source.text[original];
    }
    originalOffsets[normalized.length] = source.text.length;
    let offset = 0;
    for (const token of new Marked().lexer(normalized)) {
      const end = offset + token.raw.length;
      if (token.type === "heading")
        headings.push({
          offset: originalOffsets[offset]!,
          depth: token.depth,
          text: source.text.slice(originalOffsets[offset], originalOffsets[end]),
        });
      offset = end;
    }
    framing.set(sourceIndex, {
      opening: ranges[0] ? source.text.slice(ranges[0].start, ranges[0].end) : "",
      headings,
    });
    const anchors = input.anchors.get(source.documentId) ?? [];
    const paragraphWords = ranges.map((range) =>
      relevanceWords(source.text.slice(range.start, range.end)),
    );
    const frequency = new Map<string, number>();
    for (const words of paragraphWords)
      for (const word of words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
    const ranked = ranges
      .map((range, i) => {
        const paragraph = source.text.slice(range.start, range.end);
        const words = paragraphWords[i]!;
        const scores = new Map<number, number>();
        let overlap = 0;
        for (const word of words) {
          const weight = Math.log1p(ranges.length / frequency.get(word)!);
          for (const clause of matchingClauses.get(word) ?? []) {
            const score = (scores.get(clause) ?? 0) + weight;
            scores.set(clause, score);
            overlap = Math.max(overlap, score);
          }
        }
        // Repeated names/signatures carry little distinguishing information;
        // tiny fragments should not outrank substantive matching sentences.
        const score = overlap / Math.sqrt(Math.max(8, words.size));
        const anchor = anchors.some((quote) => paragraph.includes(quote));
        // Adjacent paragraphs retain local qualifications. Never slice a long
        // unbroken paragraph just to make it fit: that could remove a negation.
        return {
          source: sourceIndex,
          start: ranges[Math.max(0, i - 1)]!.start,
          end: ranges[Math.min(ranges.length - 1, i + 1)]!.end,
          anchor,
          score,
        };
      })
      .filter((candidate) => candidate.anchor || candidate.score > 0);
    for (const quote of anchors) {
      if (!quote) continue;
      let from = 0;
      for (let occurrence = 0; occurrence < MAX_WINDOWS_PER_SOURCE; occurrence++) {
        const at = source.text.indexOf(quote, from);
        if (at < 0) break;
        from = at + quote.length;
        const first = ranges.findIndex((range) => range.end > at);
        const last = ranges.findIndex((range) => range.end >= at + quote.length);
        if (first >= 0 && last >= first)
          ranked.push({
            source: sourceIndex,
            start: ranges[Math.max(0, first - 1)]!.start,
            end: ranges[Math.min(ranges.length - 1, last + 1)]!.end,
            anchor: true,
            score: 0,
          });
      }
    }
    // Small sources retain their complete observed scope, even if synonyms
    // prevent a lexical match. This is allocation, never semantic proof.
    if (Buffer.byteLength(source.text) <= input.maxBytes / Math.max(1, input.sources.length))
      ranked.push({
        source: sourceIndex,
        start: 0,
        end: source.text.length,
        anchor: anchors.some((quote) => source.text.includes(quote)),
        score: ranked.reduce((max, c) => Math.max(max, c.score), 0),
      });
    ranked.sort(compare);
    const seen = new Set<string>();
    return ranked
      .filter((candidate) => {
        const key = `${candidate.start}:${candidate.end}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_WINDOWS_PER_SOURCE);
  });
  const selected = new Map<number, Range[]>();
  const materialize = (): AnswerSourceEvidence[] =>
    [...selected.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, ranges]) => {
        const source = input.sources[i]!;
        const merged: Range[] = [];
        for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
          const last = merged.at(-1);
          if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
          else merged.push({ ...range });
        }
        if (merged.length === 1 && merged[0]!.start === 0 && merged[0]!.end === source.text.length)
          return source;
        const quotes = merged.map((range) => source.text.slice(range.start, range.end));
        const scope = framing.get(i)!;
        const scopedPassages = merged.map((range, index) => {
          const stack: Array<{ depth: number; text: string }> = [];
          for (const heading of scope.headings) {
            if (heading.offset > range.start) break;
            while (stack.length && stack.at(-1)!.depth >= heading.depth) stack.pop();
            stack.push(heading);
          }
          return `Observed enclosing headings (interpretation only):\n${stack.map((h) => h.text).join("\n")}\nObserved passage:\n${quotes[index]}`;
        });
        return {
          ...source,
          authority: "selected_quote",
          text: `Observed opening paragraph (interpretation only):\n${scope.opening}\n\n${scopedPassages.join("\n\n[Noncontiguous observed passage]\n\n")}`,
          selectedQuotes: quotes,
        };
      });
  // One first-choice window per source before second choices. Exact quote
  // anchors lead each round; stable source/offset order resolves all ties.
  for (let round = 0; round < MAX_WINDOWS_PER_SOURCE; round++) {
    const choices = candidates.flatMap((rows) => (rows[round] ? [rows[round]!] : [])).sort(compare);
    for (const candidate of choices) {
      const prior = selected.get(candidate.source) ?? [];
      selected.set(candidate.source, [...prior, { start: candidate.start, end: candidate.end }]);
      if (input.packetBytes(materialize(), true) > input.maxBytes) {
        if (prior.length) selected.set(candidate.source, prior);
        else selected.delete(candidate.source);
      }
    }
  }
  const sources = materialize();
  return { sources, incomplete: true };
}
function compare(a: Candidate, b: Candidate): number {
  return (
    Number(b.anchor) - Number(a.anchor) ||
    b.score - a.score ||
    a.source - b.source ||
    a.start - b.start ||
    b.end - a.end
  );
}
/** Ranking only: original source bytes, including links, remain untouched. */
function relevanceWords(text: string): Set<string> {
  return new Set(
    (
      text
        .replace(/(?:https?:\/\/|mailto:)[^\s<>)]*/giu, "")
        .toLowerCase()
        .match(/[\p{L}\p{N}]{3,}/gu) ?? []
    ).filter((word) => !STOP_WORDS.has(word)),
  );
}
const STOP_WORDS = new Set(
  "the and for that this with from have has had are was were not but you your what which when where how can could would should all any some into about been being they their them our out only also more than then there here".split(
    " ",
  ),
);
