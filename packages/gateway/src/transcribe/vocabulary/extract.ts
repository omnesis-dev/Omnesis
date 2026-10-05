// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { boundedSelfAuthoredText } from "@omnesis/types";

import {
  vocabularyConversationKey,
  type VocabularyCandidate,
  type VocabularyDocument,
  type VocabularySettings,
  type ExtractedVocabularyDocument,
} from "./types.js";

import { isCommonVocabularyWord } from "./common-words.js";
import { cleanVocabularyName } from "./names.js";
import { vocabularyText } from "./text.js";
import {
  observeVocabularySpelling,
  selectVocabularySpelling,
  vocabularySpellingBenefit,
  type VocabularySpellingObservation,
} from "./spelling.js";

// Consume the complete lexical run before applying the length cap. A bounded
// regex would turn oversized strings into several invented vocabulary hints.
const WORD = /[\p{L}][\p{L}\p{M}\p{N}'‘’.-]+/gu;
const withinWordLimit = (word: string): boolean =>
  word.length <= 48 || (word.length <= 96 && [...word].length <= 48);
const normalize = (s: string): string => s.normalize("NFC").toLocaleLowerCase("und");
const isCommon = (s: string): boolean => isCommonVocabularyWord(s);

/** Remove complete identifiers before tokenization can split them into hints. */
function stripIdentifiers(text: string): string {
  return (
    text
      // Consume whole tokens once: searching for a required @ at every offset
      // is quadratic on long delimiter-free strings. Drop malformed addresses
      // too, so no identifier fragment survives.
      .replace(/[^\s<>]+/gu, (token) => (/https?:\/\/|\bwww\.|@/iu.test(token) ? " " : token))
      // An optional dotted suffix consumes ordinary label runs once, while
      // only complete dotted identifiers are removed.
      .replace(/\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\b/gu, (token) =>
        token.includes(".") ? " " : token,
      )
  );
}

type CandidateObservations = Map<string, Map<string, VocabularySpellingObservation>>;

/** The same lexical safety and spelling evidence applies to received and authored prose. */
function observeTextCandidates(
  text: string,
  people: VocabularyDocument["people"],
  candidates: CandidateObservations,
  onObserve?: (term: string) => void,
): void {
  const add = (text: string, benefit: number): void => {
    const clean = text.normalize("NFC").replace(/^[.'‘’ -]+|[.'‘’ -]+$/gu, "");
    if (clean.length < 3 || clean.length > 80 || isCommon(clean)) return;
    if (!/\p{L}/u.test(clean) || /https?|www\.|@|\d{3}/iu.test(clean)) return;
    const term = normalize(clean);
    let variants = candidates.get(term);
    if (!variants) {
      variants = new Map();
      candidates.set(term, variants);
    }
    observeVocabularySpelling(variants, clean, benefit);
    onObserve?.(term);
  };
  // A people link identifies full-name phrases, including common components.
  // Only occurrences in cleaned prose supply their spelling and evidence.
  // They need corroboration like every other materialized phrase.
  const groundedNames = new Set<string>();
  for (const person of people.slice(0, 16)) {
    const name = cleanVocabularyName(person.name);
    if (!name) continue;
    const term = normalize(name);
    if (groundedNames.has(term)) continue;
    groundedNames.add(term);
    const escaped = name
      .split(/\s+/u)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("\\s+");
    const occurrence = new RegExp(
      `(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?![\\p{L}\\p{M}\\p{N}])`,
      "giu",
    );
    for (const match of text.matchAll(occurrence)) add(match[0].replace(/\s+/gu, " "), 2.5);
  }
  const wholeWordStarts = new Set<number>();
  const wholeWordEnds = new Set<number>();
  for (const match of text.matchAll(WORD)) {
    // Reject oversized runs before trimming: even a suffix regex can
    // rescan a long punctuation run when it is not at the string's end.
    if (match[0].length > 96) continue;
    const word = match[0].replace(/[.'‘’ -]+$/gu, "");
    if (!withinWordLimit(word)) continue;
    wholeWordStarts.add(match.index);
    wholeWordEnds.add(match.index + word.length);
    if (isCommon(word)) continue;
    // Repeated occurrences select the document's actual spelling. They
    // still count as only one supporting document in the repository.
    add(word, vocabularySpellingBenefit(word));
  }
  // Preserve adjacent uncommon capitalized words as a phrase, never an
  // instruction. Names with common components remain represented above.
  const phrase = /\b[\p{Lu}][\p{L}\p{M}]{2,30}(?: [\p{Lu}][\p{L}\p{M}]{2,30}){1,2}\b/gu;
  for (const match of text.matchAll(phrase)) {
    if (
      !groundedNames.has(normalize(match[0])) &&
      // The phrase must start and end at complete words at this occurrence;
      // another occurrence cannot legitimize an oversized token's suffix.
      wholeWordStarts.has(match.index) &&
      wholeWordEnds.has(match.index + match[0].length) &&
      match[0].split(" ").every((word) => !isCommon(word))
    )
      add(match[0], /\p{Ll}/u.test(match[0]) ? 2.5 : 1);
  }
}

function selectedCandidates(
  candidates: CandidateObservations,
  limit: number,
): VocabularyCandidate[] {
  return [...candidates.entries()]
    .map(([term, variants]): VocabularyCandidate => {
      const selected = selectVocabularySpelling(variants.values())!;
      return { term, text: selected.text, benefit: selected.benefit };
    })
    .sort((a, b) => b.benefit - a.benefit || a.term.localeCompare(b.term))
    .slice(0, Math.min(limit, 128));
}

/** Bounded pure CPU work; the scheduler's CPU pool owns this function. */
export function extractTranscriptionVocabulary(
  docs: VocabularyDocument[],
  settings: VocabularySettings,
): ExtractedVocabularyDocument[] {
  if (!settings.enabled) return [];
  return docs.slice(0, Math.min(settings.batchSize, 16)).map((doc) => {
    const candidates: CandidateObservations = new Map();
    const text = stripIdentifiers(
      `${vocabularyText(doc.title.slice(0, 256))}\n${vocabularyText(doc.content.slice(0, settings.maxDocumentChars))}`,
    );
    observeTextCandidates(text, doc.people, candidates);
    // Only source-owned authored segments earn self evidence. A person link or
    // mixed document's author role never grants it. Each occurrence votes for
    // spelling, while the latest original source instant is kept per term.
    const selfCandidates: CandidateObservations = new Map();
    const recordedAtByTerm = new Map<string, string>();
    let hasSelfText = false;
    for (const segment of boundedSelfAuthoredText(doc.selfAuthoredText ?? [])) {
      const segmentText = stripIdentifiers(vocabularyText(segment.text));
      hasSelfText ||= /\p{L}/u.test(segmentText);
      observeTextCandidates(segmentText, doc.people, selfCandidates, (term) => {
        const previous = recordedAtByTerm.get(term);
        if (!previous || segment.recordedAt > previous)
          recordedAtByTerm.set(term, segment.recordedAt);
      });
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
      generation: doc.generation,
      scopes,
      recordedAt: doc.recordedAt,
      hasText: /\p{L}/u.test(text) || hasSelfText,
      hasSelfText,
      automatedEvidence: doc.automatedEvidence,
      terms: selectedCandidates(candidates, settings.maxTermsPerDocument),
      ...(doc.selfAuthoredText !== undefined
        ? {
            selfTerms: selectedCandidates(selfCandidates, settings.maxTermsPerDocument).map(
              (candidate) => ({ ...candidate, recordedAt: recordedAtByTerm.get(candidate.term)! }),
            ),
          }
        : {}),
    };
  });
}
