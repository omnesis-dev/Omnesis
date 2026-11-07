// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** A character of an address's domain: `[a-zA-Z0-9.-]`. */
function isDomainChar(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57) || code === 46 || code === 45;
}

/** A character of an address's local part: `[a-zA-Z0-9._%+-]`. */
function isLocalChar(code: number): boolean {
  return isDomainChar(code) || code === 95 || code === 37 || code === 43;
}

/**
 * Every address-shaped run in the text, left to right, with where it starts:
 * what `/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g` finds, found
 * without that expression.
 *
 * The expression backtracks: from each starting character of a run of
 * address characters it reads to the end of the run looking for an `@`, so
 * a long run with none — a row of dots or hyphens, an encoded blob in a
 * Drive file — costs the square of its length, and a megabyte of it stalls
 * the process that asked. This walks from each `@` instead. A local part
 * reaches back from the `@` to the nearest character that cannot be in one;
 * a domain is the run of domain characters after it, cut at its last
 * `.` followed by two letters and extended over the letters that follow
 * that dot. Every character is read a bounded number of times, so the cost
 * is linear in the text whatever it holds.
 */
export function addressMatches(text: string): Array<{ index: number; match: string }> {
  const matches: Array<{ index: number; match: string }> = [];
  let from = 0;
  let at = text.indexOf("@");
  while (at !== -1) {
    let start = at;
    while (start > from && isLocalChar(text.charCodeAt(start - 1))) start -= 1;
    let domainEnd = at + 1;
    while (domainEnd < text.length && isDomainChar(text.charCodeAt(domainEnd))) domainEnd += 1;
    let dot = domainEnd - 3;
    while (
      dot >= at + 2 &&
      !(
        text.charCodeAt(dot) === 46 &&
        isAsciiLetter(text.charCodeAt(dot + 1)) &&
        isAsciiLetter(text.charCodeAt(dot + 2))
      )
    ) {
      dot -= 1;
    }
    if (start < at && dot >= at + 2) {
      let end = dot + 3;
      while (end < domainEnd && isAsciiLetter(text.charCodeAt(end))) end += 1;
      matches.push({ index: start, match: text.slice(start, end) });
      from = end;
    }
    at = text.indexOf("@", Math.max(at + 1, from));
  }
  return matches;
}

/** What `.` in a regular expression without the `s` flag does not match. */
function isLineTerminator(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

function hasLineTerminator(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) if (isLineTerminator(text.charCodeAt(i))) return true;
  return false;
}

/**
 * `Name <inner>`: what `/^(.+?)\s*<([^>]*)>$/` captures, found without it.
 * That expression tries every name length against every `<` and costs the
 * square of a header full of them. The `<` it settles on is the first one,
 * after the name's first character, with no `>` between it and the closing
 * one; the name runs to the whitespace before it and holds no line break.
 */
export function splitNameAngleAddress(text: string): { name: string; inner: string } | null {
  const close = text.length - 1;
  if (close < 2 || text[close] !== ">") return null;
  const open = text.indexOf("<", Math.max(1, text.lastIndexOf(">", close - 1) + 1));
  if (open === -1) return null;
  let nameEnd = open;
  while (nameEnd > 1 && /\s/.test(text[nameEnd - 1]!)) nameEnd -= 1;
  const name = text.slice(0, nameEnd);
  if (hasLineTerminator(name)) return null;
  return { name, inner: text.slice(open + 1, close) };
}

/**
 * `address (Name)`: what `/^([^\s(]+@[^\s(]+)\s*\((.+?)\)$/` captures, found
 * without it. That expression tries every `@` as the split and costs the
 * square of a header full of them. The address is the leading run free of
 * whitespace and `(`, with an `@` that neither starts nor ends it; the name
 * is everything between the `(` after it and the closing `)`, non-empty and
 * on one line.
 */
export function splitAddressParenName(text: string): { address: string; name: string } | null {
  let addressEnd = 0;
  while (addressEnd < text.length && text[addressEnd] !== "(" && !/\s/.test(text[addressEnd]!)) {
    addressEnd += 1;
  }
  const at = text.indexOf("@", 1);
  if (at === -1 || at > addressEnd - 2) return null;
  let open = addressEnd;
  while (open < text.length && /\s/.test(text[open]!)) open += 1;
  const close = text.length - 1;
  if (text[open] !== "(" || text[close] !== ")" || close - open < 2) return null;
  const name = text.slice(open + 1, close);
  if (hasLineTerminator(name)) return null;
  return { address: text.slice(0, addressEnd), name };
}

/**
 * The text before a `>` that ends it: what `text.replace(/>.*$/, "")`
 * leaves, found without trying every `>` against the rest of the line. That
 * `>` is the first one after the last line break, since `.` stops at one.
 */
export function withoutClosingBracketTail(text: string): string {
  let lineStart = text.length;
  while (lineStart > 0 && !isLineTerminator(text.charCodeAt(lineStart - 1))) lineStart -= 1;
  const close = text.indexOf(">", lineStart);
  return close === -1 ? text : text.slice(0, close);
}
