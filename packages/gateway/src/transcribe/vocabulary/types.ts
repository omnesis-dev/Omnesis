// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export interface VocabularySettings {
  enabled: boolean;
  maxTerms: number;
  maxPromptTokens: number;
  batchSize: number;
  maxDocumentChars: number;
  maxTermsPerDocument: number;
  periodMs: number;
  idlePeriodMs: number;
}

export interface VocabularyScope {
  kind: "global" | "person" | "conversation";
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
