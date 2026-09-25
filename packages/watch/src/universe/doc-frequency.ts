// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How often a term appears in a universe's documents.
 *
 * The validator asks this at compile time to refuse a lexical term that would
 * nominate half the corpus. A live install answers from the search index; a
 * universe answers from its own journal, which is the only text it has.
 *
 * What it can see is a limit worth stating: the journal carries titles, not
 * bodies, so a term appearing only in the body of a document is counted zero
 * times here. That makes this a *lower* bound on frequency — it can miss a
 * flood-prone term, never invent one — so the check errs towards accepting, and
 * the backtest's reach count remains the guardrail behind it.
 */

import { readJournal } from "../journal/read.js";
import { containsTerm, normalizeForMatch, type DocumentFrequency } from "../runtime/lexical.js";
import { journalPath } from "./paths.js";

export class UniverseDocumentFrequency implements DocumentFrequency {
  private readonly texts: readonly string[];

  constructor(universe?: string) {
    const seen = new Map<string, string>();
    for (const event of readJournal(journalPath(universe))) {
      if (event.kind !== "doc.event") continue;
      const payload = event.payload as { docId: string; title?: string };
      if (!seen.has(payload.docId)) seen.set(payload.docId, payload.title ?? "");
    }
    this.texts = [...seen.values()].map(normalizeForMatch);
  }

  frequency(term: string): { documents: number; corpus: number } {
    const documents = this.texts.filter((text) => containsTerm(text, term)).length;
    return { documents, corpus: this.texts.length };
  }
}
