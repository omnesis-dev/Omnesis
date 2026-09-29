// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isUtf8 } from "node:buffer";
import { htmlToMarkdown } from "./html-to-markdown.js";

/**
 * Decode the bytes of one text part of a mail message.
 *
 * Valid UTF-8 is read as UTF-8 whatever the part declares: pure ASCII reads
 * the same in every charset mail uses, and bytes that are not ASCII but happen
 * to be valid UTF-8 almost never come from a single-byte charset. Anything
 * else is read in the charset the part declares — unless that is UTF-8, which
 * the bytes have just shown it is not — and otherwise as windows-1252, the
 * superset of Latin-1 that mail clients actually wrote.
 */
export function decodeMailText(bytes: Uint8Array, charset?: string): string {
  if (isUtf8(bytes)) return Buffer.from(bytes).toString("utf8");
  return new TextDecoder(nonUtf8Charset(charset) ?? "windows-1252").decode(bytes);
}

function nonUtf8Charset(label: string | undefined): string | undefined {
  const trimmed = label?.trim().replace(/^"|"$/g, "");
  if (!trimmed) return undefined;
  try {
    const encoding = new TextDecoder(trimmed).encoding;
    return encoding === "utf-8" ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

/** The `charset` parameter of a `Content-Type` value, when it names one. */
export function charsetOfContentType(contentType: string | undefined): string | undefined {
  return /;\s*charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? "")?.[1];
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: "\u00a0",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  euro: "€",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  hellip: "…",
  ndash: "–",
  mdash: "—",
};

/**
 * Tidy the text a message is read as: HTML entities decoded, and runs of
 * blank lines cut to one. Mailers that build the plain-text part from HTML
 * often leave `&nbsp;` and `&#8217;` in it, and layout tables leave dozens of
 * empty lines; neither is text anyone wrote, and both get in the way of search.
 */
export function tidyMailBody(text: string): string {
  const decoded = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#")) {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  });
  return decoded.replace(/[ \t\u00a0]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** A plain-text part shorter than this may be a stand-in for the HTML one. */
const STUB_TEXT_CHARS = 400;

/**
 * How many times more words the HTML must hold before it replaces a plain
 * part that is not a stub, and by how many words at least. Link targets and
 * image references are not counted, so a newsletter's link-heavy markup does
 * not outweigh a plain part that carries the same prose.
 */
const ABRIDGED_WORD_RATIO = 3;
const ABRIDGED_MIN_EXTRA_WORDS = 300;

function countReplacements(text: string): number {
  return text.match(/\uFFFD/g)?.length ?? 0;
}

/** Whether a "plain text" part is really markup: several tags a person would not type. */
function looksLikeHtml(text: string): boolean {
  if (!/<(html|body|div|table|p|br|span|td)\b/i.test(text)) return false;
  return (text.match(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi)?.length ?? 0) >= 5;
}

/** Words a reader sees in Markdown converted from HTML: link targets and images left out. */
function visibleWords(markdown: string): number {
  const visible = markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\]\([^)]*\)/g, "]");
  return visible.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

/**
 * The text a message is read as, from its plain-text and HTML parts.
 *
 * The plain-text part when it carries the message, since it is what the sender
 * wrote for reading as text. Four kinds of mail break that, and each is read
 * from its HTML instead:
 * - a plain part that decodes into more replacement characters than the HTML
 *   (a wrongly labelled charset, while the HTML part is labelled right);
 * - a plain part that is really markup, converted as the HTML it is;
 * - a one-line stand-in ("view this email in your browser") beside an HTML
 *   part that says much more;
 * - an abridged plain part — a newsletter's first paragraphs and a link —
 *   beside HTML holding several times as many words.
 *
 * The result is tidied with {@link tidyMailBody} and trimmed.
 */
export function chooseMailBody(parts: { text?: string; html?: string }): string {
  let converted: string | undefined;
  const html = () => (converted ??= parts.html ? htmlToMarkdown(parts.html).trim() : "");
  return tidyMailBody(
    pickMailBody(parts.text?.trim() ?? "", parts.html !== undefined, html),
  ).trim();
}

function pickMailBody(text: string, hasHtml: boolean, html: () => string): string {
  if (!text) return html();
  if (!hasHtml) return looksLikeHtml(text) ? htmlToMarkdown(text) : text;
  if (text.includes("\uFFFD") && countReplacements(html()) < countReplacements(text)) {
    return html();
  }
  if (looksLikeHtml(text)) return htmlToMarkdown(text);
  if (text.length < STUB_TEXT_CHARS) {
    return html().length > Math.max(STUB_TEXT_CHARS, text.length * 3) ? html() : text;
  }
  const textWords = wordCount(text);
  const htmlWords = visibleWords(html());
  const abridged =
    htmlWords >= textWords * ABRIDGED_WORD_RATIO &&
    htmlWords - textWords >= ABRIDGED_MIN_EXTRA_WORDS;
  return abridged ? html() : text;
}
