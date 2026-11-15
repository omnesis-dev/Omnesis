// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The versions of keyword-search text analysis.
 *
 * Keyword search only works when indexed chunks and queries are cut into words
 * by the same rules. A version names one set of rules: the FTS5 tokenizer spec
 * and an optional rewrite applied to the text before that tokenizer sees it.
 * The full-text index records the version that built it, and every query is
 * cut by the version of the index (or in-memory ranker) that answers it.
 *
 * Changing the rules means adding a version, never editing one: an install
 * whose index was built by an older version keeps searching it with those
 * rules while the indexer builds the new version's index beside it, then
 * switches (see indexer/lexical-index-store.ts).
 *
 * Version 0 is the analysis every install had before versions existed: no
 * rewrite, Porter stemming over `unicode61` with diacritics folded. An index
 * that records no version and was created with that tokenizer is version 0.
 */

import { syntheticEnabled } from "@omnesis/core";

export interface LexicalTextOptions {
  /**
   * The text is a type-ahead query whose last word is a prefix still being
   * typed. A rewrite must not change that word in a way that stops it being a
   * prefix of the indexed word.
   */
  prefixLastToken?: boolean;
}

export interface LexicalVersion {
  /** Recorded in the index; never reused for different rules. */
  readonly version: number;
  /** The FTS5 `tokenize=` argument. */
  readonly tokenize: string;
  /**
   * Rewrites text before the tokenizer sees it, identically for chunks and
   * queries. Absent when the tokenizer alone does the analysis; such a version
   * indexes `chunks` directly.
   */
  readonly rewrite?: (text: string, opts?: LexicalTextOptions) => string;
}

const PORTER_UNICODE61 = "porter unicode61 remove_diacritics 2";

/** The analysis every install had before versions existed. */
const VERSION_0: LexicalVersion = { version: 0, tokenize: PORTER_UNICODE61 };

/** The version new indexes are built with and older ones are rebuilt to. */
const CURRENT_VERSION = 0;

const PRODUCTION_VERSIONS: readonly LexicalVersion[] = [VERSION_0];

/**
 * Versions that exist only so the rebuild can be tested end to end. Each
 * reverses every word, so a query cut by the wrong version matches nothing.
 * They are known only on a synthetic gateway.
 */
const TEST_LEXICAL_VERSIONS: readonly number[] = [9001, 9002];

function reverseWords(text: string): string {
  return text.replace(/[\p{L}\p{N}\p{M}]+/gu, (word) => [...word].reverse().join(""));
}

function testVersions(): LexicalVersion[] {
  return TEST_LEXICAL_VERSIONS.map((version) => ({
    version,
    tokenize: PORTER_UNICODE61,
    rewrite: (text: string, opts?: LexicalTextOptions) =>
      // A reversed prefix is not a prefix of the reversed word; a type-ahead
      // query keeps its last word as typed so it still matches nothing wrongly
      // and the rest of the query is cut as indexed.
      opts?.prefixLastToken ? reverseAllButLast(text) : reverseWords(text),
  }));
}

function reverseAllButLast(text: string): string {
  const match = /[\p{L}\p{N}\p{M}]+(?=[^\p{L}\p{N}\p{M}]*$)/u.exec(text);
  if (!match) return reverseWords(text);
  return reverseWords(text.slice(0, match.index)) + text.slice(match.index);
}

/**
 * A target selected by `OMNESIS_LEXICAL_TEST_VERSION`, on a synthetic gateway
 * only: any version this build knows, so a test can start a gateway on an
 * older version and then upgrade it.
 */
function testTargetVersion(): number | null {
  if (!syntheticEnabled()) return null;
  const raw = process.env.OMNESIS_LEXICAL_TEST_VERSION;
  if (!raw) return null;
  const version = Number(raw);
  return knownLexicalVersions().some((v) => v.version === version) ? version : null;
}

/** Every version this build can search with. */
function knownLexicalVersions(): readonly LexicalVersion[] {
  return syntheticEnabled() ? [...PRODUCTION_VERSIONS, ...testVersions()] : PRODUCTION_VERSIONS;
}

/** The rules for `version`, or null when this build does not know them. */
export function lexicalVersion(version: number): LexicalVersion | null {
  return knownLexicalVersions().find((v) => v.version === version) ?? null;
}

/** The version this build indexes with. */
export function targetLexicalVersion(): LexicalVersion {
  const version = testTargetVersion() ?? CURRENT_VERSION;
  const rules = lexicalVersion(version);
  if (!rules) throw new Error(`lexical version ${version} is not defined`);
  return rules;
}

/**
 * The rules of an index that records no version: its tokenizer, no rewrite.
 * Version 0 when the tokenizer is version 0's.
 */
export function unversionedLexicalRules(tokenize: string): LexicalVersion {
  return tokenize === VERSION_0.tokenize ? VERSION_0 : { version: -1, tokenize };
}

/** `text` as `rules` cut it, before the tokenizer. */
export function analyze(rules: LexicalVersion, text: string, opts?: LexicalTextOptions): string {
  return rules.rewrite ? rules.rewrite(text, opts) : text;
}
