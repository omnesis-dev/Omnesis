// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Strip invisible Unicode characters that waste embedding tokens
 * without carrying semantic meaning. Marketing/newsletter emails
 * routinely pad HTML with zero-width joiners, non-joiners, and
 * invisible separators to defeat client-side whitespace collapsing.
 *
 * Categories removed:
 *  - Zero-width characters: U+200B (ZWS), U+200C (ZWNJ), U+200D (ZWJ), U+FEFF (BOM)
 *  - Invisible formatting: U+00AD (soft hyphen), U+034F (combining grapheme joiner)
 *  - Invisible separators: U+2060 (word joiner), U+2061–U+2064 (invisible operators)
 *  - Tag characters: U+E0001–U+E007F (deprecated Unicode tag block)
 */
// eslint-disable-next-line no-irregular-whitespace, no-misleading-character-class
const INVISIBLE_RE = /[­͏​-‍⁠-⁤﻿\u{E0001}-\u{E007F}]/gu;

/**
 * Control characters that carry no semantic value and that the embedder's
 * tokenizer (HF/Rust `tokenizers` backend) rejects: the C0 range minus the
 * three whitespace controls we keep (`\t` `\n` `\r`), DEL, and the C1 range.
 * Left in, a single one of these makes the whole embed batch fail. Built via
 * `RegExp` from escape strings so the source carries no literal control bytes.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]", "g");

/**
 * Lone UTF-16 surrogates: a high surrogate not followed by a low one, or a
 * low surrogate not preceded by a high one. They cannot encode to valid
 * UTF-8, so the embedder server's Python→Rust string conversion throws and
 * the request fails with an opaque tokenizer error. Matched without the `u`
 * flag so individual code units are visible; valid surrogate pairs (emoji,
 * astral scripts) are left intact.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const WHITESPACE_RUNS_RE = /[^\S\n]{3,}/g;
const BLANK_LINES_RE = /\n{4,}/g;

/**
 * Normalize document content for indexing. Lightweight, conservative:
 * removes characters that are invisible or meaningless to humans and never
 * useful for search or retrieval, and strips the control/surrogate bytes
 * that make the embedder's tokenizer reject the input outright.
 *
 * Returns the empty string unchanged (the caller skips empty docs).
 */
export function normalizeContent(content: string): string {
  if (!content) return content;
  let s = content.replace(INVISIBLE_RE, "");
  s = s.replace(CONTROL_RE, "");
  s = s.replace(LONE_SURROGATE_RE, "");
  s = s.replace(WHITESPACE_RUNS_RE, "  ");
  s = s.replace(BLANK_LINES_RE, "\n\n\n");
  return s;
}
