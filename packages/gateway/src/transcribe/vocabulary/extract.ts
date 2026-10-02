// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  vocabularyConversationKey,
  type VocabularyCandidate,
  type VocabularyDocument,
  type VocabularySettings,
  type ExtractedVocabularyDocument,
} from "./types.js";

import { isCommonVocabularyWord } from "./common-words.js";

const WORD = /[\p{L}][\p{L}\p{M}\p{N}'’.-]{1,47}/gu;
const normalize = (s: string): string => s.normalize("NFC").toLocaleLowerCase("und");
const isCommon = (s: string): boolean => isCommonVocabularyWord(s);

/** Bounded pure CPU work; the scheduler's CPU pool owns this function. */
export function extractTranscriptionVocabulary(
  docs: VocabularyDocument[],
  settings: VocabularySettings,
): ExtractedVocabularyDocument[] {
  if (!settings.enabled) return [];
  return docs.slice(0, Math.min(settings.batchSize, 16)).map((doc) => {
    const candidates = new Map<string, VocabularyCandidate>();
    const add = (text: string, benefit: number, groundedName = false): void => {
      const clean = text.normalize("NFC").replace(/^[.'’ -]+|[.'’ -]+$/gu, "");
      if (clean.length < 3 || clean.length > 80 || (!groundedName && isCommon(clean))) return;
      if (!/\p{L}/u.test(clean) || /https?|www\.|@|\d{3}/iu.test(clean)) return;
      const term = normalize(clean);
      const existing = candidates.get(term);
      if (!existing || existing.benefit < benefit)
        candidates.set(term, { term, text: clean, benefit });
    };
    // Names are independently grounded, including names written in scripts
    // without upper/lower case. Limit names as well as scanned text.
    for (const person of doc.people.slice(0, 16)) {
      if (person.name.length <= 80) {
        add(person.name, 3, true);
        for (const word of person.name.match(WORD) ?? []) add(word, 2.5);
      }
    }
    const text = `${doc.title.slice(0, 256)}\n${doc.content.slice(0, settings.maxDocumentChars)}`
      // Vocabulary names are spoken phrases, not addresses or URL fragments.
      // Remove the complete identifier before tokenization can split it.
      .replace(/https?:\/\/[^\s<>]+|\bwww\.[^\s<>]+|[^\s<>@]+@[^\s<>@]+/giu, " ")
      .replace(/\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+\b/gu, " ");
    const words = new Map<string, { text: string; benefit: number }>();
    for (const match of text.matchAll(WORD)) {
      const word = match[0];
      if (isCommon(word)) continue;
      const key = normalize(word);
      const acronym = /^[\p{Lu}]{2,10}$/u.test(word);
      const mixedCase = /\p{Ll}\p{Lu}/u.test(word);
      const proper = /^\p{Lu}/u.test(word);
      const benefit = acronym || mixedCase ? 3 : proper ? 2 : 1;
      const prior = words.get(key);
      if (!prior || prior.benefit < benefit) words.set(key, { text: word, benefit });
    }
    for (const word of words.values()) {
      // Weak lower-case terms need support across independent documents before
      // inference uses them; the repository enforces that selection rule.
      add(word.text, word.benefit);
    }
    // Preserve adjacent uncommon capitalized words as a phrase, never an
    // instruction. Names with common components remain represented above.
    const phrase = /\b[\p{Lu}][\p{L}\p{M}]{2,30}(?: [\p{Lu}][\p{L}\p{M}]{2,30}){1,2}\b/gu;
    for (const match of text.matchAll(phrase)) {
      if (match[0].split(" ").some((word) => !isCommon(word))) add(match[0], 2.5);
    }
    const scopes: ExtractedVocabularyDocument["scopes"] = [{ kind: "global", key: "" }];
    const people = new Set(
      doc.people
        .filter(
          (p) => !p.isSelf && ["author", "sender", "recipient", "participant"].includes(p.role),
        )
        .slice(0, 16)
        .map((p) => p.personId),
    );
    for (const personId of people) scopes.push({ kind: "person", key: personId });
    if (doc.threadId)
      scopes.push({
        kind: "conversation",
        key: vocabularyConversationKey(doc.sourceId, doc.threadId),
      });
    return {
      id: doc.id,
      contentHash: doc.contentHash,
      updatedAt: doc.updatedAt,
      revision: doc.revision,
      scopes,
      recordedAt: doc.recordedAt,
      terms: [...candidates.values()]
        .sort((a, b) => b.benefit - a.benefit || a.term.localeCompare(b.term))
        .slice(0, Math.min(settings.maxTermsPerDocument, 128)),
    };
  });
}
