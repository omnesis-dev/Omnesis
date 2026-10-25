// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Lexer, type Token } from "marked";

// These model-generated control strings have no citation authority. Real
// citations travel separately; do not interpret IDs or touch Markdown links.
const RESERVED_CITATION = /[\t ]*\uE200cite(?:\uE202[^\uE200\uE201\r\n]+)+\uE201/g;
const LITERAL_QUOTE = /"[^"\r\n]*"|“[^”\r\n]*”|'[^'\r\n]*'|‘[^’\r\n]*’/g;

function prose(text: string): string {
  let cursor = 0;
  let result = "";
  for (const match of text.matchAll(LITERAL_QUOTE)) {
    result += text.slice(cursor, match.index).replace(RESERVED_CITATION, "") + match[0];
    cursor = match.index + match[0].length;
  }
  return result + text.slice(cursor).replace(RESERVED_CITATION, "");
}

function children(raw: string, tokens: Token[], depth: number): string {
  if (depth > 64) return raw;
  let cursor = 0;
  let result = "";
  for (const token of tokens) {
    const offset = raw.indexOf(token.raw, cursor);
    // Preserve unfamiliar parser layouts rather than rewriting uncertain spans.
    if (offset < 0) return raw;
    result += raw.slice(cursor, offset) + transform(token, depth + 1);
    cursor = offset + token.raw.length;
  }
  return result + raw.slice(cursor);
}

function transform(token: Token, depth: number): string {
  // A quoted example may span emphasis tokens. Preserve that containing block
  // conservatively instead of interpreting the example as a citation attempt.
  if ([...token.raw.matchAll(LITERAL_QUOTE)].some((match) => match[0].includes("\uE200cite\uE202")))
    return token.raw;
  if (token.type === "list") return children(token.raw, token.items, depth);
  // Only known prose containers are traversed. Tables, HTML, code, links and
  // future parser extensions may contain literal text in other-shaped fields.
  if (!["text", "paragraph", "heading", "list_item", "strong", "em", "del"].includes(token.type))
    return token.raw;
  if ("tokens" in token && Array.isArray(token.tokens))
    return children(token.raw, token.tokens, depth);
  return token.type === "text" ? prose(token.raw) : token.raw;
}

/** Final assembled Answer prose only; raw private agent traces remain untouched. */
export function normalizeAnswerProse(text: string): string {
  if (!text.includes("\uE200cite\uE202")) return text;
  return children(text, Lexer.lex(text), 0);
}
