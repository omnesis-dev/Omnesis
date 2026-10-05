// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SelfAuthoredTextSegment } from "@omnesis/types";

export interface VocabularySettings {
  enabled: boolean;
  authoredWeight?: number;
  machineEvidenceWeight?: number;
  contextPriorDocuments?: number;
  maxTerms: number;
  maxPromptTokens: number;
  batchSize: number;
  maxDocumentChars: number;
  maxTermsPerDocument: number;
  periodMs: number;
  idlePeriodMs: number;
}

export interface VocabularyScope {
  kind: "global" | "person" | "conversation" | "self";
  key: string;
}

export interface VocabularyDocument {
  id: string;
  contentHash: string;
  updatedAt: string;
  revision: number;
  /** Persisted materialization generation fences extraction across rebuilds. */
  generation: number;
  title: string;
  content: string;
  sourceId: string;
  threadId: string | null;
  recordedAt: string;
  selfAuthoredText?: SelfAuthoredTextSegment[];
  automatedEvidence?: boolean;
  people: Array<{ personId: string; name: string; isSelf: boolean; role: string }>;
}

export interface VocabularyCandidate {
  term: string;
  text: string;
  benefit: number;
}

export interface ExtractedVocabularyDocument {
  /** Writer continuation offset; never exposed on the public API. */
  applyOffset?: number;
  id: string;
  contentHash: string;
  updatedAt: string;
  revision: number;
  /** Persisted materialization generation fences extraction across rebuilds. */
  generation: number;
  scopes: VocabularyScope[];
  terms: VocabularyCandidate[];
  selfTerms?: Array<VocabularyCandidate & { recordedAt: string }>;
  /** Clean lexical prose provides frequency opportunities even without uncommon terms. */
  hasText?: boolean;
  hasSelfText?: boolean;
  automatedEvidence?: boolean;
  recordedAt: string;
}

export interface VocabularyApplyResult {
  applied: number;
  skipped: number;
  remaining: ExtractedVocabularyDocument[];
}

/** JSON avoids collisions from delimiters inside provider-issued thread identifiers. */
export const vocabularyConversationKey = (sourceId: string, threadId: string): string =>
  JSON.stringify([sourceId, threadId]);

/** A single free-text document cannot corroborate its own vocabulary. */
export const MIN_VOCABULARY_DOCUMENTS = 2;
