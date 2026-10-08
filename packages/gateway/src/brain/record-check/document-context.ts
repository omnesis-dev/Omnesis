// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Trusted source context for judging a document annotation's marginal value. */
export interface DocumentRecordContext {
  subject_text: string;
  subject_characters: number;
  subject_truncated: boolean;
  evidence: { source: number; is_subject: boolean; quote: string }[];
  evidence_truncated: boolean;
}

const SUBJECT_CHARACTERS = 8_000;
const MAX_EVIDENCE_SOURCES = 9;
const QUOTE_CHARACTERS = 500;

function wholeCharacters(text: string, start: number, end: number): string {
  const first = text.charCodeAt(start);
  if (start > 0 && first >= 0xdc00 && first <= 0xdfff) start++;
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(start, end);
}

/** Inputs must already have passed the source/evidence privacy firewall. */
export function documentRecordContext(
  subjectId: string,
  subjectText: string,
  atoms: readonly { docId: string; quote: string }[],
): DocumentRecordContext {
  const sourceNumbers = new Map<string, number>();
  const truncated = subjectText.length > SUBJECT_CHARACTERS;
  return {
    subject_text: truncated
      ? wholeCharacters(subjectText, 0, 6_000) +
        "\n[Middle omitted]\n" +
        wholeCharacters(subjectText, subjectText.length - 2_000, subjectText.length)
      : subjectText,
    subject_characters: subjectText.length,
    subject_truncated: truncated,
    evidence: atoms.slice(0, MAX_EVIDENCE_SOURCES).map((atom) => {
      if (!sourceNumbers.has(atom.docId)) sourceNumbers.set(atom.docId, sourceNumbers.size);
      return {
        source: sourceNumbers.get(atom.docId)!,
        is_subject: atom.docId === subjectId,
        quote: wholeCharacters(atom.quote, 0, Math.min(atom.quote.length, QUOTE_CHARACTERS)),
      };
    }),
    evidence_truncated:
      atoms.length > MAX_EVIDENCE_SOURCES ||
      atoms.some((atom) => atom.quote.length > QUOTE_CHARACTERS),
  };
}
