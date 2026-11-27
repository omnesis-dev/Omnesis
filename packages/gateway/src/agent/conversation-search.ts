// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search over the Ask conversation list. Ranking needs two inputs. The first
 * is the hits the search index finds in conversation text, already ranked by
 * relevance. The second is the listed summaries, which are the authority on
 * which conversations exist: a hit for a conversation that has been deleted,
 * or whose deletion is still running, matches nothing. A conversation the
 * index has not reached yet, such as one whose first turn just ended, still
 * matches on its title.
 */

import type { ConversationSummary } from "./conversation-store.js";

/** A conversation the search index matched, best first. */
export interface ConversationSearchHit {
  conversationId: string;
  /** Text of the best matching passage, as plain prose. */
  text: string;
}

/** Search conversation text. Resolves to hits in relevance order. */
export type ConversationSearch = (query: string) => Promise<ConversationSearchHit[]>;

/** A listed conversation that matched, with the passage that matched it. */
export type ConversationMatch = ConversationSummary & { match?: { snippet: string } };

export const MAX_CONVERSATION_QUERY_LENGTH = 200;

const SNIPPET_LENGTH = 160;

/**
 * Index hits first, in relevance order. Conversations matched only by their
 * title come after them, keeping the list order. Each conversation appears at
 * most once.
 */
export function rankConversationMatches(
  summaries: readonly ConversationSummary[],
  hits: readonly ConversationSearchHit[],
  query: string,
): ConversationMatch[] {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const out: ConversationMatch[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const summary = byId.get(hit.conversationId);
    if (!summary || seen.has(summary.id)) continue;
    seen.add(summary.id);
    const snippet = conversationSnippet(withoutLeadingTitle(hit.text, summary.title, query), query);
    out.push(snippet ? { ...summary, match: { snippet } } : summary);
  }
  const terms = queryTerms(query);
  if (terms.length === 0) return out;
  for (const summary of summaries) {
    if (seen.has(summary.id)) continue;
    const title = fold(summary.title);
    if (terms.every((term) => title.includes(term))) out.push(summary);
  }
  return out;
}

/**
 * About {@link SNIPPET_LENGTH} characters of a passage: the window holding
 * the most distinct query terms, the earliest such window on a tie.
 */
export function conversationSnippet(text: string, query: string): string {
  const plain = withoutInlineMarkup(text);
  if (plain.length <= SNIPPET_LENGTH) return plain;
  // Folding keeps one character per character, so offsets carry over.
  const folded = fold(plain);
  const terms = [...new Set(queryTerms(query))];
  const occurrences: { at: number; term: number }[] = [];
  terms.forEach((term, index) => {
    for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + 1)) {
      occurrences.push({ at, term: index });
    }
  });
  occurrences.sort((a, b) => a.at - b.at);
  let anchor = 0;
  let best = 0;
  for (const [i, first] of occurrences.entries()) {
    const within = new Set<number>();
    for (let j = i; j < occurrences.length; j += 1) {
      const next = occurrences[j]!;
      if (next.at + terms[next.term]!.length > first.at + (SNIPPET_LENGTH * 2) / 3) break;
      within.add(next.term);
    }
    if (within.size > best) {
      best = within.size;
      anchor = first.at;
    }
  }
  let start = Math.max(0, Math.min(anchor - SNIPPET_LENGTH / 3, plain.length - SNIPPET_LENGTH));
  start = start > 0 ? nextWordStart(plain, Math.floor(start)) : 0;
  let end = Math.min(plain.length, start + SNIPPET_LENGTH);
  if (end < plain.length) end = previousWordEnd(plain, end, start);
  return `${start > 0 ? "…" : ""}${plain.slice(start, end)}${end < plain.length ? "…" : ""}`;
}

/** Prose without emphasis and code markers, on one line. */
function withoutInlineMarkup(text: string): string {
  return text
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A conversation's title is usually its first message, so a passage from the
 * start of one repeats the title the list already shows. Drop that repeat.
 * When nothing a query term matches is left after it, the title was the match
 * and there is no passage to show.
 */
function withoutLeadingTitle(text: string, title: string, query: string): string {
  const plain = withoutInlineMarkup(text);
  const heading = title.replace(/\s+/g, " ").trim();
  if (!heading || !fold(plain).startsWith(fold(heading))) return plain;
  const rest = plain.slice(heading.length).trim();
  const folded = fold(rest);
  return queryTerms(query).some((term) => folded.includes(term)) ? rest : "";
}

function queryTerms(query: string): string[] {
  return fold(query)
    .split(/\s+/)
    .map((term) => term.replace(/^["'(]+|["'),.!?;:]+$/g, ""))
    .filter((term) => term.length > 0);
}

/** Lower case without diacritics, one output character per input character. */
function fold(value: string): string {
  let out = "";
  for (const char of value) {
    const base = char
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase();
    out += base.length === char.length ? base : char;
  }
  return out;
}

function nextWordStart(text: string, from: number): number {
  const space = text.indexOf(" ", from);
  return space === -1 || space - from > 20 ? from : space + 1;
}

function previousWordEnd(text: string, from: number, floor: number): number {
  const space = text.lastIndexOf(" ", from);
  return space <= floor || from - space > 20 ? from : space;
}
